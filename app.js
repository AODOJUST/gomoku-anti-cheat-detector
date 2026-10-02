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
// 0.5.4 §4.1.2 — the mapping itself lives in `storage.js` (see the note there). It moved because
// the OVERLAY needs `coordToShare` for 复制棋谱代码 and a content script does not load this file,
// while storage.js is loaded by all three realms. These two names are kept — app.js is where
// they have always been called from, and `module.exports` at the bottom still offers them.
//
// ⚠ The inline fallback is deliberate and is the 0.5.0 precedent (learn.js / viewer.js each keep
// a `typeof` fallback for `isExemptUnique`): the test suites `require` this file on its own —
// `t-data047` requires app.js BEFORE storage.js — so `GMStorage` really can be absent at the
// moment the first call arrives. It is one expression, and `verify-057` proves the two agree
// over all 225 points rather than trusting the comment.
function shareToCoord(token) {
  // "h8" -> {x:7, y:7}  (x:0=left 'a', y:0=top -> number = SIZE - y)
  if (typeof GMStorage !== 'undefined' && GMStorage && GMStorage.shareToCoord) {
    return GMStorage.shareToCoord(token);
  }
  const m = token.match(/([a-z])(\d+)/i);
  if (!m) return null;
  const x = m[1].toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0);
  const y = SIZE - parseInt(m[2], 10);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  return [x, y];
}
function coordToShare(p) {
  if (typeof GMStorage !== 'undefined' && GMStorage && GMStorage.coordToShare) {
    return GMStorage.coordToShare(p);
  }
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
// 0.5.1 §2.1.2 — the build list, the engine ids and the protocol names live in engines.js now, so
// that describing a second engine does not mean a second copy of Rapfi's details. They are NOT
// repeated here: a fallback literal would be the fourth time this project shipped two spellings
// of one answer, and the copy that is never run is always the one that rots. When the registry is
// absent — a bare unit test that required this file alone — the list comes back empty and
// `init()` says so by name, instead of failing somewhere less obvious.
//
// Build preference order, unchanged: the multi-threaded builds first (same engine, plus a pthread
// pool, ~7x the nodes/sec of the single build on a 32-core box — multi @1 thread: 218K nps,
// @8 threads: 1662K nps), with the single builds as the fallback for browsers where
// SharedArrayBuffer is unavailable.
function engineRegistry() {
  return (typeof GMEngines !== 'undefined' && GMEngines) ? GMEngines : null;
}
function rapfiBuilds() {
  const reg = engineRegistry();
  const list = reg && reg.RAPFI_BUILDS;
  return (list && list.length) ? list.slice() : [];
}

// GTP/SGF column letters — 'I' is skipped. The constant is the full 19-letter GTP alphabet
// (A..T, no I); a 15x15 board only ever uses its first fifteen, A..P, and the range checks below
// are what enforce that. Rapfi's `COL` above is the share-string alphabet (lowercase, no skip) and
// is NOT interchangeable with this one: using it would shift every column past H by one and
// produce coordinates that are wrong rather than absent. Both directions are total: an
// out-of-range or unparsable token returns null, and the caller decides whether that is fatal.
const GTP_COL = 'ABCDEFGHJKLMNOPQRST';
function toGtpCoord(p) {
  if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
  const x = p[0], y = p[1];
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
  return GTP_COL.charAt(x) + (SIZE - y);
}
function fromGtpCoord(s) {
  const t = String(s == null ? '' : s).trim().toUpperCase();
  if (!t || t === 'PASS') return null;
  const x = GTP_COL.indexOf(t.charAt(0));
  // `x >= SIZE` as well as `x < 0`: the alphabet runs to T, so 'Q1'..'T1' index 15..18 and used to
  // come back as a legal-looking [15,14]. A row check alone cannot catch it — the y it produces is
  // on the board — so a server answering a 19x19 board (or a typo) handed this file a coordinate
  // outside its own grid, and every board lookup after it read an unrelated cell. `toGtpCoord`
  // already refused the same values, which is what made this a broken mirror rather than a bug.
  if (x < 0 || x >= SIZE) return null;
  // Digits only. `parseInt` stops at the first non-digit, so 'H8x' parsed as row 8 and 'H8 ' (or
  // 'H8abc') was accepted as a coordinate — the "unparsable token returns null" promise above
  // needs the whole token, not its prefix.
  if (!/^\d+$/.test(t.slice(1))) return null;
  const row = parseInt(t.slice(1), 10);
  if (!isFinite(row)) return null;
  const y = SIZE - row;
  if (y < 0 || y >= SIZE) return null;
  return [x, y];
}

// 0/1/2 is the numeric rule the whole pipeline carries (`ruleCode()` in content.js). KataGomo's
// `kata-set-rule` names the same three, so the only thing that has to stay in step is this table.
const KATAGO_RULES = { 0: 'freestyle', 1: 'standard', 2: 'renju' };
function katagoRuleName(rule) {
  return KATAGO_RULES[rule] || 'freestyle';
}

// Request ids only have to be unique enough for a server that correlates them. `Date.now()` alone
// collides for every request inside the same millisecond, and a server that de-duplicates by id
// would then answer the second position with the first one's verdict — silently, and about a
// board that was never analysed.
let _katagoSeq = 0;

// ---------- the KataGo analysis-JSON wire format (0.5.1 §2.1.3) ----------
//
// This is the request the KataGo analysis engine itself parses (`katago analysis`, one JSON
// object per line on stdin), so an operator can put KataGomo behind any wrapper that forwards
// the body — including the REST server that already exists for KataGo and passes every analysis
// option through. Colours are paired with coordinates rather than implied by position: the native
// format allows `initialStones` and handicaps, and guessing the colour of move i from its index
// is a rule this codebase already has too many copies of.
//
// The response renames nothing that matters: `moveInfos[].move` is the native field and
// `moveCoord` is what one popular wrapper calls it, so both are accepted. `winrate`/`scoreLead`
// are from the side to move's perspective in both engines, so neither is flipped.
function buildKatagoRequest(prefixMoves, opts) {
  const o = opts || {};
  const moves = [];
  for (let i = 0; i < prefixMoves.length; i++) {
    const c = toGtpCoord(prefixMoves[i]);
    // Loud on purpose. Dropping a coordinate would silently replay a different game, and every
    // verdict after it would be about a position that was never played.
    if (!c) throw new Error(i18nErr('engine.badCoord', { i: i + 1 }));
    moves.push([i % 2 === 0 ? 'B' : 'W', c]);
  }
  const q = {
    id: 'bs-' + Date.now() + '-' + (++_katagoSeq),
    moves,
    rules: katagoRuleName(o.rule),
    komi: 0,
    boardXSize: SIZE,
    boardYSize: SIZE,
    includePolicy: false,
    includeOwnership: false,
  };
  // A visit count cannot be derived from a millisecond budget without knowing the machine; the
  // server does know it, and `maxTime` is a field it already honours. The liveness probe asks
  // for one visit instead, because it is asking "does this answer at all", not "how strong is it".
  if (o.maxVisits) q.maxVisits = o.maxVisits;
  else q.maxTime = Math.max(1, Math.min(600, Math.round((o.thinkMs || 2000) / 1000)));
  return q;
}

function parseKatagoResponse(text) {
  let data = text;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  const infos = Array.isArray(data.moveInfos) ? data.moveInfos : [];
  const cands = [];
  infos.forEach((mi) => {
    if (!mi) return;
    const move = fromGtpCoord(mi.moveCoord != null ? mi.moveCoord : mi.move);
    if (!move) return;
    const winrate = parseFloat(mi.winrate);
    const lead = parseFloat(mi.scoreLead);
    const pv = Array.isArray(mi.pv) ? mi.pv.map(fromGtpCoord).filter(Boolean) : [];
    cands.push({
      move,
      winrate: isFinite(winrate) ? winrate : null,
      // `eval` keeps the codebase's unit-free string convention (evalNum() parses it). scoreLead
      // is KataGo's nearest equivalent to Rapfi's EVAL, and falling back to the win rate keeps
      // the ordering meaningful for a server that reports only win rates.
      eval: isFinite(lead) ? String(lead) : (isFinite(winrate) ? String(winrate) : '0'),
      // Rapfi's convention, which the rest of the file relies on: bestline[0] IS this candidate's
      // own move. A server that omits `pv` still gets a one-move line rather than an empty one,
      // because `_searchRapfi` filters out candidates whose bestline is empty.
      bestline: pv.length && eqCoord(pv[0], move) ? pv : [move].concat(pv),
    });
  });
  if (!cands.length) return null;
  // Same order the Rapfi path produces (scoreStep reads cands[0] as the best candidate), and the
  // same truncation to at most NBEST_EXTENDED — done here rather than by asking the server,
  // because a request field the server might not know is a worse bet than discarding work we
  // already paid for.
  cands.sort((a, b) => evalNum(b.eval) - evalNum(a.eval));
  return { best: cands[0].move, candidates: cands.slice(0, NBEST_EXTENDED) };
}

// ---------- GTP transcript (0.5.1 §2.1.3) ----------
// Built for a local GTP WASM engine. Nothing registers one today (see engines.js), and the suite
// drives these two through a stub worker so the transcript and the parser are covered anyway —
// an untested branch is how a "two spellings" defect survives a release.
//
// `info` lines are the LeelaZero/KataGo analysis format. Each analysis group is introduced by the
// `info` keyword, and one line can carry several: `info move H8 visits 9 … info move J8 visits 4 …`.
// Splitting on `info` is safe because no GTP coordinate can begin with 'I' — the alphabet skips it
// — so the token can never be a value we care about. Splitting on the `move` keyword instead is
// what a first pass did, and it glued the NEXT group's `info` onto this group's `pv`.
function parseGtpInfoLine(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s || !/^info\b/.test(s)) return [];
  const out = [];
  s.split(/\binfo\b/).forEach((raw) => {
    const part = raw.trim().replace(/^move\s+/, '');
    if (!part) return;
    const toks = part.split(/\s+/);
    const rec = { move: toks[0], winrate: null, scoreMean: null, pv: [] };
    let inPv = false;
    for (let i = 1; i < toks.length; i++) {
      const k = toks[i];
      if (k === 'pv') { inPv = true; continue; }
      if (inPv) { rec.pv.push(k); continue; }
      const v = toks[i + 1];
      if (v === undefined) break;
      if (k === 'winrate') rec.winrate = parseFloat(v);
      else if (k === 'scoreMean') rec.scoreMean = parseFloat(v);
      i++;                       // consumed the value
    }
    out.push(rec);
  });
  return out;
}

// A record's optional numeric field, read as a NUMBER or NaN. `isFinite(null)` is TRUE in
// JavaScript — `Number(null)` is 0 — so the obvious `isFinite(r.scoreMean) ? … : …` took the
// "present" branch for a field that `parseGtpInfoLine` had left as null, and produced
// `eval: 'null'`. Every candidate then carried the string 'null' as its evaluation, so the sort
// had nothing to sort by and the "best" move was whichever one the server happened to list first.
// (`parseKatagoResponse` is safe by accident, not by design: it feeds `parseFloat` results, which
// give NaN rather than null. This normalises the two paths onto the same answer.)
function gtpNum(v) {
  if (v == null || v === '') return NaN;
  return parseFloat(v);
}

function gtpCandidates(recs, board) {
  const cands = [];
  recs.forEach((r) => {
    const move = fromGtpCoord(r.move);
    if (!move) return;
    const pv = r.pv.map(fromGtpCoord).filter(Boolean);
    const wr = gtpNum(r.winrate), sm = gtpNum(r.scoreMean);
    cands.push({
      move,
      winrate: isFinite(wr) ? wr : null,
      eval: isFinite(sm) ? String(sm) : (isFinite(wr) ? String(wr) : '0'),
      bestline: pv.length && eqCoord(pv[0], move) ? pv : [move].concat(pv),
    });
  });
  if (!cands.length) return null;
  cands.sort((a, b) => evalNum(b.eval) - evalNum(a.eval));
  return { best: cands[0].move, candidates: cands.slice(0, NBEST_EXTENDED) };
}

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
// 0.5.1 §2.1.4 — how long the HTTP liveness probe may take. Short on purpose: it is the gate the
// fallback chain has to get through, and a chain that waits a minute per dead candidate is worse
// than the failure it is covering.
const HTTP_PROBE_MS = 8000;

class Engine {
  // 0.5.1 §2.1.2 — an engine is now identified, not assumed. `engineId` is resolved against the
  // registry once, here, so `protocol` is a property of the instance and the dispatch below is a
  // plain switch rather than a string comparison repeated at every call site.
  constructor(engineId) {
    const reg = engineRegistry();
    this.engineId = engineId || (reg && reg.DEFAULT_ID) || 'rapfi';
    this.config = (reg && reg.get ? reg.get(this.engineId) : null)
      || { id: this.engineId, name: this.engineId, kind: 'wasm', protocol: 'yxboard' };
    this.protocol = this.config.protocol;
    this.kind = this.config.kind;
    this.worker = null;
    this.ready = false;
    this.threads = false;        // the build that won is a pthread build
    this.build = null;           // which file won, or the server address for an http engine
    this.threadNum = 1;          // the number actually handed to the engine
    this.thinkMs = 2000;         // last TIMEOUT_TURN, used to scale the silence watchdog
    this.noThreads = false;      // the environment refused a shared WebAssembly.Memory
    this.fallbackReason = '';
    // 0.5.1 §2.2 — for a custom weight package: the blob URL worker.js answers `locateFile`
    // with. Created in init() (an extension-page job — IndexedDB is not reachable from a content
    // script) and owned here, because only this object knows when its worker is replaced.
    this.dataURL = '';
    // 0.5.1 §2.2.5 — the fallback this instance was created by, if any. It lives ON THE ENGINE
    // rather than in a module-level variable, which is the 0.4.9 lesson reapplied: a module
    // variable and the engine it describes have different lifetimes. As a module variable it was
    // never cleared, so ONE failed custom-model verification (whose chain steps down to Rapfi)
    // made every later analysis in that session report 「已回退」 even after the operator fixed
    // the model and a fresh engine loaded cleanly.
    this.fallback = null;
  }
  onStatus = () => {};

