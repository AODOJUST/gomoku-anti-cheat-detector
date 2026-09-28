/* Gomoku Anti-Cheat Detector — MVP
 * Engine: Rapfi (WASM, from dhbloo/gomoku-calculator / gomocalc.com)
 */
'use strict';

// 0.3.6 §1.7 决策 3: anything this file produces that will be SHOWN to the operator travels as
// a code, not as prose. app.js runs in the offscreen document, where the UI language is
// neither known nor relevant, and the message has to survive a round trip through
// offscreen.js before the panel or the viewer renders it. The consumer calls
// GMI18n.trError() on the way out.
//
// `console.warn` / `console.error` deliberately keep their Chinese text (§1.7 例外) — those
// are for whoever is reading devtools, and a translated log is harder to grep.
function i18nErr(key, vars) {
  if (typeof GMI18n !== 'undefined' && GMI18n && GMI18n.errCode) return GMI18n.errCode(key, vars);
  // i18n.js is absent when this file is required by a bare unit test; the prefix alone is
  // still a valid code, so the consumer can translate it if it has the tables.
  var s = '__i18n:' + key;
  if (vars) Object.keys(vars).forEach(function (k) { s += '|' + k + '=' + encodeURIComponent(vars[k]); });
  return s;
}

const SIZE = 15;
const COL = 'abcdefghijklmno'; // 15 columns

// ---------- coordinate helpers ----------
function shareToCoord(token) {
  // "h8" -> {x:7, y:7}  (x:0=left 'a', y:0=top -> number = SIZE - y)
  const m = token.match(/([a-z])(\d+)/i);
  if (!m) return null;
  const x = m[1].toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0);
  const y = SIZE - parseInt(m[2], 10);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  return [x, y];
}
function coordToShare(p) {
  return COL[p[0]] + (SIZE - p[1]);
}
function eqCoord(a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; }

// ---------- record parsing ----------
// Accepts:
//  - share string: "h8i9i8..."
//  - JSON: {moves:[{m:"h8",t:1234.5}, ...]} or {moves:["h8","i9"], times:[...]}
function parseRecord(text) {
  text = text.trim();
  let moves = [];
  let times = [];
  let explicitStones = null;
  let meta = { source: 'unknown' };

  if (text.startsWith('{')) {
    let j = JSON.parse(text);
    meta.source = 'json';
    meta.rule = j.rule || 'freestyle';
    if (Array.isArray(j.stones)) explicitStones = j.stones;
    if (Array.isArray(j.moves)) {
      let dropped = 0;
      for (let i = 0; i < j.moves.length; i++) {
        let mv = j.moves[i];
        let coord = null;
        let t = null;
        if (typeof mv === 'string') coord = shareToCoord(mv);
        else if (mv && mv.m) { coord = shareToCoord(mv.m); t = mv.t; }
        if (coord) {
          moves.push(coord);
          // Kept in lockstep with `moves`. Writing times[i] with the *source* index used
          // to shift every later timestamp by one position as soon as a single move failed
          // to parse — and a shifted timestamp is still a plausible number, so nothing
          // downstream could tell: the "no time data" fallback never fired and the time
          // statistics (and markDesperate's `fast` test) were silently computed from the
          // wrong moves.
          times.push(t != null ? t : null);
        } else {
          dropped++;
        }
      }
      if (dropped) meta.droppedFromParse = dropped;
    }
    // An external `times` array is only a fallback, and only safe when no move carried a
    // timestamp of its own: it is keyed by the source order, so adopting it after moves
    // were dropped would re-introduce exactly the shift fixed above. Truncated to fit, and
    // padded so every move still has a slot.
    if (Array.isArray(j.times) && !times.some((v) => v != null)) {
      times = j.times.slice(0, moves.length);
      while (times.length < moves.length) times.push(null);
    }
  } else {
    meta.source = 'share';
    const toks = text.toLowerCase().match(/[a-z]\d{1,2}/g) || [];
    for (const tk of toks) {
      const c = shareToCoord(tk);
      if (c) moves.push(c);
    }
  }
  const seen = new Set();
  const clean = [];
  // De-duplication drops entries from `moves`, so the timestamps have to be carried
  // through it index by index. Reusing `times` unchanged would desynchronise the two
  // arrays here just as thoroughly as the parse loop above used to.
  const cleanTimes = [];
  let dups = 0;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const k = m[0] + ',' + m[1];
    // 0.4.1 §三.1: `continue`, not `break` — the same rule content.js's toRecord() has always
    // followed. A gomoku point is played at most once per game, so a repeated coordinate is
    // always a capture artefact (a socket replay after a reconnect, or a board render
    // confirming a stone that already had its own event) and the hands AFTER it are still
    // real. Breaking threw them all away: one replayed stone in a 60-move record re-imported
    // as a 12-move stub, and nothing distinguished that from a genuinely short game — the
    // operator saw a plausible, complete-looking archive of the wrong length.
    if (seen.has(k)) { dups++; continue; }
    seen.add(k);
    clean.push(m);
    cleanTimes.push(times[i] == null ? null : times[i]);
  }
  // Counted, not just dropped: `dropped` is what content.js's toRecord() writes for the same
  // situation, so an imported record and a live one describe their damage the same way.
  if (dups) meta.dropped = dups;
  // Colour of each stone. Play order alone decides it here (black starts, then strictly
  // alternates) — an explicit `stones` array in the JSON wins when the file carries one,
  // because that is the only trustworthy source once a record may have gaps.
  const stones = [];
  for (let i = 0; i < clean.length; i++) {
    const given = explicitStones && explicitStones[i];
    stones.push(given === 1 || given === 2 ? given : (i % 2 === 0 ? 1 : 2));
  }
  // 0.4.1 §三.4: one word for "how much should the numbers built on this record be trusted".
  // Two moves of one colour in a row cannot happen in gomoku, so a non-zero count means the
  // capture lost or doubled a stone and the per-side figures rest on a wrong order.
  //
  // The mirror of content.js's toRecord() (the only other producer of `meta.quality`) — the
  // two are kept in step by hand, exactly like defaultThreadNum()/detectedThreads(), because
  // app.js runs in the offscreen document and never loads storage.js.
  let issues = 0;
  for (let i = 1; i < stones.length; i++) if (stones[i] && stones[i] === stones[i - 1]) issues++;
  meta.quality = issues ? 'suspect' : (dups ? 'partial' : 'good');
  return { moves: clean, stones, times: cleanTimes, meta, sources: clean.map(() => 'player') };
}

// ---------- eval string -> number (centipawn-like, mate scores) ----------
function evalNum(e) {
  let v = parseFloat(e);
  if (isNaN(v)) {
    if (e && e.startsWith('+M')) v = 40000 - parseInt(e.slice(2), 10);
    else if (e && e.startsWith('-M')) v = -40000 + parseInt(e.slice(2), 10);
    else v = -80000;
  }
  return v;
}

// ---------- engine wrapper ----------
// Build preference order. The multi-threaded builds are tried first: they are the same
// engine, just with a pthread pool, and on a 32-core box they measure ~7x the nodes/sec of
// the single-threaded build (multi @1 thread: 218K nps, @8 threads: 1662K nps). The single
// builds remain as fallbacks for browsers where SharedArrayBuffer is unavailable.
const ENGINE_BUILDS = [
  'engine/rapfi-multi-simd128.js',
  'engine/rapfi-multi.js',
  'engine/rapfi-single-simd128.js',
  'engine/rapfi-single.js',
];

// Ceiling for the manual override and for the automatic default (0.3.7 §二.1). The default is
// half the cores — a 32-core machine gets 16 — because the engine is only one of the things
// running: the offscreen document, the page and the OS still need cores, and oversubscribing
// a `shared: true` memory pool costs more than it buys. Half rather than all keeps even the
// ceiling from taking the whole machine.
const MAX_THREADS = 16;

