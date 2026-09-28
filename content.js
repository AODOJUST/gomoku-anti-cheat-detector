// Gomoku Anti-Cheat Detector — content script (isolated world).
//
// Responsibilities
//   1. Collect the move record in the REAL play order.
//      Preferred: hook.js (MAIN world) taps window.socket -> ordered moves + real intervals.
//      Fallback : MutationObserver on the board grid, which also yields arrival order.
//   2. Drive analysis through the offscreen document (which owns the Rapfi worker):
//        全局分析   -> gm-analyze           (analyzeGame, once, at game end)
//        逐步分析   -> gm-step              (analyzeStep per move, live)
//                   -> gm-analyze-stepwise (analyzeStepwise, replay after the game)
//   3. Render the panel: 基础数据 / 排队列表 / 设置预选项.
//   4. Persist every finished analysis as an archive (GMStorage) for the viewer.
//
// Settings live in the shared storage layer (storage.js, loaded before this file), so
// the panel and viewer.html edit the exact same record.
(function () {
  if (window.__gmContent) return;
  window.__gmContent = true;

  var EV_EVENT = '__gm_event';
  var EV_REQ = '__gm_req';
  var EV_RESP = '__gm_resp';

  // The panel footer's version. Read from the manifest rather than hand-copied: this literal
  // had to be bumped in step with manifest.json on every release and was missed once, which
  // is exactly how a footer ends up advertising a version the extension is not. background.js
  // and viewer.js already read it this way; the fallback only covers the (impossible in a
  // content script) case of no extension API.
  var VERSION = (function () {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '0.4.1'; }
  })();

  // ---------- i18n (0.3.6 §1) ----------
  // `i18n.js` + the eight locale tables are loaded before this file (see manifest.json), so
  // every UI string here goes through T(). The panel is rebuilt from `shellHtml()` on a
  // language change, which is why nothing may cache a translated string in a closure.
  var LANG = GMI18n.DEFAULT;

  function T(key, vars) { return GMI18n.t(key, vars); }
  // A stored canonical value (risk level, job status, tag, end reason) in the current
  // language. Never used on the way INTO storage.
  function TO(ns, value, vars) { return GMI18n.tOr(ns, value, vars); }
  // Messages that travelled from app.js / offscreen.js as `__i18n:` codes.
  function TE(msg) { return GMI18n.trError(msg); }

  function applyLang(setting) {
    LANG = GMI18n.resolveLang(setting);
    GMI18n.setLocale(LANG);
    // The host page's <html lang> belongs to gomoku.com, so i18n.js only tags it with
    // data-gm-lang; the panel's own subtree carries the real lang attribute for font
    // resolution (CJK vs Cyrillic vs Latin metrics differ enough to shift the layout).
    if (root && root.host) root.host.setAttribute('lang', LANG);
  }

  // ---------- settings (persisted, shared with viewer.html) ----------
  var S = GMStorage.defaults();
  var moreOpen = false;

  function loadSettings() {
    return GMStorage.loadSettings().then(function (v) { S = v; return S; });
  }
  function saveSetting(key, value) {
    S[key] = value;
    return GMStorage.saveSetting(key, value);
  }

  // ---------- state ----------
  var socketRec = null;
  var domMoves = [];
  var domGrid = null;
  var domSeeded = 0;        // stones absorbed from a board render (order unknown)
  var emptySince = 0;
  var ended = false;
  var endedBy = '';
  var jobs = [];
  var seqCounter = 0;
  var runningJob = null;   // one-shot job being analysed
  var liveJob = null;      // 实时逐步 session job
  // 0.3.5: the live session is finished for good. Set when a live four stops detection, and
  // kept AFTER liveJob is retired — otherwise the very next move would sail past the
  // `if (!liveJob) startLiveSession()` line and silently start a second session, re-scoring
  // hands the game no longer needs. Cleared only by an explicit restart (手动「开始分析」)
  // or by a board reset.
  var liveStopped = null;  // { moveNo, reason } | null
  // 0.3.7 §一.1 — which game we are collecting, and which ones are already archived.
  // "The game ended" can be announced by a socket event, a settlement overlay, five in a
  // row, a full board or a timeout — or by nothing at all, in which case the only evidence
  // is that the NEXT game has started. `gameEpoch` makes that visible: every path that
  // begins a new game bumps it, and every successful archive marks the epoch it belongs to,
  // so a finished game can never be silently dropped and can never be archived twice.
  var gameEpoch = 1;
  var archivedEpoch = {};   // { epoch: true }
  var selectedId = null;
  var lastStepBudget = null;
  var lastArchive = null;
  var lastSkip = null;      // { moves, min } — the last analysis that was too short to keep
  // Engine status as the offscreen document reports it: which build won, and whether it is
  // a pthread build. Shown as a note only when something is worth saying (degraded to
  // single-thread, or an explicit thread count on a multi build).
  var engineNote = '';

  function isRenju() { return /\/renju/i.test(location.pathname); }

  // ---------- clock alignment (0.4.1 §三.2) ----------
  // Two clocks stamp moves: hook.js (MAIN world) stamps every socket move, and this file
  // stamps the stones it reads off the board. They are two JS worlds of ONE document, so
  // `performance.now()` should share a time origin and the offset below should be ~0. It is
  // MEASURED, not assumed: `emit()` dispatches its CustomEvent synchronously, so the gap
  // between hook's `clockNow` and our own reading is well under a millisecond, and a non-zero
  // offset is a real disagreement worth correcting (hook used to emit times relative to its
  // own per-GAME `startedAt`, which is an origin this file has never heard of).
  //
  // Everything downstream then works in PAGE time, so `socketRec.moves[].t` and the `t` this
  // file stamps on a DOM stone are directly comparable rather than merely each internally
  // consistent.
  var clockDeltaLogged = false;
  function alignSocketClock(rec) {
    if (!rec || typeof rec.clockNow !== 'number' || !rec.moves) return rec;
    var d = performance.now() - rec.clockNow;
    if (Math.abs(d) < 0.5) return rec;            // the expected case: one shared time origin
    if (!clockDeltaLogged) {
      clockDeltaLogged = true;
      console.log('[detector] hook 与 content 的 performance.now() 相差 ' + Math.round(d) +
                  'ms，已按该偏移对齐 socket 时间戳');
    }
    for (var i = 0; i < rec.moves.length; i++) {
      if (typeof rec.moves[i].t === 'number') rec.moves[i].t += d;
    }
    return rec;
  }

  // The move list the record is built from.
  //
  // The two collectors are NOT interchangeable, and switching between them wholesale (what
  // this used to do) could drop stones: the moment the socket produced its first move,
  // `activeMoves()` jumped from the DOM scanner to `socketRec` — and anything the socket
  // never saw, i.e. the stones that were already on the board when we attached, went with
  // it. Whether that happened at all came down to which collector attached first.
  //
  // So they are merged instead of chosen between. The socket keeps the order and the real
  // intervals; a stone the board shows that the socket does not account for is added as
  // order-unknown (it was played before anything the socket reported) or, when our own
  // scanner watched it arrive, appended as the latest move.
  function activeMoves() {
    var sock = (socketRec && socketRec.moves) || [];
    if (!sock.length) return domMoves;
    if (!domMoves.length) return sock;
    var have = {}, i;
    for (i = 0; i < sock.length; i++) have[cellKey(sock[i].row, sock[i].col)] = true;
    var pre = [], post = [];
    for (i = 0; i < domMoves.length; i++) {
      var m = domMoves[i];
      if (have[cellKey(m.row, m.col)]) continue;
      (m.inferred ? pre : post).push(m);
    }
    if (!pre.length && !post.length) return sock;
    return pre.map(unorderedStone).concat(sock, post.map(untimedStone));
  }

  // A merged-in stone still cannot carry a timestamp, even though both clocks are now on the
  // page's origin (see alignSocketClock above). The reason is no longer the clocks, it is the
  // ORDER: `post` holds stones the board showed but the socket has not reported yet, so
  // "arrived after the socket's last move" is a premise and not a fact. If the socket simply
  // never reported one of them, its `t` can land BEFORE its predecessor — and `toRecord`
  // clamps that to a 0ms interval, which markDesperate reads as an instant move, i.e. as
  // evidence of an engine. A missing interval is honest; a fabricated 0ms one is a false
  // accusation. The same applies to `pre`, whose order is unrecoverable outright.
  function unorderedStone(m) {
    return { row: m.row, col: m.col, stone: m.stone, t: null, inferred: true };
  }
  // Observed by our own scanner but not (yet) on the socket: a real move in real order, so
  // it stays scorable — only its timing is unknown.
  function untimedStone(m) {
    return { row: m.row, col: m.col, stone: m.stone, t: null, inferred: false };
  }
  function fromSocket() { return !!(socketRec && socketRec.moves.length); }
  function countInferred(mv) {
    var n = 0;
    for (var i = 0; i < mv.length; i++) if (mv[i].inferred) n++;
    return n;
  }

  // ---------- opening (RIF 26) ----------
  // A collected stone -> the app's own board coordinates: x = column, y = row counted
  // downward (see openings.js). `14 - row` is the same flip `toRecord` does, so a move that
  // goes through both agrees.
  function movePoint(m) { return [m.col, 14 - m.row]; }

  // The opening of the CURRENT game, or null. Cheap enough for the status line: it only ever
  // looks at the first three moves, and it refuses outright as soon as any stone has an
  // unknown place in the order.
  function currentOpening() {
    var mv = activeMoves();
    if (mv.length < 3 || countInferred(mv)) return null;
    return GMOpening.detectOpening([movePoint(mv[0]), movePoint(mv[1]), movePoint(mv[2])], null);
  }

  // Adjacent same-colour moves: impossible in gomoku (black starts, play alternates), so
  // a non-zero count means the capture lost or doubled a stone. Returns the count, which
  // is falsy when the order is clean.
  function orderBad(mv) {
    var n = 0;
    for (var i = 1; i < mv.length; i++) {
      if (mv[i].stone && mv[i].stone === mv[i - 1].stone) n++;
    }
    return n;
  }

  function toRecord(moves) {
    var pts = [], times = [], sources = [], stones = [];
    var inferred = 0, known = 0, dups = 0;
    var seen = {};
    // `prev` walks the KEPT moves, not the raw list: measuring an interval across a
    // dropped duplicate would report a gap that never happened.
    var prev = null;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var key = cellKey(m.row, m.col);
      // A gomoku point is played at most once per game, so a repeated coordinate is a
      // capture artefact (a socket replay after a reconnect, or a render confirming a
      // stone we already had). Keeping both would show the same hand twice and break the
      // colour alternation the per-side statistics rely on.
      if (seen[key]) { dups++; continue; }
      seen[key] = true;
      pts.push([m.col, 14 - m.row]);          // board row 0 = top; app.js y counts from bottom
      stones.push(m.stone || null);           // 1 = black, 2 = white — the side's ground truth
      // An interval is only meaningful between two CONSECUTIVE observed moves. A
      // stone recovered from a board render carries no timestamp, and the gap that
      // follows it is measured from page load, not from the previous move — so both
      // sides of it report null and the engine falls back to a fixed budget.
      var timed = !m.inferred && prev && !prev.inferred &&
                  typeof m.t === 'number' && typeof prev.t === 'number';
      times.push(timed ? Math.max(0, Math.round(m.t - prev.t)) : null);
      if (m.inferred) { sources.push('prejoin'); inferred++; } else { sources.push('player'); known++; }
      prev = m;
    }
    // Adjacent same-colour moves cannot happen in a real game. Computed here as well as
    // in app.js so the panel can warn while a game is still running.
    var issues = 0;
    for (var q = 1; q < stones.length; q++) if (stones[q] && stones[q] === stones[q - 1]) issues++;
    var names = playerNames();
    var ident = detectIdentity(names);
    return {
      moves: pts,
      stones: stones,
      times: times,
      sources: sources,
      // `prejoin` = order unrecoverable, position exact. Never scored, always replayed.
      meta: {
        source: fromSocket() ? 'socket' : 'dom',
        rule: isRenju() ? 'renju' : 'freestyle',
        // The RIF opening, derived from the first three KEPT moves (the dedup above can drop
        // one, and then "move 3" would not be the third stone). Refuses when any stone's
        // place in the order is unknown, because then the first three are not the opening.
        opening: GMOpening.detectOpening(pts, { unorderedCount: inferred }),
        // registered | guest | spectator, plus the route it was decided by — these are all
        // heuristics and an undiagnosable guess is worse than no field.
        identity: ident.identity,
        identityHow: ident.how,
        inferredCount: inferred,
        // Same number, named for what it MEANS to a reader of the record: these are the
        // stones whose place in the move order is unknown, so the replay board draws them
        // as a distinct block and the report calls the game "数据不完整".
        unorderedCount: inferred,
        orderKnownCount: known,
        dropped: dups,
        orderSuspect: issues > 0,
        orderIssues: issues,
        // 0.4.1 §三.4: ONE word for the whole record, so the operator does not have to
        // combine 盘面还原 / 手序校验 / 重复坐标 by hand to decide whether to believe the
        // percentages above them. A single bad thing makes the record suspect, not good:
        //   suspect  adjacent same-colour stones — the per-side figures rest on a wrong order
        //   partial  a stone was dropped, or part of the order is unknown (mid-join)
        //   good     neither
        // Display-only so far: nothing reads this to change a score. The mirror of
        // app.js's parseRecord() — the two are the only producers of `meta.quality`.
        quality: issues ? 'suspect' : ((dups || inferred) ? 'partial' : 'good'),
        // Only the names belong in the record; which route produced them is `nameSource`.
        players: {
          black: names.black || null, white: names.white || null,
          self: names.self || null, opponent: names.opponent || null,
        },
        nameSource: names.source,
        roomId: socketRec ? socketRec.roomId : null,
        winner: socketRec ? socketRec.winner : null,
        // A draw is a finished game, not a missing result. Recorded explicitly so the
        // archive list can label it instead of showing a blank outcome.
        draw: !!(socketRec && socketRec.draw),
        outcome: !socketRec || !socketRec.ended ? 'unknown'
               : socketRec.draw ? 'draw'
               : (socketRec.winner ? 'win' : 'unknown'),
        endedBy: endedBy || null,
        // The socket event that closed the game, when there was one. `endedBy` says which
        // channel won the race (socket / 结算浮层 / 五连兜底); this says which event name
        // the site actually used, which is the part that changes without notice.
        endEvent: socketRec ? (socketRec.endEvent || null) : null,
      },
    };
  }

  function baseOpts() {
    return {
      rule: isRenju() ? 2 : 0,
      thinkMs: S.thinkMs,
      openingCutoff: S.openingCutoff,
      suspect: S.suspect,
      // 0 = auto (half the cores, max 4). app.js resolves it, and forces 1 when the
      // single-threaded fallback build is what actually loaded.
      threadNum: S.threadNum,
    };
  }

  // ---------- player names ----------
  // Three-level fallback, in the order the 0.2.2 spec fixed:
  //   1. socket events (hook.js) — the only source that maps a name to a COLOUR;
  //   2. DOM scan — gives names but not colours, so it is stored as self/opponent;
  //   3. anonymous — the naming rule then drops the "A VS B" prefix entirely.
  // `source` is kept so the archive (and the operator) can tell which route won.
  // `player 1` / `player 2` / `spectating` are the spectate page's own initial text (its
  // <h3> elements ship with "Player 1" / "Player 2" before `spectate-joined` fills them in).
  // Without them the detector reads the placeholder as a real name and archives the game
  // as "Player 1 vs Player 2" whenever it attaches before the roster arrives.
  var NAME_PLACEHOLDERS = ['you', 'opponent', 'player', 'player2', 'player 1', 'player 2',
                           'spectating', '你', '您', '对手', '對手', '玩家', ''];

  // Selectors seen in the wild, best first. Kept as a list rather than one CSS query so
  // a site-side rename degrades to "no name" instead of "wrong name".
  var DOM_NAME_SEL = {
    // Only selectors that name a side EXPLICITLY. `#player-name-display` is "you" and
    // carries no colour, so it must not appear here — matching it would let the route
    // label the opponent white and you unknown ("黑 ? / 白 Bob"), which is a worse lie
    // than admitting the colours are unknown.
    //
    // 观战 (spectator) pages name the sides too, in their own container — those selectors
    // belong here precisely BECAUSE they carry the colour, unlike the unlabelled list that
    // `spectatorPair()` handles below.
    //
    // The 观战 page is a SEPARATE document (/spectate/, its own spectate.js) and shares no
    // markup with the play page: its names live in #spectate-player1-name / -player2-name,
    // and spectate.js fills them from `players.find(p => p.color === 'black' | 'white')`
    // — so, unlike the colourless pair, these two DO carry the colour. They are first in
    // the list because they are the only selectors verified against the live site; every
    // other entry is a guess that a rename elsewhere may invalidate.
    black: ['#spectate-player1-name',
            '.player-black .name', '[data-player="black"] .name', '.black-player .player-name',
            '.spectator-player.black .name', '.spectator-players .black .name',
            '.game-players .player.black .name', '[data-color="black"] .name'],
    white: ['#spectate-player2-name',
            '.player-white .name', '[data-player="white"] .name', '.white-player .player-name',
            '.spectator-player.white .name', '.spectator-players .white .name',
            '.game-players .player.white .name', '[data-color="white"] .name'],
    // Colours unknown: the site always shows "self" vs "opponent".
    self: ['#player-name-display', '.player-self .name', '[data-player="self"] .name'],
    opponent: ['#opponent-name-display-2', '#opponent-name', '.player-opponent .name',
               '[data-player="opponent"] .name'],
  };

  // The two names a spectator page shows side by side. There is no colour attached to them
  // (that is the whole problem with 观战), so they can only ever fill self/opponent — but
  // "A vs B（未对应黑白）" is far more use than "—", and it is what the naming rule then
  // prints instead of giving up.
  //
  // #spectate-player1-name / -player2-name are listed here only as a fallback for the case
  // where one of the two colour selectors above fails to match; when both match, the
  // colour-correct route wins and this list is never consulted.
  var SPECTATOR_PAIR_SEL = '#spectate-player1-name, #spectate-player2-name, ' +
                           '.spectator-players .player-name, .game-players .name, ' +
                           '.spectator-player .name, .game-players .player-name';

  function cleanName(el) {
    if (!el) return null;
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (NAME_PLACEHOLDERS.indexOf(t.toLowerCase()) >= 0) return null;
    return t.slice(0, 40);
  }

  function spectatorPair() {
    var nodes = document.querySelectorAll(SPECTATOR_PAIR_SEL);
    if (nodes.length < 2) return null;
    var a = cleanName(nodes[0]), b = cleanName(nodes[1]);
    if (!a || !b || a === b) return null;
    return { self: a, opponent: b };
  }

  function domOneOf(sels) {
    for (var i = 0; i < sels.length; i++) {
      var t = domText(sels[i]);
      if (t) return t;
    }
    return null;
  }

  function domText(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (NAME_PLACEHOLDERS.indexOf(t.toLowerCase()) >= 0) return null;
    return t.slice(0, 40);
  }

  function playerNames() {
    var out = { black: null, white: null, source: null };
    // 1) socket
    if (socketRec && socketRec.players) {
      out.black = socketRec.players.black || null;
      out.white = socketRec.players.white || null;
      if (out.black || out.white) out.source = 'socket';
    }
    // 2) DOM
    if (!out.black && !out.white) {
      var db = domOneOf(DOM_NAME_SEL.black), dw = domOneOf(DOM_NAME_SEL.white);
      if (db && dw) { out.black = db; out.white = dw; out.source = 'dom'; }
      else {
        // Side-by-side or not at all: a half-filled black/white pair would put a name on
        // the wrong colour, which is what the archive naming then prints.
        out.self = domOneOf(DOM_NAME_SEL.self);
        out.opponent = domOneOf(DOM_NAME_SEL.opponent);
        if (!out.self && !out.opponent) {
          // 观战: no "you"/"opponent" wording anywhere, just the two names in a list. Still
          // no colour, so it fills self/opponent — but it is a real pair of names, and it is
          // also the one reliable DOM sign that this session is a spectator.
          var sp = spectatorPair();
          if (sp) { out.self = sp.self; out.opponent = sp.opponent; out.spectator = true; }
        }
        if (out.self || out.opponent) out.source = 'dom';
      }
    }
    // 3) anonymous — nothing to fill in
    if (!out.source) out.source = 'none';
    return out;
  }

  // ---------- identity: 注册 / 游客 / 观战 ----------
  // Three session kinds that behave differently on the site (0.3.0 spec §2), and that were
  // previously told apart by nothing at all. Two sources, strongest first:
  //   1. hook.js's socket observations — an explicit guest/spectator flag, or the spectator
  //      side-by-side name list (that one comes back through `playerNames` above);
  //   2. the URL / page DOM.
  // `how` is stored next to the value. Every one of these is a heuristic and a wrong guess
  // is only fixable if the route that produced it is on record.
  var ID_SEL = {
    // #spectate-page / .spectator-mode-indicator / .spectator-badge are the 观战 page's own
    // markers (verified against the live /spectate/ document). `.spectate-info-bar` is
    // deliberately NOT here: the ONLINE BATTLE page also renders one (for players who
    // enable spectating of their own room), so matching it would label a normal player a
    // spectator — a badge that is always on says nothing.
    spectator: ['.spectator-mode', '[data-mode="spectator"]', '.spectator-panel',
                '#spectator-view', '.watch-mode', '#spectate-page',
                '.spectator-mode-indicator', '.spectator-badge'],
    guest: ['.guest-badge', '[data-account="guest"]', '.guest-tag', '[data-guest="true"]',
            '.guest-user'],
  };

  function hasAny(sels) {
    for (var i = 0; i < sels.length; i++) if (document.querySelector(sels[i])) return true;
    return false;
  }

  function detectIdentity(names) {
    var sock = socketRec || {};
    if (sock.spectator) return { identity: 'spectator', how: 'socket' };
    if (sock.guest) return { identity: 'guest', how: 'socket' };
    if (names && names.spectator) return { identity: 'spectator', how: 'dom-names' };
    if (/spectat|\/watch|\/replay|\/live/i.test(location.pathname)) {
      return { identity: 'spectator', how: 'url' };
    }
    if (hasAny(ID_SEL.spectator)) return { identity: 'spectator', how: 'dom' };
    if (hasAny(ID_SEL.guest)) return { identity: 'guest', how: 'dom' };
    return { identity: 'registered', how: 'default' };
  }

  // ---------- archives ----------
  // One archive per finished analysis. `job.archiveId` makes a re-run rewrite its own
  // entry instead of stacking a duplicate — the live stepwise session finishes exactly
  // once, but a manual 全局分析 on the same game is easy to trigger twice.
  async function archiveFromJob(job) {
    var report = job.report;
    if (!report) return null;
    // A null aggregate is a legitimate outcome (every move inside 开局排除, or all of
    // them forced defences) — the record and the per-move verdicts are still worth
    // keeping. Only a report with no verdicts at all is refused.
    var hasAgg = !!(report.black || report.white);
    if (!hasAgg && !(report.steps || []).length) return null;
    // 0.3.7 §一.1: a finalize job archives a SNAPSHOT taken when the game ended, not the
    // live collectors. Analysis is asynchronous and the collectors are reset synchronously
    // by the next game, so reading them here would file the new game's board under the old
    // game's name. `activeMoves()` stays the source for every other job (the operator asked
    // to analyse what is on screen right now).
    var record = job._snap ? job._snap.record : toRecord(activeMoves());
    var players = job._snap ? job._snap.players : playerNames();
    // Short games are not archived: a 6-move abort has no signal in it and would push a
    // real game out of the 200-entry cap. The threshold is a setting (5–30).
    //
    // 0.3.5: `totalMoves` is how many hands we actually SCORED, which is not the same as
    // how long the game was — when detection stops early on a live four the board may hold
    // many more. Testing the scored count threw away a 25-move game that stopped at move 12
    // ("对局过短：仅 12 手"), i.e. the data could not be saved at all. `originalTotalMoves`
    // is the real length; it is what viewer.js's archiveCurrent already uses.
    var total = report.originalTotalMoves || report.totalMoves || record.moves.length || 0;
    var minMoves = GMStorage.clampMinMoves(S.minArchiveMoves);
    if (total < minMoves) {
      job.note = T('panel|对局过短：仅 {n} 手（少于 {min} 手），未存档。', { n: total, min: minMoves });
      lastSkip = { moves: total, min: minMoves };
      lastArchive = null;
      // Short by THE RECORD's own length, not by what was scored. Marked as handled so the
      // finalize path does not re-evaluate it on every later signal.
      if (job._epoch != null) archivedEpoch[job._epoch] = true;
      console.log('[detector] ' + job.note);
      if (root) paintStatus();
      return null;
    }
    try {
      var entry = GMStorage.buildArchive({
        report: report,
        record: record,
        players: players,
        mode: S.mode,
        rule: isRenju() ? 'renju' : 'freestyle',
        suspect: S.suspect,
        outcome: record.meta.outcome,
      });
      await GMStorage.saveArchive(entry, { replaceId: job.archiveId || null });
      job.archiveId = entry.id;
      lastArchive = entry;
      lastSkip = null;
      if (job._epoch != null) archivedEpoch[job._epoch] = true;   // 0.3.7 §一.1
      console.log('[detector] 已存档：' + entry.name);
      if (root) paintStatus();
      return entry;
    } catch (e) {
      console.warn('[detector] 存档失败：' + ((e && e.message) || e));
      job.note = T('panel|存档失败：{err}', { err: TE((e && e.message) || e) });
      return null;
    }
  }

  // ---------- record sources ----------
  // Index of the move that most recently arrived with a real timestamp. Needed because
  // a board render can confirm a stone in place, which does not grow the array.
  function lastObservedIdx(mv) {
    var best = -1, bt = -Infinity;
    for (var i = 0; i < mv.length; i++) {
      if (mv[i].inferred) continue;
      var t = typeof mv[i].t === 'number' ? mv[i].t : -1;
      if (t > bt) { bt = t; best = i; }
    }
    return best;
  }

  window.addEventListener(EV_EVENT, function (e) {
    var p;
    try { p = JSON.parse(e.detail); } catch (err) { return; }
    if (!p || !p.data || p.data.source !== 'socket') return;

    // 0.3.7 §一.1 — ORDER IS LOAD-BEARING for `reset`. It arrives together with a snapshot
    // that has ALREADY been cleared, so the previous game must be finalised while `socketRec`
    // still holds it, i.e. BEFORE the assignment below. Reading it afterwards finalises an
    // empty board and loses exactly the game this section exists to save.
    //
    // `seed` is deliberately NOT treated as a new game: it means the board merely revealed
    // moves we never saw (joined mid-game / resync). Finalising there would archive the first
    // half of the CURRENT game — the mid-join fixture has 12 restored stones on the board
    // before the socket's seed even arrives, and "new game" would file that as a finished
    // record. Only the session is retired; the epoch is left alone.
    if (p.kind === 'reset') {
      beginNewGame('新对局开始');
    }

    // 0.4.1 §三.2: put the socket's timestamps on THIS file's clock before they are stored —
    // one correction at the single ingest point beats every consumer remembering to apply it.
    socketRec = alignSocketClock(p.data);

    if (p.kind === 'reset') {
      ended = false; endedBy = '';
      paint();
      return;
    }

    if (p.kind === 'players') { paintStatus(); return; }

    if (p.kind === 'seed') {
      // The board revealed moves we never saw (joined mid-game / resync). Anything the live
      // session had accumulated no longer lines up with the record, so it is retired — but
      // the game itself continues, so nothing is archived and `gameEpoch` does not move.
      if (liveJob) { liveJob.status = '已中止'; liveJob = null; }
      liveStopped = null;      // the record no longer matches what was stopped on
      // Debug line: §1.7's exception says console output stays Chinese and untranslated.
      // It also used to reference an undeclared `src.side`, which threw a ReferenceError out
      // of this listener and skipped the paintStatus() below it — so a mid-game join left the
      // panel stale until the next event.
      console.log('[detector] 已从盘面还原 ' + (socketRec.seedSource || '?') +
                  '：' + socketRec.inferredCount + ' 手（手序不可恢复）');
      paintStatus();
      return;
    }

    if (p.kind === 'move' || p.kind === 'attached') {
      if (socketRec.moves.length) {
        var idx = lastObservedIdx(socketRec.moves);
        if (S.mode === 'stepwise' && idx >= 0) liveStepFor(idx);
      }
    }
    if (p.kind === 'end') {
      // A draw arrives as a normal end event with `winner: null`; naming it correctly is
      // the difference between "game-end 事件" and an operator wondering which side won.
      // The event NAME is printed too (0.3.0 §2.2): a guest game that "never ends" is
      // usually a name we were not listening for, so seeing the one that did fire is the
      // whole diagnosis. `game-end` keeps its old wording so nothing downstream shifts.
      var evName = socketRec.endEvent || 'game-end';
      // An abandoned game (opponent left / room reclaimed) has no winner and is not a
      // draw, so printing the bare event name would leave the operator to look it up.
      var label = (socketRec.end && socketRec.end.type === 'abandoned')
        ? '对局中止（' + evName + '）'
        : evName + ' 事件';
      endGame(label + (socketRec.draw ? '（和棋）' : ''));
    }
    paintStatus();
  });

  // The board's intersections. Four selectors, most specific first: the play page's own
  // container, the 观战 page's own container (`#spectate-board`, a separate document with
  // its own spectate.js), then any grid container, then the bare intersection class — a
  // spectator page renders the board under a different wrapper, but the intersections
  // themselves are the board, so matching them directly is the last honest fallback.
  function boardCells() {
    var cells = document.querySelectorAll('#online-player-board .board-intersection');
    if (!cells.length) cells = document.querySelectorAll('#spectate-board .board-intersection');
    if (!cells.length) cells = document.querySelectorAll('.board-grid-container .board-intersection');
    if (!cells.length) cells = document.querySelectorAll('.board-intersection');
    return cells;
  }

  function findGrid() {
    var g = document.querySelector('#online-player-board .board-grid-container') ||
            document.querySelector('#spectate-board .board-grid-container') ||
            document.querySelector('.board-grid-container') ||
            document.querySelector('.spectator-board .board-grid-container');
    if (g) return g;
    var cell = document.querySelector('.board-intersection');
    return cell ? cell.parentNode : null;
  }

  // One key convention for a board point, everywhere: `row,col`, in this order. hook.js has
  // the identical `keyOf()` on the other side of the world boundary, and `toRecord` uses it
  // for dedup too — a mixed order would not break anything on its own, but the two keys
  // look interchangeable and that is how a future merge/dedup between them goes wrong.
  function cellKey(r, c) { return r + ',' + c; }

  // online.js appends one .stone.black-stone | .stone.white-stone per played cell.
  // Returns null when the board has not been built yet (unknown) vs [] for "empty".
  function boardStones() {
    var cells = boardCells();
    if (!cells.length) return null;
    var out = [];
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var st = cell.querySelector('.stone');
      if (!st) continue;
      var cls = st.classList;
      var stone = cls.contains('black-stone') ? 1 : cls.contains('white-stone') ? 2 : 0;
      if (!stone) continue;
      out.push({ row: parseInt(cell.dataset.row, 10), col: parseInt(cell.dataset.col, 10), stone: stone });
    }
    return out;
  }

  // Reconcile the record against the live board.
  //
  // A *batch* of previously unseen stones can only come from a board render — joining
  // a game already in progress, or a reconnect resync. Its stones are known but their
  // order is not, so they form an "inferred" block that leads the record and is never
  // scored (it exists so later positions are evaluated on the right board).
  // A *lone* new stone is an ordinary move: arrival order is play order.
  //
  // Mirrors hook.js's absorbStones(); keep the two in step.
  function reconcileDom() {
    var stones = boardStones();
    if (stones === null) return;
    if (!stones.length) return;                 // board cleared -> see emptySince in tickDom
    emptySince = 0;

    var onBoard = {};
    for (var i = 0; i < stones.length; i++) onBoard[cellKey(stones[i].row, stones[i].col)] = true;

    // Stones the board no longer shows (undo / reset / new game).
    var kept = [];
    for (var j = 0; j < domMoves.length; j++) {
      if (onBoard[cellKey(domMoves[j].row, domMoves[j].col)]) kept.push(domMoves[j]);
    }
    if (kept.length !== domMoves.length) {
      // Keep the invariant that unknown-order stones lead the record.
      var inf = [], obs = [];
      for (var d = 0; d < kept.length; d++) (kept[d].inferred ? inf : obs).push(kept[d]);
      domMoves = inf.concat(obs);
    }

    var have = {};
    for (var k = 0; k < domMoves.length; k++) have[cellKey(domMoves[k].row, domMoves[k].col)] = true;

    var fresh = [];
    for (var q = 0; q < stones.length; q++) {
      if (!have[cellKey(stones[q].row, stones[q].col)]) fresh.push(stones[q]);
    }
    if (!fresh.length) return;

    if (fresh.length === 1) {
      var s = fresh[0];
      domMoves.push({ row: s.row, col: s.col, stone: s.stone, t: Math.round(performance.now()), inferred: false });
      if (S.mode === 'stepwise') liveStepFor(domMoves.length - 1);
      paintStatus();
      return;
    }

    // Deterministic order inside the block: colours alternate (black first) with each
    // colour taken in row-major order. Arbitrary by construction — it only has to keep
    // the move INDEX -> SIDE mapping right, which every per-side statistic relies on.
    fresh.sort(function (a, b) {
      return (a.row - b.row) || (a.col - b.col) || (a.stone - b.stone);
    });
    var blacks = [], whites = [];
    for (var f = 0; f < fresh.length; f++) {
      if (fresh[f].stone === 2) whites.push(fresh[f]); else blacks.push(fresh[f]);
    }
    var block = [];
    while (blacks.length || whites.length) {
      if (blacks.length) { var bb = blacks.shift(); block.push({ row: bb.row, col: bb.col, stone: bb.stone, t: null, inferred: true }); }
      if (whites.length) { var ww = whites.shift(); block.push({ row: ww.row, col: ww.col, stone: ww.stone, t: null, inferred: true }); }
    }
    domMoves = block.concat(domMoves);
    domSeeded = block.length;
    console.log('[detector] board render absorbed: ' + block.length + ' 手（手序不可恢复，仅还原盘面）');
    paintStatus();
  }

  function startDomObserver() {
    var grid = findGrid();
    if (!grid || grid === domGrid) return;
    domGrid = grid;
    // A different grid element means the page rendered a new board (0.3.7 §一.1): finalize
    // whatever the previous one collected before clearing.
    beginNewGame('新对局开始（棋盘已重建）');
    domMoves = [];
    domSeeded = 0;
    emptySince = 0;
    new MutationObserver(function () { reconcileDom(); })
      .observe(grid, { childList: true, subtree: true });
    reconcileDom();
  }

  // Board emptied without a reset event: only trust it after it stays empty a while,
  // so a clear-then-repaint render cycle is not mistaken for a new game.
  function tickDom() {
    var stones = boardStones();
    if (stones && !stones.length && domMoves.length) {
      var now = performance.now();
      if (!emptySince) emptySince = now;
      else if (now - emptySince > 1500) {
        emptySince = 0;
        // A cleared board IS the next game, usually before any event says so (0.3.7 §一.1).
        beginNewGame('新对局开始（棋盘已清空）');
        domMoves = []; domSeeded = 0;
        paintStatus();
      }
      return;
    }
    emptySince = 0;
    reconcileDom();
  }

  // ---------- end-of-game detection ----------
  // A win and a draw do not necessarily surface through the same DOM. The original probe
  // only knew `.game-end-overlay`, so a drawn game could sit there "in progress" forever:
  // no end event, so maybeAuto() never fired, so no report. Three independent signals now:
  //   1. the settlement overlay (wins, resignations),
  //   2. a draw-specific overlay — matched loosely, but only accepted when it actually has
  //      text, because the site renders several empty placeholder nodes whose class names
  //      contain "draw",
  //   3. a completely full 15x15 board. In gomoku that is unambiguous: no legal move is
  //      left, the game is over, whatever the UI is doing.
  // `socketRec.draw` (hook.js normalises winner:null) is the fourth, and it arrives through
  // the socket event handler rather than here.
  function drawOverlay() {
    var nodes = document.querySelectorAll('.game-draw-overlay, .game-result-draw, [data-result="draw"], [class*="draw"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.classList.contains('hidden')) continue;
      if (el.hasAttribute('hidden')) continue;
      if (el.style && el.style.display === 'none') continue;
      if (!(el.textContent || '').trim()) continue;
      return el;
    }
    return null;
  }

  function boardFull() {
    var cells = boardCells();
    if (cells.length < 225) return false;
    for (var i = 0; i < cells.length; i++) if (!cells[i].querySelector('.stone')) return false;
    return true;
  }

  // ---------- five in a row: the game really is over ----------
  // A guest game (0.3.0 §2 场景②) can end with no settlement overlay we recognise and no
  // socket `game-end`, which left the panel at "采集中" forever and the game never analysed.
  // Five joined stones is the one end signal that does not depend on which UI the site
  // happens to render: the stones are on the board and, in every rule set, five in a row
  // ends the game (in Renju a black OVERLINE is a loss rather than a win — still the end).
  //
  // This is deliberately not "no move for 30 seconds => assume finished". A player may
  // legitimately think for minutes, and ending a live game early would archive a partial
  // record as though it were the whole game — a wrong archive is worse than a missing one.
  // A five cannot exist in a position that is still being played.
  var FIVE_GRACE_MS = 3000;      // let the site's own overlay/socket event win the race
  var fiveSince = 0;

  function sideWithFive(moves) {
    var grid = {}, i, d, k;
    for (i = 0; i < moves.length; i++) {
      if (moves[i] && moves[i].stone) grid[cellKey(moves[i].row, moves[i].col)] = moves[i].stone;
    }
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];   // vertical / horizontal / both diagonals
    // Scanning forward from EVERY stone covers a run from any of its members, so no
    // backward pass is needed.
    for (i = 0; i < moves.length; i++) {
      var a = moves[i];
      if (!a || !a.stone) continue;
      for (d = 0; d < dirs.length; d++) {
        var run = 1;
        for (k = 1; k < 5; k++) {
          if (grid[cellKey(a.row + dirs[d][0] * k, a.col + dirs[d][1] * k)] !== a.stone) break;
          run++;
        }
        if (run >= 5) return a.stone === 1 ? 'B' : 'W';
      }
    }
    return null;
  }

  function endGame(by) {
    if (ended) return;
    ended = true;
    endedBy = by;
    onGameEnd();
  }

  // ---------- 0.3.7 §一.1: 结算文案探测 ----------
  // 现有结束通道要么依赖具体 class（`.game-end-overlay`），要么依赖 socket 事件名，两者都会
  // 随站点改版漂移 —— 而「和棋」和「对手中途离开」正是最容易漏掉的两类：没有五连，结算浮层
  // 的 class 也可能换名字，于是这一局永远停在「采集中」，报告和存档都出不来。
  //
  // 结算 UI 一定会给出「再来一局」这类按钮，或直接写出「和棋」。按钮的存在本身就是「上一局
  // 已经结束」的可靠证据，与 class 名无关，所以用它兜一层。
  var END_TEXT_RE = /(再来一局|再來一局|再来一盘|再來一盤|和棋|平局|和局|rematch|play\s*again|draw|引き分け|もう一度|무승부|다시\s*하기)/i;

  // Visible = has layout boxes. `offsetParent` is deliberately not used: it is also null for
  // position:fixed elements, and an overlay is exactly that.
  function visibleText(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return '';
    if (el.hasAttribute && el.hasAttribute('hidden')) return '';
    if (el.classList && el.classList.contains('hidden')) return '';
    var st = el.style || {};
    if (st.display === 'none' || st.visibility === 'hidden') return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function endProbe() {
    // Buttons/links first: 「再来一局」 can only appear after the game is over.
    var btns = document.querySelectorAll('button, a, [role="button"], [class*="btn"]');
    for (var i = 0; i < btns.length; i++) {
      var t = visibleText(btns[i]);
      if (t && t.length <= 24 && END_TEXT_RE.test(t)) return t.slice(0, 14);
    }
    // Then the result text inside a dialog-ish container: a bare 「和棋 / Draw」.
    var boxes = document.querySelectorAll(
      '[class*="overlay"],[class*="modal"],[class*="dialog"],[class*="popup"],[class*="result"],[class*="finish"]');
    for (var j = 0; j < boxes.length; j++) {
      var txt = visibleText(boxes[j]);
      if (txt && txt.length <= 24 && END_TEXT_RE.test(txt)) return txt.slice(0, 14);
    }
    return null;
  }

  function pollEnd() {
    if (!ended) {
      var o = document.querySelector('.game-end-overlay');
      var ep = null;
      if (o && !o.classList.contains('hidden')) {
        endGame('结算浮层');
      } else if (drawOverlay()) {
        endGame('和棋浮层');
      } else if ((ep = endProbe())) {
        // Only evaluated when every earlier branch missed, so the DOM scan happens once.
        endGame('结算文案（' + ep + '）');
      } else if (activeMoves().length >= 200 && boardFull()) {
        // Guarded by the move count: a full board can only happen at the very end, and the
        // count keeps a mis-selected 225-node grid from ending a game on the first tick.
        endGame('棋盘已满（和棋）');
      } else if (sideWithFive(activeMoves())) {
        // Held back for a moment so the site's own channels get to name the ending first.
        if (!fiveSince) fiveSince = performance.now();
        else if (performance.now() - fiveSince > FIVE_GRACE_MS) endGame('五连成立（无结算浮层）');
      } else if (activeMoves().length >= 5 && lastMoveAt > 0 &&
                 performance.now() - lastMoveAt > STALL_MS) {
        // Last-resort backstop, for an ending that announced itself on NO channel we can
        // see: no end event, no overlay, no five. Two real shapes reach it — the socket is
        // unreachable (the 观战 page's spectate.js never sets `window.socket`, so hook.js
        // cannot attach there), or the server closed the room without telling the client.
        //
        // The threshold is the SAME one the status line already calls "no way forward"
        // (STALL_MS = 3 min), not the 30 s the spec proposed. A player may legitimately
        // think for minutes, and archiving a half-played game as though it were finished
        // is worse than archiving nothing; 3 minutes of silence in a clocked online game
        // is not a think, it is a dead game.
        endGame('超时兜底（' + Math.round(STALL_MS / 60000) + ' 分钟无落子）');
      } else {
        fiveSince = 0;
      }
    }
    paintStatus();
  }

  // 兜底: no end event, no overlay, and the moves stopped coming. The panel must never
  // leave the operator staring at "采集中" with no way forward, so after a long stall the
  // status line says so and points at the manual button.
  var lastMoveAt = 0, lastMoveCount = 0;
  var STALL_MS = 180000;
  function tickStall() {
    var n = activeMoves().length;
    if (n !== lastMoveCount) { lastMoveCount = n; lastMoveAt = performance.now(); }
    else if (!lastMoveAt) lastMoveAt = performance.now();
  }
  function stalled() {
    if (ended || !activeMoves().length || running()) return false;
    return lastMoveAt > 0 && (performance.now() - lastMoveAt) > STALL_MS;
  }

  // ---------- offscreen bridge ----------
  function send(message) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(message, function (resp) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  function ensureOffscreen() {
    return send({ type: 'gm-ensure-offscreen' });
  }

  // One-shot request with retry: the browser may evict the offscreen document.
  async function askOffscreen(message, attempts) {
    await ensureOffscreen();
    var lastErr = T('panel|offscreen 文档没有响应（检查扩展是否已重新加载）');
    var n = attempts || 6;
    for (var i = 0; i < n; i++) {
      var resp = null;
      try { resp = await send(message); }
      catch (e) { lastErr = String((e && e.message) || e); }
      if (resp && resp.ok) {
        if (resp.info) noteEngine(resp.info);
        return resp;
      }
      if (resp && (resp.error || resp.aborted)) return resp;
      await ensureOffscreen().catch(function () {});
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    throw new Error(lastErr);
  }

  // 0.2.5: multi-threading is the default build now, so "which engine produced this number"
  // is worth a line of its own — a report analysed on the single-threaded fallback reaches a
  // different depth in the same budget, and the operator has no way to know otherwise.
  function noteEngine(info) {
    if (!info) return;
    if (info.degraded) {
      engineNote = T('panel|引擎降级为单线程模式：{reason}（分析仍可进行，同等预算下思考深度略低）。',
        { reason: TE(info.reason) || T('panel|多线程 WASM 在此环境不可用') });
    } else if (info.threads) {
      engineNote = T('panel|引擎：多线程构建 · {n} 线程。', { n: info.threadNum || 1 });
    } else {
      engineNote = '';
    }
  }

  // 0.3.2 C3: `gm-warmup` is the first call that can report a degraded engine, and both
  // call sites used to throw its `info` away. The result was that a fallback to the
  // single-threaded build only surfaced with the first real analysis, which can be minutes
  // later — long enough for the operator to conclude that multi-threading was never on.
  function warmup() {
    return ensureOffscreen()
      .then(function () { return send({ type: 'gm-warmup' }); })
      .then(function (resp) {
        if (resp && resp.info) { noteEngine(resp.info); paintStatus(); }
      })
      .catch(function () {});
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'gm-progress') {
      var job = findJob(msg.jobId);
      if (!job) return;
      job.progress = msg.p;
      job.progressMsg = msg.msg;
      if (selectedId == null) selectedId = job.id;
      paintStatus();
      return;
    }
    if (msg.type === 'gm-restore-panel') {
      // The `×` removed the panel; the extension icon asks us to put it back.
      sendResponse({ restored: restorePanel() });
    }
  });

  // ---------- job queue ----------
  function findJob(jobId) {
    for (var i = 0; i < jobs.length; i++) if (jobs[i].id === jobId) return jobs[i];
    return null;
  }
  function newJob(mode, label) {
    seqCounter++;
    var job = {
      // `seqCounter` is per page, so two tabs that start their first job in the same
      // millisecond would build the SAME id — and jobId is what tells the offscreen
      // document whose live session / progress broadcast a message belongs to. The random
      // suffix makes a collision impossible instead of merely unlikely.
      id: 'j' + Date.now() + '_' + seqCounter + '_' + Math.random().toString(36).slice(2, 8),
      seq: seqCounter,
      mode: mode,                 // 'global' | 'step' | 'step-live'
      label: label,
      status: '待分析',
      progress: 0,
      progressMsg: '',
      report: null,
      summary: null,
      error: '',
      archiveId: null,
      _busy: false,
      _queue: [],
    };
    jobs.push(job);
    return job;
  }
  function running() { return runningJob || liveJob; }

  function pump() {
    if (running()) return;
    for (var i = 0; i < jobs.length; i++) {
      if (jobs[i].status === '待分析') { startJob(jobs[i]); return; }
    }
  }

  async function startJob(job) {
    runningJob = job;
    job.status = '分析中';
    selectedId = job.id;
    // 0.4.1 §五.4: ONE snapshot, taken here, used by BOTH the engine request below and the
    // archive written when the run finishes.
    //
    // Before this, the request read the live collectors at start (`toRecord(activeMoves())`)
    // and `archiveFromJob` read them AGAIN after the analysis — which on a live board is
    // seconds later and several moves further on. The archive then described a different
    // position from the one the report was computed for: every row's verdict pointed at a hand
    // the record did not have, and the extra moves were stored unanalysed. GLOBAL/逐步分析 on
    // a game still in progress is exactly when this happened, and it is the common case.
    //
    // A finalize job arrives with its own `_snap` (taken when the game ended, see
    // finalizeGame); `if (!job._snap)` keeps that one — it is older and therefore righter.
    // `snapshotGame()` returns null on an empty board, which leaves both fallbacks intact.
    if (!job._snap) job._snap = snapshotGame();
    paint();
    try {
      // 0.3.7 §一.1: a finalize job carries the snapshot taken when the game ended.
      var snap = job._snap;
      var record = snap ? snap.record : toRecord(activeMoves());
      if (!record.times.some(function (v) { return v != null; })) {
        job.note = T('panel|无时间数据，降级为固定预算模式');
      }
      // 前置中途加入拦截. The mid-join signal used to be invisible from here: the offscreen
      // document refused the request with 「引擎正忙」 and the operator read that as a hang
      // instead of "the data was never complete to begin with". Whether the run is allowed
      // is unchanged (the pre-join stones are excluded from scoring, not from the board),
      // but the reason is now stated up front on the job itself.
      var inferred = snap ? snap.inferred : countInferred(activeMoves());
      if (inferred) {
        var midNote = T('panel|检测器中途加入：前 {n} 手由盘面还原，手序不可恢复，不参与命中率/时间统计。', { n: inferred });
        job.note = job.note ? (job.note + ' ｜ ' + midNote) : midNote;
      }
      paint();
      var resp = await askOffscreen(
        job.mode === 'global'
          ? { type: 'gm-analyze', jobId: job.id, record: record, opts: baseOpts() }
          : { type: 'gm-analyze-stepwise', jobId: job.id, record: record, opts: baseOpts() }
      );
      if (resp.aborted) { job.status = '已中止'; job.error = T('panel|被新的分析任务中断'); }
      else {
        job.report = resp.report;
        job.status = '已完成';
        await archiveFromJob(job);
      }
    } catch (e) {
      job.status = '失败';
      job.error = String((e && e.message) || e);
    } finally {
      runningJob = null;
      paint();
      pump();
    }
  }

  // 实时逐步：analyse one move as it lands.
  function startLiveSession() {
    if (liveJob) return liveJob;
    // An explicit restart (手动「开始分析」) is the operator overriding the stop, so the
    // 已终止 banner comes down here. Anything else that reaches this point has already
    // been blocked by the liveStopped guard in liveStepFor.
    liveStopped = null;
    liveJob = newJob('step-live', '实时逐步');
    liveJob.status = '分析中';
    liveJob._reset = true;
    liveJob._terminal = false;
    selectedId = liveJob.id;
    // Warm the engine up front so the first move is not stuck behind a 10-30s load.
    warmup();
    return liveJob;
  }

  async function liveStepFor(idx) {
    if (S.mode !== 'stepwise') return;
    if (runningJob) return;                       // 全局/回放正在跑 -> 让位
    var moves = activeMoves();
    if (idx < 0 || idx >= moves.length) return;

    // 0.3.5: a finished-for-good session must not be resurrected by the next move. Without
    // this, the line below would build a brand-new live session the moment liveJob was
    // retired by the terminal handler, and detection would quietly restart mid-game.
    if (liveStopped) return;
    if (!liveJob) startLiveSession();
    // 0.3.1 活四停止: once a live four appeared, no further hand is scored. The game may
    // keep going, but the live analysis is finished — further moves are ignored here.
    if (liveJob._terminal) return;
    // Analysis can lag behind play (engine warm-up, slow budgets): queue every index so
    // no move is silently skipped.
    if (liveJob._busy) { if (liveJob._queue.indexOf(idx) < 0) liveJob._queue.push(idx); return; }

    liveJob._busy = true;
    try {
      var actualMove = moves[idx];
      var record = toRecord(moves.slice(0, idx + 1));
      // toRecord drops repeated coordinates, so the move being stepped is the LAST kept
      // one — and if this index did not survive, it was a capture artefact (a replayed
      // event or a render confirming a stone we already had) with nothing new to score.
      var pos = record.moves.length - 1;
      var last = record.moves[pos];
      if (!last || last[0] !== actualMove.col || last[1] !== 14 - actualMove.row) return;
      var resp = await askOffscreen({
        type: 'gm-step',
        jobId: liveJob.id,
        reset: !!liveJob._reset,
        prefix: record.moves.slice(0, -1),
        // 0.3.4: the prefix's real colours, for the live-four shape test. Index parity would
        // be wrong the moment a stone was duplicated, dropped or recovered from a render —
        // exactly the same reason `side` below is sent rather than derived.
        prefixSides: record.stones.slice(0, -1).map(function (s) {
          return s === 1 ? 'B' : (s === 2 ? 'W' : null);
        }),
        actual: last,
        playerIdx: pos,
        // The recorded colour, not the index: a duplicated or missing stone would shift
        // every later move to the wrong side.
        side: actualMove.stone ? (actualMove.stone === 1 ? 'B' : 'W') : null,
        recorded: record.times[pos],
        prejoinCount: countInferred(moves.slice(0, idx + 1)),
        opts: baseOpts(),
      }, 3);
      liveJob._reset = false;
      if (resp.ok) {
        liveJob.summary = resp.summary;
        liveJob.progress = Math.min(99, 100 * (idx + 1) / Math.max(moves.length, 1));
        if (resp.step && resp.step.budgetMs != null) lastStepBudget = resp.step.budgetMs;
        // 0.3.1 活四停止 / 0.3.5: a real live four came back — no further hand is scored,
        // and the session is closed on the spot (see below) rather than left hanging until
        // the game-end event. The game itself may continue; the ANALYSIS is over.
        if (resp.step && resp.step.terminal) {
          liveJob._terminal = true;
          var tMoveNo = resp.step.moveNo != null ? resp.step.moveNo : (idx + 1);
          var tReason = resp.step.stopReason || '活四';
          liveJob.note = T('panel|检测提前终止（第 {n} 手）：{reason}',
            { n: tMoveNo, reason: TO('stopReason', tReason) });
          liveStopped = { moveNo: tMoveNo, reason: tReason };
          // 0.3.5: finish NOW instead of waiting for game-end. The old flow left liveJob
          // alive and only called liveFinish() from onGameEnd(), so until that event
          // arrived the panel said 「分析中 · 实时逐步」 next to a note that said 检测停止 —
          // two contradictory lines, which is the "系统提示终止但分析还在进行" report. Worse,
          // when game-end never fires (结算浮层 selector miss, 和棋, 游客, 观战) the session
          // dangled forever and the report — hence the archive — was never produced at all.
          // liveFinish() retires liveJob synchronously, so the `finally` below sees it gone
          // and correctly drops the queued indices instead of stepping them.
          liveFinish();
          return;
        }
      } else {
        liveJob.error = resp.error || '';
      }
    } catch (e) {
      if (liveJob) liveJob.error = String((e && e.message) || e);
    } finally {
      if (liveJob) {
        liveJob._busy = false;
        var next = liveJob._queue.shift();
        paint();
        if (next != null) liveStepFor(next);
      }
    }
  }

  async function liveFinish() {
    if (!liveJob) return;
    var job = liveJob;
    liveJob = null;
    job._busy = false;
    try {
      var resp = await askOffscreen({ type: 'gm-step-finish', jobId: job.id }, 3);
      if (resp.ok) {
        job.report = resp.report;
        job.status = '已完成';
        job.progress = 100;
        await archiveFromJob(job);
      } else { job.status = '失败'; job.error = resp.error || ''; }
    } catch (e) {
      job.status = '失败';
      job.error = String((e && e.message) || e);
    }
    paint();
    pump();
  }

  // ---------- 0.3.7 §一.1: 对局收尾 ----------
  // 「一局结束」可能由 socket 事件、结算浮层、五连、棋盘已满或超时宣布 —— 也可能谁都不说，
  // 唯一的证据是**下一局已经开始了**。旧实现把「新局开始」当成纯粹的丢弃信号：reset /
  // seed / 棋盘清空都把 liveJob 直接置 null，于是上一局既没有报告也没有存档。用户报的
  // 「中途结束 / 和棋无法保存」「再来一局后上一局丢了」就是这一条路径。
  //
  // 现在所有路径都先经过 finalizeGame()：**同步**抓一份当前对局的快照，再**异步**分析归档。
  // 快照是必需的 —— 分析要走引擎（几秒），而重置是同步的，等结果回来时盘面可能已经是下一局，
  // 那时再读 activeMoves() 就会把新局写到旧局名下。
  function snapshotGame() {
    var mv = activeMoves();
    if (!mv.length) return null;
    var copy = [];
    for (var i = 0; i < mv.length; i++) {
      var m = mv[i];
      copy.push({ row: m.row, col: m.col, stone: m.stone, t: m.t, inferred: !!m.inferred });
    }
    return {
      moves: copy,
      record: toRecord(copy),
      players: playerNames(),
      inferred: countInferred(copy),
    };
  }

  // `force` distinguishes the two callers:
  //   · the game ended normally  → respect 对局结束自动分析 (the operator's setting);
  //   · a new game is starting   → this is the LAST chance to keep the data, so archive
  //     whatever was collected even if auto-analysis is off (0.3.7 §一.1: 样本不能再丢).
  async function finalizeGame(reason, force) {
    var epoch = gameEpoch;
    if (archivedEpoch[epoch]) return null;            // 本局已归档，收尾是幂等的
    var snap = snapshotGame();
    if (!snap || !snap.record.moves.length) return null;
    var total = snap.record.moves.length;
    var minMoves = GMStorage.clampMinMoves(S.minArchiveMoves);
    if (total < minMoves) {
      // Same short-game rule the archive path uses, applied early so the decision is made
      // once and never re-litigated on the following signals. The session (if any) is retired
      // here too: leaving it alive would let it adopt the next game's moves.
      archivedEpoch[epoch] = true;
      lastSkip = { moves: total, min: minMoves };
      if (liveJob) { liveJob.status = '已中止'; liveJob = null; }
      console.log('[detector] 收尾跳过（' + reason + '）：仅 ' + total + ' 手，少于 ' + minMoves + ' 手');
      if (root) paintStatus();
      return null;
    }
    if (!force && !S.autoAnalyze) {
      // The operator turned 「对局结束自动分析」 off. A normal ending is left for the manual
      // 「结束并出报告」 button, exactly as before.
      if (liveJob) {
        liveJob.status = '已暂停';
        liveJob.note = T('panel|自动分析已关闭，点「结束并出报告」收尾');
      }
      return null;
    }
    if (liveJob) {
      // The live session already holds everything it scored; let it produce the report.
      liveJob._snap = snap;
      liveJob._epoch = epoch;
      console.log('[detector] 收尾：' + reason + '（实时会话 ' + total + ' 手）');
      await liveFinish();
      return null;
    }
    // No live session: this game was never analysed (auto-analysis was off, the detector was
    // opened mid-game, or the session was retired). The stones are on record, so produce the
    // report now — otherwise the game is lost, which is the bug being fixed.
    var job = newJob(S.mode === 'stepwise' ? 'step-live' : 'global', '收尾分析');
    job._snap = snap;
    job._epoch = epoch;
    job.note = T('panel|{reason}：为上一局补出报告并存档（{n} 手）', { reason: reason, n: total });
    console.log('[detector] 收尾：' + reason + '（补分析 ' + total + ' 手）');
    paint();
    pump();
    return job;
  }

  // Called by every path that begins a new game. Order matters: finalize BEFORE the
  // collectors are cleared, then bump the epoch so the next game's archive cannot be
  // credited to this one. The cleanup afterwards is a backstop — a session that outlived its
  // game would silently adopt the next game's moves.
  //
  // 0.3.7 §一.1 — 但「新局开始」这个信号本身是**不可信**的：`hook.js` 把 `game-start` /
  // `game-reset` / `game-restart` / `rematch-start` 全部映射成 `reset`，而 `game-start` 在
  // **中途加入**时也会来一发 —— 那时盘面上已经有棋子，但它们全是 `inferred`（从盘面还原，
  // 我们从没观测到落子），属于**当前这局的开局**，不是上一局的残局。照单收尾就会把刚加入的
  // 这局的前半盘当成一局完整棋归档（D4 中途加入夹具正是这个形状：12 颗 inferred 子 →
  // 一条「12 手 / prejoin=12 / 有效样本 0」的垃圾存档，还顺带把测试等的那一条挤成两条）。
  //
  // 判据用「至少观测到过 1 手」：中途加入的盘面一手都不满足，而操作者报的
  // 「上一局没结束就点了再来一局」里上一局是**看着下完的**，每手都带真实时间戳，必然满足。
  // 这道闸门不会漏掉任何能救的数据 —— 全是 inferred 的记录一手都算不出命中率，
  // archiveFromJob 本来就拒收。
  function beginNewGame(reason) {
    if (hasObservedMove()) finalizeGame(reason, true);
    if (liveJob) { liveJob.status = '已中止'; liveJob = null; }
    liveStopped = null;
    gameEpoch++;
  }

  // 记录里有没有「我们亲眼看过落子」的手。`inferred` 是唯一可靠判据（合并进来的手 t 为 null，
  // 但 inferred 才是「这手不是观测到的」的权威标记）。
  function hasObservedMove() {
    var mv = activeMoves();
    for (var i = 0; i < mv.length; i++) if (!mv[i].inferred) return true;
    return false;
  }

  function onGameEnd() {
    // 对局结束自动分析 is a user setting — when it is off, the game still gets
    // recorded, it just waits for the operator to press the button. finalizeGame() carries
    // that branch itself; passing force=false is what keeps the setting meaningful.
    finalizeGame('对局结束（' + (endedBy || '未知') + '）', false);
  }

  function abortRunning() {
    var job = running();
    if (!job) return;
    if (liveJob) { liveFinish(); return; }
    send({ type: 'gm-abort', jobId: job.id }).catch(function () {});
  }

  // ---------- UI (Shadow DOM so the page's CSS cannot reach us) ----------
  var host = null, root = null, els = {};

  var CSS = [
    // --gm-max is what caps the panel: 86vh while the height is auto, the dragged height
    // once the operator has resized it. Keeping it in a variable means the resize code
    // never has to fight a hard-coded max-height.
    ':host{all:initial;position:fixed;top:12px;right:12px;width:580px;--gm-max:86vh;z-index:2147483647;display:block;',
    'font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#e6edf3}',
    '*{box-sizing:border-box}',
    '.gm{background:#161b22;border:1px solid #2a3441;border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column;max-height:var(--gm-max);position:relative}',
    // Resized: the height is explicit, so the box fills it and .body does the scrolling.
    ':host(.sized) .gm{height:100%}',
    // 0.4.0 §一.4 更新横幅。它在**流内**（没有 position:fixed/absolute），所以是把整个面板
    // 向下推而不是盖住——「不遮挡其他 UI 和按键」是规格里的关键约束。
    // 尺寸上必须配对：`.gm` 的上限是 `--gm-max`，横幅吃掉多少就从里面减掉多少（`--gm-ban`），
    // 否则一块 86vh 的面板再加一条横幅会一起顶出视口。
    '.gmban{display:none;align-items:center;gap:8px;padding:7px 10px;margin-bottom:8px;',
    'background:#16233d;border:1px solid #2f4b8f;border-radius:10px;font-size:12px;color:#cfe0ff}',
    ':host(.upd) .gmban{display:flex}',
    // 缩略态（只显示评估值）和图标态（48×48）都没有位置放横幅，也不该被它撑大。
    ':host(.mg) .gmban,:host(.cp) .gmban{display:none}',
    ':host(.upd) .gm{max-height:calc(var(--gm-max) - var(--gm-ban,0px))}',
    '.gmban .bi{font-weight:700;color:#7aa2ff;flex:none}',
    '.gmban .bt{font-weight:600;color:#e6edf3}',
    '.gmban .sp{flex:1}',
    '.gmban .blk{color:#7aa2ff;cursor:pointer;white-space:nowrap;flex:none}',
    '.gmban .blk:hover{text-decoration:underline}',
    // Minimised: no chrome at all, just the 48x48 shield restored by a click.
    ':host(.mg) .gm{display:none}',
    '.mface{display:none;width:48px;height:48px;border-radius:12px;background:#161b22;border:1px solid #2a3441;',
    'box-shadow:0 6px 20px rgba(0,0,0,.5);color:#e6edf3;font-size:24px;line-height:46px;text-align:center;cursor:pointer}',
    '.mface:hover{border-color:#3c5ee7}',
    ':host(.mg) .mface{display:block}',
    // 0.3.1 缩略态：只显示评估值，点击任意处恢复完整面板。不带按钮、状态文字或进度条。
    ':host(.cp) .gm{display:none}',
    ':host(.cp) .gmcp{display:block}',
    '.gmcp{display:none;background:#161b22;border:1px solid #2a3441;border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.55);overflow:hidden;cursor:grab;user-select:none;touch-action:none}',
    ':host(.dragging) .gmcp{box-shadow:0 14px 40px rgba(0,0,0,.7);border-color:#3c5ee7}',
    '.gmcp .cprow{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:7px 12px}',
    '.gmcp .cpk{font-size:12px;color:#9aa7b4}',
    '.gmcp .cpv{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}',
    '.gmcp .cpbar{height:4px;background:#0d1117;margin:0 12px 8px}',
    '.gmcp .cpbar>i{display:block;height:100%;background:#3c5ee7;width:0}',
    // The shrink icon is a tap target (restore); a press that travels drags it instead.
    ':host(.mg) .mface{cursor:pointer}',
    '.hd{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1a2029;border-bottom:1px solid #2a3441;',
    'cursor:move;user-select:none;touch-action:none}',
    ':host(.dragging) .gm{box-shadow:0 14px 40px rgba(0,0,0,.7);border-color:#3c5ee7}',
    '.hd b{font-weight:500;font-size:13px}',
    '.hd .sp{flex:1}',
    '.hd .lk{color:#7aa2ff;cursor:pointer;font-size:12px}',
    '.hd .lk:hover{text-decoration:underline}',
    // 0.3.6 §2.1: 📋 is greyed out with no report to copy. It stays clickable so the click can
    // explain WHY it is greyed out (the footer says 「尚无分析结果」) instead of silently doing
    // nothing — a dead button with no feedback is the worse failure mode.
    '.hd .lk[data-copy-state=off]{color:#4a5563;opacity:.6}',
    '.hd .lk[data-copy-state=off]:hover{text-decoration:none}',
    '.hd .lk[data-copy-state=partial]{color:#f1c40f}',
    // Buttons inside the drag bar must not look draggable.
    '.hd .lk,.hd .x,.hd .mn{cursor:pointer}',
    '.hd .mn,.hd .x{-webkit-user-select:none;user-select:none}',
    '.x{color:#8b98a5;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px}',
    '.x:hover{color:#e6edf3}',
    '.mn{color:#8b98a5;cursor:pointer;font-size:15px;line-height:1;padding:2px 6px}',
    '.mn:hover{color:#e6edf3}',
    '.rz{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;color:#6e7b8a;',
    'font-size:13px;line-height:16px;text-align:center;user-select:none;touch-action:none}',
    '.rz:hover{color:#e6edf3}',
    '.body{overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}',
    '.sec{border:1px solid #2a3441;border-radius:8px;background:#1a2029}',
    '.sec>h3{margin:0;padding:6px 10px;font-weight:500;font-size:11px;letter-spacing:.4px;color:#8b98a5;border-bottom:1px solid #22303c}',
    '.sec>.in{padding:9px 10px}',
    '.stats{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:#9aa7b4;margin-bottom:8px}',
    '.stats b{color:#e6edf3;font-weight:500}',
    // Permanent marker for a mid-game join — it changes how every number below should be
    // read, so it lives in the status line rather than in a note further down.
    '.warn{color:#f1c40f;border:1px solid #6b5411;background:#2a2410;border-radius:9px;padding:1px 7px;font-size:11px}',
    '.src{color:#6e7b8a;font-size:10px;border:1px solid #2a3441;border-radius:8px;padding:0 6px}',
    '.bar{height:5px;background:#0d1117;border-radius:3px;overflow:hidden;margin:2px 0 9px}',
    '.bar>i{display:block;height:100%;background:#3c5ee7;width:0}',
    '.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}',
    '.card{background:#0d1117;border:1px solid #22303c;border-radius:7px;padding:7px 6px;text-align:center}',
    '.card .v{font-size:19px;font-weight:500;line-height:1.25}',
    '.card .k{font-size:10px;color:#8b98a5;margin-top:1px}',
    '.card .s{font-size:10px;color:#6e7b8a}',
    '.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;align-items:start}',
    '.q{max-height:190px;overflow:auto}',
    '.qi{padding:6px 9px;border-bottom:1px solid #22303c;cursor:pointer;display:flex;gap:6px;align-items:center;font-size:12px}',
    '.qi:last-child{border-bottom:0}',
    '.qi:hover{background:#202834}',
    '.qi.on{background:#22303c}',
    '.qi .no{color:#6e7b8a;min-width:20px;flex:none}',
    '.qi .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.qi .rk{color:#9aa7b4;font-size:11px;flex:none}',
    '.tag{font-size:10px;padding:1px 5px;border-radius:9px;border:1px solid transparent;white-space:nowrap;flex:none}',
    '.t-wait{color:#8b98a5;border-color:#39434f}',
    '.t-run{color:#7aa2ff;border-color:#2f4b8f;background:#16233d}',
    '.t-done{color:#4ec97b;border-color:#245c39;background:#12291c}',
    '.t-stop{color:#f1c40f;border-color:#6b5411;background:#2a2410}',
    '.t-fail{color:#e74c3c;border-color:#6e2b24;background:#2b1614}',
    '.emp{color:#6e7b8a;font-size:12px;padding:8px 10px}',
    '.row{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
    '.row label{width:74px;color:#9aa7b4;font-size:12px;flex:none}',
    'select{flex:1;background:#0d1117;color:#e6edf3;border:1px solid #2a3441;border-radius:6px;padding:4px 6px;font:inherit;font-size:12px}',
    'input[type=number]{width:84px;background:#0d1117;color:#e6edf3;border:1px solid #2a3441;border-radius:6px;padding:4px 6px;font:inherit;font-size:12px}',
    'input[type=checkbox]{accent-color:#3c5ee7}',
    '.more{margin-top:2px;border-top:1px solid #22303c;padding-top:8px}',
    '.more .row label{width:74px}',
    '.btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}',
    'button{font:inherit;font-size:12px;border:0;border-radius:6px;padding:5px 11px;cursor:pointer;background:#2a3441;color:#e6edf3}',
    'button:hover{background:#33404f}',
    'button.p{background:#3c5ee7;color:#fff}',
    'button.p:hover{background:#4a6cf0}',
    'button:disabled{opacity:.45;cursor:default}',
    '.ft{padding:5px 10px;border-top:1px solid #2a3441;color:#6e7b8a;font-size:10px;display:flex;gap:10px}',
    '.note{color:#f1c40f;font-size:11px;margin-top:6px}',
    '.ok{color:#4ec97b;font-size:11px;margin-top:6px}',
    '.err{color:#e74c3c;font-size:11px;margin-top:6px;word-break:break-all}',
  ].join('');

  // The static shell, as a FUNCTION rather than a one-shot string: a language change has to
  // rebuild it (§1.8), and the panel's listeners all sit on the shadow root, so replacing
  // `root.innerHTML` leaves them intact. Everything the operator reads goes through T().
  function shellHtml() {
    return '<div class="mface" title="' + esc(T('panel|展开检测器（点击恢复，按住可拖动）')) + '">🛡</div>' +
      // 0.4.0 §一.4 — 流式更新横幅，位置在 `--gm-max` 之上、`.gm` 之外（见上面的 CSS 注释）。
      '<div class="gmban">' +
        '<span class="bi" aria-hidden="true">↑</span>' +
        '<span class="bt" data-slot="updtext"></span><span class="sp"></span>' +
        '<span class="blk" data-act="upd-open">' + esc(T('update.view')) + '</span>' +
        '<span class="blk" data-act="upd-dismiss">' + esc(T('update.dismiss')) + '</span>' +
      '</div>' +
      '<div class="gm">' +
        '<div class="hd" title="' + esc(T('panel|按住此处拖动面板到任意位置')) + '">' +
          '<span aria-hidden="true" style="color:#6e7b8a;font-size:12px;line-height:1">⠿</span>' +
          '<b>' + esc(T('panel|Gomoku 反作弊检测')) + '</b><span class="sp"></span>' +
          '<span class="lk" data-act="open-viewer">' + esc(T('panel|查看器')) + '</span>' +
          '<span class="lk" data-act="copy" data-copy-state="off" title="' +
            esc(T('copy.title')) + '">📋</span>' +
          '<span class="lk" data-act="compact" title="' + esc(T('panel|缩略：只显示评估值')) + '">' +
            esc(T('panel|缩略')) + '</span>' +
          '<span class="lk" data-act="min" title="' +
            esc(T('panel|缩小为图标（点击恢复，按住可拖动）')) + '">—</span>' +
          '<span class="x" data-act="close" title="' +
            esc(T('panel|关闭浮层（检测器继续采集，点扩展图标可重新打开）')) + '">✕</span></div>' +
        '<div class="body">' +
          '<div class="sec"><h3>' + esc(T('panel|基础数据（状态，步数等）')) +
            '</h3><div class="in" data-slot="top"></div></div>' +
          '<div class="cols">' +
            '<div class="sec"><h3>' + esc(T('panel|排队列表')) +
              '</h3><div class="q" data-slot="queue"></div></div>' +
            '<div class="sec"><h3>' + esc(T('panel|设置预选项')) +
              '</h3><div class="in" data-slot="ctrl"></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="ft"><span>Gomoku Detector v' + VERSION + '</span><span data-slot="foot"></span></div>' +
        '<div class="rz" data-act="resize" title="' + esc(T('panel|拖动调整大小')) + '">◢</div>' +
      '</div>' +
      '<div class="gmcp" data-act="restore" title="' + esc(T('panel|点击恢复完整面板')) + '">' +
        '<div class="cprow"><span class="cpk">' + esc(T('panel|黑')) +
          '</span><span class="cpv" data-cp="b">—</span></div>' +
        '<div class="cprow"><span class="cpk">' + esc(T('panel|白')) +
          '</span><span class="cpv" data-cp="w">—</span></div>' +
        '<div class="cpbar"><i></i></div>' +
      '</div>';
  }

  // (Re)builds the shell and re-binds everything that lives inside it. Safe to call twice.
  function renderShell() {
    if (!root) return;
    root.innerHTML = '<style>' + CSS + '</style>' + shellHtml();
    els.top = root.querySelector('[data-slot=top]');
    els.queue = root.querySelector('[data-slot=queue]');
    els.ctrl = root.querySelector('[data-slot=ctrl]');
    els.foot = root.querySelector('[data-slot=foot]');
    els.cpB = root.querySelector('[data-cp=b]');
    els.cpW = root.querySelector('[data-cp=w]');
    els.cpBar = root.querySelector('.cpbar>i');
    els.copy = root.querySelector('[data-act=copy]');
    els.updText = root.querySelector('[data-slot=updtext]');
    if (root.host) root.host.setAttribute('lang', LANG);
    attachMiniHandlers();
    paintCopyButton();
    // Re-render happens on a language change too, and the banner's text (and therefore its
    // height, and therefore `--gm-ban`) moves with it.
    applyBanner();
  }

  // ---------- 0.4.0 §一.4: the update banner ----------
  // `updateInfo` is the last check the service worker stored (null = nothing to show, or
  // nothing checked yet). The banner is only meaningful on the full panel — the compact and
  // mini faces have nowhere to put it — so `applyBanner()` gates on `ovState.state` as well
  // as on the info, and the CSS hides it again if the state moves after the fact.
  var updateInfo = null;

  function applyBanner() {
    if (!root) return;
    var el = root.querySelector('.gmban');
    var show = !!(updateInfo && el) && ovState.state === 'normal';
    if (host) host.classList.toggle('upd', show);
    if (!show) {
      // Zeroing the reservation is what lets the panel grow back to the full --gm-max.
      if (host) host.style.removeProperty('--gm-ban');
      return;
    }
    els.updText.textContent = T('update.available', { v: updateInfo.latestVersion });
    // Measured, not hard-coded: the strip is one line in Chinese and can wrap in Russian,
    // and a wrong number here either clips the panel or leaves a gap under it.
    var h = el.offsetHeight || 0;
    if (h) host.style.setProperty('--gm-ban', h + 'px');
  }

  // Reads the two storage records through the shared helper and repaints. Never rejects:
  // a failed update lookup must not be able to take the panel down with it.
  function refreshUpdateBanner() {
    return GMStorage.pendingUpdate().then(function (info) {
      updateInfo = info || null;
      applyBanner();
    }, function () { updateInfo = null; applyBanner(); });
  }

  function openUpdatePage() {
    var url = (updateInfo && (updateInfo.releaseUrl || updateInfo.downloadUrl)) ||
              GMStorage.UPDATE_RELEASES;
    try { window.open(url, '_blank', 'noopener'); } catch (e) { /* popup blocked */ }
  }

  function dismissBanner() {
    if (!updateInfo) return;
    var v = updateInfo.latestVersion;
    // Hide first, persist after: the click has to feel instant, and the write only has to
    // land before the next 12-hourly check.
    updateInfo = null;
    applyBanner();
    GMStorage.dismissUpdate(v).catch(function () {});
  }

  function build() {
    host = document.createElement('div');
    host.id = '__gm_panel';
    root = host.attachShadow({ mode: 'open' });
    renderShell();
    (document.body || document.documentElement).appendChild(host);

    els.top = root.querySelector('[data-slot=top]');
    root.addEventListener('click', function (ev) {
      // A drag that travelled ends in a mouseup, and that mouseup still fires a click.
      // Without this the eval-only panel would expand the instant a drag ended on it.
      if (suppressNextClick) { suppressNextClick = false; return; }
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var tag = t.tagName;
      if (tag === 'SELECT' || tag === 'OPTION' || tag === 'INPUT' || tag === 'LABEL') return;
      // Walk up to the nearest ancestor carrying data-act instead of reading the exact
      // node that was hit. The eval-only panel's inner rows (.cprow/.cpv/.cpbar) are
      // what the pointer actually lands on, and only their wrapper carries
      // data-act="restore" — reading ev.target alone left almost the whole panel dead to
      // clicks, which is what "the mode switch went unresponsive" looked like.
      var hit = t.closest ? t.closest('[data-act]') : null;
      var act = hit ? hit.getAttribute('data-act') : null;
      if (!act) {
        var q = t.closest && t.closest('.qi');
        if (q) { selectedId = q.getAttribute('data-id'); paint(); }
        return;
      }
      if (act === 'close') { closePanel(); return; }
      // 0.3.1: the three states are one field now. `min` shrinks to the shield icon,
      // `compact` shows the eval-only panel, `restore` (compact) and the mini icon's
      // tap both expand back to the full panel.
      if (act === 'min') { setOverlayState('mini'); return; }
      if (act === 'compact') { setOverlayState('compact'); return; }
      if (act === 'restore') { setOverlayState('normal'); return; }
      if (act === 'resize') return;   // handled by mousedown below, not by click
      if (act === 'open-viewer') { openViewer(); return; }
      if (act === 'upd-open') { openUpdatePage(); return; }
      if (act === 'upd-dismiss') { dismissBanner(); return; }
      if (act === 'copy') { copyResult(); return; }
      if (act === 'toggle-more') { moreOpen = !moreOpen; paintControls(); return; }
      if (act === 'analyze') { manualAnalyze(); return; }
      if (act === 'replay') { manualReplay(); return; }
      if (act === 'export') { exportSelected(); return; }
      if (act === 'clear') { jobs = []; seqCounter = 0; selectedId = null; paint(); return; }
    });

    // The resize handle needs mousedown (a click alone carries no drag), so it gets its
    // own listener instead of riding the delegation above.
    root.addEventListener('mousedown', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute('data-act') === 'resize') { startResize(ev); return; }
      // Anything inside the header drags the panel; the buttons in it opt out inside
      // startDrag(). Resize keeps priority because it lives outside the header.
      // The compact (eval-only) panel is draggable too (0.3.1): it is a grab handle with
      // no header of its own, so the whole panel is the drag surface.
      if (t.closest && (t.closest('.hd') || t.closest('.gmcp'))) startDrag(ev);
    });

    root.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var act = t.getAttribute('data-act');
      if (act === 'select-mode') changeMode(t.value);
      else if (act === 'select-suspect') saveSetting('suspect', t.value);
      else if (act === 'select-think') saveSetting('thinkMs', parseInt(t.value, 10) || 2000);
      else if (act === 'select-thread') saveSetting('threadNum', GMStorage.clampThreadNum(t.value));
      else if (act === 'set-ai-think') {
        var raw = String(t.value).trim();
        saveSetting('aiThinkMs', raw === '' ? null : (parseInt(raw, 10) || null));
      } else if (act === 'set-opening') {
        var n = parseInt(t.value, 10);
        saveSetting('openingCutoff', isNaN(n) ? 8 : Math.max(0, Math.min(40, n)));
      } else if (act === 'set-min-moves') {
        // Clamped on the way in as well as on the way out of storage, so the box can
        // never show a value the gate does not actually use.
        var mv = GMStorage.clampMinMoves(t.value);
        t.value = mv;
        saveSetting('minArchiveMoves', mv);
      } else if (act === 'set-auto') {
        saveSetting('autoAnalyze', !!t.checked);
      }
    });
  }

  // ---------- panel geometry: minimise / close / resize (0.2.3) ----------
  // Position and size are remembered per browser profile in chrome.storage.local. They
  // are deliberately NOT synced live across tabs: two gomoku tabs are two separate
  // windows onto the same game, and dragging one should not move the other. The stored
  // value is applied when a panel is built.
  var ovState = GMStorage.overlayDefaults();
  var OV_MIN_W = 240, OV_MIN_H = 200;
  // 0.3.1 three-state sizes. Compact is fixed (~132×70); mini is the 48×48 shield.
  var OV_COMPACT_W = 132, OV_COMPACT_H = 72, OV_MINI = 48;

  function ovClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Clamping the stored position is a repair, not a policy: it exists so a position saved
  // on a wide monitor does not park the panel off-screen in a narrow window. Re-applying it
  // on every repaint would instead fight the operator — resizing the panel near the right
  // edge would slide it left, and minimising (48px) would undo that slide. So it runs once,
  // right after the stored state is loaded, and never again.
  var ovClampPending = true;

  // Two mutually exclusive horizontal anchors, shared by all three states. `left` is null
  // until the drag bar (or the mini/compact grab) is used, and the original right-edge
  // placement is what "null" means.
  function placeBox(w, h) {
    var vw = window.innerWidth, vh = window.innerHeight;
    if (ovState.left == null) {
      host.style.left = 'auto';
      host.style.right = ovState.right + 'px';
    } else {
      var l = ovState.left;
      if (ovClampPending) { l = Math.round(ovClamp(l, 0, Math.max(0, vw - Math.min(w, vw)))); ovState.left = l; }
      host.style.right = 'auto';
      host.style.left = l + 'px';
    }
    var t = ovState.top;
    if (ovClampPending) { t = Math.round(ovClamp(t, 0, Math.max(0, vh - Math.min(h, vh)))); ovState.top = t; }
    host.style.top = t + 'px';
    ovClampPending = false;
  }

  function paintOverlay() {
    if (!host) return;
    var st = ovState.state;
    host.classList.remove('mg', 'cp', 'sized', 'dragging');
    host.style.maxHeight = '';

    if (st === 'mini') {
      // 48×48 shield, draggable by long press (see attachMiniHandlers).
      host.classList.add('mg');
      host.style.width = OV_MINI + 'px';
      host.style.height = OV_MINI + 'px';
      placeBox(OV_MINI, OV_MINI);
      applyBanner();
      return;
    }
    if (st === 'compact') {
      // Eval-only panel, fixed size. The whole panel is a drag surface (mousedown →
      // startDrag), and a click (no drag) restores the full panel.
      host.classList.add('cp');
      host.style.width = OV_COMPACT_W + 'px';
      host.style.height = OV_COMPACT_H + 'px';
      placeBox(OV_COMPACT_W, OV_COMPACT_H);
      applyBanner();   // §一.4 — the strip has no room here; drop the reservation too
      return;
    }
    // normal: the full panel, resizeable, anchored as stored.
    host.style.width = ovState.width + 'px';
    if (ovState.height > 0) {
      host.style.height = ovState.height + 'px';
      host.classList.add('sized');
      host.style.setProperty('--gm-max', ovState.height + 'px');
    } else {
      host.style.height = '';
      host.classList.remove('sized');
      host.style.setProperty('--gm-max', '86vh');
    }
    // Back to the full panel: re-reserve the strip's height (it was released by the
    // mini/compact branches above and by applyBanner's own `show === false` path).
    applyBanner();
    placeBox(ovState.width, ovState.height > 0 ? ovState.height : host.offsetHeight);
  }

  function loadOverlayState() {
    return GMStorage.loadOverlay().then(function (st) {
      ovState = st;
      ovClampPending = true;      // the one place a stale off-screen position gets repaired
      paintOverlay();
      return st;
    });
  }

  // 0.3.1: the three states live in one field. `setMinimized` is kept only for the
  // extension-icon restore path; it maps onto the same state machine.
  function setOverlayState(st) {
    ovState.state = st;
    ovState.minimized = (st === 'mini');
    // Expanding changes the box width (48 → 132 → 580). A left edge that was legal for the
    // shield can push the full panel off-screen, which reads as "clicking the icon does
    // nothing". Clamping on every transition repairs it; a legal position is never moved.
    ovClampPending = true;
    GMStorage.saveOverlay({ state: st, minimized: ovState.minimized });
    paintOverlay();
    if (st !== 'mini') paint();
  }

  function setMinimized(v) { setOverlayState(v ? 'mini' : 'normal'); }

  // ---- 0.3.1 mini icon: a press that does not travel restores; a press that moves drags ----
  function attachMiniHandlers() {
    // Must be root (the shadow root), not host: the icon lives inside the shadow tree,
    // and `host.querySelector` only walks the light DOM, so it always returned null here
    // and the handler silently bound to nothing — leaving the mini icon unable to expand
    // (tap) or to be dragged (press and move).
    var icon = root && root.querySelector('.mface');
    if (!icon) return;
    icon.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      startMiniPress(e.clientX, e.clientY);
    });
  }

  // Travel distance — not elapsed time — decides tap vs drag. The original 0.1s timer
  // misfired on ordinary human clicks (a real press lasts 80-150ms): the timer flipped
  // `miniDragging` before the button came up, so mouseup took the "drag ended" branch and
  // never restored. Automated clicks (0ms hold) passed, which is why it slipped through.
  function startMiniPress(sx, sy) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var rect = host.getBoundingClientRect();
    var startLeft = rect.left, startTop = rect.top;
    var w = host.offsetWidth, h = host.offsetHeight;
    var moved = false;
    function onMove(e2) {
      if (!moved) {
        if (Math.abs(e2.clientX - sx) <= 3 && Math.abs(e2.clientY - sy) <= 3) return;
        moved = true;
        // Re-anchor only on the first real travel, so a plain tap never persists a `left`
        // taken from the 48px box.
        host.style.right = 'auto';
      }
      var maxL = Math.max(0, vw - w), maxT = Math.max(0, vh - h);
      host.style.left = ovClamp(startLeft + e2.clientX - sx, 0, maxL) + 'px';
      host.style.top = ovClamp(startTop + e2.clientY - sy, 0, maxT) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      if (!moved) { setOverlayState('normal'); return; }
      var l = Math.round(parseFloat(host.style.left));
      var tp = Math.round(parseFloat(host.style.top));
      if (!isFinite(l) || !isFinite(tp)) return;
      ovState.left = l;
      ovState.top = tp;
      GMStorage.saveOverlay({ left: l, top: tp });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
  }

  // Close removes the panel outright; collection keeps running so the operator can bring
  // it back and still see the whole game. Reopening is the extension icon's job.
  function closePanel() {
    if (host) host.remove();
    host = null; root = null; els = {};
  }

  // Returns whether the panel had to be brought back — the icon opens the viewer when
  // nothing needed restoring, so a click always does something.
  function restorePanel() {
    var wasGone = !host;
    var wasMin = (ovState.state === 'mini');
    if (wasGone) build();
    if (wasMin) {
      ovState.state = 'normal';
      ovState.minimized = false;
      GMStorage.saveOverlay({ state: 'normal', minimized: false });
    }
    paintOverlay();
    paint();
    return wasGone || wasMin;
  }

  function startResize(ev) {
    if (!host || ovState.state === 'mini') return;
    ev.preventDefault();
    var startX = ev.clientX, startY = ev.clientY;
    var startW = host.offsetWidth, startH = host.offsetHeight;
    var maxW = Math.round(window.innerWidth * 0.9);
    var maxH = Math.round(window.innerHeight * 0.9);
    function onMove(e2) {
      var w = ovClamp(startW + e2.clientX - startX, OV_MIN_W, maxW);
      var h = ovClamp(startH + e2.clientY - startY, OV_MIN_H, maxH);
      host.style.width = w + 'px';
      host.style.height = h + 'px';
      host.classList.add('sized');
      host.style.setProperty('--gm-max', h + 'px');
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      ovState.width = host.offsetWidth;
      ovState.height = host.offsetHeight;
      GMStorage.saveOverlay({ width: ovState.width, height: ovState.height });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // 浮动面板拖动 (0.2.5). The handle is the existing header row — it already carries the
  // title and the minimise/close buttons, so a second stacked bar would only eat height.
  // The difference from resize is which geometry changes: the drag writes `left`/`top`,
  // the corner handle writes `width`/`height`, and neither touches the other's fields.
  // Set by a drag that actually travelled, consumed by the very next click (startDrag's
  // onMove writes it, the click handler above clears it). Keeps "grab and move" from also
  // being read as "tap to restore".
  var suppressNextClick = false;

  function startDrag(ev) {
    if (!host || ovState.state === 'mini') return;   // mini uses its own press-drag
    if (ev.button !== 0) return;
    suppressNextClick = false;
    // Clicks on the buttons inside the bar are clicks, not drags. The eval-only panel is
    // the one exception: it carries data-act="restore" so that a tap can expand it, but
    // its whole surface is the grab handle (cursor:grab), so it has to drag too. Reading
    // only ev.target here used to exclude it, which killed dragging in that state.
    var t = ev.target;
    var hit = t && t.closest ? t.closest('[data-act]') : null;
    if (hit && !hit.classList.contains('gmcp')) return;
    ev.preventDefault();
    var startX = ev.clientX, startY = ev.clientY;
    var rect = host.getBoundingClientRect();
    var startLeft = rect.left, startTop = rect.top;
    var w = host.offsetWidth, h = host.offsetHeight;
    // Re-anchoring (right:12px -> an absolute left) is deferred to the first movement
    // that actually travels. Doing it on mousedown would turn a plain tap into a "drag
    // that ended where it began": onUp would then store the current box's left as a
    // position, and since the eval-only panel is 132px wide while the full panel is 580px,
    // tapping it to expand would pin the panel at the compact left and push the expanded
    // panel far off the right edge of the viewport — and persist that to storage.
    var moved = false;
    function reAnchor() {
      host.style.right = 'auto';
      host.style.left = startLeft + 'px';
      host.style.top = startTop + 'px';
      host.classList.add('dragging');
    }

    function onMove(e2) {
      if (!moved) {
        if (Math.abs(e2.clientX - startX) <= 3 && Math.abs(e2.clientY - startY) <= 3) return;
        moved = true;
        // A press that actually travels is a drag; the mouseup that ends it must not be
        // read as a tap on whatever happens to sit under the cursor by then.
        suppressNextClick = true;
        reAnchor();
      }
      var maxL = Math.max(0, window.innerWidth - w);
      var maxT = Math.max(0, window.innerHeight - h);
      host.style.left = ovClamp(startLeft + e2.clientX - startX, 0, maxL) + 'px';
      host.style.top = ovClamp(startTop + e2.clientY - startY, 0, maxT) + 'px';
    }
    function onUp() {
      if (!active) return;
      active = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      host.classList.remove('dragging');
      if (!moved) return;      // a tap: nothing travelled, so there is no position to keep
      var l = Math.round(parseFloat(host.style.left));
      var tp = Math.round(parseFloat(host.style.top));
      if (!isFinite(l) || !isFinite(tp)) return;
      ovState.left = l;
      ovState.top = tp;
      GMStorage.saveOverlay({ left: l, top: tp });
    }
    var active = true;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // Releasing outside the window never fires mouseup here; without this the panel would
    // stay glued to the cursor the next time the page is touched.
    window.addEventListener('blur', onUp);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function tagOf(status) {
    var cls = status === '已完成' ? 't-done' : status === '分析中' ? 't-run'
            : status === '待分析' ? 't-wait' : status === '已中止' ? 't-stop' : 't-fail';
    return '<span class="tag ' + cls + '">' + esc(TO('jobStatus', status)) + '</span>';
  }

  // The level is compared by its CANONICAL value (it is what app.js writes and what archives
  // persist), so only the colour lookup uses the raw string.
  function riskColor(level) {
    return level === '高风险' ? '#e74c3c' : level === '可疑' ? '#f1c40f' : '#2ecc71';
  }

  function paintStatus() {
    if (!root) return;
    var moves = activeMoves();
    var inferred = countInferred(moves);
    var serverCount = socketRec ? socketRec.serverMoveNumber : null;
    var cur = running() || findJob(selectedId) || jobs[jobs.length - 1] || null;

    // 0.3.5: a live session stopped by a live four is NOT 「分析中」. Two sources say so,
    // and both are needed: `liveJob._terminal` covers the instant the step came back (before
    // liveFinish has retired it), and `cur._terminal` covers everything after — liveFinish
    // nulls liveJob immediately, so the finished job in the queue is what the panel is
    // showing from then on. Checking only liveJob is how the panel ended up contradicting
    // its own note ("分析中" next to "检测停止").
    var stopped = (liveJob && liveJob._terminal) ? liveJob
      : (cur && cur._terminal) ? cur : null;
    var state, pct = 0;
    if (stopped && !ended) {
      // Once the game itself ends, 对局已结束 is the newer fact and takes over.
      state = T('panel|已终止（活四）· {label}', { label: TO('jobLabel', stopped.label) });
      pct = 100;
    }
    else if (ended) {
      // 0.3.7 §一.1 — 这一支必须排在 `running()` 之前：收尾分析是「对局已结束」的**结果**，
      // 不是「还在下」的证据。反过来的顺序会让一局刚结束的棋显示成「分析中 · 收尾分析」，
      // 操作者读到的正好相反。存档状态也是「对局状态」的一部分 —— 结束之后要知道它到底存了没有。
      //
      // endedBy is a stored diagnostic that embeds the raw socket event name, so it is
      // translated when it is one of our own known reasons and shown verbatim otherwise.
      state = T('panel|对局已结束（{reason}）', { reason: TO('end', endedBy) });
      if (running()) {
        state += ' · ' + T('panel|收尾分析中');
        pct = running().progress || 0;
      } else {
        if (archivedEpoch[gameEpoch]) state += ' · ' + T('panel|已存档');
        pct = 100;
      }
    }
    else if (running()) { state = T('panel|分析中 · {label}', { label: TO('jobLabel', running().label) }); pct = running().progress || 0; }
    else if (moves.length) { state = T('panel|采集中'); }
    else { state = T('panel|等待对局…'); }

    var names = playerNames();
    var nameTxt = (names.black || names.white)
      ? T('panel|黑 {b} / 白 {w}', { b: names.black || '?', w: names.white || '?' })
      : (names.self || names.opponent
          ? T('panel|{self} vs {opp}（未对应黑白）', { self: names.self || '?', opp: names.opponent || '?' })
          : '—');
    // Shown only once the three stones are on the board AND their order is known — an
    // unidentified opening prints nothing at all (0.3.0 §1.6).
    var opening = currentOpening();
    var ident = detectIdentity(names);

    var h = '<div class="stats">' +
      '<span>' + esc(T('panel|状态：')) + '<b>' + esc(state) + '</b></span>' +
      '<span>' + esc(T('panel|数据源：')) + '<b>' + (fromSocket() ? 'socket' : (domMoves.length ? 'DOM' : '—')) + '</b></span>' +
      '<span>' + esc(T('panel|已采集：')) + '<b>' + moves.length + '</b> ' + esc(T('panel|手')) +
        (inferred ? T('panel|（其中 <b>{n}</b> 手无手序）', { n: inferred }) : '') + '</span>' +
      (opening ? '<span>' + esc(T('panel|开局：')) + '<b>' +
        esc(GMOpening.label(opening, LANG)) + '</b></span>' : '') +
      // 观战 / 游客 change how the figures below should be read (a spectator has no "self",
      // a guest game may end without the channels the collector normally relies on), so they
      // are badges in the status line rather than a footnote.
      (ident.identity === 'spectator'
        ? '<span class="src" title="' + esc(T('panel|观战页面（判定依据：{how}）', { how: ident.how })) +
          '">' + esc(T('panel|观战')) + '</span>' : '') +
      (ident.identity === 'guest'
        ? '<span class="src" title="' + esc(T('panel|游客账号（判定依据：{how}）', { how: ident.how })) +
          '">' + esc(T('panel|游客')) + '</span>' : '') +
      // Permanent, not a note: "before the detector was opened" changes how every number
      // on this panel should be read.
      (inferred ? '<span class="warn" title="' +
        esc(T('panel|检测器在中途加入，前 {n} 手由盘面还原，手序不可恢复', { n: inferred })) +
        '">' + esc(T('panel|⚠ 中途加入')) + '</span>' : '') +
      // Two moves of one colour in a row cannot happen: the capture dropped or doubled a
      // stone, and every per-side number below is built on a wrong order.
      (orderBad(moves) ? '<span class="warn" title="' +
        esc(T('panel|相邻两步同色：采集可能缺失或重复，手序异常')) +
        '">' + esc(T('panel|⚠ 手序异常')) + '</span>' : '') +
      (S.mode === 'stepwise' && lastStepBudget != null
        ? '<span>' + esc(T('panel|本步预算：')) + '<b>' + lastStepBudget + 'ms</b></span>' : '') +
      '</div>' +
      '<div class="stats"><span>' + esc(T('panel|玩家：')) + '<b>' + esc(nameTxt) + '</b></span>' +
        (names.source === 'socket' ? '<span class="src">socket</span>'
          : names.source === 'dom' ? '<span class="src">DOM</span>' : '') +
      '</div>' +
      '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, pct)).toFixed(1) + '%"></i></div>';

    if (inferred) {
      h += '<div class="note">' + T('panel|数据不完整：前 {n} 手缺失（检测器中途加入，由盘面还原），有效样本 n = <b>{known}</b> 手 / 原始 {total} 手（来源：{src}）。这些手不参与命中率/时间统计，只用于还原盘面。',
        { n: inferred, known: moves.length - inferred, total: moves.length,
          src: esc(socketRec ? (socketRec.seedSource || T('panel|盘面')) : (domSeeded ? T('panel|盘面') : '—')) }) + '</div>';
    }
    if (orderBad(moves)) {
      h += '<div class="note">' + T('panel|手序异常：记录里有 {n} 处相邻两步同色（五子棋黑白必然交替）。手数、盘面与结论请谨慎使用。',
        { n: orderBad(moves) }) + '</div>';
    }
    if (serverCount != null && serverCount !== moves.length) {
      h += '<div class="note">' + T('panel|站点手数 {server} 手，本地记录 {local} 手 —— 盘面可能尚未同步，等待刷新。',
        { server: serverCount, local: moves.length }) + '</div>';
    }

    var rep = cur && (cur.report || cur.summary);
    h += '<div class="cards">' +
      card(T('panel|黑方'), rep && rep.black, '#e6edf3') +
      card(T('panel|白方'), rep && rep.white, '#e6edf3') +
      card(T('panel|豁免'), rep ? String(rep.forcedCount || 0) : '—', '#9aa7b4', T('panel|冲四强制应手')) +
      card(T('panel|时间模式'), rep ? (rep.hasTime ? T('panel|真实间隔') : T('panel|固定预算')) : '—', '#9aa7b4',
           GMStorage.modeLabel(S.mode)) +
      '</div>';
    // Every one of these may carry an app.js / offscreen.js error code, so they all go
    // through TE() — a code that is not translated renders as 「__i18n:…」, which is exactly
    // the 中英混杂 the release set out to remove.
    if (cur && cur.note) h += '<div class="note">' + esc(TE(cur.note)) + '</div>';
    if (cur && cur.status === '失败' && cur.error) h += '<div class="err">' + esc(TE(cur.error)) + '</div>';
    if (cur && cur.status === '已中止' && cur.error) h += '<div class="note">' + esc(TE(cur.error)) + '</div>';
    if (running() && running().progressMsg) h += '<div class="note">' + esc(TE(running().progressMsg)) + '</div>';
    // Suppressed once a live four has stopped detection: the report this note offers to
    // produce has already been produced, so pointing at 「结束并出报告」 would be a dead end.
    if (!running() && !stopped && stalled()) {
      h += '<div class="note">' + T('panel|已 {n} 分钟无落子，且未检测到对局结束事件 —— 点「{btn}」可手动出报告。',
        { n: Math.round(STALL_MS / 60000),
          btn: S.mode === 'global' ? T('panel|分析当前对局') : T('panel|结束并出报告') }) + '</div>';
    }
    if (engineNote) h += '<div class="note">' + esc(TE(engineNote)) + '</div>';
    if (!running() && lastArchive) h += '<div class="ok">' + T('panel|已存档：{name}', { name: esc(lastArchive.name) }) + '</div>';
    // Mutually exclusive with 已存档: a skipped game must not leave the previous game's
    // confirmation on screen, which would read as "this one was saved".
    if (!running() && !lastArchive && lastSkip) {
      h += '<div class="note">' + T('panel|对局过短：仅 {n} 手（少于 {min} 手），未存档。阈值可在设置里改。',
        { n: lastSkip.moves, min: lastSkip.min }) + '</div>';
    }

    els.top.innerHTML = h;

    // queue
    var q = '<div class="q">';
    if (!jobs.length) q += '<div class="emp">' + esc(T('panel|暂无任务')) + '</div>';
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var risk = '';
      var agg = j.report || j.summary;
      if (agg && agg.black) {
        risk = Math.round(agg.black.risk) + '/' + Math.round(agg.white ? agg.white.risk : 0);
      }
      q += '<div class="qi' + (j.id === selectedId ? ' on' : '') + '" data-id="' + j.id + '">' +
        '<span class="no">#' + j.seq + '</span>' +
        '<span class="nm">' + esc(TO('jobLabel', j.label)) + '</span>' +
        (risk ? '<span class="rk">' + risk + '</span>' : '') +
        tagOf(j.status) + '</div>';
    }
    q += '</div>';
    els.queue.innerHTML = q;

    els.foot.textContent = (footMsg && performance.now() < footMsgUntil)
      ? footMsg
      : (T('panel|队列 {n}', { n: jobs.length }) + (running() ? T('panel| · 1 运行中') : ''));
  }

  function card(k, agg, color, sub) {
    if (!agg) return '<div class="card"><div class="v" style="color:#6e7b8a">—</div><div class="k">' + esc(k) + '</div></div>';
    if (typeof agg === 'string') {
      return '<div class="card"><div class="v" style="color:' + color + ';font-size:13px">' + esc(agg) + '</div>' +
             '<div class="k">' + esc(k) + '</div>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
    }
    return '<div class="card"><div class="v" style="color:' + riskColor(agg.level) + '">' +
      Math.round(agg.risk) + '</div><div class="k">' + esc(k) + ' · ' + esc(TO('level', agg.level)) + '</div>' +
      '<div class="s">' + agg.n + ' ' + esc(T('panel|手')) + '</div></div>';
  }

  // A <select> whose value is not among its <option>s silently shows the first option,
  // so a thinkMs set elsewhere (the viewer's 设置 tab accepts any number) would display
  // as "1000 ms" while 6000 was actually stored. Always include the live value.
  function thinkOptions() {
    var opts = [1000, 2000, 3000, 5000, 8000];
    if (opts.indexOf(S.thinkMs) < 0) opts.push(S.thinkMs);
    opts.sort(function (a, b) { return a - b; });
    return opts.map(function (v) {
      return '<option value="' + v + '"' + (S.thinkMs === v ? ' selected' : '') + '>' + v + ' ms</option>';
    }).join('');
  }

  function paintControls() {
    if (!root) return;
    var busy = !!running();
    var h =
      '<div class="row"><label>' + esc(T('panel|分析模式')) + '</label>' +
        '<select data-act="select-mode"' + (busy ? ' disabled' : '') + '>' +
          '<option value="global"' + (S.mode === 'global' ? ' selected' : '') + '>' +
            esc(T('panel|全局分析（对局结束后一次）')) + '</option>' +
          '<option value="stepwise"' + (S.mode === 'stepwise' ? ' selected' : '') + '>' +
            esc(T('panel|逐步分析（每落一子）')) + '</option>' +
        '</select></div>' +
      '<div class="row"><label>' + esc(T('panel|被怀疑方')) + '</label>' +
        '<select data-act="select-suspect">' +
          '<option value="both"' + (S.suspect === 'both' ? ' selected' : '') + '>' + esc(T('panel|双方')) + '</option>' +
          '<option value="B"' + (S.suspect === 'B' ? ' selected' : '') + '>' + esc(T('panel|黑方')) + '</option>' +
          '<option value="W"' + (S.suspect === 'W' ? ' selected' : '') + '>' + esc(T('panel|白方')) + '</option>' +
        '</select></div>' +
      '<div class="row"><label>' + esc(T('panel|检测思考')) + '</label>' +
        '<select data-act="select-think">' +
          thinkOptions() +
        '</select></div>' +
      '<div class="btns"><button data-act="toggle-more">' +
        esc(moreOpen ? T('panel|收起设置 ▴') : T('panel|更多设置 ▾')) + '</button></div>' +
      (moreOpen ?
        '<div class="more">' +
          '<div class="row"><label>' + esc(T('panel|AI 思考')) + '</label>' +
            '<input type="number" min="0" step="100" data-act="set-ai-think" placeholder="' +
              esc(T('panel|跟随')) + '" value="' +
              (S.aiThinkMs == null ? '' : S.aiThinkMs) + '">' +
            '<span style="color:#6e7b8a;font-size:11px">' + esc(T('panel|ms，留空=跟随检测思考')) + '</span></div>' +
          '<div class="row"><label>' + esc(T('panel|开局排除')) + '</label>' +
            '<input type="number" min="0" max="40" data-act="set-opening" value="' + (S.openingCutoff || 0) + '">' +
            '<span style="color:#6e7b8a;font-size:11px">' + esc(T('panel|手')) + '</span></div>' +
          '<div class="row"><label>' + esc(T('panel|线程数')) + '</label>' +
            '<select data-act="select-thread">' +
              // 0.3.7 §二.1: the automatic entry names the count this machine will actually
              // get, so "自动" is not an opaque promise — a 32-thread host reads 「自动（16 线程）」.
              [[0, T('panel|自动（{n} 线程）', { n: GMStorage.detectedThreads() })]]
                .concat([1, 2, 3, 4, 6, 8, 12, 16].map(function (v) { return [v, String(v)]; }))
                .map(function (pair) {
                  return '<option value="' + pair[0] + '"' + (S.threadNum === pair[0] ? ' selected' : '') + '>' +
                    pair[1] + '</option>';
                }).join('') +
            '</select></div>' +
          '<div class="row"><label>' + esc(T('panel|最小存档')) + '</label>' +
            '<input type="number" min="' + GMStorage.MIN_MOVES_LO + '" max="' + GMStorage.MIN_MOVES_HI +
              '" data-act="set-min-moves" value="' + S.minArchiveMoves + '">' +
            '<span style="color:#6e7b8a;font-size:11px">' + esc(T('panel|手，不足不存档')) + '</span></div>' +
          '<div class="row" style="margin-bottom:0"><label>' + esc(T('panel|结束自动分析')) + '</label>' +
            '<input type="checkbox" data-act="set-auto"' + (S.autoAnalyze ? ' checked' : '') + '>' +
            '<span style="color:#6e7b8a;font-size:11px">' + esc(T('panel|对局结束时自动出报告并存档')) + '</span></div>' +
          '<div class="note">' +
            esc(T('panel|引擎：多线程 rapfi-multi-simd128 优先，加载失败自动回退单线程。「自动」= 半核且不超过 16 线程。')) +
          '</div>' +
        '</div>'
        : '') +
      '<div class="btns">' +
        (S.mode === 'global'
          ? '<button class="p" data-act="analyze"' + (busy ? ' disabled' : '') + '>' +
              esc(T('panel|分析当前对局')) + '</button>'
          : '<button class="p" data-act="analyze"' + (busy ? ' disabled' : '') + '>' +
              esc(liveJob ? T('panel|结束并出报告') : T('panel|开始实时逐步')) + '</button>') +
        '<button data-act="replay"' + (busy ? ' disabled' : '') + '>' + esc(T('panel|导入回放')) + '</button>' +
        '<button data-act="export"' + (selectedId ? '' : ' disabled') + '>' + esc(T('panel|导出JSON')) + '</button>' +
        '<button data-act="clear"' + (jobs.length && !busy ? '' : ' disabled') + '>' + esc(T('panel|清空队列')) + '</button>' +
      '</div>' +
      '<div class="note">' +
        esc(T('panel|逐步预算 = min( max(2000ms, 落子间隔), 检测思考 )；无时间数据时回退到该上限。')) +
      '</div>';
    els.ctrl.innerHTML = h;
  }

  function paint() {
    if (!root) return;
    paintStatus();
    paintControls();
    paintCompact();
    paintCopyButton();
  }

  // 0.3.1: the eval-only (compact) panel shows just the two risk numbers, updating live.
  // While a job runs it shows the progress percentage instead; otherwise the rounded
  // black/white risk, or "—" before the first analysis.
  function paintCompact() {
    if (!root || !els.cpB) return;
    var cur = running() || findJob(selectedId) || jobs[jobs.length - 1] || null;
    var rep = cur && (cur.report || cur.summary);
    if (running()) {
      var p = Math.round((running().progress || 0));
      els.cpB.textContent = p + '%';
      els.cpW.textContent = '分析中';
      if (els.cpBar) els.cpBar.style.width = p + '%';
    } else if (rep) {
      els.cpB.textContent = rep.black ? Math.round(rep.black.risk) : '—';
      els.cpW.textContent = rep.white ? Math.round(rep.white.risk) : '—';
      if (els.cpBar) els.cpBar.style.width = '100%';
    } else {
      els.cpB.textContent = '—';
      els.cpW.textContent = '—';
      if (els.cpBar) els.cpBar.style.width = '0';
    }
  }

  // ---------- 0.3.6 §2: copy the result to the clipboard ----------
  // The panel's own status line is the footer, so a copy result is reported there for a few
  // seconds. `paintStatus` runs on every move, so the override has to be explicit — otherwise
  // a repaint would wipe the confirmation before it could be read.
  var footMsg = '';
  var footMsgUntil = 0;

  function flashFoot(msg) {
    footMsg = msg;
    footMsgUntil = performance.now() + 5000;
    if (els.foot) els.foot.textContent = msg;
  }

  function currentReport() {
    var cur = running() || findJob(selectedId) || jobs[jobs.length - 1] || null;
    return (cur && (cur.report || cur.summary)) || null;
  }

  function paintCopyButton() {
    if (!els.copy) return;
    var rep = currentReport();
    var busy = !!running();
    els.copy.setAttribute('data-copy-state', rep ? (busy ? 'partial' : 'on') : 'off');
    // §2.1: usable while a job runs (it copies the part that is done) but says so.
    els.copy.setAttribute('title', rep
      ? (busy ? T('copy.partial') : T('copy.title'))
      : T('copy.noData'));
  }

  // §2.2 template:
  //   前缀 模型名-黑方名（黑） VS 白方名（白）-手数-开局名-黑方（AI率：n%，程度），白方（…）
  // Everything that can be translated is; the engine build name is NOT (it is a file name and
  // an operator comparing two reports needs the same token in every language).
  //
  // NOTE the prefix is followed by the model directly, with no separator: `copy.prefix`
  // already ends in '：' / ': ', and the worked examples in §2.2 show
  // 「…输出：rapfi-multi-simd128-…」. §2.5's sketch inserts an extra '-' there, which would
  // render 「…输出：-rapfi-…」; the examples win.
  function buildCopyText() {
    var rep = currentReport();
    if (!rep) return null;

    var names = playerNames();
    var eng = rep.engine || {};
    var model = eng.build ? String(eng.build).split('/').pop().replace(/\.js$/, '') : 'unknown';
    if (eng.degraded) model += T('copy.degraded');

    // `originalTotalMoves` is the real game length; `scoredCount` is how many hands actually
    // carry a verdict. They differ exactly when a live four cut detection short, which is the
    // case the 过短 test had to be fixed for in 0.3.5 — the same distinction matters here.
    var total = rep.originalTotalMoves || rep.totalMoves || 0;
    var scored = rep.scoredCount != null ? rep.scoredCount : (rep.totalMoves || 0);
    var handStr = (scored < total)
      ? T('copy.hands.withScored', { total: total, scored: scored })
      : T('copy.hands.simple', { total: total });

    var opening = rep.opening || (rep.record && rep.record.meta && rep.record.meta.opening);
    var openingStr = opening ? (GMOpening.label(opening, LANG) || T('copy.opening.unknown'))
                             : T('copy.opening.unknown');

    var blackName = names.black || T('copy.player.unknown');
    var whiteName = names.white || T('copy.player.unknown');
    // Neither side identified: 「黑方」/「白方」 reads better than 「未知 VS 未知」 and still
    // tells the operator which half of the line is which.
    if (!names.black && !names.white) {
      blackName = T('copy.player.genericBlack');
      whiteName = T('copy.player.genericWhite');
    }

    function sideStr(side, name) {
      var agg = side === 'B' ? rep.black : rep.white;
      if (!agg) return name + T('copy.rate.unanalyzed');
      return name + T('copy.rate.format', {
        rate: Math.round(agg.risk),
        level: TO('level', agg.level),
      });
    }

    var head = T('copy.prefix') + model + '-' +
               blackName + T('copy.blackTag') + ' VS ' +
               whiteName + T('copy.whiteTag') + '-' +
               handStr + '-' + openingStr + '-';

    return head + sideStr('B', blackName) + T('copy.sides.sep') + sideStr('W', whiteName);
  }

  function copyResult() {
    var text = buildCopyText();
    if (!text) { flashFoot(T('copy.noData')); return; }
    var done = function () { flashFoot(T('copy.done')); };
    var fail = function (e) {
      flashFoot(T('copy.fail') + ': ' + ((e && e.message) || e));
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fail);
        return;
      }
    } catch (e) { /* fall through to the legacy path */ }
    // gomoku.com is https so the async API exists, but a clipboard write can still be refused
    // (document not focused). execCommand is deprecated yet remains the only fallback that
    // works without the Clipboard API permission.
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) done(); else fail(new Error('execCommand rejected'));
    } catch (e) { fail(e); }
  }

  // ---------- actions ----------
  function changeMode(next) {
    if (next === S.mode) return;
    var job = running();
    if (job) {
      var ok = window.confirm(T('panel|当前有任务正在运行（{label}，{status}）。\n切换分析模式会中止它，确定继续吗？',
        { label: TO('jobLabel', job.label), status: TO('jobStatus', job.status) }));
      if (!ok) { paintControls(); return; }
      abortRunning();
    }
    saveSetting('mode', next);
    paint();
    if (next === 'stepwise') {
      warmup();
    }
  }

  function openViewer() {
    send({ type: 'gm-open-viewer' }).catch(function () {
      alert(T('panel|无法打开查看器，请点击扩展图标。'));
    });
  }

  // Guards for the two analysis actions. A mid-game join is fully usable now — the
  // board is complete — but the moves with no recoverable order cannot be scored, so
  // say so instead of quietly reporting statistics computed from a guessed order.
  function allowAnalyze(what) {
    var moves = activeMoves();
    var inferred = countInferred(moves);
    var known = moves.length - inferred;
    if (moves.length < 5) {
      alert(T('panel|手数太少（当前 {n} 手），无法{what}。', { n: moves.length, what: what }));
      return false;
    }
    if (known < 5) {
      return window.confirm(T('panel|数据不完整：当前 {total} 手中有 {inf} 手是检测器中途加入时从盘面还原的，手序不可恢复、不参与统计，真正可评估的只有 {known} 手。\n\n推荐改用「全局分析」（对已采集的部分出报告，并在报告里标注数据不完整）。\n\n仍要继续{what}吗？',
        { total: moves.length, inf: inferred, known: known, what: what }));
    }
    return true;
  }

  function manualAnalyze() {
    if (!allowAnalyze(T('panel|分析'))) return;
    if (S.mode === 'global') {
      if (running()) return;
      newJob('global', '全局分析');
      paint();
      pump();
    } else {
      if (liveJob) { liveFinish(); return; }
      startLiveSession();
      paint();
    }
  }

  function manualReplay() {
    if (!allowAnalyze(T('panel|回放'))) return;
    if (running()) return;
    if (liveJob) { liveFinish(); }
    newJob('step', '导入回放');
    paint();
    pump();
  }

  function exportSelected() {
    var job = findJob(selectedId);
    if (!job) return;
    var report = job.report || job.summary;
    if (!report) { alert(T('panel|该任务还没有结果。')); return; }
    var blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gomoku-report-' + job.seq + '.json';
    a.click();
  }

  // ---------- boot ----------
  console.log('[detector] content script ready (v' + VERSION + ')');

  // The panel and viewer.html share one settings object. Pick up edits made in the
  // viewer (or another tab) so the panel never shows a value that is no longer stored.
  // If the operator is typing inside the panel, only refresh the status line — a full
  // re-render would replace the input under their cursor.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      // 0.4.0 §一.4 — the service worker's 12-hourly check writes `updateInfo` while this tab
      // is already open, and「暂不更新」in another tab writes `updateDismissed`. Either one
      // has to reach this panel without a reload.
      if (changes.updateInfo || changes.updateDismissed) refreshUpdateBanner();
      if (!changes.settings) return;
      GMStorage.loadSettings().then(function (v) {
        // 0.4.1 §五.3: same subtlety as the viewer — `saveSetting` resolves with the NEW
        // settings, so `S` already holds the new `lang` when this broadcast lands and
        // `v.lang !== S.lang` is false for a change made from this panel's own dropdown.
        // The applied locale (`LANG`) is the only honest baseline.
        var langChanged = GMI18n.resolveLang(v.lang) !== LANG;
        S = v;
        if (!root) return;
        // §1.8: a language change invalidates the SHELL, not just the values in it — every
        // label in it was baked into the DOM by shellHtml(). So it takes a rebuild. It also
        // has to win over the "operator is typing" guard below: nobody is typing into a panel
        // they just switched language on, and skipping the rebuild would leave half the panel
        // in the old language until the next move.
        if (langChanged) { applyLang(S.lang); renderShell(); paint(); return; }
        if (root.activeElement) paintStatus(); else paint();
      });
    });
  }

  function boot() {
    // Before build(): shellHtml() reads T(), so the locale must be resolved first or the very
    // first paint flashes Chinese before the listener can correct it.
    applyLang(S.lang);
    build();
    // Geometry comes from storage, so the panel appears at the remembered size instead
    // of flashing at the default one.
    loadOverlayState();
    paint();
    // 0.4.0 §一.4 — reads whatever the last check left behind; it never triggers a check of
    // its own (only the service worker and the viewer's button do that).
    refreshUpdateBanner();
  }
  loadSettings().then(function () {
    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
  });

  startDomObserver();
  setInterval(function () {
    startDomObserver();
    tickDom();
    tickStall();
    pollEnd();
  }, 1000);
})();