  async init() {
    if (this.kind === 'http') return this._initHttp();
    return this._initWasm();
  }

  _revokeData() {
    if (!this.dataURL) return;
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      try { URL.revokeObjectURL(this.dataURL); } catch (e) { /* already gone */ }
    }
    this.dataURL = '';
  }

  async _initWasm() {
    const builds = (this.config.builds && this.config.builds.length) ? this.config.builds : rapfiBuilds();
    if (!builds.length) throw new Error(i18nErr('engine.noBuilds'));
    // A custom engine is a WEIGHT PACKAGE on top of the packaged build: the JS still comes from
    // the extension, only the `.data` request is answered differently. Resolving the blob here
    // rather than inside the worker is what keeps the CSP question out of the engine — the worker
    // never imports anything but `engine/rapfi-….js`, which `'self'` already allows.
    if (this.config.custom && this.config.dataId && typeof GMCustomEngines !== 'undefined' && GMCustomEngines) {
      try {
        this.dataURL = await GMCustomEngines.blobUrl(this.config.dataId);
      } catch (e) { this.dataURL = ''; }
      if (!this.dataURL) {
        const err = new Error(i18nErr('custom.missing'));
        err.reason = 'custom-missing';
        this.onStatus('custom weight package unavailable: ' + this.config.dataId);
        throw err;
      }
    }
    for (const url of builds) {
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
    this._revokeData();
    throw new Error('All engine builds failed to load.');
  }

  // §2.1.4's fallback chain has to be able to tell "unreachable server" from "slow server", and
  // the only honest probe is the one §2.2.3 uses one level down: ask it for a position. A GET on
  // a health path would be cheaper, but the operator's wrapper may not have one, and a missing
  // path would then read as a dead engine.
  async _initHttp() {
    if (!this.config.url) throw new Error(i18nErr('engine.noUrl'));
    const res = await this._searchHttp([], 1, HTTP_PROBE_MS, { maxVisits: 1 });
    if (!res || !res.candidates || !res.candidates.length) throw new Error(i18nErr('engine.noAnswer'));
    this.ready = true;
    this.build = this.config.url;
    this.threads = false;        // no build, no pthread pool — the panel says so rather than lying
    this.threadNum = 0;
    return this.config.url;
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
      // `dataURL` is empty for a packaged engine, in which case worker.js answers `locateFile`
      // with the file the build ships. It is one string either way, so the message shape does
      // not branch on whether the engine is custom.
      w.postMessage({ type: 'engineScriptURL', data: { engineURL: url, dataURL: this.dataURL || '' } });
    });
  }

  send(cmd) { this.worker.postMessage({ type: 'command', data: cmd }); }

  // Replaces the multi-threaded worker with a single-threaded one, once, after the pthread
  // build has proved it cannot search here. Kept on the instance so `info()` (and therefore
  // the panel, the report and the archive) tells the truth about what produced the verdicts.
  async downgrade(why) {
    const singles = rapfiBuilds().filter((u) => !/-multi/.test(u));
    if (!singles.length) throw new Error(i18nErr('engine.noBuilds'));
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
    this.thinkMs = thinkMs;          // the silence watchdog is scaled from this
    if (this.kind === 'http') {
      // Nothing to send. The wire format carries the budget on every request (see _searchHttp),
      // and a thread count would be a claim about somebody else's machine — so the panel is told
      // 0 and renders no thread line rather than an invented one.
      this.threadNum = 0;
      return;
    }
    // A single-threaded build ignores INFO THREAD_NUM, and reporting a thread count the
    // engine is not using would be a lie in the panel.
    this.threadNum = this.threads ? resolveThreadNum(threadNum) : 1;
    if (this.protocol === 'gtp') { this._configureGTP({ rule }); return; }
    this._configureRapfi({ rule, thinkMs });
  }

  _configureRapfi(args) {
    const { rule = 0, thinkMs = 2000 } = args;
    this.send('START ' + SIZE);
    this.send('INFO RULE ' + rule);
    this.send('INFO THREAD_NUM ' + this.threadNum);
    this.send('INFO HASH_SIZE 131072');
    this.send('INFO SHOW_DETAIL 3');
    this.send('INFO MAX_DEPTH 100');
    this.send('INFO TIMEOUT_TURN ' + thinkMs);
    this.send('INFO TIME_LEFT 99999999');
  }

  // KataGomo is a KataGo fork, so the command set is KataGo's plus the gomoku extensions —
  // `kata-set-rule` is the one our own rule setting has to be translated into (0/1/2 →
  // freestyle / standard / renju). `komi 0` because gomoku is win-or-lose: a komi the other
  // engine does not use would make the two evaluations incomparable, and this file's flags
  // compare win rates across engines when the operator switches one mid-archive.
  _configureGTP(args) {
    const { rule = 0 } = args;
    this.send('boardsize ' + SIZE);
    this.send('kata-set-board-size ' + SIZE);
    this.send('clear_board');
    this.send('komi 0');
    this.send('kata-set-rule ' + katagoRuleName(rule));
  }

  info() {
    const cfg = this.config || {};
    return {
      id: this.engineId,
      name: cfg.name || this.engineId,
      kind: this.kind,
      // Which server produced these verdicts. Stored in the archive alongside the build name:
      // a report analysed against a different model is not comparable with this machine's, and
      // the operator has no other way to tell the two apart six months later.
      url: this.kind === 'http' ? (this.build || cfg.url || '') : '',
      custom: !!cfg.custom,
      build: this.build,
      threads: this.threads,
      threadNum: this.threadNum,
      degraded: !this.threads && this.kind !== 'http',
      reason: this.fallbackReason,
      // Travels with the engine, so "did we have to step down to get here" cannot outlive the
      // engine it is about (see the constructor).
      fallback: this.fallback,
    };
  }

  // How long the engine may stay completely silent before we call it dead. A search that
  // is actually running prints INFO/PV lines continuously, and even a done-by-deadline
  // search answers within TIMEOUT_TURN — so silence past this is never a slow search.
  silenceLimit() {
    return Math.max(SILENCE_FLOOR, (this.thinkMs || 2000) * 4 + 4000);
  }

  // Analyse position after `prefix` moves. Returns {best, candidates:[{move,eval,winrate,bestline}]}
  //
  // 0.5.1 §2.1.3 — dispatch by protocol. Only the Rapfi branch has the pthread downgrade: that
  // recovery exists because a `shared: true` pool can fail to start, which is a property of the
  // WASM bridge and means nothing to an HTTP server or to a GTP build.
  async analyzePosition(prefixMoves, nbest = 5, timeoutMs, opts) {
    if (this.kind === 'http') return this._searchHttp(prefixMoves, nbest, timeoutMs, opts);
    if (this.protocol === 'gtp') return this._searchGTP(prefixMoves, nbest, timeoutMs);
    try {
      return await this._searchRapfi(prefixMoves, nbest, timeoutMs);
    } catch (e) {
      // Never seeing the search progress means the pthread pool never started — there is
      // nothing to salvage on this build. Swap in the single-threaded one and redo the same
      // call: it is both faster and more honest than reporting a failed analysis, and it is
      // what the panel's "引擎降级为单线程模式" line exists for.
      if (e && e.noProgress && this.threads) {
        await this.downgrade(e.message);
        return await this._searchRapfi(prefixMoves, nbest, timeoutMs);
      }
      throw e;
    }
  }

  _searchRapfi(prefixMoves, nbest, timeoutMs) {
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

  // GTP over the worker's stdin/stdout. Nothing registers a GTP engine today (see engines.js for
  // why KataGomo cannot be one), but the transcript is a pure function of the position and the
  // response format is a documented one, so both halves get covered by the suite against a stub
  // worker — an untested branch is precisely how a "two spellings of one answer" defect survives
  // a release, and this file has shipped three of those.
  //
  // Replay mirrors `_searchRapfi`'s watchdog: any byte re-arms the silence timer, but only an
  // analysis or result line counts as progress, because the engine's startup chatter arrives
  // either way and would otherwise mask a dead process.
  _searchGTP(prefixMoves, nbest, timeoutMs) {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      let recs = [];
      let done = false;
      let sawProgress = false;
      let silenceTimer = null;

      const fail = (msg) => {
        if (done) return;
        done = true;
        clearTimeout(hardTimer);
        clearTimeout(silenceTimer);
        worker.onmessage = null;
        reject(new Error(msg));
      };
      const armSilence = () => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => fail(i18nErr('engine.poolDown',
          { sec: Math.round(this.silenceLimit() / 1000) })), this.silenceLimit());
      };
      const finish = (body) => {
        if (done) return;
        done = true;
        clearTimeout(hardTimer);
        clearTimeout(silenceTimer);
        worker.onmessage = null;
        const pm = /^play\s+(\S+)/i.exec(body);
        const last = fromGtpCoord(pm ? pm[1] : body);
        const res = gtpCandidates(recs, null);
        if (res) {
          if (last) res.best = last;
          resolve(res);
          return;
        }
        // A server (or build) that answers with the move but prints no `info` lines still told
        // us something useful. Inventing a candidate list instead would be worse than one entry.
        if (!last) { reject(new Error(i18nErr('engine.badResponse'))); return; }
        resolve({ best: last, candidates: [{ move: last, winrate: null, eval: '0', bestline: [last] }] });
      };

      const hardTimer = setTimeout(() => fail('analysis timeout'), timeoutMs || HARD_TIMEOUT);
      armSilence();

      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type !== 'stdout') return;
        armSilence();
        const out = String(m.data == null ? '' : m.data);
        if (!out) return;
        // GTP is line- and prefix-oriented: '=' success, '?' failure, and a bare '=' ends a
        // multi-line response.
        if (out.charAt(0) === '?') { fail(out.slice(1).trim() || i18nErr('engine.gtpFailed')); return; }
        if (/^info\b/.test(out)) {
          sawProgress = true;
          recs = recs.concat(parseGtpInfoLine(out));
          return;
        }
        const body = (out.charAt(0) === '=' ? out.slice(1) : out).trim();
        if (!body) { if (/^info\b/.test(out)) sawProgress = true; return; }
        sawProgress = true;
        finish(body);
      };

      for (let i = 0; i < prefixMoves.length; i++) {
        const c = toGtpCoord(prefixMoves[i]);
        if (!c) { fail(i18nErr('engine.badCoord', { i: i + 1 })); return; }
        this.send('play ' + (i % 2 === 0 ? 'B' : 'W') + ' ' + c);
      }
      const side = prefixMoves.length % 2 === 0 ? 'B' : 'W';
      // Interval in centiseconds: the same wall-clock budget the Rapfi path spends, so the two
      // engines produce comparable verdicts for the same `thinkMs`.
      const interval = Math.max(1, Math.round((this.thinkMs || 2000) / 10));
      this.send('kata-genmove_analyze ' + side + ' ' + interval);
    });
  }

  // HTTP, forwarded through the service worker (the extension's only network exit — a content
  // script's `fetch` is bound to the PAGE's origin and would be a cross-origin request the
  // operator's server answers without CORS headers). The body and the parser are the module-level
  // pure functions above, so the suite can check the wire format without a network.
  _searchHttp(prefixMoves, nbest, timeoutMs, opts) {
    const o = opts || {};
    if (!this.config.url) return Promise.reject(new Error(i18nErr('engine.noUrl')));
    let body;
    try {
      body = buildKatagoRequest(prefixMoves, {
        rule: this._lastArgs ? this._lastArgs.rule : 0,
        thinkMs: this.thinkMs,
        maxVisits: o.maxVisits,
      });
    } catch (e) { return Promise.reject(e); }
    return sendEngineHttp(this.config.url, body, timeoutMs || HARD_TIMEOUT).then((text) => {
      const res = parseKatagoResponse(text);
      if (!res) throw new Error(i18nErr('engine.badResponse'));
      return res;
    });
  }
}

// The one place this file talks to the network, and it does not do the talking itself: the
// service worker owns the request implementation (same arrangement as GMLLM.call). A rejection
// carries the server's own message when there is one, because that is what §2.2.3's "验证失败时
// 显示明确错误" has to show the operator.
function sendEngineHttp(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      reject(new Error(i18nErr('engine.noBridge')));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(i18nErr('engine.httpTimeout', { sec: Math.round((timeoutMs || 0) / 1000) })));
    }, (timeoutMs || HARD_TIMEOUT) + 1000);
    chrome.runtime.sendMessage(
      { type: 'gm-engine-http', url, body, timeoutMs },
      (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) { reject(new Error(err.message || String(err))); return; }
        if (!resp) { reject(new Error(i18nErr('engine.noAnswer'))); return; }
        if (!resp.ok) { reject(new Error(resp.error || i18nErr('engine.httpFailed'))); return; }
        resolve(resp.text);
      }
    );
  });
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

// ---------- 0.4.7 §1.4 Top8 扩展 ----------
// How many candidates to ask the engine for. The default stays five — that is what every
// previous release used, and the four thresholds and the whole segment geometry are built on
// Top5 agreement. Above §1.4's 6-second mark the engine is being given long enough that its
// sixth-to-eighth choices are worth recording, so the request widens.
//
// This is deliberately a FUNCTION of the budget rather than a constant, and both analysis
// paths call it: a record whose hands carry no timing at all (`thinkMs == null`) keeps the
// old five-candidate behaviour, which is the majority of archives and the reason the change
// is safe to make.
//
// `YXNBEST` accepts any count, so nothing else has to change to ask for eight.
const NBEST_DEFAULT = 5;
const NBEST_EXTENDED = 8;
const THINK_MS_EXTENDED = 6000;
function nbestFor(thinkMs) {
  return (thinkMs != null && thinkMs > THINK_MS_EXTENDED) ? NBEST_EXTENDED : NBEST_DEFAULT;
}