// A pthread build can instantiate perfectly and still never answer a search: the pool
// workers are created lazily on the first `pthread_create`, and in some process states they
// never come up. Measured with a heavy real page already loaded, the whole stdout stream of
// such an engine is
//     status "" / MESSAGE Load config from config.toml / MESSAGE Evaluator set to mix9svq. / OK
// and then nothing — it stalls before it even loads its NNUE weights, while a working engine
// continues with "MESSAGE mix9svq nnue: load weight …" and the result coordinate within
// ~300ms. Note that the early `OK`/`MESSAGE` lines mean "did anything come back at all" is
// NOT a usable test: the search itself must be seen progressing. See Engine.analyzePosition
// for what happens when it never does.
const SILENCE_FLOOR = 12000;      // ms of total silence that can never be legitimate
const HARD_TIMEOUT = 60000;       // absolute cap, unchanged from before

class Engine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.threads = false;        // the build that won is a pthread build
    this.build = null;           // which file won
    this.threadNum = 1;          // the number actually handed to the engine
    this.thinkMs = 2000;         // last TIMEOUT_TURN, used to scale the silence watchdog
    this.noThreads = false;      // the environment refused a shared WebAssembly.Memory
    this.fallbackReason = '';
  }
  onStatus = () => {};

  async init() {
    for (const url of ENGINE_BUILDS) {
      // Once the environment has said no to SharedArrayBuffer there is no point burning a
      // 40MB data-package load on the other multi build — go straight to single-threaded.
      if (this.noThreads && /-multi/.test(url)) continue;
      try {
        this.worker = new Worker('worker.js');
        const info = await this._load(url);
        this.ready = true;
        this.threads = !!info.threads;
        this.build = url;
        if (!this.threads) {
          this.fallbackReason = this.fallbackReason || i18nErr('engine.noSab');
        }
        return url;
      } catch (err) {
        if (err && err.reason === 'no-threads') this.noThreads = true;
        this.onStatus('engine load failed (' + url + '): ' + err + ' - trying fallback');
        try { this.worker.terminate(); } catch (e) {}
      }
    }
    throw new Error('All engine builds failed to load.');
  }

  _load(url) {
    return new Promise((resolve, reject) => {
      const w = this.worker;
      const timer = setTimeout(() => reject(new Error('engine init timeout')), 60000);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { clearTimeout(timer); resolve({ threads: !!m.threads, build: m.data || url }); }
        else if (m.type === 'error') {
          clearTimeout(timer);
          const err = new Error(m.data);
          err.reason = m.reason;
          reject(err);
        } else if (m.type === 'stderr') console.warn('[engine stderr]', m.data);
      };
      w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'worker error')); };
      w.postMessage({ type: 'engineScriptURL', data: { engineURL: url } });
    });
  }

  send(cmd) { this.worker.postMessage({ type: 'command', data: cmd }); }

  // Replaces the multi-threaded worker with a single-threaded one, once, after the pthread
  // build has proved it cannot search here. Kept on the instance so `info()` (and therefore
  // the panel, the report and the archive) tells the truth about what produced the verdicts.
  async downgrade(why) {
    const singles = ENGINE_BUILDS.filter((u) => !/-multi/.test(u));
    try { if (this.worker) this.worker.terminate(); } catch (e) {}
    this.ready = false;
    this.threads = false;
    this.noThreads = true;
    this.threadNum = 1;
    // Cause only — the panel/report already say "降级为单线程" around it, so repeating the
    // remedy here would read as "降级：…已回退单线程".
    this.fallbackReason = why || i18nErr('engine.noResponse');
    for (const url of singles) {
      try {
        this.worker = new Worker('worker.js');
        await this._load(url);
        this.build = url;
        this.ready = true;
        // The new worker is a fresh engine: replay the settings the caller already sent to
        // the dead one, otherwise the retried search would run on an unconfigured board.
        if (this._lastArgs) this.configure(this._lastArgs);
        this.onStatus('engine downgraded to single-threaded (' + url + ')');
        return url;
      } catch (e) {
        this.onStatus('fallback build failed (' + url + '): ' + e);
      }
    }
    throw new Error('All engine builds failed to load.');
  }

  configure(args = {}) {
    const { rule = 0, thinkMs = 2000, threadNum = 0 } = args;
    this._lastArgs = args;           // replayed verbatim if the build is swapped mid-run
    // A single-threaded build ignores INFO THREAD_NUM, and reporting a thread count the
    // engine is not using would be a lie in the panel.
    this.threadNum = this.threads ? resolveThreadNum(threadNum) : 1;
    this.thinkMs = thinkMs;          // the silence watchdog is scaled from this
    this.send('START ' + SIZE);
    this.send('INFO RULE ' + rule);
    this.send('INFO THREAD_NUM ' + this.threadNum);
    this.send('INFO HASH_SIZE 131072');
    this.send('INFO SHOW_DETAIL 3');
    this.send('INFO MAX_DEPTH 100');
    this.send('INFO TIMEOUT_TURN ' + thinkMs);
    this.send('INFO TIME_LEFT 99999999');
  }

  info() {
    return {
      build: this.build,
      threads: this.threads,
      threadNum: this.threadNum,
      degraded: !this.threads,
      reason: this.fallbackReason,
    };
  }

  // How long the engine may stay completely silent before we call it dead. A search that
  // is actually running prints INFO/PV lines continuously, and even a done-by-deadline
  // search answers within TIMEOUT_TURN — so silence past this is never a slow search.
  silenceLimit() {
    return Math.max(SILENCE_FLOOR, (this.thinkMs || 2000) * 4 + 4000);
  }

  // Analyse position after `prefix` moves. Returns {best, candidates:[{move,eval,winrate,bestline}]}
  async analyzePosition(prefixMoves, nbest = 5, timeoutMs) {
    try {
      return await this._search(prefixMoves, nbest, timeoutMs);
    } catch (e) {
      // Never seeing the search progress means the pthread pool never started — there is
      // nothing to salvage on this build. Swap in the single-threaded one and redo the same
      // call: it is both faster and more honest than reporting a failed analysis, and it is
      // what the panel's "引擎降级为单线程模式" line exists for.
      if (e && e.noProgress && this.threads) {
        await this.downgrade(e.message);
        return await this._search(prefixMoves, nbest, timeoutMs);
      }
      throw e;
    }
  }

  _search(prefixMoves, nbest, timeoutMs) {
    return new Promise((resolve, reject) => {
      let boardCmd = 'YXBOARD';
      let side = 1;
      for (const p of prefixMoves) {
        boardCmd += ' ' + p[0] + ',' + p[1] + ',' + side;
        side = 3 - side;
      }
      boardCmd += ' DONE';

      const worker = this.worker;
      let curPV = -1;
      let pvs = {};
      let done = false;
      let sawProgress = false;      // the SEARCH moved — startup chatter does not count
      let silenceTimer = null;

      const fail = (msg) => {
        if (done) return;
        done = true;
        clearTimeout(hardTimer);
        clearTimeout(silenceTimer);
        worker.onmessage = null;
        // Never seeing the search move is the dead-pool signature, not a slow search.
        const noProgress = !sawProgress;
        const err = new Error(msg === 'analysis timeout' && noProgress ? i18nErr('engine.stalled') : msg);
        err.noProgress = noProgress;
        reject(err);
      };
      const armSilence = () => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(
          () => fail(i18nErr('engine.poolDown', { sec: Math.round(this.silenceLimit() / 1000) })),
          this.silenceLimit());
      };
      const hardTimer = setTimeout(() => fail('analysis timeout'), timeoutMs || HARD_TIMEOUT);
      armSilence();

      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type !== 'stdout') return;
        // Any byte proves the worker is alive, so it re-arms the watchdog — but only a
        // search line (INFO PV/… or the result) proves the *pool* came up. The engine's
        // startup chatter (`OK`, `MESSAGE Load config…`) arrives either way, which is
        // exactly why "did anything come back" cannot be the liveness test.
        armSilence();
        const out = m.data;
        const sp = out.indexOf(' ');
        if (sp === -1) {
          if (out === 'OK' || out === 'SWAP') return;
          sawProgress = true;
          const c = out.split(',');
          const best = [parseInt(c[0], 10), parseInt(c[1], 10)];
          if (!done) {
            done = true;
            clearTimeout(hardTimer);
            clearTimeout(silenceTimer);
            const candidates = Object.keys(pvs).map(k => pvs[k])
              .filter(p => p.bestline && p.bestline.length)
              .sort((a, b) => evalNum(b.eval) - evalNum(a.eval))
              .map(p => ({ move: p.bestline[0], eval: p.eval, winrate: p.winrate, bestline: p.bestline }));
            resolve({ best, candidates });
          }
          return;
        }
        const head = out.substring(0, sp);
        const tail = out.substring(sp + 1);
        if (head === 'INFO') {
          const sp2 = tail.indexOf(' ');
          const k = tail.substring(0, sp2);
          const v = tail.substring(sp2 + 1);
          if (k === 'PV') {
            sawProgress = true;
            if (v === 'DONE') curPV = -1;
            else { curPV = parseInt(v, 10); pvs[curPV] = pvs[curPV] || {}; }
          } else if (curPV >= 0) {
            sawProgress = true;
            if (k === 'EVAL') pvs[curPV].eval = v;
            else if (k === 'WINRATE') pvs[curPV].winrate = parseFloat(v);
            else if (k === 'DEPTH') pvs[curPV].depth = parseInt(v, 10);
            else if (k === 'BESTLINE') {
              pvs[curPV].bestline = (v.match(/\d+,\d+/g) || []).map(s => s.split(',').map(Number));
            }
          }
        }
      };
      this.send(boardCmd);
      this.send('YXNBEST ' + nbest);
    });
  }
}