// Fills best / top1..top5 / loss / isSharp / forcedDefense from one engine result.
//
// 0.4.8 §1.1: `board` / `prevBoard` / `budgetMs` are optional and exist for the shape-first
// forced-defence test below. A caller that passes none of them gets exactly the pre-0.4.8
// behaviour (engine-only test at the 0.15 gap) — which is what keeps an old harness that
// calls scoreStep(step, res, actual) scoring as it always did.
function scoreStep(step, res, actual, board, prevBoard, budgetMs) {
  const cands = res.candidates || [];
  const best = res.best;
  const bestCand = cands[0] || {};
  const bestWR = bestCand.winrate != null ? bestCand.winrate : null;
  const actualCand = cands.find(c => eqCoord(c.move, actual));
  step.best = best;
  step.bestStr = best ? coordToShare(best) : '—';
  // 0.4.7 §1.4: the stored/displayed candidate list is eight long, not five, because a hand
  // with >6s of recorded thinking was analysed with `YXNBEST 8` and the sixth-to-eighth
  // candidates are real evidence about it. `top5`/`top8` below are what the analysis reads;
  // `cands` is what the table and the archive carry, and it has to be at least as long as the
  // deepest flag or the viewer would show a hand as Top6-8 with no candidate to point at.
  step.cands = cands.slice(0, 8);
  step.candStrs = cands.slice(0, 8).map(c => coordToShare(c.move) + '(' + (c.winrate != null ? (c.winrate * 100).toFixed(0) + '%' : '?') + ')');
  step.top1 = !!(eqCoord(actual, best) || (actualCand && cands.indexOf(actualCand) === 0));
  step.top3 = cands.slice(0, 3).some(c => eqCoord(c.move, actual));
  step.top5 = cands.slice(0, 5).some(c => eqCoord(c.move, actual));
  // 0.4.7 §1.4. Only ever true when the caller asked for eight candidates (see nbestFor) —
  // on a 5-candidate result `cands.slice(0,8)` is just the same five, so this cannot fire by
  // accident and a Top5 hand is never relabelled as Top8.
  step.top8 = cands.slice(0, 8).some(c => eqCoord(c.move, actual));
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
  // 0.4.8 §1.1: the engine-only test under-reports in the live path. `step.top1` requires
  // `eqCoord(actual, best)` and a four's two blocking points are frequently symmetric, so the
  // engine returns one of them and the operator plays the other — the hand is a forced defence
  // and reads as `top1 = false`. At the live budget (2000ms) the candidate list is also short
  // enough that the top-2 win rate is unreliable, so `gap` is understated across the board.
  // The gap cut therefore moves with the budget, and the shape test below is the real fix: a
  // hand that was the ONLY blocking point is a forced defence by the rules of the board, with
  // no reference to what the engine happened to return.
  const gapThreshold = (budgetMs != null && budgetMs <= 2000) ? 0.12 : 0.15;
  const engForced = !!(bestWR != null && gap >= gapThreshold && step.top1);
  const shape = forcedDefenseByShape(board, step.side, actual, prevBoard);
  step.forcedDefense = engForced || !!(shape && shape.forced);
  step.forcedDefenseHow = (shape && shape.forced) ? 'shape' : (engForced ? 'engine' : null);
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

// ---------- 0.4.8 §1.1 冲四豁免：形状优先 ----------
// The engine-only test (`gap >= 0.15 && top1`) misses a forced defence in the live path for
// four separate reasons, and the spec names the last one as the main cause: a four's blocking
// points are often SYMMETRIC, so the engine returns one and the operator plays the other, and
// `top1` — which is `eqCoord(actual, best)` — then reads false on a hand that had no
// alternative. None of that has anything to do with what the board allows, so the uniqueness
// of the defence is decided from the board instead.
//
// (0.5.0 §1.1 added a second shape reader beside this one — `classifyFour` — for the four's
// FORM rather than its uniqueness. They answer different questions and the file keeps both.)
//
// `uniqueBlocksForFour(board, side)` enumerates every empty point that, once `side` plays
// there, removes the OPPONENT's four. That set IS the side's set of legal defences against
// the four: a point that does not answer it leaves the four standing. Exactly one such point,
// equal to the move actually played, is a forced defence by definition — no threshold, no
// engine, nothing to jitter.
function uniqueBlocksForFour(board, side) {
  if (!board || !board.length || (side !== 'B' && side !== 'W')) return [];
  const opp = side === 'B' ? 'W' : 'B';
  const occ = {};
  for (let i = 0; i < board.length; i++) {
    const s = board[i];
    if (!s || s.x == null || s.y == null) continue;
    occ[s.x + ',' + s.y] = s.side;
  }
  const out = [];
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (occ[x + ',' + y]) continue;
      const nb = board.concat([{ x: x, y: y, side: side }]);
      const t = scanThreats(nb);
      // `!t` means the pushed position cannot be reasoned about at all (scanThreats refuses
      // below three known stones). Treating that as "this point blocks" would hand back every
      // empty square as a defence and the `length === 1` test below would then never fire —
      // the conservative direction, which is the right one for a verdict of "forced".
      if (!t || !t[opp].four) out.push([x, y]);
    }
  }
  return out;
}

// `prevBoard` is the position BEFORE the hand being judged: the four we are answering must
// already be on the board, otherwise there is nothing to be forced by. Returns null when the
// caller supplied no board (a bare harness), which leaves the engine verdict in charge.
function forcedDefenseByShape(board, side, actual, prevBoard) {
  if (!prevBoard) return null;
  if (!actual || actual[0] == null || actual[1] == null) return null;
  const opp = side === 'B' ? 'W' : 'B';
  const t = scanThreats(prevBoard);
  if (!t || !t[opp] || !t[opp].four) return null;
  const unique = uniqueBlocksForFour(prevBoard, side);
  if (unique.length === 1 && unique[0][0] === actual[0] && unique[0][1] === actual[1]) {
    return { forced: true, reason: 'shape-unique-block' };
  }
  return { forced: false, reason: unique.length ? 'shape-multi-block' : 'shape-none' };
}

// ---------- 0.5.0 §1.1 四的形态：真四 / 跳四 / 双四 ----------
// `scanThreats` answers "is there a four" — a 5-cell window holding exactly 4 own stones and 1
// empty one. That test cannot tell `XXXX_` from `XX_XX` from `X_XXX`: all three are "4 own + 1
// empty" and all three would make five at one point. §1.1 is the consequence — `applyTerminal`
// read a 跳四 as half of a 四三杀 and truncated the record.
//
// The property that separates them is the four's SHAPE, and the cheapest way to state it is
// from the other end: enumerate the points at which this side would complete a five.
//   · 0 points  — there is no four at all;
//   · 1 point   — the defender has exactly one legal answer, so the four is FORCING;
//   · 2+ points — no single answer exists (a live four, or two fours), so it is not "a four
//                 plus something else", it is already a win.
// Inside the 1-point case the shapes still differ: when the four stones are CONTIGUOUS
// (`XXXX_`) the five point sits at an END of the line, and when they are not (`X_XXX`,
// `XX_XX`, `XXX_X`) it sits INSIDE it. §1.1 calls the first 真四 and the second 跳四, and only
// the first may be read as half of a 四三杀.
//
// This is a SECOND question, not a second spelling of `uniqueBlocksForFour`. That one asks
// "which of my moves leave the opponent with no four at all" — so a live four answers "none",
// which verify-048 pins. This one asks "where could the opponent make five". The two agree
// only while the opponent has a single four; both are needed and neither replaces the other.
function fivePointsFor(board, side) {
  if (!board || !board.length || (side !== 'B' && side !== 'W')) return [];
  const own = {}, occ = {};
  for (let i = 0; i < board.length; i++) {
    const s = board[i];
    if (!s || s.x == null || s.y == null) continue;
    occ[s.x + ',' + s.y] = true;
    if (s.side === side) own[s.x + ',' + s.y] = true;
  }
  const pts = [];
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (occ[x + ',' + y]) continue;
      if (fiveAt(own, x, y)) pts.push([x, y]);
    }
  }
  return pts;
}

// Would one more own stone at (px,py) make five? `o` is that stone's index inside the 5-cell
// window, so the window's start slides with it and every alignment through the point is tried.
// A window only counts when all five of its cells are own stones — an empty cell or an
// opponent's stone anywhere in it means this is not a five. `own` alone is enough: a cell that
// is not own is either the new point (counted) or a blocker.
function fiveAt(own, px, py) {
  for (let d = 0; d < FOUR_DIRS.length; d++) {
    const dx = FOUR_DIRS[d][0], dy = FOUR_DIRS[d][1];
    for (let o = 0; o < 5; o++) {
      const sx = px - dx * o, sy = py - dy * o;
      let cells = 0, ok = true;
      for (let i = 0; i < 5; i++) {
        const cx = sx + dx * i, cy = sy + dy * i;
        if (cx < 0 || cx >= SIZE || cy < 0 || cy >= SIZE) { ok = false; break; }
        if (cx === px && cy === py) { cells++; continue; }
        if (own[cx + ',' + cy]) cells++;
      }
      if (ok && cells === 5) return true;
    }
  }
  return false;
}

// Is the four completed at `p` a CONTIGUOUS run? Asked directly, as the question it is: does a
// 5-cell window exist in which `p` sits at one END and the other four cells are all own? A jump
// four has no such window — its empty point is always strictly between the stones.
//
// The spec's sketch inferred this from "does the five point have three neighbours of one colour
// in some direction", which is the wrong test: in `X_XXX` the three stones to the RIGHT of the
// hole are a run of three and a neighbour count would call it contiguous. The window edge is
// the fact; the neighbour count is a symptom of it.
function fourIsSolid(board, side, p) {
  const own = {};
  for (let i = 0; i < board.length; i++) {
    const s = board[i];
    if (s && s.side === side && s.x != null && s.y != null) own[s.x + ',' + s.y] = true;
  }
  for (let d = 0; d < FOUR_DIRS.length; d++) {
    const dx = FOUR_DIRS[d][0], dy = FOUR_DIRS[d][1];
    for (let e = 0; e < 2; e++) {
      const o = e === 0 ? 0 : 4;                    // the five point at either end
      const sx = p[0] - dx * o, sy = p[1] - dy * o;
      let ok = true;
      for (let i = 0; i < 5; i++) {
        const cx = sx + dx * i, cy = sy + dy * i;
        if (cx < 0 || cx >= SIZE || cy < 0 || cy >= SIZE) { ok = false; break; }
        if (cx === p[0] && cy === p[1]) continue;
        if (!own[cx + ',' + cy]) { ok = false; break; }
      }
      if (ok) return true;
    }
  }
  return false;
}

// `{kind, points}` or null. `doubleFour` is §1.1's name for "two or more five points", which
// covers both a true double four and an open four — either way no single defence exists, which
// is the only thing the caller does with the answer.
function classifyFour(board, side) {
  const pts = fivePointsFor(board, side);
  if (!pts.length) return null;
  if (pts.length >= 2) return { kind: 'doubleFour', points: pts };
  return { kind: fourIsSolid(board, side, pts[0]) ? 'solidFour' : 'jumpFour', points: pts };
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
//
// 0.4.8 §1.3 splits the pass in two. The SHAPE half is synchronous and unchanged. The
// four-three half gains a counter check, because a four-three is not always a kill: if the
// defender's blocking point is itself a four (a 反四), the attacker must answer it and the
// open three never becomes a live four — the game continues, and stopping there threw away
// the rest of the record. The check only runs where a four-three was actually detected, so
// the common case pays nothing for it.
function applyTerminalShape(step, board) {
  const t = scanThreats(board);
  if (!t) return null;
  const me = (step.side === 'B' || step.side === 'W') ? step.side : null;
  const you = me === 'B' ? 'W' : (me === 'W' ? 'B' : null);

  // 0.5.0 §1.1 — "four AND open three" was the whole test, and `scanThreats` cannot tell a 真四
  // from a 跳四. A 跳四 + 活三 is NOT a kill: the four's only answer sits INSIDE the four, which
  // is exactly where one stone can also answer the open three, and the defender may equally
  // have a counter-four. Only a solid or double four is read as half of a 四三杀; a jump four
  // is merely RECORDED (`jumpFourOnly`, which the async half turns into `step.jumpFourFlag`).
  //
  // Measuring conservatively is the deliberate direction (§0.3.4): a missed early stop costs
  // engine time, whereas a false one invents a result and truncates the record.
  //
  // `openThree` is also the gate on the classification, because a four without a three is not a
  // kill and is not reported by anything here — which keeps the per-hand cost of the new
  // enumeration at zero on the overwhelming majority of positions.
  const kindOf = (s) => (s && t[s].four && t[s].openThree) ? classifyFour(board, s) : null;
  const kills = (f) => !!f && (f.kind === 'solidFour' || f.kind === 'doubleFour');
  const myKind = kindOf(me), yourKind = kindOf(you);

  if (kills(myKind)) return { kind: 'fourThree', attacker: me };
  if (kills(yourKind)) return { kind: 'fourThree', attacker: you };
  if (me && t[me].liveFour) return { kind: 'liveFour', attacker: me };
  if (me && t[you].liveFour) return { kind: 'liveFour', attacker: you };
  // Checked AFTER the live four: a position that holds a real live four is over regardless of
  // which side owns the jump four, and the wording must say so.
  if (myKind) return { kind: 'jumpFourOnly', attacker: me };
  if (yourKind) return { kind: 'jumpFourOnly', attacker: you };
  if (!me) {
    // The colour of the side to move is unknown (rare, but a record with no authoritative
    // `stones` can reach here). The shapes are still hard evidence, so stop anyway and
    // report the holder rather than guessing a direction. `attacker: null` carries that
    // "unknown" through to the wording — and the SAME classification decides whether a four
    // is a kill, so a 跳四 does not stop the game here either.
    if (['B', 'W'].some((s) => kills(kindOf(s)))) return { kind: 'fourThree', attacker: null };
    if (['B', 'W'].some((s) => t[s].liveFour)) return { kind: 'liveFour', attacker: null };
  }
  return null;
}

// Does the defender, in answering the four, form a four of their own? `blkBlocks` is exactly
// the set of squares that answer the attacker's four, so a four formed at one of them is a
// counter-four and the four-three is not a kill. Pure shape work — the name says "engine" in
// the spec's prose but the given implementation never calls one; the async wrapper is kept so
// that stays true if a future revision does.
async function checkFourThreeCounter(board, attackerSide) {
  const defender = attackerSide === 'B' ? 'W' : (attackerSide === 'W' ? 'B' : null);
  if (!defender) return { counter: false, reason: 'unknown-side' };
  const blocks = uniqueBlocksForFour(board, defender);
  if (!blocks.length) return { counter: false, reason: 'no-block' };
  for (let i = 0; i < blocks.length; i++) {
    const x = blocks[i][0], y = blocks[i][1];
    const nb = board.concat([{ x: x, y: y, side: defender }]);
    const t = scanThreats(nb);
    if (t && t[defender] && t[defender].four) {
      return { counter: true, block: [x, y], reason: 'defender-forms-four' };
    }
  }
  return { counter: false, reason: 'no-counter' };
}

async function applyTerminal(step, opts, board) {
  if (!step) return false;
  const shape = applyTerminalShape(step, board);
  if (!shape) return false;

  if (shape.kind === 'liveFour') {
    step.terminal = true;
    step.stopReason = shape.attacker === null ? '任一方形成活四，检测停止'
      : (shape.attacker === step.side ? '当前方形成活四，对手必败' : '对手形成活四，当前方必败');
    return true;
  }

  // 0.5.0 §1.1 — 跳四 + 活三. Detection CONTINUES (return false, no stopReason): the hand is
  // recorded so the operator can see why a four that looks like a kill did not end the game,
  // which is otherwise indistinguishable from a detection that simply missed it.
  if (shape.kind === 'jumpFourOnly') {
    step.jumpFourFlag = true;
    step.terminal = false;
    return false;
  }

  // fourThree. An unknown colour cannot be checked against a defender, so it keeps the old
  // stop — the shape is still hard evidence and guessing a direction would be worse.
  if (shape.attacker === null) {
    step.terminal = true;
    step.stopReason = '任一方形成四三杀，检测停止';
    return true;
  }
  let chk;
  try {
    chk = await checkFourThreeCounter(board, shape.attacker);
  } catch (e) {
    // Conservative fallback (§1.3 边界): a check that cannot be run must not be allowed to end
    // the game. Detection simply continues, and the note says why.
    step.fourThreeCounter = { counter: false, reason: 'check-failed' };
    step.terminal = false;
    step.stopCheckFailed = true;
    return false;
  }
  if (chk.counter) {
    step.fourThreeCounter = chk;
    step.terminal = false;
    return false;
  }
  step.fourThreeCounter = chk;
  step.terminal = true;
  step.stopReason = shape.attacker === step.side
    ? '当前方形成四三杀，对手必败'
    : '对手形成四三杀，当前方必败';
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
  // literally the same set of hands being moved out of it. A forced defence is already exempt
  // (§2.4: a hand that had no alternative cannot be a deliberate smoke screen) — through
  // `isExemptUnique()`, so this file has ONE spelling of that rule and not five — and the
  // opening is excluded because there is no "previous hand of my own" yet.
  const own = { B: [], W: [] };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s.analyzed || s.isOpening || isExemptUnique(s)) continue;
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

// ---------- 0.4.7 §1.1 连续无用冲四 ----------
// A "four run" is >=2 of the SAME SIDE's consecutive hands, each of which left that side
// holding a four. Read along the side's own sequence (the opponent's intervening hands are
// skipped), so "consecutive" means consecutive HANDS OF THAT PLAYER, which is what a forcing
// sequence actually is.
//
// The classification is by `prevBestWR`: the win rate the engine gave the best move in the
// position BEFORE the run started. §1.1 is explicit that this is "序列第一步之前" and not the
// first hand's own `bestWR` — a four that is already on the board has moved the win rate, so
// reading the run's own first value would relabel exactly the case being looked for. That is
// why `analyzeGame` / `analyzeStepwise` record `prevBestWR` per step (see recordPrevBestWR).
//
//   vcf        bestWR >= 0.90 : the run is the conversion. Normal, and evidence of strength.
//   useless    bestWR <= 0.10 : a lost player firing fours that change nothing. This is the
//                               one that raises the risk score.
//   defensive  in between     : the outcome is undecided. Counted and reported, not scored.
//
// A single four is not a run: §1.1's acceptance criterion 4 says so, and a lone four is how
// most games end. Both bounds are read from the thresholds object so they stay learnable.
const FOUR_RUN_MIN = 2;
const VCF_WR = 0.90;
const LOST_WR = 0.10;

function markFourRuns(steps, thresholds) {
  const t = thresholds || BASE_THRESHOLDS;
  const vcfWR = t.fourVcfWR != null ? t.fourVcfWR : VCF_WR;
  const lostWR = t.fourLostWR != null ? t.fourLostWR : LOST_WR;
  for (let i = 0; i < steps.length; i++) {
    // Reset first, unconditionally: this is a post-processing pass that runs again on the same
    // array during a live session (like markEvasion), and a stale flag left behind would keep
    // scoring a hand after the run it belonged to was re-derived.
    steps[i].fourRun = 0;
    steps[i].fourKind = null;
  }
  for (const side of ['B', 'W']) {
    const own = [];
    steps.forEach((s, i) => {
      if (s.side === side && s.analyzed && !s.isOpening) own.push({ s: s, i: i });
    });
    let k = 0;
    while (k < own.length) {
      if (!own[k].s.four) { k++; continue; }
      const start = k;
      while (k + 1 < own.length && own[k + 1].s.four) k++;
      const end = k;
      const runLen = end - start + 1;
      if (runLen >= FOUR_RUN_MIN) {
        const first = own[start].s;
        // `prevBestWR` when the analysis recorded one; falling back to the step's own bestWR
        // rather than to null, so a record analysed before 0.4.7 still classifies — it just
        // classifies with the value that was available, which is what the hand knows.
        const wr = first.prevBestWR != null ? first.prevBestWR : first.bestWR;
        let kind;
        if (wr != null && wr >= vcfWR) kind = 'vcf';
        else if (wr != null && wr <= lostWR) kind = 'useless';
        else kind = 'defensive';
        for (let j = start; j <= end; j++) {
          own[j].s.fourRun = runLen;
          own[j].s.fourKind = kind;
        }
      }
      k++;
    }
  }
  return steps;
}

// ---------- 0.4.7 §1.1: the win rate of the position BEFORE each hand ----------
// `markFourRuns` classifies a run of fours by the value the engine gave the best move before
// the run began, so every analysed step has to carry "what the best move was worth one of MY
// hands ago". Two things make this per-SIDE and not per-row: gomoku alternates strictly, so
// the opponent's intervening hand has already changed the position and its own `bestWR` is
// about a different player; and a run is defined along one side's own sequence.
//
// `i` is the side's OWN hand index (0-based), which is what makes this robust to a mid-game
// join or an ai-suggest stone sitting in the middle of the record: the two are skipped, so the
// numbering is still "my first analysed hand, my second, …".
function recordPrevBestWR(steps) {
  const last = { B: null, W: null };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.side !== 'B' && s.side !== 'W') continue;
    if (!s.analyzed) continue;
    // Explicitly null rather than left undefined: `markFourRuns` reads it with `!= null`, and
    // an absent field and a null one mean the same thing to it — but only one of them survives
    // a JSON round trip through storage, and only one of them is honest about "not recorded".
    s.prevBestWR = last[s.side];
    if (s.bestWR != null) last[s.side] = s.bestWR;
  }
  return steps;
}

// The per-side evasion figures §2.3 scores. Split out of sideAggregate so the two things it
// returns can be read separately — the COUNT (how often) and the REGULARITY (how evenly
// spaced), which mean different things: a player who blunders once may have simply blundered,
// while three of them at a fixed interval is a rhythm.
function evasionStats(steps, side, thresholds) {
  const t = thresholds || BASE_THRESHOLDS;
  const own = steps.filter(x => x.side === side && x.analyzed && !x.isOpening && !isExemptUnique(x));
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
  // 0.4.8 §1.1: the position before this hand, for the shape-first forced-defence test. `board`
  // is the position AFTER the hand (what applyTerminal reads); slicing off the last stone gives
  // the position the hand was answering, which is where the four it may have been forced to
  // block has to already exist.
  const bd = board || boardFromCoords(allMoves);
  const prevBoard = bd.slice(0, -1);
  // 0.4.5 §三 — 开局排除 skips the ENGINE, not the shape test. This early return is what
  // makes the live-stepwise path cheap: content.js still calls analyzeStep for every hand,
  // but the first N per side return here without a single engine call. applyTerminal MUST
  // still run (0.4.5 §3.4): a live four formed inside the opening is rare but real, and
  // dropping the test here would let the detector run straight past it.
  if (step.isOpening) {
    step.analyzed = false;
    step.best = null; step.bestStr = '—';
    step.cands = []; step.candStrs = [];
    step.top1 = step.top3 = step.top5 = step.top8 = false;
    step.outsideTop5 = false;
    step.bestWR = step.actualWR = step.loss = null;
    step.isSharp = false;
    step.forcedDefense = false;
    step.forcedDefenseHow = null;
    await applyTerminal(step, opts, bd);
    return step;
  }
  eng.configure({ rule: opts.rule, thinkMs: budgetMs, threadNum: opts.threadNum });
  // 0.4.7 §1.4: the RECORDED interval decides how deep a candidate list this hand gets, not the
  // engine budget. The budget is clamped (min 2s, capped by the panel setting), so a hand the
  // player actually thought 9s about would be analysed at 2s and never widen; the recorded
  // interval is the human's real thinking time and is exactly what §1.4's "思考时间 > 6000ms"
  // means. `recordedMs` is null on a hand with no timing, and nbestFor() then returns five.
  const res = await eng.analyzePosition(allMoves.slice(0, -1), nbestFor(recordedMs));
  scoreStep(step, res, actual, bd, prevBoard, budgetMs);
  // 0.3.4 活四停止: shape test on the position AFTER this hand, so the offscreen live
  // session still ends on a real live four (doStep sets live.ended) — but not on the
  // opening, where the old win-rate proxy used to fire.
  await applyTerminal(step, opts, bd);
  return step;
}