// ---------- per-step scoring (shared by analyzeGame and analyzeStepwise) ----------

// Move provenance, decided by the collector:
//   'player'     a move actually played and observed — exact order, exact interval.
//   'ai-suggest' an engine proposal, not a played move (does not consume a turn's
//                statistics but DOES consume a board slot).
//   'prejoin'    a stone recovered from a board render because the detector started
//                mid-game. Its SET is exact, its ORDER is not: it must be replayed so
//                that later positions are evaluated on the right board, but it must
//                never be scored — a top1 hit rate computed from a guessed order is
//                worse than no number at all.
const PREJOIN = 'prejoin';
function scorable(source) { return source !== 'ai-suggest' && source !== PREJOIN; }
function isPrejoin(source) { return source === PREJOIN; }

// ---------- side resolution ----------
// The collector records the colour of every stone (`stones[i]`: 1 = black, 2 = white,
// taken from the socket's `stoneType` / the DOM's black-stone|white-stone class). That is
// the ground truth. Deriving the side from the move INDEX only works while the index
// happens to line up with the real alternation — and it stops lining up the moment a
// stone is missing, duplicated, undone or absorbed out of a board render in a ratio
// other than B/W/B/W. Using the recorded colour removes the whole failure mode.
function sideFromStone(record, i) {
  const st = record && record.stones;
  if (st && st[i] != null) return st[i] === 1 ? 'B' : 'W';
  return null;                       // unknown -> caller falls back to index parity
}

// Adjacent same-colour moves can only come from a broken capture: gomoku alternates
// strictly (black first). Reported rather than silently corrected — the verdicts derived
// from a bad order are wrong, and an operator needs to see that instead of trusting them.
function orderIssues(record) {
  const st = (record && record.stones) || [];
  const out = [];
  for (let i = 1; i < st.length; i++) {
    if (st[i] != null && st[i] === st[i - 1]) out.push({ i: i, stone: st[i], from: st[i - 1] });
  }
  return out;
}

// Fills best / top1..top5 / loss / isSharp / forcedDefense from one engine result.
function scoreStep(step, res, actual) {
  const cands = res.candidates || [];
  const best = res.best;
  const bestCand = cands[0] || {};
  const bestWR = bestCand.winrate != null ? bestCand.winrate : null;
  const actualCand = cands.find(c => eqCoord(c.move, actual));
  step.best = best;
  step.bestStr = best ? coordToShare(best) : '—';
  step.cands = cands.slice(0, 5);
  step.candStrs = cands.slice(0, 5).map(c => coordToShare(c.move) + '(' + (c.winrate != null ? (c.winrate * 100).toFixed(0) + '%' : '?') + ')');
  step.top1 = !!(eqCoord(actual, best) || (actualCand && cands.indexOf(actualCand) === 0));
  step.top3 = cands.slice(0, 3).some(c => eqCoord(c.move, actual));
  step.top5 = cands.slice(0, 5).some(c => eqCoord(c.move, actual));
  step.outsideTop5 = !step.top5;
  step.bestWR = bestWR;
  step.actualWR = actualCand ? actualCand.winrate : null;
  if (bestWR != null) {
    step.loss = actualCand ? bestWR - actualCand.winrate
                           : bestWR - (cands[cands.length - 1] ? cands[cands.length - 1].winrate : 0);
  } else step.loss = null;
  const top2WR = cands[1] ? cands[1].winrate : 0;
  const gap = bestWR != null ? bestWR - top2WR : 0;
  step.isSharp = bestWR != null && ((bestWR >= 0.90) || (bestWR <= 0.10)) && gap >= 0.12;
  step.forcedDefense = !!(bestWR != null && gap >= 0.15 && step.top1);
  return step;
}

// ---------- 0.3.4 活四：真实形状识别 ----------
// 0.3.1 inferred a live four from the engine's win rate (bestWR >= 0.95 / <= 0.05). That is
// a PROBABILITY, not a proof, and it fires in the opening: with three stones a side the
// engine routinely reports >= 0.95 simply because it evaluates the position as favourable,
// so the panel announced a live four that did not exist and detection stopped after three
// hands. Bug report 一、1 (spectating overlay) and 一、2 (a 26-move record truncated to 3
// stones) turned out to be this one root cause.
//
// A live four is a SHAPE: four same-coloured stones in a line with BOTH ends empty
// (_XXXX_). The opponent can block only one end, so the fifth stone is unstoppable and the
// game is decided. That is decidable exactly, with no threshold, so we test it directly.
//
// `board` is [{x, y, side:'B'|'W'}] — the position AFTER the hand being judged. Returns
// 'B' / 'W' for the side holding a live four, else null.
const LIVE_FOUR_DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
function liveFourHolder(board) {
  // Four stones of one colour are the arithmetic minimum for a live four; anything less
  // cannot contain one, and this is also what makes the opening case impossible.
  if (!board || board.length < 4) return null;
  const key = (x, y) => x * SIZE + y;
  const inb = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  const sets = { B: new Set(), W: new Set() };
  const occ = new Set();
  for (let i = 0; i < board.length; i++) {
    const s = board[i];
    if (!s || s.x == null || s.y == null) continue;
    occ.add(key(s.x, s.y));
    if (sets[s.side]) sets[s.side].add(key(s.x, s.y));
  }
  for (const side of ['B', 'W']) {
    const mine = sets[side];
    if (mine.size < 4) continue;
    for (const k of mine) {
      const x0 = Math.floor(k / SIZE), y0 = k % SIZE;
      for (let d = 0; d < LIVE_FOUR_DIRS.length; d++) {
        const dx = LIVE_FOUR_DIRS[d][0], dy = LIVE_FOUR_DIRS[d][1];
        // Window of six: p0 and p5 are the two ends that must be EMPTY, p1..p4 the four.
        // Anchoring on every stone of the run means each run is examined from its head.
        const ax = x0 - dx, ay = y0 - dy;          // p0
        const bx = x0 + 4 * dx, by = y0 + 4 * dy;  // p5
        if (!inb(ax, ay) || !inb(bx, by)) continue;          // an edge is not an empty end
        if (occ.has(key(ax, ay)) || occ.has(key(bx, by))) continue;
        let all = true;
        for (let i = 1; i <= 4; i++) {
          const cx = x0 + (i - 1) * dx, cy = y0 + (i - 1) * dy;
          if (!inb(cx, cy) || !mine.has(key(cx, cy))) { all = false; break; }
        }
        if (all) return side;
      }
    }
  }
  return null;
}