// 逐步分析: one engine call per move, in play order, at the per-step time budget.
async function analyzeStepwise(record, opts, onProgress, onStep) {
  onProgress && onProgress(0, i18nErr('progress.loading'));
  const eng = await getEngine(opts.engineId);
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
    // 0.4.5 §三 — 开局排除 belongs here as well as in the aggregation. Without it the first N
    // hands per side were analysed by the engine and then thrown away by sideAggregate()'s
    // `!x.isOpening` filter: openingCutoff = 8 wasted 16 engine calls per game.
    const isOpening = playerIdxByMove[i] < opts.openingCutoff;
    need.push(scorable(sources[i]) && !isOpening && (suspect === 'both' || side === suspect));
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
        top1: false, top3: false, top5: false, top8: false, outsideTop5: false,
        bestWR: null, actualWR: null, loss: null, isSharp: false, forcedDefense: false,
        forcedDefenseHow: null,
      };
      // 0.4.5 §三/§3.4 — the step we just stopped analysing as an opening hand is exactly the
      // step that still has to be shape-tested. Only for scorable hands: a prejoin or
      // ai-suggest stone keeps its old behaviour, because its `side` may be a parity guess and
      // a shape verdict built on a guessed colour is worse than no verdict.
      if (playerIdxByMove[i] < opts.openingCutoff && scorable(sources[i])) {
        await applyTerminal(un, opts, boardStones.slice());
      }
      steps.push(un);
      if (un.terminal) { onStep && onStep(un); break; }
    }
    onStep && onStep(steps[steps.length - 1]);
  }

  markDesperate(steps);
  // 0.4.2 §2.3: the evasion pass, right after markDesperate and before anything aggregates —
  // sideAggregate() drops the hands this flags, so it must have run by then.
  markEvasion(steps, riskParams(learned).t);
  // 0.4.7 §1.1: the four-run pass and the value it classifies with. Both run AFTER the two
  // passes above so a hand that is an evasion is still visible as one, and BEFORE buildReport,
  // which is where sideAggregate() counts `fourKind === 'useless'`.
  recordPrevBestWR(steps);
  markFourRuns(steps, riskParams(learned).t);
  // 0.5.2 §1.1/§1.2: the two pool passes, after the four-run pass for the same reason it runs
  // after markEvasion — a hand's 冲四豁免 verdict has to be settled before markGoodPool decides
  // whether the hand joins the run, and the live-three flags read `cands`/`top1`/`top3`, which
  // are final by now. Both are idempotent, so re-running them over a partially analysed list is
  // safe (the live summary does exactly that).
  markPoolSignals(steps);
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
  // 0.4.7 §1.1: the four-run pass is part of the score now, so the live summary has to run it
  // too — same reason as the line above. Both are idempotent (they reset their own fields).
  recordPrevBestWR(steps);
  markFourRuns(steps, riskParams(params).t);
  // 0.5.2 §1.1/§1.2 — same two passes as the finished report, same reason as the two above: the
  // live score has to equal the score the game ends with. Both reset their own fields, so they
  // are safe to re-run on every update.
  markPoolSignals(steps);
  // Two steps in a row by the same side cannot happen in a real game. The live session
  // only holds PLAYED moves, so an adjacency here means the capture lost one.
  let issues = 0;
  for (let i = 1; i < steps.length; i++) if (steps[i].side === steps[i - 1].side) issues++;
  const black = sideAggregate(steps, 'B', hasTime, params);
  const white = sideAggregate(steps, 'W', hasTime, params);
  // 0.4.3 §1.2/§1.5: the live summary carries the same two per-side pictures the finished
  // report does. Without them the segment lines would appear only once the game ended, and
  // the risk band would visibly change at that moment — which reads as a bug, not a feature.
  const segments = { B: segmentSide(steps, 'B'), W: segmentSide(steps, 'W') };
  const typeTh = riskParams(params).t;
  return {
    partial: true,
    totalMoves: steps.length,
    scoredCount: steps.filter(x => x.analyzed).length,
    prejoinCount: steps.filter(x => isPrejoin(x.source)).length,
    forcedCount: steps.filter(x => isExemptUnique(x)).length,
    orderSuspect: issues > 0,
    orderIssues: issues,
    hasTime,
    suspect: (opts && opts.suspect) || 'both',
    black, white,
    segments,
    types: {
      B: black ? classifySide(black.risk, segments.B, steps, 'B', typeTh) : null,
      W: white ? classifySide(white.risk, segments.W, steps, 'W', typeTh) : null,
    },
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
// 0.4.2 §2.3 added the last two. They were a SURCHARGE on top of the six, not a slice of them:
// 0.4.2's acceptance criteria require a risk score that does not move when neither signal
// fires (§2.6 #6, §五 #5), and making room by scaling the six down to 0.90 — the arithmetic
// §2.3 sketches — would multiply EVERY existing score by ~0.9 and flip games sitting on the
// 70 cut from 高风险 to 可疑. So the six kept the values that summed to 1, the two added on
// top, and sideAggregate() clamped the total at 100. learn.js normalised the two groups
// separately for the same reason. NOTE: 0.5.5 §1.3 supersedes this — see below.
// ⚠⚠ 0.5.5 §1.3 REVERSES the surcharge model that 0.4.8 and 0.5.2 both refused to give up.
//
// History: 0.4.8 §1.2 and 0.5.2 §1.1.4 each wrote a single table summing to 1.00 and each time the
// instruction was declined, because scaling the six down so a new term could take a slice out of
// them multiplies EVERY archived score (~0.87) and flips games sitting on the 70/40 cuts from
// 高风险 to 可疑 — i.e. it silently invalidates the comparability of the whole corpus. The six kept
// their sum, and every newer signal rode on top (the table summed to 1.28).
//
// 0.5.5 §1.3.2 is not that instruction reissued: it is an explicit, operator-confirmed decision
// (「权重方案 A」) that 好点池 becomes a first-class term at 0.18 — the same magnitude as 唯一手 —
// and that the difference is taken OUT of the existing terms rather than added on top. `out`
// (−0.07) and `sharp` (−0.04) carry most of it, on the stated grounds that all three describe the
// same phenomenon (did the player stay inside the engine's own recommendations) from different
// angles, and that goodPool covers the widest version of it.
//
// So the invariant this table protects is now 「the whole table sums to 1.00」 — NOT 「the six sum to
// 1.00 and everything else rides on top」. verify-048's assertion was moved with it (the property it
// was protecting was always the total, and a corpus split is exactly what that assertion exists to
// catch — which is why the reversal had to be an explicit decision rather than a silent edit).
const BASE_WEIGHTS = {
  // 0.5.5 §1.3.1 方案 A. 方案 A 的表逐项：top1 0.13 / acpl 0.06 / sharp 0.14 / out 0.15 /
  // desperate 0.05 / time 0.10 / evasion 0.04 / winBlunder 0.03 / uselessFour 0.03 /
  // sharpStreak 0.03 / sharpTotal 0.03 / goodPool 0.18 / liveThree 0.03 — 总和 1.00.
  //
  // The three keys whose MEANING is unchanged keep the notes they earned:
  //   · `uselessFour` — 0.4.7 §1.1's run of consecutive fours played from a lost position. §1.1
  //     asked for it at 0.05 while comparing it to `desperate` (then 0.08); 0.5.5's table settles
  //     both at 0.05, which is the value §1.1 named twice.
  //   · `sharpStreak` / `sharpTotal` — 0.4.8 §1.2's two 唯一手 runs.
  top1: 0.13, acpl: 0.06, sharp: 0.14, out: 0.15, desperate: 0.05, time: 0.10,
  evasion: 0.04, winBlunder: 0.03,
  uselessFour: 0.03,
  sharpStreak: 0.03,
  sharpTotal: 0.03,
  // 0.5.5 §1.1/§1.3.1 — the redefined pool, now the joint-largest single term. It is no longer a
  // surcharge: a game with no good points scores its `goodPool` 0 contribution like any other term,
  // and the difference is carried by the terms above having been scaled down.
  goodPool: 0.18,
  // §1.2 — the 活三 pool, deliberately unchanged in value and in kind.
  liveThree: 0.03,
};
const BASE_THRESHOLDS = {
  // 0.4.3 §1.1: the ramp aTop1 now reads. `top1Lo`/`top1Hi` are kept because a pre-0.4.3
  // archive and the `opts.legacyTop1` comparison path still describe themselves with them,
  // but the detector itself no longer consumes them.
  //
  // 0.4.7 §1.2 moves Lo from 0.50 down to 0.45, which is what makes the three-tier proximity
  // of stepProximity() actually pay off: with the graded mean now sitting higher for the same
  // hands, the ramp reaches its useful range sooner instead of clipping at the bottom.
  topProxLo: 0.45, topProxHi: 0.90,
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
  // 0.4.7 §1.1: the two win-rate cuts that split a run of consecutive fours into VCF /
  // 防御性 / 无用. They MUST be listed here and not only as the module-level VCF_WR / LOST_WR
  // constants used as their fallback: `markFourRuns` prefers the value on the threshold set,
  // `riskParams` merges the learned set key by key against THIS object, and storage.js's
  // DEFAULT_THRESHOLDS is merged into the same one. A key that is absent here is therefore
  // invisible to every one of those paths — the learner would report that it updated a cut it
  // never actually touched, and a hand-edited storage entry would be silently dropped. The
  // constants stay as the belt-and-braces default for a caller that passes no set at all.
  fourVcfWR: 0.90,      // at or above this, the four-run is a winning line (VCF)
  fourLostWR: 0.10,     // at or below this, it is 无用冲四 and it scores
  // 0.4.3 §1.6: the five risk bands' four cut lines, all right-open (75 is AI, 74 is 疑似AI).
  // The band a game lands in is a summary of the risk score, not a second opinion about it,
  // so these are configurable and learnable like every other cut but never feed back into the
  // score itself.
  typeAiMin: 75,
  typeSuspectMin: 55,
  typeProMin: 45,
  typeExpertMin: 30,
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
// Persistent engine singleton (shared between analyzeGame, the per-step path and the viewer's
// AI-think button).
//
// 0.5.1 §2.1.4 — the engine is now chosen, so the singleton remembers WHICH one it holds. Asking
// for a different model rebuilds the engine, because a verdict produced by a model other than the
// one on the label is the exact class of silent substitution this project keeps finding. The old
// instance is disposed rather than dropped: a Rapfi build is a 40MB data package and a pthread
// pool, and leaving one running behind every model switch would cost real memory on a real game.
let _sharedEng = null;
// The last recovery the chain had to make lives on the ENGINE instance (see its constructor), so
// that it cannot outlive the engine it describes. Every surface reads it through `engineInfo()`.
function disposeEngine(eng) {
  if (!eng) return;
  try { if (eng.worker) eng.worker.terminate(); } catch (e) { /* already gone */ }
  if (typeof eng._revokeData === 'function') eng._revokeData();
}

// Deduplicated, and pruned of candidates that cannot answer at all — an http engine with no
// address, a custom model whose package was deleted — so the operator is told the real failure
// rather than a made-up one. The preferred id is always kept: if the operator picked something
// broken, they should get that error, not a silent substitution.
//
// 0.5.1 — ONE DELIBERATE DEVIATION from the 定稿's `[id, 'katagomo', 'rapfi']`. Rapfi is added as
// the floor, but katagomo is NOT appended to a chain the operator did not ask for it in. Falling
// back from a local engine to a remote one is not a downgrade: it ships the operator's game to a
// server they did not select, over a network, possibly in another country. A recovery may cost
// more time (a weaker build, a shorter search); it may not cost more of the operator's data. So an
// http engine is only ever used when it is the chosen one — and if it fails, Rapfi answers.
function engineFallbackChain(preferredId) {
  const reg = engineRegistry();
  const want = preferredId || (reg && reg.DEFAULT_ID) || 'rapfi';
  const order = [want, 'rapfi'].filter((id, i, a) => id && a.indexOf(id) === i);
  const ok = order.filter((id) => !reg || !reg.usable || reg.usable(id));
  return ok.length ? ok : [want];
}

async function getEngine(preferredId) {
  // The early return is why the fallback record had to move onto the instance: this path hands
  // back an engine that was created by an earlier call, and whatever fallback occurred then is
  // still the truth about it. A module-level record would have been stale here (and wrong).
  if (_sharedEng && _sharedEng.ready && (!preferredId || _sharedEng.engineId === preferredId)) {
    return _sharedEng;
  }
  const chain = engineFallbackChain(preferredId);
  const wanted = chain[0];
  let lastErr = null;
  for (const id of chain) {
    try {
      const eng = new Engine(id);
      await eng.init();
      if (id !== wanted) {
        eng.fallback = {
          from: wanted,
          to: id,
          name: eng.config ? eng.config.name : id,
          error: lastErr ? String(lastErr.message || lastErr) : '',
        };
      }
      if (_sharedEng && _sharedEng !== eng) disposeEngine(_sharedEng);
      _sharedEng = eng;
      return eng;
    } catch (e) {
      lastErr = e;
      console.warn('[engine] ' + id + ' 加载失败：', e);
    }
  }
  const err = new Error(i18nErr('engine.allFailed'));
  err.lastError = lastErr;
  throw err;
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

// Engine status for the panel: which engine and build loaded, whether multi-threading is live,
// and — 0.5.1 §2.1.4/§2.2.5 — whether the fallback chain had to step down to get here.
//
// It carries the report's engine id as well as the build file, because §2.1.5 #4 asks the report
// to record which model produced the verdicts and the archive keeps this object verbatim.
function engineInfo() {
  if (!_sharedEng || !_sharedEng.ready) {
    return {
      id: null, name: null, kind: null, url: '', custom: false, build: null,
      threads: false, threadNum: 0, degraded: false, reason: '', loaded: false,
      fallback: null,
    };
  }
  const info = _sharedEng.info();
  info.loaded = true;
  return info;
}

async function warmEngine(preferredId) {
  const eng = await getEngine(preferredId);
  return eng.info();
}

async function analyzeGame(record, opts, onProgress) {
  const suspect = opts.suspect || 'both'; // 'both' | 'B' | 'W'
  onProgress && onProgress(0, i18nErr('progress.loading'));
  const eng = await getEngine(opts.engineId);
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
  // 0.4.5 §三 — the denominator has to exclude the opening hands too, or the progress bar
  // promises engine calls that are deliberately never made (and 5 + 90*done/analyzedTotal
  // would stall below 95% for the whole opening).
  const analyzedTotal = moves.filter((_, i) => {
    const side = sideFromStone(record, i) || ((playerIdxByMove[i] % 2 === 0) ? 'B' : 'W');
    const isOpening = playerIdxByMove[i] < opts.openingCutoff;
    return scorable(sources[i]) && !isOpening && (suspect === 'both' || side === suspect);
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
    const needEngine = scorable(source) && !step.isOpening &&
                       (suspect === 'both' || side === suspect);
    if (needEngine) {
      if (opts.shouldAbort && opts.shouldAbort()) throw new Error('__aborted__');
      const prefix = moves.slice(0, i);
      // 0.4.7 §1.4: same rule as the stepwise path — the recorded interval decides the width,
      // so `thinkMs > 6000` is measured on the human's clock and not on the engine budget.
      const res = await eng.analyzePosition(prefix, nbestFor(record.times[i]));
      // 0.4.8 §1.1: the board before this hand, so a forced defence is read off the shape.
      const prevBoard = boardStones.slice(0, -1);
      scoreStep(step, res, actual, boardStones, prevBoard, opts.thinkMs);
      step.budgetMs = opts.thinkMs;
      // 0.3.4 活四停止: a real live four in the position after this hand ends the game, so
      // the rest carries no signal. The terminal step IS the last hand analysed.
      await applyTerminal(step, opts, boardStones);
      analyzedDone++;
      onProgress && onProgress(5 + 90 * (analyzedTotal ? analyzedDone / analyzedTotal : 1),
        i18nErr(side === 'B' ? 'progress.step.black' : 'progress.step.white',
                { i: playerIdxByMove[i] + 1, n: playerCount }));
      await awaitIfPaused();
    } else {
      step.analyzed = false;
      step.best = null; step.bestStr = '—';
      step.cands = []; step.candStrs = [];
      step.top1 = step.top3 = step.top5 = step.top8 = false;
      step.outsideTop5 = false;
      step.bestWR = step.actualWR = step.loss = null;
      step.isSharp = false;
      step.forcedDefense = false;
      step.forcedDefenseHow = null;
      // 0.4.5 §三/§3.4 — the opening hand whose engine call we just removed is the one that
      // still has to be shape-tested. Restricted to scorable hands so prejoin / ai-suggest
      // stones keep their previous behaviour (their `side` may be a parity guess, and a shape
      // verdict built on a guessed colour is worse than no verdict).
      if (step.isOpening && scorable(source)) await applyTerminal(step, opts, boardStones);
    }
    if (step.terminal) { steps.push(step); break; }
    steps.push(step);
  }

  markDesperate(steps);
  // 0.4.2 §2.3: same pass as the stepwise path, for the same reason — and before buildReport,
  // which is where sideAggregate() reads the flags.
  markEvasion(steps, riskParams(learned).t);
  // 0.4.7 §1.1: same two steps as the stepwise path, in the same order and for the same reason.
  recordPrevBestWR(steps);
  markFourRuns(steps, riskParams(learned).t);

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

// 0.4.3 §1.1: how close this hand came to the engine's first choice, as a graded score
// rather than a yes/no. 1.0 = the top pick, 0.75 = Top2-3, 0.55 = Top4-5, 0 = further down.
//
// Why a grade replaces a binary hit: a side that keeps landing on Top2-T5 is playing just as
// much like the engine as one that lands on Top1, and the 0.3.1 model called the first case
// "no evidence at all". `aTop1`'s ramp dropped to exactly 0 below 0.72 top-1 agreement, and
// `sharpHit` counted only top-1 hits among the sharp hands — so BOTH terms collapsed together
// and a game that read 80+ slid into the 50s. Human play does not hug the engine's first few
// candidates that tightly; being one candidate off is a coordinate, not a different player.
//
// 0.4.7 §1.2 flattens the middle to a single 0.80 and adds a Top6-8 tier at 0.50. The 0.4.3
// split (0.75 / 0.55) said Top4-5 is a materially weaker signal than Top2-3; on the real
// corpus it is not — the engine's internal ordering beyond its first pick is noisy at a fixed
// time budget, and the operator's own observation was that the 0.55 tier was the single
// largest source of understated scores. Top6-8 exists only because §1.4 started ASKING for
// eight candidates when the recorded thinking time exceeded 6s; on every other hand `top8` is
// false, so this tier is unreachable and the grade is the 0.4.7 two-tier one. Reading `top8`
// is therefore safe: it is never true unless the engine was actually asked for eight.
const PROX = { top1: 1.0, top3: 0.80, top5: 0.80, top8: 0.50 };
function stepProximity(s) {
  if (s.top1) return PROX.top1;
  if (s.top5) return PROX.top5;   // Top2-5, one tier: see above
  if (s.top8) return PROX.top8;   // Top6-8, only ever set on a >6s hand (§1.4)
  return 0;
}

// ---------- 0.5.0 §1.2 唯一手豁免的边界 ----------
// The ONLY hand kept out of the main statistics is a 冲四强制应对手 — a hand whose entire
// content was answering the opponent's four.
//
// The rule was already implemented; what §1.2 asked for was for it to be STATABLE. Read as a
// bare `!x.forcedDefense` in a filter clause it looks like it might exclude every unique hand,
// and the question "does this also drop a 唯一好手 in an open position?" has no answer from the
// code. It does not, and it never did:
//
//   · `forcedDefense` is set by the board's shape test (`forcedDefenseByShape`, the only
//     blocking point and the operator played it) or by the engine's win-rate gap;
//   · both of those are tests for "there was nothing else to play";
//   · a 唯一手 that is merely the engine's favourite in an open position has neither test
//     against it, so it stays in the statistics — which is what §1.2 wants.
//
// `forcedDefenseHow` is deliberately NOT consulted. A forced defence is a fact about the board;
// 'shape' and 'engine' are two ways of NOTICING the same fact, and preferring one would make
// the exemption depend on which detector happened to fire. §1.2 offers the narrower reading as
// an option; it is not taken, and this function is the single place a future switch would live.
//
// SCOPE — this predicate is the definition for THIS FILE, and every site in it that needs the
// rule calls it (markEvasion, evasionStats, sharpStreakStats, subscoresForSide, segmentSide, and
// the two `forcedCount` diagnostics). `learn.js` and `viewer.js` carry their own copy of the
// same clause on purpose: app.js publishes through `module.exports` rather than a global, so
// calling this from either of them would need the `typeof … === 'function'` fallback that
// duplicates the rule it was meant to remove. A change here must therefore be mirrored in
// `learn.js:subscoresForSide` and in the viewer's two step-table filters — verify-053 counts all
// three files so a future edit cannot move one without being told about the others.
function isExemptUnique(s) {
  return !!(s && s.forcedDefense);
}

// ---------- 0.4.8 §1.2 唯一手连续命中 ----------
// 唯一手 here is the ENGINE's only-good-move reading (`isSharp`: best-vs-second gap >= 0.12
// with the best move winning or losing outright) — not the four's only-block reading, which is
// §1.1's `forcedDefense` and is excluded below so the two never count the same hand twice.
//
// Why a streak and not just a rate: a single sharp hand is ordinary. A run of them, each
// played as the engine's own first choice, is a different claim about the player — the point
// at which "good at gomoku" stops explaining the sequence. `totalSharp` and `streakHits` are
// carried beside the two sub-scores because the report prints them, and because "one long run"
// and "many short ones" produce the same count but not the same story.
//
// Walked over the side's OWN sequence (`filter` on side), so "consecutive" means consecutive
// hands of that player — the opponent's intervening hands are not part of the run. A sharp hand
// that MISSED the top move breaks the chain; a hand that is not sharp at all leaves it
// standing, because it is neither a hit nor a failure to hit.
//
// 0.5.0 §1.2 — the exemption is now stated as a predicate instead of as a bare `… .forcedDefense`
// in each filter clause. See `isExemptUnique` for what it does and, more importantly, what it
// deliberately does NOT cover.
function sharpStreakStats(steps, side) {
  const own = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.side === side && s.analyzed && !s.isOpening && !isExemptUnique(s)) own.push(s);
  }
  let maxStreak = 0, totalSharp = 0, streakHits = 0, currentStreak = 0;
  for (let i = 0; i < own.length; i++) {
    const s = own[i];
    if (s.isSharp && s.top1) {
      currentStreak++;
      streakHits++;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
    } else if (s.isSharp && !s.top1) {
      currentStreak = 0;
    }
    if (s.isSharp) totalSharp++;
    // The running position of this hand inside its run, stamped on the step so the viewer can
    // label a row 「唯一手（连续 K）」 without re-walking the sequence — a second copy of this
    // walk in the viewer is exactly the kind of duplicated answer this project has shipped
    // wrong three times. 0 on everything that is not a hit, so a step that is not part of a run
    // reads as 0 rather than `undefined`.
    s.sharpStreak = (s.isSharp && s.top1) ? currentStreak : 0;
  }
  return { maxStreak, totalSharp, streakHits };
}

// ---------- 0.5.5 §一 好点池重定义 ----------
// 好点 = 落在引擎 Top5 及其以内（Top6-8 只在「必要时」算 —— 见下）。0.5.2 用的是 Top3，本次扩大
// 到 Top5 并按 §1.1.4 把主指标从「连续 ≥3 次」换成「占比 70% + 连续度 30%」。
//
// ⚠ 0.5.2 的 `stepProximity >= 0.75` 那条读法**彻底不在了**：PROX 把 Top2-3 与 Top4-5 并成同一
// 个 0.80 带，用接近度当阈值等于把边界交给一个 0.4.7 已经判定为噪声的分级。现在判据是 top5 位，
// 与接近度无关 —— 这也是 §1.1.2 写死的形式。
//
// 「必要时」的语义 = §1.1.3：只有记录到的思考时间超过 THINK_MS_EXTENDED（6s）时，引擎才被要求
// 给出 8 个候选（见 nbestFor），所以 Top6-8 只在那样的手上存在。**复用同一个 6000 常量**而不是
// 再写一个字面量 —— 两个地方的 6000 迟早会分家。
const GOOD_TOP8_MS = THINK_MS_EXTENDED;   // > 6s, the width nbestFor asks for top8
const GOOD_RATIO_LO = 0.55;               // below this share of good points the rate scores 0
const GOOD_RATIO_SPAN = 0.45;             // 0.55 -> 0.0, 1.00 -> 1.0
const GOOD_STREAK_MIN = 3;                // consecutive good points before the streak scores
const GOOD_STREAK_BASE = 1.25;            // 3 -> 0.1, 8 -> 0.5, 15 -> 1.0
const GOOD_STREAK_DIV = 8;
const GOOD_W_RATIO = 0.7;                 // §1.1.4 组合：占比 70% + 连续度 30%
const GOOD_W_STREAK = 0.3;

// The predicate. §1.1.2's own JS, with one addition: a null step is not a good move (the old
// `isGoodPoint` was total, and a suite that hands it `null` must not crash the pass).
//
// ⚠ The 冲四豁免 test is `isExemptUnique(s)`, NOT `s.forcedDefense`: app.js has ONE spelling of
// that rule (0.5.0 §1.1: the verdict is decided by shape) and verify-053 counts the other
// spellings in code to keep it that way. Writing the flag here by hand tripped that tripwire.
function isGoodMove(s) {
  if (!s || !s.analyzed || s.isOpening || isExemptUnique(s)) return false;
  if (s.top5) return true;
  if (s.top8 && s.thinkMs != null && s.thinkMs > GOOD_TOP8_MS) return true;
  return false;
}

// Which hands the pool is measured over: this side's scored hands, past the opening cutoff, minus
// the 冲四豁免 ones. ONE predicate with three consumers (the ratio, the streak walk and the per-hand
// stamp below) — 0.5.5 shipped a version where the skip rule was written out twice, which is the
// failure this project has paid for five times. The exemption goes through `isExemptUnique` for the
// same reason it does in every other call site in this file.
//
// 活三好手 deliberately has its own pool (`liveThreePool`) and does NOT appear here: per §1.2 a
// 活三 defence that lands as the engine's first choice is a good point on its own merits, so it is
// not double-counted either way.
function goodPoolCounts(s, side) {
  return !!s && s.side === side && s.analyzed && !s.isOpening && !isExemptUnique(s);
}

// A hand that is not on this side's own list never reaches isGoodMove's second tier, so `thinkMs`
// is only read for hands the side actually played.
function goodOwnSteps(steps, side) {
  return (steps || []).filter((s) => goodPoolCounts(s, side));
}

// §1.1.3 indicator A — 好点占比. `own` is the population above, so the denominator is hands this
// side actually played rather than table rows.
function goodMoveRatio(steps, side) {
  const own = goodOwnSteps(steps, side);
  if (!own.length) return { ratio: 0, count: 0, total: 0 };
  const good = own.filter(isGoodMove);
  return { ratio: good.length / own.length, count: good.length, total: own.length };
}

// §1.1.3 indicator B — 好点连续度: the LONGEST run of consecutive good points. A miss resets it;
// a hand outside the population is not in `own` at all, so it neither extends nor breaks the run
// (the same "neither a hit nor a failure" semantics sharpStreakStats uses).
function goodMoveStreak(steps, side) {
  let max = 0, cur = 0;
  goodOwnSteps(steps, side).forEach((s) => {
    if (isGoodMove(s)) { cur++; if (cur > max) max = cur; }
    else cur = 0;
  });
  return max;
}

// §1.1.4 — the two sub-scores and their combination. Both are exactly 0 for a side with no good
// points at all, and the streak sub-score is 0 for anything under GOOD_STREAK_MIN, so a short run
// costs nothing: §1.1.4's 「连续度低不减少」.
//
// ⚠ Same formula-vs-gloss problem 0.5.2 hit, and the same call: §1.1.4's own note prints
// 「3 → 0.1；8 → 0.5；15 → 1.0」 while `(1.25^(streak-2) - 1) / 8` gives 0.031 / 0.352 / 1.000.
// The FORMULA is implemented — it is the code, it is unambiguous, and the acceptance criteria it
// has to satisfy (starts at 3, grows with the run, reaches 1.0 at 15) are all met by it.
function computeGoodPool(steps, side) {
  const r = goodMoveRatio(steps, side);
  const streak = goodMoveStreak(steps, side);
  const aRatio = clamp((r.ratio - GOOD_RATIO_LO) / GOOD_RATIO_SPAN, 0, 1);
  const aStreak = streak >= GOOD_STREAK_MIN
    ? clamp((Math.pow(GOOD_STREAK_BASE, streak - 2) - 1) / GOOD_STREAK_DIV, 0, 1)
    : 0;
  return {
    ratio: r.ratio, count: r.count, total: r.total, streak,
    aRatio, aStreak,
    aGoodPool: GOOD_W_RATIO * aRatio + GOOD_W_STREAK * aStreak,
  };
}

// Stamps the RUNNING 好点 count on every hand, per side, plus the predicate's own verdict (`isGood`).
// The running count is what the step table's 好点池 column prints and what `slimStep` persists;
// `isGood` is persisted separately so an archive can be re-scored without re-deriving the rule from
// top5/top8/thinkMs.
//
// ⚠ This is the per-hand view of the SAME walk `goodMoveStreak` does, not a second opinion: both
// read `goodPoolCounts` + `isGoodMove`, and the max of what is stamped here equals what that
// function returns. Kept as a stamping pass because the viewer needs a property ON the hand in
// table order and must not rebuild the run.
function markGoodPool(steps) {
  for (let i = 0; i < steps.length; i++) {
    steps[i].goodPool = 0;
    steps[i].isGood = false;
  }
  for (const side of ['B', 'W']) {
    let streak = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!goodPoolCounts(s, side)) continue;
      const good = isGoodMove(s);
      s.isGood = good;
      if (good) { streak++; s.goodPool = streak; }
      else streak = 0;
    }
  }
  return steps;
}

// ---------- 0.5.2 §1.2 活三特例 ----------
// 对手形成活三时，防点通常只有两个，且引擎对这两个点的胜率几乎一样。§1.2.1 splits the
// response three ways, and the split only means anything if the detector can tell a 活三 defence
// apart from an ordinary hand — hence the two-part test below: the opponent really had an open
// three, AND the engine's top two candidates are close enough that they are the same decision.
//
// The second half is what keeps this from firing on every hand. A position can hold an open three
// for the opponent while the engine's first choice is still ten points clear of its second — that
// is not a two-way choice, and calling it one would hand out 活三 credit for an ordinary move.
const LIVE_THREE_WR_GAP = 0.15;
const LIVE_POOL_MIN = 2;      // consecutive 活三 hits before the term starts scoring

function isLiveThreeDefense(step, prevBoard, cands) {
  if (!step || !prevBoard) return false;
  const opp = step.side === 'B' ? 'W' : 'B';
  const t = scanThreats(prevBoard);
  if (!t || !t[opp].openThree) return false;
  if (!cands || cands.length < 2) return false;
  const p1 = cands[0].move, p2 = cands[1].move;
  if (eqCoord(p1, p2)) return false;
  const wr1 = cands[0].winrate || 0, wr2 = cands[1].winrate || 0;
  return Math.abs(wr1 - wr2) <= LIVE_THREE_WR_GAP;
}

// The per-hand fact. Needs the board AS IT WAS BEFORE the hand — which is why this walk is
// incremental rather than a lookup: `scanThreats` reads a stone list, and nothing on a step
// records the position that preceded it. Building `board` as we go costs one push per hand and
// keeps the whole thing O(n) instead of re-deriving a prefix board per step.
function markLiveThreeFlags(steps) {
  const board = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    s.liveThreeDefense = isLiveThreeDefense(s, board, s.cands);
    s.liveThreeHit = !!(s.liveThreeDefense && s.top1);
    s.liveThreeTop2 = !!(s.liveThreeDefense && !s.top1 && s.top3);
    s.liveThreeMiss = !!(s.liveThreeDefense && !s.top1 && !s.top3);
    if (s.actual) board.push({ x: s.actual[0], y: s.actual[1], side: s.side });
  }
  return steps;
}