// ---------- 0.3.7 §三.1 四三杀：优先级高于活四 ----------
// 0.3.4 起终止条件只看「活四」，于是漏掉了一类真实的必胜形：一方走出**四三杀**
// （一条线上冲四、另一条线上活三），对手只能堵一处，下一手必成五。此时若**对手**盘面上
// 另有一个活四，旧实现按 liveFourHolder 的返回顺序把终止理由记成「对手形成活四，当前方
// 必败」——胜负说反了，实战里的四三胜被判成负。
//
// 两处威胁都用「落子推演」定义，与 liveFourHolder 的 6 格窗口同构，不做概率近似：
//   · four(side)      ：存在一个空点，落下去即成五（活四与冲四都覆盖）。
//   · liveFour(side)  ：存在一条 `_XXXX_`（两端皆空的四子连珠）。
//   · openThree(side) ：存在一个空点，落下去即形成 liveFour（`_XXX_` 与其跳形都覆盖）。
// 于是 fourThree(side) = four(side) && openThree(side)。
//
// 判定序（高→低）：当前方四三杀 > 对手四三杀 > 当前方活四 > 对手活四。
// 四三杀排在活四之前正是本版要求：谁的四三杀先成立谁赢，不能因为对手盘面上摆着一个
// 够不着的活四就改判。
//
// 活四自身不会满足 openThree（它不需要再成四），所以一个纯活四不会被误报成四三杀，
// 文案与语义都保持原样。
const FOUR_DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

function scanThreats(board) {
  if (!board || !board.length) return null;
  const key = (x, y) => x * SIZE + y;
  const inb = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  const own = { B: new Set(), W: new Set() };
  const occ = new Set();
  let known = 0;
  for (let i = 0; i < board.length; i++) {
    const s = board[i];
    if (!s || s.x == null || s.y == null) continue;
    occ.add(key(s.x, s.y));
    if (own[s.side]) { own[s.side].add(key(s.x, s.y)); known++; }
  }
  if (known < 3) return null;          // 活三就要 3 子；少于 3 子连活三都不可能有

  const out = {
    B: { four: false, liveFour: false, openThree: false },
    W: { four: false, liveFour: false, openThree: false },
  };

  for (const side of ['B', 'W']) {
    const mine = own[side];
    if (mine.size < 3) continue;       // 活三要 3 子、四要 4 子，取小的
    const t = out[side];
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        for (let d = 0; d < FOUR_DIRS.length; d++) {
          const dx = FOUR_DIRS[d][0], dy = FOUR_DIRS[d][1];
          // — 5 格窗口：4 己方 + 1 空 => 下一手成五（冲四 / 活四 / 嵌五都算）
          if (!t.four) {
            let c = 0, e = 0, bad = false;
            for (let i = 0; i < 5; i++) {
              const cx = x + dx * i, cy = y + dy * i;
              if (!inb(cx, cy)) { bad = true; break; }
              const k = key(cx, cy);
              if (mine.has(k)) c++;
              else if (occ.has(k)) { bad = true; break; }
              else e++;
            }
            if (!bad && c === 4 && e === 1) t.four = true;
          }
          // — 6 格窗口：两端空 + 中间 4 格里恰 3 己方（另 1 空）=> 下一手成活四
          if (!t.liveFour || !t.openThree) {
            const ax = x - dx, ay = y - dy;             // p0
            const bx = x + 4 * dx, by = y + 4 * dy;     // p5
            if (inb(ax, ay) && inb(bx, by) &&
                !occ.has(key(ax, ay)) && !occ.has(key(bx, by))) {
              let c = 0, e = 0, bad = false;
              for (let i = 0; i < 4; i++) {
                const cx = x + dx * i, cy = y + dy * i;   // p1..p4
                if (!inb(cx, cy)) { bad = true; break; }
                const k = key(cx, cy);
                if (mine.has(k)) c++;
                else if (occ.has(k)) { bad = true; break; }
                else e++;
              }
              if (!bad) {
                if (c === 4) t.liveFour = true;                      // _XXXX_
                else if (c === 3 && e === 1) t.openThree = true;     // _XXX_ / 跳活三
              }
            }
          }
          if (t.four && t.liveFour && t.openThree) break;
        }
        if (t.four && t.liveFour && t.openThree) break;
      }
      if (t.four && t.liveFour && t.openThree) break;
    }
  }
  return out;
}

// 0.3.4: the win-rate proxy is gone (see liveFourHolder above). A step is terminal when the
// position after it contains a live four. `board` is that position; when a caller cannot
// supply one the step is simply not terminal — a missed early stop only costs engine time,
// whereas a false one invents a result and truncates the record.
//
// There is deliberately no `isOpening` guard: the shape test is exact on its own. A live
// four needs four stones of one colour, so it cannot exist with three stones a side, and
// gating on the move number would instead hide a real one whenever the operator raises
// 开局排除.
//
// 0.3.7 §三.1 widens the test from "a live four exists" to a priority list, because the
// narrow version mis-attributed the result of a 四三杀. `step.side` is the side that just
// moved, so "当前方" is that side and "对手" is the other one.
function applyTerminal(step, opts, board) {
  if (!step) return false;
  const t = scanThreats(board);
  if (!t) return false;
  const me = (step.side === 'B' || step.side === 'W') ? step.side : null;
  const you = me === 'B' ? 'W' : (me === 'W' ? 'B' : null);
  const isFT = (s) => !!s && t[s].four && t[s].openThree;

  let reason = null;
  if (isFT(me)) reason = '当前方形成四三杀，对手必败';
  else if (isFT(you)) reason = '对手形成四三杀，当前方必败';
  else if (me && t[me].liveFour) reason = '当前方形成活四，对手必败';
  else if (me && t[you].liveFour) reason = '对手形成活四，当前方必败';
  else if (!me) {
    // The colour of the side to move is unknown (rare, but a record with no authoritative
    // `stones` can reach here). The shapes are still hard evidence, so stop anyway and
    // report the holder rather than guessing a direction.
    if (['B', 'W'].some(isFT)) reason = '任一方形成四三杀，检测停止';
    else if (['B', 'W'].some((s) => t[s].liveFour)) reason = '任一方形成活四，检测停止';
  }
  if (!reason) return false;
  step.terminal = true;
  step.stopReason = reason;
  return true;
}

// Colour for every slot of a coordinate list, used when a caller has no recorded `stones`.
// Correct only for a prefix of pure PLAYER moves — an ai-suggest reference stone or a
// mid-game join shifts the alternation, which is why every caller that knows the real
// colours passes a board instead.
function boardFromCoords(coords) {
  const out = [];
  for (let i = 0; i < (coords || []).length; i++) {
    const c = coords[i];
    if (!c) continue;
    out.push({ x: c[0], y: c[1], side: (i % 2 === 0) ? 'B' : 'W' });
  }
  return out;
}


// AI fingerprint: desperate "useless four" runs.
// Losing position (bestWR < 6%), move outside top5, fast thinking.
// Flag runs of >=2 consecutive such moves by the same side.
function markDesperate(steps) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    s.desperate = false;
    if (!s.analyzed || s.isOpening) continue;
    if (s.bestWR == null) continue;
    const fast = (s.thinkMs == null) || (s.thinkMs < 1500);
    if (s.bestWR < 0.06 && s.outsideTop5 && fast) {
      let run = 1;
      for (let j = i - 1; j >= 0; j--) {
        const p = steps[j];
        if (p.side !== s.side || !p.analyzed || p.isOpening) break;
        if (p.bestWR != null && p.bestWR < 0.06 && p.outsideTop5 &&
            ((p.thinkMs == null) || (p.thinkMs < 1500))) run++;
        else break;
      }
      if (run >= 2) { for (let j = i; j > i - run; j--) steps[j].desperate = true; }
    }
  }
  return steps;
}

// 0.4.2 §2.3: 回避手 (evasion move) — a deliberately bad hand played between two good ones,
// read as smoke for the benefit of a detector rather than as a chess mistake.
//
// The shape is what makes it interesting: ONE hand the player gave significant win rate away
// on, while their own previous and next hands were both the engine's top choice with almost
// nothing given away. A real blunder does not come wrapped in two perfect hands, so the
// pattern is much rarer than "played a bad move" and much less likely to be a coincidence.
// It is also direction-blind: it fires in a won position, a lost one, or an even one.
//
// Kept a separate pass from markDesperate, not a branch of it: markDesperate looks for a RUN
// of hopeless hands in a LOST position (bestWR < 6%), which is the exact opposite situation.
//
// `thresholds` is the resolved threshold object (riskParams(...).t), so all five cuts are
// configurable and learnable without this file knowing where they came from.
function markEvasion(steps, thresholds) {
  const t = thresholds || BASE_THRESHOLDS;
  const lossMin = t.evasionLoss != null ? t.evasionLoss : 0.20;
  const goodMax = t.goodLoss != null ? t.goodLoss : 0.05;
  for (let i = 0; i < steps.length; i++) steps[i].evasion = false;

  // Same population sideAggregate() scores, so "excluded from the main statistics" below is
  // literally the same set of hands being moved out of it. `forcedDefense` is already exempt
  // (§2.4: a hand that had no alternative cannot be a deliberate smoke screen), and the
  // opening is excluded because there is no "previous hand of my own" yet.
  const own = { B: [], W: [] };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s.analyzed || s.isOpening || s.forcedDefense) continue;
    if (s.side === 'B' || s.side === 'W') own[s.side].push(s);
  }
  const isGood = (s) => !!s && s.top1 && (s.loss == null || s.loss < goodMax);

  for (const side of ['B', 'W']) {
    const list = own[side];
    // Ends are skipped on purpose: an evasion is DEFINED by having a good hand on each side,
    // so a hand at either end of the side's sequence cannot be one.
    for (let k = 1; k < list.length - 1; k++) {
      const s = list[k];
      if (s.top1) continue;                                    // was the best move anyway
      if (s.loss == null || s.loss < lossMin) continue;         // not a blunder
      if (isGood(list[k - 1]) && isGood(list[k + 1])) s.evasion = true;
    }
  }
  return steps;
}

// The per-side evasion figures §2.3 scores. Split out of sideAggregate so the two things it
// returns can be read separately — the COUNT (how often) and the REGULARITY (how evenly
// spaced), which mean different things: a player who blunders once may have simply blundered,
// while three of them at a fixed interval is a rhythm.
function evasionStats(steps, side, thresholds) {
  const t = thresholds || BASE_THRESHOLDS;
  const own = steps.filter(x => x.side === side && x.analyzed && !x.isOpening && !x.forcedDefense);
  const evs = own.filter(x => x.evasion);
  const count = evs.length;

  // §2.2 信号 B: the gaps between evasion hands measured in that side's own move sequence.
  // stddev/mean is the coefficient of variation — scale-free, so "every third hand" scores the
  // same whether the game lasted 12 moves or 120. Below `evasionMin` evasions there is not
  // enough of a pattern to talk about one, so the term stays 0 rather than being noisy.
  let regularity = 0;
  const minEv = t.evasionMin != null ? t.evasionMin : 3;
  if (count >= minEv) {
    const positions = [];
    own.forEach((s, i) => { if (s.evasion) positions.push(i); });
    const gaps = [];
    for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
    if (gaps.length) {
      const mean = avg(gaps);
      const std = Math.sqrt(avg(gaps.map(g => (g - mean) ** 2)));
      const regMax = t.evasionReg != null ? t.evasionReg : 0.35;
      // A perfectly even rhythm (std 0) -> 1; at or beyond the ceiling -> 0.
      regularity = mean > 0 ? clamp(1 - std / mean / Math.max(1e-6, regMax), 0, 1) : 0;
    }
  }

  // §2.2 信号 C: 将胜乱下 — a big loss taken while already winning. Independent of the
  // evasion flag: the hand does not need good neighbours to be worth reporting, because
  // throwing away a won position is not something a strong player does by accident.
  const winWR = t.winningWR != null ? t.winningWR : 0.85;
  const lossMin = t.evasionLoss != null ? t.evasionLoss : 0.20;
  const winBlunders = own.filter(s =>
    s.bestWR != null && s.bestWR >= winWR &&
    s.loss != null && s.loss >= lossMin).length;

  return { count, regularity, winBlunders };
}

// Per-step engine time budget.
//   budget = min( max(2000, recordedMs), panelThinkMs )
// recordedMs == null (no timing data) -> fall back to the panel value (fixed budget mode).
function stepBudget(recordedMs, opts) {
  const cap = (opts && opts.thinkMs) || 2000;
  if (recordedMs == null) return { budget: cap, fallback: true };
  return { budget: Math.min(Math.max(2000, recordedMs), cap), fallback: false };
}

// Analyse a single position and return a step object.
// allMoves: array of [x,y] physical stones, with `actual` as the LAST element.
// playerIdx: ordinal among player moves (0-based) — the fallback for the side.
// side: the recorded colour of the move ('B' | 'W'), when the collector knew it.
// budgetMs: engine think time for this position; recordedMs: the player's real interval.
// board: optional [{x,y,side}] for allMoves — the colours the live-four test needs. Omitting
//        it falls back to index parity, which is only right for a pure player-move prefix.
async function analyzeStep(eng, allMoves, playerIdx, actual, opts, budgetMs, recordedMs, side, board) {
  const i = allMoves.length - 1;
  const mySide = side || ((playerIdx % 2 === 0) ? 'B' : 'W');
  const step = {
    i, moveNo: playerIdx + 1, side: mySide, source: 'player',
    actual, actualStr: coordToShare(actual),
    isOpening: playerIdx < opts.openingCutoff,
    thinkMs: recordedMs != null ? recordedMs : null,
    budgetMs,
    analyzed: true,
    orderKnown: true,
  };
  eng.configure({ rule: opts.rule, thinkMs: budgetMs, threadNum: opts.threadNum });
  const res = await eng.analyzePosition(allMoves.slice(0, -1), 5);
  scoreStep(step, res, actual);
  // 0.3.4 活四停止: shape test on the position AFTER this hand, so the offscreen live
  // session still ends on a real live four (doStep sets live.ended) — but not on the
  // opening, where the old win-rate proxy used to fire.
  applyTerminal(step, opts, board || boardFromCoords(allMoves));
  return step;
}