// The INDEPENDENT 活三 pool. §1.2.2 is the whole point of this function:
//   · 走 Top2 — no credit, and NO reset. Top2 on a two-way defence is what an ordinary strong
//     player picks, so it is not evidence either way.
//   · 走 Top1 — a hit; the run extends.
//   · Top3 外 — the defence was missed; the run breaks.
//   · a hand that is not a 活三 defence at all — neither extends nor breaks, so a good point in
//     between does not disturb the 活三 run and the two pools stay genuinely independent.
function markLiveThreePool(steps) {
  for (let i = 0; i < steps.length; i++) steps[i].liveThreePool = 0;
  for (const side of ['B', 'W']) {
    let streak = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.side !== side || !s.analyzed || s.isOpening) continue;
      if (s.liveThreeTop2) continue;
      if (s.liveThreeHit) {
        streak++;
        s.liveThreePool = streak;
      } else if (s.liveThreeMiss) {
        streak = 0;
      }
    }
  }
  return steps;
}

// Both 0.5.2 pools, in the order the pipeline needs them. Kept as one entry point so the two
// callers (analyzeGame and summarizeSteps) cannot run one pass and forget the other — the live
// summary and the finished report have to agree, or the risk score visibly moves at the moment
// the game ends.
function markPoolSignals(steps) {
  markGoodPool(steps);
  markLiveThreeFlags(steps);
  markLiveThreePool(steps);
  return steps;
}

function sideAggregate(steps, side, hasTime, params, opts) {
  const { w, t } = riskParams(params);
  // 0.4.2 §2.3: an evasion hand is excluded from the main statistics. That exclusion IS the
  // signal: a deliberately bad move would otherwise dilute the very percentages (Top-1 /
  // ACPL / Top5-外) it is meant to be evidence about — the operator would see a "human-like"
  // ACPL produced by the smoke screen rather than by the play. The two evasion terms below
  // are what carries that evidence instead, so nothing is lost.
  const s = steps.filter(x => x.side === side && !x.isOpening && x.analyzed &&
                              !isExemptUnique(x) && !x.evasion);
  if (!s.length) return null;
  const n = s.length;
  const top1 = avg(s.map(x => x.top1 ? 1 : 0));
  const top3 = avg(s.map(x => x.top3 ? 1 : 0));
  const top5 = avg(s.map(x => x.top5 ? 1 : 0));
  // 0.4.3 §1.1: the graded mean the two 0.3.1 terms now read. Left visible in the report
  // beside top1/top3/top5 because it is a different number about the same hands, and the
  // only way to tell "this side always hit Top3" from "this side always hit Top1" in an
  // archive is to carry it.
  // 0.4.3 §1.1: if a caller asks for the pre-0.4.3 reading (`opts.legacyTop1`, the comparison
  // switch §五 #2 asks for), EVERYTHING the graded step feeds goes back to the binary hit —
  // not just the ramp below. §1.1's diagnosis was that the two terms COLLAPSED TOGETHER ("80+
  // slid into the 50s"), and a switch that reverses only one of them cannot reproduce the
  // number it exists to compare against: it would understate the old defect by ~6 points.
  // So this one flag covers the whole old behaviour, and a test can score the same steps both
  // ways instead of asserting against a re-implementation of either.
  const legacy = !!(opts && opts.legacyTop1);
  const topProx = avg(s.map(stepProximity));
  const losses = s.map(x => x.loss).filter(v => v != null);
  const meanLoss = avg(losses);
  const sharp = s.filter(x => x.isSharp);
  const sharpHit = sharp.length
    ? (legacy ? avg(sharp.map(x => (x.top1 ? 1 : 0))) : avg(sharp.map(stepProximity)))
    : null;
  const outTop5 = avg(s.map(x => x.outsideTop5 ? 1 : 0));
  const desperateCount = s.filter(x => x.desperate).length;
  // 0.4.7 §1.1: runs of consecutive fours played from a lost position. Counted as RUNS, not
  // hands: the signal is "this side, losing, fired a forcing sequence that could not work", and
  // a five-hand run is one such decision rather than five. §1.1's relationship note is explicit
  // that this does NOT double-count `desperateCount` — a hand can satisfy both predicates, and
  // each count is of its own predicate over its own unit (a hand vs a run).
  //
  // The hands are walked in the table's order and a new run is counted whenever the length
  // stamped by markFourRuns() differs from the previous hand's. Two adjacent runs of the same
  // length are separated by a non-four hand (otherwise they would be one run), and that hand
  // resets `prevLen` to 0 — which is what makes the count exact rather than approximate.
  const uselessFourCount = s.filter(x => x.fourKind === 'useless').length;
  const fourRuns = { vcf: 0, useless: 0, defensive: 0 };
  let prevRun = 0;
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    const len = x.fourKind ? (x.fourRun || 0) : 0;
    if (len && len !== prevRun) fourRuns[x.fourKind]++;
    prevRun = len;
  }
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

  // `top1Lo`/`top1Hi` stay in storage and in the learner (they are still what an old archive
  // describes itself with), but nothing here reads them unless `legacy` above asks for it.
  const aTop1 = legacy ? rampUp(top1, t.top1Lo, t.top1Hi)
                       : rampUp(topProx, t.topProxLo, t.topProxHi);
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
  // 0.4.7 §1.1: the useless-four surcharge. Exactly 0 when the side never played a run of
  // consecutive fours from a lost position, which is what keeps every earlier release's score
  // reproducible — the same construction the two terms above use. Full weight at two such
  // runs (a single one can be a desperate but honest attempt to create a threat).
  const aUselessFour = clamp(fourRuns.useless / 2, 0, 1);
  // 0.4.8 §1.2: the two 唯一手 streak terms. Both are exactly 0 with no sharp hands, so a game
  // with none scores bit-for-bit what it scored before — the acceptance criterion #5 the
  // weight table above is reconciled against. `aSharpStreak` ramps over the LONGEST run (a
  // 3-run is worth 0.14, ten in a row saturates); `aSharpTotal` over the total number of hits,
  // which catches a side that keeps finding the only move without ever running long.
  const ss = sharpStreakStats(steps, side);
  // 0.5.2 §1.3.2 — both curves are now EXPONENTIAL. §1.3.1's linear ramps treated the 4th, 5th
  // and 6th consecutive hit as worth the same as the 2nd, which is the opposite of what a run
  // means: the longer a player matches the engine's only move, the less "good at gomoku"
  // explains it, and the increment should grow with the run rather than stay flat.
  //
  // ⚠ The spec prints example values beside both formulas that the formulas do not produce
  // (§1.3.2 glosses 5 → 0.29 and 7 → 0.78 where the expression gives 0.24 and 0.54). The
  // FORMULA is implemented: it is the code, it is unambiguous, and §1.3.3's acceptance criteria
  // (a small increment at 3, near-full at 8, growth that increases) are satisfied by it. Same
  // call as 0.4.8 made when §1.2's weight table contradicted §1.2's own criterion.
  const aSharpStreak = ss.maxStreak >= 3 ? clamp((Math.pow(1.3, ss.maxStreak - 2) - 1) / 5, 0, 1) : 0;
  const aSharpTotal = ss.streakHits >= 3 ? clamp((Math.pow(1.15, ss.streakHits - 2) - 1) / 8, 0, 1) : 0;
  // 0.5.5 §1.1.4 — the redefined 好点池. The whole computation lives in computeGoodPool(), which
  // takes the FULL step list and does its own population filtering, exactly as §1.1.3's two
  // functions do: the pool is measured over this side's scored, non-opening, non-exempt hands —
  // NOT over `s` above, which additionally drops the evasion hands. The evasion filter belongs to
  // the six (see the note at the top of this function); a 好点 is a fact about where a move landed,
  // and 0.5.2's stamping pass drew its population the same way.
  //
  // `aLiveThree` is unchanged from 0.5.2 (its own independent pool, exponential, from the 2nd).
  //
  // ⚠ Same formula-vs-gloss note as above: §1.2.4 prints 4 → 0.22 / 6 → 0.5 where the
  // expression gives 0.30 / 0.68. The formula is implemented.
  const gp = computeGoodPool(steps, side);
  const aGoodPool = gp.aGoodPool;
  const liveThreeMax = s.reduce((m, x) => Math.max(m, x.liveThreePool || 0), 0);
  const aLiveThree = liveThreeMax >= LIVE_POOL_MIN
    ? clamp((Math.pow(1.3, liveThreeMax - 1) - 1) / 4, 0, 1)
    : 0;
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
  // 0.5.5: the table now sums to 1.00 as a whole (see BASE_WEIGHTS), so scaling all of it by
  // (1 − simW) and adding `simW * aSim` on top keeps the total at exactly 1.00 — the property the
  // max possible score depends on. With no feature library `simW` is 0 and this is the identity.
  const risk = clamp(100 * (wEff.top1 * aTop1 + wEff.acpl * aAcpl + wEff.sharp * aSharp + wEff.out * aOut
                    + wEff.desperate * aDesperate + wEff.time * aTime + simW * aSim
                    + wEff.evasion * aEvasion + wEff.winBlunder * aWinBlunder
                    + wEff.uselessFour * aUselessFour
                    + wEff.sharpStreak * aSharpStreak + wEff.sharpTotal * aSharpTotal
                    + wEff.goodPool * aGoodPool + wEff.liveThree * aLiveThree), 0, 100);
  const level = risk >= t.riskHigh ? '高风险' : (risk >= t.riskMid ? '可疑' : '低风险');
  return {
    side, n, top1, top3, top5, topProx, meanLoss, sharpHit, outTop5, desperateCount,
    sharpCount: sharp.length, time, simCount,
    // 0.4.2 §二. n / top1 / meanLoss above deliberately do NOT include these hands; these
    // three fields are the only place they are counted.
    evasionCount: ev.count, evasionRegularity: ev.regularity, winBlunderCount: ev.winBlunders,
    // 0.4.7 §1.1. Three numbers about the four runs: how many hands carried a useless run
    // (the thing that scores), and how many runs of each kind there were (reported, so an
    // operator can tell "one long run" from "three short ones" — the score cannot).
    uselessFourCount, fourRuns,
    // 0.4.8 §1.2. The two streak figures behind the terms above. `sharpStreakMax` is the
    // longest run of top-1 sharp hands, `sharpStreakHits` the total count — reported so the
    // detail table can say "唯一手最长连续命中 N 次 / 累计 M 次" without recomputing either.
    sharpStreakMax: ss.maxStreak,
    sharpStreakHits: ss.streakHits,
    // 0.5.5 §1.1.3/§1.4.1. The two 好点 figures behind the term above, reported so the metric table
    // can print 「好点占比」 and 「好点最长连击」 without recomputing either — the same reason
    // sharpStreakMax/sharpStreakHits are carried. `goodRatio`/`count`/`total` come from the ratio
    // walk, `goodStreak` from the streak walk, and all three are read off the SAME population.
    goodRatio: gp.ratio, goodCount: gp.count, goodTotal: gp.total, goodStreak: gp.streak,
    // §1.2. Unchanged: the 活三 pool's own run length.
    liveThreeMax,
    contributions: {
      top1: wEff.top1 * aTop1 * 100, acpl: wEff.acpl * aAcpl * 100, sharp: wEff.sharp * aSharp * 100,
      out: wEff.out * aOut * 100, desperate: wEff.desperate * aDesperate * 100, time: wEff.time * aTime * 100,
      sim: simW * aSim * 100,
      evasion: wEff.evasion * aEvasion * 100, winBlunder: wEff.winBlunder * aWinBlunder * 100,
      uselessFour: wEff.uselessFour * aUselessFour * 100,
      sharpStreak: wEff.sharpStreak * aSharpStreak * 100, sharpTotal: wEff.sharpTotal * aSharpTotal * 100,
      goodPool: wEff.goodPool * aGoodPool * 100, liveThree: wEff.liveThree * aLiveThree * 100,
    },
    risk, level,
  };
}

// ---------- 0.4.3 §1.2 分段识别 ----------
// A "segment" is a maximal run of this side's hands that share the same nearness class, where
// the class is deliberately BINARY: inside the engine's Top5, or outside it. Not Top1 / Top2-3
// / Top4-5 — the engine's exact ranking inside its own candidate list is noisy at a fixed
// time budget, and a classifier built on that noise would change its mind between two runs of
// the same game. Top5 is a boundary the engine is actually confident about.
const MIN_SEGMENT = 3;