// 逐步分析: one engine call per move, in play order, at the per-step time budget.
async function analyzeStepwise(record, opts, onProgress, onStep) {
  onProgress && onProgress(0, i18nErr('progress.loading'));
  const eng = await getEngine();
  // 0.3.3 §3.5: same rule as analyzeGame — read learnedParams once per run unless the caller
  // pinned them (opts.learned === null forces defaults).
  const learned = (opts.learned !== undefined) ? opts.learned : await loadLearnedParams();
  onProgress && onProgress(3, i18nErr('progress.ready'));

  const moves = record.moves;
  const times = record.times || [];
  const sources = record.sources || moves.map(() => 'player');
  const suspect = opts.suspect || 'both';
  const N = moves.length;

  const playerIdxByMove = [];
  let playerCount = 0;
  for (let i = 0; i < N; i++) {
    playerIdxByMove.push(playerCount);
    if (sources[i] !== 'ai-suggest') playerCount++;
  }
  // Recorded colour wins; index parity is only the fallback for records with no `stones`.
  const sideAt = (i) => sideFromStone(record, i) || ((playerIdxByMove[i] % 2 === 0) ? 'B' : 'W');
  // A move number identifies a PLAYED move, so a reference stone must not claim one —
  // otherwise the table shows the same hand twice (once per board slot) and reads as a
  // broken move order.
  const noAt = (i) => (sources[i] === 'ai-suggest' ? null : playerIdxByMove[i] + 1);
  const need = [];
  for (let i = 0; i < N; i++) {
    const side = sideAt(i);
    need.push(scorable(sources[i]) && (suspect === 'both' || side === suspect));
  }
  const total = need.filter(Boolean).length;
  let done = 0;

  const steps = [];
  // 0.3.4: the running position, one entry per move slot (prejoin and ai-suggest stones are
  // on the board too — they just are not scored). The live-four test reads this.
  const boardStones = [];
  for (let i = 0; i < N; i++) {
    if (opts.shouldAbort && opts.shouldAbort()) throw new Error('__aborted__');
    const side = sideAt(i);
    const actual = moves[i];
    const recorded = times[i] != null ? times[i] : null;
    boardStones.push({ x: actual[0], y: actual[1], side: side });

    if (need[i]) {
      const { budget } = stepBudget(recorded, opts);
      const step = await analyzeStep(eng, moves.slice(0, i + 1), playerIdxByMove[i], actual, opts, budget, recorded, side, boardStones.slice());
      step.timedBy = recorded != null ? 'times' : 'fixed';
      step.moveNo = noAt(i);
      done++;
      onProgress && onProgress(total ? 3 + 95 * done / total : 100,
        `逐步分析 第 ${noAt(i)} 手（${side === 'B' ? '黑' : '白'}方）· 本步预算 ${budget}ms`);
      // 0.3.4 活四停止: a real live four ends the game here. The step is kept (it is the
      // last hand analysed); the loop breaks instead of scoring the rest.
      if (step.terminal) { steps.push(step); onStep && onStep(step); break; }
      steps.push(step);
    } else {
      const un = {
        i, moveNo: noAt(i), side, source: sources[i] || 'player',
        actual, actualStr: coordToShare(actual),
        isOpening: playerIdxByMove[i] < opts.openingCutoff,
        thinkMs: recorded, budgetMs: null, analyzed: false,
        orderKnown: scorable(sources[i]),
        best: null, bestStr: '—', cands: [], candStrs: [],
        top1: false, top3: false, top5: false, outsideTop5: false,
        bestWR: null, actualWR: null, loss: null, isSharp: false, forcedDefense: false,
      };
      steps.push(un);
    }
    onStep && onStep(steps[steps.length - 1]);
  }

  markDesperate(steps);
  // 0.4.2 §2.3: the evasion pass, right after markDesperate and before anything aggregates —
  // sideAggregate() drops the hands this flags, so it must have run by then.
  markEvasion(steps, riskParams(learned).t);
  // 0.3.3 C: same fingerprint pass as analyzeGame, for the same reason.
  if (learned && learned.features && learned.features.length &&
      typeof GMLearn !== 'undefined' && GMLearn && GMLearn.matchFeatures) {
    GMLearn.matchFeatures(steps, learned.features, learned.simThreshold);
  }
  onProgress && onProgress(99, i18nErr('progress.risk'));
  return buildReport(steps, record, Object.assign({}, opts, { learned: learned }));
}

// A compact live summary, used while 实时逐步分析 is still accumulating steps.
function summarizeSteps(steps, times, opts) {
  const hasTime = (times || []).some(v => v != null);
  const params = (opts && opts.learned) || null;
  // 0.4.2 §2.3: the live summary has to run the same pass the finished report does, or the
  // risk score would visibly change the moment the game ends — and the change would look like
  // a bug. markEvasion() rewrites the flags from scratch, so re-running it per update is safe.
  markEvasion(steps, riskParams(params).t);
  // Two steps in a row by the same side cannot happen in a real game. The live session
  // only holds PLAYED moves, so an adjacency here means the capture lost one.
  let issues = 0;
  for (let i = 1; i < steps.length; i++) if (steps[i].side === steps[i - 1].side) issues++;
  return {
    partial: true,
    totalMoves: steps.length,
    scoredCount: steps.filter(x => x.analyzed).length,
    prejoinCount: steps.filter(x => isPrejoin(x.source)).length,
    forcedCount: steps.filter(x => x.forcedDefense).length,
    orderSuspect: issues > 0,
    orderIssues: issues,
    hasTime,
    suspect: (opts && opts.suspect) || 'both',
    black: sideAggregate(steps, 'B', hasTime, params),
    white: sideAggregate(steps, 'W', hasTime, params),
  };
}

// ---------- stats helpers ----------
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Higher input -> higher sub-score. Guarded so a learned lo/hi pair can never divide by
// zero or invert: an inverted ramp would silently score a suspicious game as clean.
function rampUp(v, lo, hi) {
  if (!(hi > lo)) return v >= hi ? 1 : 0;
  return clamp((v - lo) / (hi - lo), 0, 1);
}
// Lower input -> higher sub-score (loss, out-of-top5 rate).
function rampDown(v, lo, hi) {
  if (!(hi > lo)) return v <= lo ? 1 : 0;
  return clamp((hi - v) / (hi - lo), 0, 1);
}

// ---------- 0.3.3 risk parameters ----------
// The 0.3.1 constants, kept here as the fallback so the detector runs with no learner at
// all. storage.js holds the canonical copy (DEFAULT_WEIGHTS / DEFAULT_THRESHOLDS) that the
// learner and the viewer read; this literal is what a run uses before anyone ever pressed
// 重新学习, and the two are the same numbers.
//
// 0.4.2 §2.3 adds the last two. They are a SURCHARGE on top of the six, not a slice of them:
// 0.4.2's acceptance criteria require a risk score that does not move when neither signal
// fires (§2.6 #6, §五 #5), and making room by scaling the six down to 0.90 — the arithmetic
// §2.3 sketches — would multiply EVERY existing score by ~0.9 and flip games sitting on the
// 70 cut from 高风险 to 可疑. So the six keep the values that sum to 1, the two add on top,
// and sideAggregate() clamps the total at 100. learn.js normalises the two groups separately
// for the same reason.
const BASE_WEIGHTS = {
  top1: 0.20, acpl: 0.08, sharp: 0.22, out: 0.27, desperate: 0.08, time: 0.15,
  evasion: 0.06, winBlunder: 0.04,
};
const BASE_THRESHOLDS = {
  top1Lo: 0.72, top1Hi: 0.90,
  acplLo: 0.003, acplHi: 0.015,
  sharpHitLo: 0.65, sharpHitSpan: 0.35,
  outTop5Hi: 0.03,
  riskHigh: 70, riskMid: 40,
  simWeight: 0.10,
  // 0.4.2 §4.3: the evasion thresholds. Same mechanism as the rest — learn.js merges its own
  // copy key by key, and only for keys it knows — so all five are learnable. The defaults are
  // the ones §2.3 documents.
  evasionLoss: 0.20,    // "a blunder": win rate this hand gave up
  goodLoss: 0.05,       // "a good hand": ceiling for the two hands either side of it
  evasionMin: 3,        // fewest evasions before the rhythm score means anything
  evasionReg: 0.35,     // stddev / mean ceiling for "a regular rhythm"
  winningWR: 0.85,      // "winning" for the 将胜乱下 signal
};

// Resolve learnedParams into the two objects sideAggregate consumes. Unknown or
// non-numeric fields are ignored rather than trusted: a hand-edited storage entry must not
// be able to turn a weight into NaN and blank out the whole risk score.
function riskParams(params) {
  const w = Object.assign({}, BASE_WEIGHTS);
  const t = Object.assign({}, BASE_THRESHOLDS);
  if (params) {
    const pw = params.weights, pt = params.thresholds;
    if (pw) for (const k in w) if (isFinite(pw[k])) w[k] = pw[k];
    if (pt) for (const k in t) if (isFinite(pt[k])) t[k] = pt[k];
  }
  return { w, t };
}