function segmentSide(steps, side) {
  // Same population the step table draws: this side's scored, non-opening, non-exempt hands.
  // Evasion hands stay IN on purpose — a segment is a picture of the game as it was played,
  // and the operator sees every hand in the table; hiding one from the geometry would put the
  // green/orange line at a row that does not match the run it describes.
  const ownIdx = [];
  steps.forEach(function (s, i) {
    if (s.side === side && s.analyzed && !s.isOpening && !isExemptUnique(s)) ownIdx.push(i);
  });
  if (ownIdx.length < MIN_SEGMENT) return [];

  // 1. binarise, then run-length encode over THIS SIDE's own sequence (the opponent's hands
  //    in between are skipped, so a run is "three of my hands", not three table rows). The
  //    colour array is kept flat and re-encoded after every merge below, because a merge is
  //    only a merge once the absorbed run shares its neighbour's colour.
  const kind = ownIdx.map(function (i) { return steps[i].top5 ? 'high' : 'low'; });
  function rle() {
    const out = [];
    let start = 0;
    for (let k = 1; k <= kind.length; k++) {
      if (k === kind.length || kind[k] !== kind[start]) {
        out.push({ from: start, to: k - 1, kind: kind[start] });
        start = k;
      }
    }
    return out;
  }

  // 2. absorb every run shorter than MIN_SEGMENT into its longer neighbour, until they are all
  //    long enough or only one run is left. A two-hand "segment" is a blip, not a phase.
  //    Re-encoding after each merge is what makes the blip actually disappear: flipping a short
  //    run into a neighbour of the same colour leaves two ADJACENT same-kind runs if the array
  //    is not re-encoded, i.e. a boundary line drawn through a uniform stretch — and it would
  //    also keep measuring that stretch in two pieces, so a length-2 run sitting inside a
  //    length-7 region would still look "short" and get flipped again.
  //
  //    0.4.7 §1.3: `low` runs are EXEMPT from the merge. The old rule deleted any dip shorter
  //    than three hands, which is precisely the shape §1.3 is about — a 5 + 2 + 4 pattern
  //    merged its two-hand dip away and read as a clean 11-hand Top5 stretch, i.e. the exact
  //    opposite of what it is. A short `low` run is a SHORT DELIBERATE DIP, which is one of the
  //    two things an evasive AI does; only short `high` runs are noise, because a two-hand
  //    run of top-5 hits inside a long poor stretch really is just two good hands. `low` runs
  //    are therefore kept at any length, and `high` runs are still merged between them.
  let runs = rle();
  while (runs.length > 1) {
    let shortest = -1, shortLen = Infinity;
    for (let r = 0; r < runs.length; r++) {
      if (runs[r].kind === 'low') continue;    // 0.4.7 §1.3: a dip is never merged away
      const len = runs[r].to - runs[r].from + 1;
      if (len < MIN_SEGMENT && len < shortLen) { shortLen = len; shortest = r; }
    }
    if (shortest < 0) break;
    const prev = shortest > 0 ? runs[shortest - 1] : null;
    const next = shortest < runs.length - 1 ? runs[shortest + 1] : null;
    const prevLen = prev ? prev.to - prev.from + 1 : -1;
    const nextLen = next ? next.to - next.from + 1 : -1;
    // `prevLen >= nextLen` also handles the two edge cases: at the first run prevLen is -1 (so
    // `next` wins unless there is none), and there is only one run when both are null — which
    // the loop condition already excludes.
    const into = (prevLen >= nextLen) ? prev : next;
    for (let p = runs[shortest].from; p <= runs[shortest].to; p++) kind[p] = into.kind;
    runs = rle();
  }

  // 3. back to global step indices. `from`/`to` address the shared steps array, so a segment
  //    spans the opponent's intervening rows rather than being a parallel numbering.
  return runs.map(function (run) {
    return { from: ownIdx[run.from], to: ownIdx[run.to], kind: run.kind };
  });
}

// ---------- 0.4.3 §1.6 区间映射 ----------
// Five bands on whole points, right-open: 75 is AI, 74 is 疑似AI. All four cuts are read from
// the thresholds object so learn.js can move them, and every fallback is the §1.6 default —
// a hand-edited learnedParams must not be able to blank a band out.
function riskBand(risk, thresholds) {
  const t = thresholds || BASE_THRESHOLDS;
  const aiMin = t.typeAiMin != null ? t.typeAiMin : 75;
  const susMin = t.typeSuspectMin != null ? t.typeSuspectMin : 55;
  const proMin = t.typeProMin != null ? t.typeProMin : 45;
  const expMin = t.typeExpertMin != null ? t.typeExpertMin : 30;
  if (risk >= aiMin) return 'ai';
  if (risk >= susMin) return 'suspect';
  if (risk >= proMin) return 'pro';
  if (risk >= expMin) return 'expert';
  return 'normal';
}

// Band -> type code, for the four non-AI bands. The CODES are what travels: `classifySide`
// runs offscreen (where t() has no dictionary) and the result is stored in the archive and in
// `manualType`, so what is persisted is a stable identifier and only the DISPLAY goes through
// TO('type', code). Same shape as app.js's `level` — except that `level` stores its Chinese
// value because content.js compares it by literal, while nothing compares a type by literal,
// so the code is the honest thing to store. See locale/zh-CN.js, which registers these.
const TYPE_OF_BAND = { suspect: 'suspectAi', pro: 'pro', expert: 'expert', normal: 'normal' };

// 0.4.3 §1.5. The band decides everything except which KIND of AI it was, and that comes from
// the segments: an AI that never left Top5 is a different animal from one that dipped out a
// few times to look human, and that in turn differs from one that left Top5 repeatedly.
//
// 0.4.7 §1.3 replaces the single "how many low hands in total" count with the SHAPE of the
// dips. §1.3's own table is the specification:
//
//   全程 Top5            -> 低级AI     (no low run at all)
//   5 + 1 + 4            -> 规避型AI   (one short dip: 1-2 hands)
//   5 + 2 + 4 + 2 + 3    -> 强规避AI   (more than one dip)
//   5 + 3 + 4            -> 强规避AI   (one dip of >=3 hands)
//
// Two dips is the ``>= 2`` clause regardless of their lengths, and one long dip is the
// ``lowMax >= 3`` clause. A single short dip is the only shape left, and it is 规避型.
//
// `lowTotal` is still reported: it is the number the 0.4.3 classifier used and an operator
// comparing two archives of the same game should be able to see why the label moved.
function classifySide(risk, segments, steps, side, thresholds) {
  const band = riskBand(risk, thresholds);
  if (band !== 'ai') {
    return { suspect: band, type: TYPE_OF_BAND[band] || 'normal', auto: true, lowSteps: 0 };
  }
  const lowRuns = [];
  let lowTotal = 0;
  (segments || []).forEach(function (sg) {
    if (sg.kind !== 'low') return;
    let cnt = 0;
    for (let i = sg.from; i <= sg.to; i++) {
      if (steps[i] && steps[i].side === side && steps[i].analyzed && !steps[i].isOpening) cnt++;
    }
    if (cnt > 0) { lowRuns.push(cnt); lowTotal += cnt; }
  });
  const lowMax = lowRuns.length ? Math.max.apply(null, lowRuns) : 0;

  let type;
  if (lowRuns.length === 0) type = 'lowAi';
  else if (lowRuns.length >= 2 || lowMax >= 3) type = 'strongEvasiveAi';
  else type = 'evasiveAi';
  // `lowSteps` keeps its 0.4.3 meaning (the total, not the run count) because storage.js copies
  // that field and a pre-0.4.7 archive is compared against it. `lowRuns`/`lowMax` travel beside
  // it so the viewer can say WHY the label is what it is.
  return { suspect: 'ai', type, auto: true, lowSteps: lowTotal, lowRuns: lowRuns.length, lowMax };
}

function buildReport(steps, record, opts) {
  const hasTime = (record.times || []).some(v => v != null);
  const suspect = (opts && opts.suspect) || 'both';
  // 0.3.3: the learned parameters (or null) that produced this report's risk numbers.
  const params = (opts && opts.learned) || null;
  const black = sideAggregate(steps, 'B', hasTime, params, opts);
  const white = sideAggregate(steps, 'W', hasTime, params, opts);
  // 0.4.3 §1.2/§1.5: the two per-side pictures that are not numbers. Both are computed here
  // from the finished step array — after markEvasion() has run, so an evasion hand is where
  // the operator will see it — and carried in the report so the viewer, the archive list and
  // the sample editor all read one computation instead of three.
  const segments = { B: segmentSide(steps, 'B'), W: segmentSide(steps, 'W') };
  const typeTh = riskParams(params).t;
  const types = {
    B: black ? classifySide(black.risk, segments.B, steps, 'B', typeTh) : null,
    W: white ? classifySide(white.risk, segments.W, steps, 'W', typeTh) : null,
  };
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
    engine: {
      // 0.5.1 §2.1.5 #4 — which model produced these verdicts, not just which build file. The
      // numeric flags below are engine-dependent (a Top-5 hit rate from Rapfi and one from
      // KataGomo are two different measurements), so the archive has to say which is which.
      id: eng.id, name: eng.name, kind: eng.kind, url: eng.url, custom: eng.custom,
      build: eng.build, threads: eng.threads, threadNum: eng.threadNum, degraded: eng.degraded,
      // The recovery, when there was one — stored so a report analysed on a fallback engine is
      // still identifiable as such after the session is gone.
      fallback: eng.fallback || null,
    },
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
    forcedCount: steps.filter(x => isExemptUnique(x)).length,
    // 0.4.8 §1.3: the four-threes that did NOT end the game because the defender's block was
    // itself a four (a 反四). Kept as a list rather than a count: the operator needs to know
    // WHICH hand it was, because that hand is the reason detection continued past a shape the
    // old build stopped on. A game analysed before this build simply has an empty list.
    fourThreeCounters: steps.filter(x => x.fourThreeCounter && x.fourThreeCounter.counter)
                            .map(x => ({ moveNo: x.moveNo, side: x.side, block: x.fourThreeCounter.block })),
    // 0.3.3: which parameter set produced these verdicts. Without it a learned run and a
    // default run are indistinguishable once archived — the same trap the engine row solves
    // for the multi-threaded / single-threaded builds.
    learned: params ? {
      trainedAt: params.trainedAt || null,
      sampleCount: params.sampleCount || 0,
      featureCount: (params.features || []).length,
    } : null,
    steps, black, white, flagged,
    // 0.4.3 §4.2/§4.3. `manualSegments` / `manualType` are the operator's overrides and start
    // empty on a fresh analysis; storage.js preserves them when a report is re-slimmed, so an
    // archive that was edited keeps its edits. `segments` and `types` are always the AUTOMATIC
    // result — the viewer prefers the manual value when there is one, which is what makes
    // 恢复自动分段 a matter of setting the override back to null.
    segments, types,
    manualSegments: { B: null, W: null },
    manualType: { B: null, W: null },
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
    // 0.4.7 §1.1: the four-run pass and the per-step value it classifies with. Exported for the
    // same reason as the two above — a test that re-derived `prevBestWR` itself would be
    // testing its own copy of the rule, and the two could drift.
    markFourRuns, recordPrevBestWR, FOUR_RUN_MIN,
    // 0.4.7 §1.4: the candidate width the two analysis paths derive from the recorded interval.
    nbestFor, NBEST_DEFAULT, NBEST_EXTENDED, THINK_MS_EXTENDED,
    // 0.4.3 §1.1/§1.2/§1.5: the proximity grade, the segmenter and the classifier. Exported
    // for the same reason — a test that had to re-implement segmentSide() to check it would
    // be testing its own copy, and the two could drift.
    stepProximity, segmentSide, riskBand, classifySide, MIN_SEGMENT,
    getEngine, defaultThreadNum, resolveThreadNum, engineInfo, warmEngine,
    // 0.3.4 活四：导出形状识别与判定，供单元测试直接驱动（不再依赖引擎胜率）
    liveFourHolder, applyTerminal, boardFromCoords, scanThreats,
    // 0.4.8 §1.1/§1.2/§1.3: the shape-first forced-defence test, the sharp-streak statistics
    // and the two-stage terminal. Exported so the suite can drive each one directly instead of
    // re-deriving it — the same reason the line above exists.
    forcedDefenseByShape, uniqueBlocksForFour, sharpStreakStats,
    applyTerminalShape, checkFourThreeCounter,
    // 0.5.0 §1.1/§1.2: the four's FORM (真四 / 跳四 / 双四) and the exemption predicate. The
    // suite drives both directly — a test that re-implemented `classifyFour` to check it would
    // be testing its own copy of the rule, which is how this project has gone wrong before.
    fivePointsFor, classifyFour, fourIsSolid, isExemptUnique,
    // 0.5.2 §1.1/§1.2: the two pool passes and their constants. Exported so the suite can drive
    // each one directly on a hand-built step list — the same reason every line above exists.
    markGoodPool, markLiveThreeFlags, markLiveThreePool, markPoolSignals,
    isLiveThreeDefense, LIVE_POOL_MIN, LIVE_THREE_WR_GAP,
    // 0.5.5 §1.1: the redefined pool — the predicate, the two indicators, the combination, and the
    // five constants behind them. `isGoodPoint`/`GOOD_PROX` are GONE with the Top3 reading they
    // belonged to; a suite still naming them is naming a rule this build no longer has.
    isGoodMove, goodPoolCounts, goodMoveRatio, goodMoveStreak, computeGoodPool,
    GOOD_TOP8_MS, GOOD_RATIO_LO, GOOD_RATIO_SPAN, GOOD_STREAK_MIN,
    GOOD_STREAK_BASE, GOOD_STREAK_DIV, GOOD_W_RATIO, GOOD_W_STREAK,
    // 0.3.3 risk-model plumbing, exported so the learner and the tests can reason about the
    // exact numbers the detector uses.
    riskParams, rampUp, rampDown, loadLearnedParams, BASE_WEIGHTS, BASE_THRESHOLDS,
    MAX_THREADS,
    // 0.5.1 §2.1.2/§2.1.3/§2.2 — the engine layer. `Engine`, the fallback chain, the two
    // coordinate alphabets and the wire-format functions are all exported so the suite can drive
    // them directly: a test that re-implemented the request body or the GTP transcript in order
    // to check it would be testing its own copy, which is how this project has gone wrong three
    // times. `ENGINE_BUILDS` stays as the registry's list for anything that still reads it.
    Engine, getEngine, engineFallbackChain, engineInfo, warmEngine,
    rapfiBuilds, engineRegistry,
    buildKatagoRequest, parseKatagoResponse, parseGtpInfoLine, gtpCandidates, gtpNum,
    toGtpCoord, fromGtpCoord, GTP_COL, KATAGO_RULES, katagoRuleName,
    HTTP_PROBE_MS, ENGINE_BUILDS: rapfiBuilds(),
  };
}