// 0.3.3 §3.5: the detector reads learnedParams on every run. Guarded so app.js stays usable
// where storage.js is absent (a bare Node harness): the detector then uses the compiled-in
// defaults, which is the pre-0.3.3 behaviour.
async function loadLearnedParams() {
  try {
    if (typeof GMStorage !== 'undefined' && GMStorage && GMStorage.loadLearnedParams) {
      return await GMStorage.loadLearnedParams();
    }
  } catch (e) { /* a corrupt blob must not stop a detection run */ }
  return null;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = avg(xs), my = avg(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (!dx || !dy) return 0;
  return num / Math.sqrt(dx * dy);
}

// ---------- main analysis ----------
// Persistent engine singleton (shared between analyzeGame and on-demand AI think overlay).
let _sharedEng = null;
async function getEngine() {
  if (_sharedEng && _sharedEng.ready) return _sharedEng;
  _sharedEng = new Engine();
  await _sharedEng.init();
  return _sharedEng;
}

// Same resolution the old script had, kept as the meaning of threadNum === 0 ("自动"):
// half the cores, capped at MAX_THREADS (0.3.7 §二.1 — a 32-thread host defaults to 16, where
// the old `1..4` clamp would have handed it 4). Half rather than all because the engine is
// only one of the things running — the offscreen document, the page and the OS still need
// cores, and oversubscribing a `shared: true` memory pool costs more than it buys.
//
// `GMStorage.detectedThreads()` in storage.js is the SAME formula for the settings UI; the
// offscreen document does not load storage.js, so the two cannot share code. Keep them equal.
function defaultThreadNum() {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return clamp(Math.floor(hc / 2), 1, MAX_THREADS);
}

function resolveThreadNum(setting) {
  const n = parseInt(setting, 10);
  if (!isFinite(n) || n <= 0) return defaultThreadNum();
  return clamp(n, 1, MAX_THREADS);
}

// Engine status for the panel: which build loaded and whether multi-threading is live.
function engineInfo() {
  if (!_sharedEng || !_sharedEng.ready) {
    return { build: null, threads: false, threadNum: 0, degraded: false, reason: '', loaded: false };
  }
  const info = _sharedEng.info();
  info.loaded = true;
  return info;
}

async function warmEngine() {
  const eng = await getEngine();
  return eng.info();
}

async function analyzeGame(record, opts, onProgress) {
  const suspect = opts.suspect || 'both'; // 'both' | 'B' | 'W'
  onProgress && onProgress(0, i18nErr('progress.loading'));
  const eng = await getEngine();
  eng.configure({
    rule: opts.rule,
    thinkMs: opts.thinkMs,
    threadNum: opts.threadNum,
  });
  // 0.3.3 §3.5: read the learned parameters once per run. `opts.learned === undefined` means
  // "ask storage"; an explicit null forces the defaults (used by tests that must not be at
  // the mercy of whatever is in the profile).
  const learned = (opts.learned !== undefined) ? opts.learned : await loadLearnedParams();
  onProgress && onProgress(5, i18nErr('progress.ready'));

  // Pause hook: opts.pauseCtrl = { paused: bool, _resume: fn|null }
  const pauseCtrl = opts.pauseCtrl || { paused: false };
  const awaitIfPaused = async () => {
    if (!pauseCtrl.paused) return;
    await new Promise(resolve => { pauseCtrl._resume = resolve; });
    pauseCtrl._resume = null;
  };

  const moves = record.moves;
  const sources = record.sources || moves.map(() => 'player');
  const steps = [];
  const N = moves.length;
  // count player moves by side (ai-suggest doesn't consume turn)
  const playerIdxByMove = [];
  let playerCount = 0;
  for (let i = 0; i < N; i++) {
    playerIdxByMove.push(playerCount);
    if (sources[i] !== 'ai-suggest') playerCount++;
  }
  const analyzedTotal = moves.filter((_, i) => {
    const side = sideFromStone(record, i) || ((playerIdxByMove[i] % 2 === 0) ? 'B' : 'W');
    return scorable(sources[i]) && (suspect === 'both' || side === suspect);
  }).length;
  let analyzedDone = 0;

  // 0.3.4: the running position for the live-four test. Every slot goes in — a prejoin or
  // ai-suggest stone occupies the board even though it is not scored, and leaving it out
  // would break a four that runs through it.
  const boardStones = [];

  for (let i = 0; i < N; i++) {
    const side = sideFromStone(record, i) || ((playerIdxByMove[i] % 2 === 0) ? 'B' : 'W');
    const actual = moves[i];
    const source = sources[i] || 'player';
    const moveNo = source === 'ai-suggest' ? null : playerIdxByMove[i] + 1;
    boardStones.push({ x: actual[0], y: actual[1], side: side });
    const step = {
      i, moveNo, side, source,
      actual, actualStr: coordToShare(actual),
      isOpening: playerIdxByMove[i] < opts.openingCutoff,
      thinkMs: record.times[i] != null ? record.times[i] : null,
      analyzed: true,
      orderKnown: scorable(source),
    };
    const needEngine = scorable(source) && (suspect === 'both' || side === suspect);
    if (needEngine) {
      if (opts.shouldAbort && opts.shouldAbort()) throw new Error('__aborted__');
      const prefix = moves.slice(0, i);
      const res = await eng.analyzePosition(prefix, 5);
      scoreStep(step, res, actual);
      step.budgetMs = opts.thinkMs;
      // 0.3.4 活四停止: a real live four in the position after this hand ends the game, so
      // the rest carries no signal. The terminal step IS the last hand analysed.
      applyTerminal(step, opts, boardStones);
      analyzedDone++;
      onProgress && onProgress(5 + 90 * analyzedDone / analyzedTotal,
        i18nErr(side === 'B' ? 'progress.step.black' : 'progress.step.white',
                { i: playerIdxByMove[i] + 1, n: playerCount }));
      await awaitIfPaused();
    } else {
      step.analyzed = false;
      step.best = null; step.bestStr = '—';
      step.cands = []; step.candStrs = [];
      step.top1 = step.top3 = step.top5 = false;
      step.outsideTop5 = false;
      step.bestWR = step.actualWR = step.loss = null;
      step.isSharp = false;
    }
    if (step.terminal) { steps.push(step); break; }
    steps.push(step);
  }

  markDesperate(steps);
  // 0.4.2 §2.3: same pass as the stepwise path, for the same reason — and before buildReport,
  // which is where sideAggregate() reads the flags.
  markEvasion(steps, riskParams(learned).t);

  // 0.3.3 C: mark steps whose fingerprint matches a human-confirmed AI move. Done here, on
  // the finished step array, because the match is a post-processing pass over verdicts — it
  // never influences the engine, only the risk score's auxiliary `sim` term.
  if (learned && learned.features && learned.features.length &&
      typeof GMLearn !== 'undefined' && GMLearn && GMLearn.matchFeatures) {
    GMLearn.matchFeatures(steps, learned.features, learned.simThreshold);
  }

  onProgress && onProgress(98, i18nErr('progress.risk'));
  const report = buildReport(steps, record, Object.assign({}, opts, { learned: learned }));
  onProgress && onProgress(100, i18nErr('progress.done'));
  return report;
}

function sideAggregate(steps, side, hasTime, params) {
  const { w, t } = riskParams(params);
  // 0.4.2 §2.3: an evasion hand is excluded from the main statistics. That exclusion IS the
  // signal: a deliberately bad move would otherwise dilute the very percentages (Top-1 /
  // ACPL / Top5-外) it is meant to be evidence about — the operator would see a "human-like"
  // ACPL produced by the smoke screen rather than by the play. The two evasion terms below
  // are what carries that evidence instead, so nothing is lost.
  const s = steps.filter(x => x.side === side && !x.isOpening && x.analyzed &&
                              !x.forcedDefense && !x.evasion);
  if (!s.length) return null;
  const n = s.length;
  const top1 = avg(s.map(x => x.top1 ? 1 : 0));
  const top3 = avg(s.map(x => x.top3 ? 1 : 0));
  const top5 = avg(s.map(x => x.top5 ? 1 : 0));
  const losses = s.map(x => x.loss).filter(v => v != null);
  const meanLoss = avg(losses);
  const sharp = s.filter(x => x.isSharp);
  const sharpHit = sharp.length ? avg(sharp.map(x => x.top1 ? 1 : 0)) : null;
  const outTop5 = avg(s.map(x => x.outsideTop5 ? 1 : 0));
  const desperateCount = s.filter(x => x.desperate).length;
  // Counted over the side's whole sequence (evasions included, since an evasion is one of
  // them) — see evasionStats. Zero on every hand ⇒ both new terms below are exactly 0.
  const ev = evasionStats(steps, side, t);

  let time = null;
  if (hasTime) {
    const tm = s.map(x => x.thinkMs).filter(v => v != null);
    if (tm.length >= 3) {
      const meanT = avg(tm);
      const stdT = Math.sqrt(avg(tm.map(v => (v - meanT) ** 2)));
      const withinMean = avg(s.map(x => (x.thinkMs != null && Math.abs(x.thinkMs - meanT) < meanT * 0.2) ? 1 : 0));
      const corrLoss = pearson(s.map(x => x.thinkMs || 0), s.map(x => x.loss || 0));
      const corrSharp = pearson(s.map(x => x.thinkMs || 0), s.map(x => x.isSharp ? 1 : 0));
      time = { meanT, stdT, withinMean, corrLoss, corrSharp };
    }
  }

  const aTop1 = rampUp(top1, t.top1Lo, t.top1Hi);
  const aAcpl = rampDown(meanLoss, t.acplLo, t.acplHi);
  const aSharp = sharp.length >= 3 ? clamp((sharpHit - t.sharpHitLo) / Math.max(0.05, t.sharpHitSpan), 0, 1) : 0.5;
  const aOut = rampDown(outTop5, 0, t.outTop5Hi);
  const aDesperate = clamp(desperateCount / 3, 0, 1); // >=3 desperate flags -> max
  let aTime = 0.5;
  if (time) {
    const flat = clamp(1 - time.stdT / (time.meanT + 1), 0, 1);
    const uncorr = clamp(1 - Math.abs(time.corrLoss), 0, 1);
    aTime = 0.6 * flat + 0.4 * uncorr;
  }
  // 0.4.2 §2.3: the two evasion sub-scores. Both are exactly 0 when the side has no evasion
  // hands and no 将胜乱下 hands — which is what keeps an ordinary game's risk score identical
  // to 0.4.1's (§2.6 #6). `aEvasion` is half "how many" and half "how regular": a single
  // blunder between two good hands is worth something, but a rhythm of them is worth more.
  // A term reaches full weight at 5 evasions and a perfectly even rhythm.
  const aEvasion = clamp(ev.count / 5, 0, 1) * 0.5 +
                   ev.regularity * clamp(ev.count / 4, 0, 1) * 0.5;
  const aWinBlunder = clamp(ev.winBlunders / 3, 0, 1);
  // 0.3.3 C: the feature library's similarity match. Only present once 重新学习 has built a
  // library; it then claims `simWeight` of the score and the six base terms are scaled down
  // proportionally, so an unlearned run is bit-identical to 0.3.1. `aiSimilar` is set by
  // GMLearn.matchFeatures() before this runs.
  const hasLib = !!(params && params.features && params.features.length);
  const simCount = hasLib ? s.filter(x => x.aiSimilar).length : 0;
  const aSim = hasLib ? clamp(simCount / n, 0, 1) : 0;
  const simW = hasLib ? clamp(t.simWeight != null ? t.simWeight : 0.10, 0, 0.5) : 0;
  const wEff = {};
  for (const k in w) wEff[k] = w[k] * (1 - simW);
  // The six 0.3.1 terms plus simW still sum to 1; the two evasion terms are a surcharge on
  // top of that (see BASE_WEIGHTS), so the total may exceed 1 and is clamped. With no evasion
  // the surcharge is 0 and this is arithmetically the 0.4.1 expression.
  const risk = clamp(100 * (wEff.top1 * aTop1 + wEff.acpl * aAcpl + wEff.sharp * aSharp + wEff.out * aOut
                    + wEff.desperate * aDesperate + wEff.time * aTime + simW * aSim
                    + wEff.evasion * aEvasion + wEff.winBlunder * aWinBlunder), 0, 100);
  const level = risk >= t.riskHigh ? '高风险' : (risk >= t.riskMid ? '可疑' : '低风险');
  return {
    side, n, top1, top3, top5, meanLoss, sharpHit, outTop5, desperateCount,
    sharpCount: sharp.length, time, simCount,
    // 0.4.2 §二. n / top1 / meanLoss above deliberately do NOT include these hands; these
    // three fields are the only place they are counted.
    evasionCount: ev.count, evasionRegularity: ev.regularity, winBlunderCount: ev.winBlunders,
    contributions: {
      top1: wEff.top1 * aTop1 * 100, acpl: wEff.acpl * aAcpl * 100, sharp: wEff.sharp * aSharp * 100,
      out: wEff.out * aOut * 100, desperate: wEff.desperate * aDesperate * 100, time: wEff.time * aTime * 100,
      sim: simW * aSim * 100,
      evasion: wEff.evasion * aEvasion * 100, winBlunder: wEff.winBlunder * aWinBlunder * 100,
    },
    risk, level,
  };
}

function buildReport(steps, record, opts) {
  const hasTime = (record.times || []).some(v => v != null);
  const suspect = (opts && opts.suspect) || 'both';
  // 0.3.3: the learned parameters (or null) that produced this report's risk numbers.
  const params = (opts && opts.learned) || null;
  const black = sideAggregate(steps, 'B', hasTime, params);
  const white = sideAggregate(steps, 'W', hasTime, params);
  const flagged = steps.filter(x =>
    x.analyzed && x.orderKnown !== false && !x.isOpening &&
    (x.outsideTop5 || (x.isSharp && !x.top1) || (x.loss != null && x.loss > 0.12) || x.desperate)
  );
  const prejoinCount = steps.filter(x => isPrejoin(x.source)).length;
  // A capture that produced two moves of the same colour in a row means the record is
  // wrong somewhere, and every verdict built on it is suspect. Surfaced, not hidden.
  const issues = orderIssues(record);
  // 0.3.1 活四停止: scan the steps for the one that ended detection. Only the first such
  // step matters — once a live four appears the rest of the game was not analysed. The
  // reported moveNo is the hand at which we stopped.
  let terminal = null;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].terminal) { terminal = { moveNo: steps[i].moveNo, reason: steps[i].stopReason }; break; }
  }
  // Which engine actually produced these verdicts. A report analysed on the single-threaded
  // fallback is not comparable with one analysed on the pthread build, and the operator has
  // no other way to tell them apart once the archive is written.
  const eng = engineInfo();
  const originalTotalMoves = (record.moves || []).length;
  return {
    createdAt: new Date().toISOString(),
    opts, hasTime, suspect,
    engine: { build: eng.build, threads: eng.threads, threadNum: eng.threadNum, degraded: eng.degraded },
    // totalMoves is the real move count, including the pre-join stones: the board is
    // complete. scoredCount is how many of them actually carry a verdict. When detection
    // stopped on a live four, totalMoves is only the hands we actually scored — the board
    // may have more — and originalTotalMoves is the true game length for that case.
    totalMoves: steps.length,
    originalTotalMoves,
    scoredCount: steps.filter(x => x.analyzed).length,
    prejoinCount,
    orderKnown: prejoinCount === 0,
    orderSuspect: issues.length > 0,
    orderIssues: issues.slice(0, 12),
    terminal,
    // 'win' | 'draw' | 'unknown'. A draw is a finished game with no winner; kept in the
    // report so the viewer and the archive name do not have to guess from a null winner.
    outcome: (record.meta && record.meta.outcome) || 'unknown',
    forcedCount: steps.filter(x => x.forcedDefense).length,
    // 0.3.3: which parameter set produced these verdicts. Without it a learned run and a
    // default run are indistinguishable once archived — the same trap the engine row solves
    // for the multi-threaded / single-threaded builds.
    learned: params ? {
      trainedAt: params.trainedAt || null,
      sampleCount: params.sampleCount || 0,
      featureCount: (params.features || []).length,
    } : null,
    steps, black, white, flagged,
  };
}

// Node test hook (no-op in browser)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseRecord, coordToShare, evalNum, SIZE,
    analyzeGame, analyzeStepwise, analyzeStep, scoreStep, stepBudget, summarizeSteps,
    buildReport, markDesperate, sideAggregate, sideFromStone, orderIssues,
    // 0.4.2 §二: the evasion pass and its per-side figures, exported so the unit tests can
    // drive the two thresholds directly instead of only through a full analysis.
    markEvasion, evasionStats,
    getEngine, defaultThreadNum, resolveThreadNum, engineInfo, warmEngine,
    // 0.3.4 活四：导出形状识别与判定，供单元测试直接驱动（不再依赖引擎胜率）
    liveFourHolder, applyTerminal, boardFromCoords, scanThreats,
    // 0.3.3 risk-model plumbing, exported so the learner and the tests can reason about the
    // exact numbers the detector uses.
    riskParams, rampUp, rampDown, loadLearnedParams, BASE_WEIGHTS, BASE_THRESHOLDS,
    ENGINE_BUILDS, MAX_THREADS,
  };
}
