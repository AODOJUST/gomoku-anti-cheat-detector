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
    //
    // 0.4.6 §二.2: `dir` is set here for the same reason and with the same split — i18n.js puts
    // `data-gm-dir` on the host document (setting `dir="rtl"` on gomoku.com itself would mirror
    // the site's own board and chat, which are not ours to mirror), and the panel's shadow host
    // is the subtree that actually flips. Every `margin-inline-*` / `text-align: start` in the
    // panel's CSS reads this attribute.
    if (root && root.host) {
      root.host.setAttribute('lang', LANG);
      root.host.setAttribute('dir', GMI18n.dirFor(LANG));
    }
  }

  // 0.4.7 §三.1 — the panel's colour scheme. The panel is a Shadow DOM subtree, so it cannot
  // use the viewer's `:root` variables: the theme attribute goes on the SHADOW HOST and the
  // panel's own CSS defines its palette per attribute value (see the STYLE blocks below).
  //
  // `auto` is left on the host as-is rather than resolved to light/dark here: the CSS carries a
  // `@media (prefers-color-scheme: light)` rule for `[data-theme=auto]`, and resolving it in JS
  // would need a matchMedia listener in the content script to stay correct when the OS theme
  // changes. Letting CSS do it means the panel follows the system with no listener at all.
  //
  // `theme` is passed through GMStorage.clampTheme so an unknown value can never be written
  // onto the host (which would match no rule and silently render the light palette).
  function applyTheme(setting) {
    if (!root || !root.host) return;
    root.host.setAttribute('data-theme', GMStorage.clampTheme(setting));
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

  // =====================================================================================
  // 0.4.8 §2 — MV3: the run's transient state lives in chrome.storage.session.
  // =====================================================================================
  // `chrome.storage.session` (MV3, Chrome 102+) holds data in memory for the life of the
  // browser session and never writes it to disk. The three facts below are exactly that kind
  // of fact — which games this session has already archived, whether the live session is
  // finished for good, and which language the opponent last spoke — and each was either being
  // written to `local` (where it outlived the session that gave it meaning) or living only in a
  // module variable (where a reload threw it away).
  //
  // The module variables stay as a SYNCHRONOUS MIRROR: the guards that read them
  // (`if (archivedEpoch[epoch])`, `if (liveStopped)`) sit in hot paths and cannot await. So the
  // session area is the durable copy and the variable is the working copy, written through
  // together by the setters below — the same split the panel already uses for settings.
  //
  // `gameEpoch` is persisted BESIDE `archivedEpoch` because the two only mean anything
  // together. The counter used to restart at 1 on every page load, so a restored `{1: true}`
  // would mark the first game of the new load as already archived and that game's archive
  // would never be written. Restoring the counter with the marks keeps them pointing at the
  // same games.
  var SESSION_KEYS = {
    archived: 'sessionArchivedEpochs',
    liveStopped: 'sessionLiveStopped',
    epoch: 'sessionGameEpoch',
  };

  function sessionArea() {
    try {
      if (chrome && chrome.storage && chrome.storage.session) return chrome.storage.session;
    } catch (e) { /* no extension storage (a stripped harness) — fall through */ }
    try {
      if (chrome && chrome.storage) return chrome.storage.local;
    } catch (e) { /* ditto */ }
    return null;
  }

  function persistSession(patch) {
    var area = sessionArea();
    if (!area || !area.set) return;
    try { area.set(patch); } catch (e) { /* quota, or a detached context: the mirror still works */ }
  }

  function markEpochArchived(epoch) {
    if (epoch == null) return;
    archivedEpoch[epoch] = true;
    var o = {}; o[SESSION_KEYS.archived] = archivedEpoch;
    persistSession(o);
  }

  function setLiveStopped(v) {
    liveStopped = v || null;
    var o = {}; o[SESSION_KEYS.liveStopped] = liveStopped;
    persistSession(o);
  }

  function bumpGameEpoch() {
    gameEpoch++;
    var o = {}; o[SESSION_KEYS.epoch] = gameEpoch;
    persistSession(o);
    return gameEpoch;
  }

  // Restores the three session facts. Called at boot rather than awaited on: every reader
  // already copes with the pre-restore value (an empty mark set, a null stop, a null chat
  // language), so a late arrival can only ADD information — it cannot make a reader wrong,
  // which is what lets this stay fire-and-forget.
  function hydrateSession() {
    var area = sessionArea();
    if (!area || !area.get) return;
    try {
      area.get([SESSION_KEYS.archived, SESSION_KEYS.liveStopped, SESSION_KEYS.epoch], function (r) {
        if (!r) return;
        var ae = r[SESSION_KEYS.archived];
        if (ae && typeof ae === 'object') for (var k in ae) if (ae[k]) archivedEpoch[k] = true;
        var ls = r[SESSION_KEYS.liveStopped];
        if (ls && typeof ls === 'object' && ls.moveNo != null) liveStopped = ls;
        var ep = Number(r[SESSION_KEYS.epoch]);
        if (isFinite(ep) && ep >= 1) gameEpoch = Math.max(gameEpoch, ep);
      });
    } catch (e) { /* nothing to restore */ }
  }

  // =====================================================================================
  // 0.4.9 §一 — the local blacklist, and the border-state machine it feeds (§二)
  // =====================================================================================
  // `blacklistIds` is a SYNCHRONOUS mirror of the stored list, keyed by the case-folded username.
  // The store itself is async (`GMStorage.loadBlacklist()`), but three hot readers cannot await:
  // the 🚫 button's paint, the per-game match check, and the status line. Same split as the
  // session facts above — the store is durable, this is the working copy, and every writer below
  // updates both. Nothing here ever leaves the machine (§1.1).
  var blacklistIds = {};          // { [id.toLowerCase()]: entry }
  var blacklistHit = null;        // the entry matched for THIS game, or null
  var blacklistCheckedEpoch = null;  // gameEpoch the match check last ran for
  var blacklistAlertActive = false;  // §2.2 — the highest-priority border state, while it plays

  // §二 — the six states the panel's border can be in. Kept as a map rather than six loose
  // string literals because the class names, the keyframes and `playFlash`'s durations all have
  // to agree, and three copies of a string this project has already shipped wrong once.
  var BORDER_STATE = {
    IDLE: 'idle',
    READY: 'ready',
    DETECT_START: 'detecting-start',
    LOW: 'low',
    SUSPECT: 'suspect',
    HIGH_FLASH: 'high-flash',
    HIGH: 'high',
    BLACKLIST: 'blacklist',
  };
  // How long each flash animation runs, in ms. Only used as a fallback for a lost
  // `animationend` (see playFlash) — the CSS is what actually times them.
  var FLASH_MS = { 'detecting-start': 1300, 'high-flash': 1150, 'blacklist': 1000 };
  var BLACKLIST_ALERT_MS = 1000;  // §2.5 — ≈ the 0.9s the three blinks take
  var currentBorderState = BORDER_STATE.IDLE;
  var detectingStarted = false;   // §2.1 — 「第一次检测开始」 is a one-shot per game
  var flashing = false;           // a flash owns the border until its animation ends
  var flashToken = 0;

  // 0.4.5 §一 — which host we are on, and what its board looks like. Everything site-specific
  // lives in sites.js; this is the only place the rest of the file has to know about it.
  // `GMSites.current()` returns null on an unrecognised host, in which case every board reader
  // below abstains rather than guessing at gomoku.com's DOM on someone else's page.
  function site() { return (typeof GMSites !== 'undefined' && GMSites) ? GMSites.current() : null; }

  // §二.2 — the rule in force: the operator's explicit choice wins, otherwise infer from the
  // site (gomoku.com's /renju/ path). `S.rule === null` means "auto".
  function isRenju() {
    if (S.rule != null) return S.rule === 2;
    return (typeof GMSites !== 'undefined' && GMSites) ? GMSites.isRenju() : false;
  }

  // 0.4.5 §二.2 — ONE owner for "which rule is in force". The decision was about to be written
  // in three places (the analysis options, the record's meta, the archive entry), and this
  // project has twice shipped a silently wrong answer that existed in three copies (the
  // chat-adjustment side, the risk-card 「交流」 flag). So: `ruleCode()` decides once, and every
  // label is derived from it rather than from `isRenju()` directly — otherwise a manual 连珠 on a
  // site with no /renju/ path would be analysed under 禁手 and filed as 自由.
  function ruleCode() {
    if (S.rule != null) return S.rule;              // 0 自由 / 1 标准 / 2 连珠
    return isRenju() ? 2 : 0;
  }
  // The archive / viewer label. Its schema is binary ('renju' | 'freestyle'), so 标准 (长连不赢,
  // no 禁手) shares the freestyle bucket — it is closer to 自由 than to 连珠.
  function ruleLabel() { return ruleCode() === 2 ? 'renju' : 'freestyle'; }

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
  // A collected stone -> the app's own board coordinates: x = column (0 = left), y = row counted
  // DOWN from the top (0 = top) — see `shareToCoord` in app.js, "y:0=top -> number = SIZE - y".
  // The collector's `row` counts the other way (gomoku.com's data-row 0 is the BOTTOM row, i.e.
  // share A1), so `14 - row` is the flip. `toRecord` does the same flip, which is why a move that
  // goes through both agrees. 0.4.5 §一: sites.js performs the equivalent flip for papergames.io,
  // whose table rows count from the top, so `m.row` means the same thing on both hosts.
  function movePoint(m) { return [m.col, 14 - m.row]; }

  // The opening of the CURRENT game, or null.
  //
  // 0.4.2 §一: no longer gated on a recoverable order. Black 1 is pinned to tengen by the
  // definition of an opening, so with 2 or 3 stones on the board the ROLES are decided by
  // position and a mid-join is identifiable for real (2 stones -> family only). Past three
  // stones "black 3" is not identifiable inside the set any more, so there the ordered path
  // is the only one — and it does need the order.
  function currentOpening() {
    var mv = activeMoves();
    if (mv.length < 2) return null;
    var inferred = countInferred(mv);
    if (mv.length > 3 && inferred) return null;
    var pts = [], sides = [];
    var upto = mv.length < 3 ? mv.length : 3;
    for (var i = 0; i < upto; i++) {
      pts.push(movePoint(mv[i]));
      // 1 = black / 2 = white in the collector; anything else lets openings.js fall back to
      // index parity (only correct when the list really does start at move 1).
      sides.push(mv[i].stone === 1 ? 'B' : (mv[i].stone === 2 ? 'W' : null));
    }
    return GMOpening.detectOpening(pts, { unorderedCount: inferred, stones: sides });
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
      pts.push([m.col, 14 - m.row]);          // board row 0 = BOTTOM (share A1); app.js y 0 = top
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
        rule: ruleLabel(),
        // The RIF opening, derived from the first three KEPT moves (the dedup above can drop
        // one, and then "move 3" would not be the third stone). 0.4.2 §一: when the order is
        // unknown the roles are recovered from the positions instead of the whole thing being
        // refused, so a mid-join now yields either a real name (3 stones) or the family alone
        // (2 stones, `stage: 'family'`). `stones` is what makes that possible — the colours
        // are known even when the order is not.
        opening: GMOpening.detectOpening(pts, { unorderedCount: inferred, stones: stones }),
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
      // §二.2 — an explicit rule (0 自由 / 1 标准 / 2 连珠) wins; otherwise the site decides.
      // papergames.io has no renju mode, which is exactly why the manual override exists.
      rule: ruleCode(),
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
  //
  // 0.4.6: `waiting` / `unknown` / `anonymous` / `guest` are the same defence for papergames.io.
  // Its player row simply does not exist until BOTH sides are seated (verified — sampling the row
  // once a second during matchmaking showed `cols=[]` until the opponent joined, never a
  // placeholder name), so these four are belt-and-braces rather than something observed. They are
  // exact matches, so a real user called "Guest123" is unaffected; the cost is that a user who
  // deliberately picks one of these four words gets no name, and the naming rule then falls back
  // to 黑方 VS 白方. A leaked placeholder is the worse of the two failures: it is a wrong name that
  // looks like a right one.
  var NAME_PLACEHOLDERS = ['you', 'opponent', 'player', 'player2', 'player 1', 'player 2',
                           'spectating', 'waiting', 'unknown', 'anonymous', 'guest',
                           '你', '您', '对手', '對手', '玩家', ''];

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
  // `pairFrom()` handles below.
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

  // 0.4.6 §一: the selectors are per-site now. gomoku.com's table is deliberately NOT wrapped,
  // rewritten or normalised — `nameSelectors()` hands back `DOM_NAME_SEL` verbatim for it, which
  // is what makes §1.6's "gomoku.com 的玩家名采集不受影响" true by construction instead of by luck.
  var GOMOKU_NAME_SEL = {
    black: DOM_NAME_SEL.black, white: DOM_NAME_SEL.white,
    self: DOM_NAME_SEL.self, opponent: DOM_NAME_SEL.opponent,
    // The 观战 page's side-by-side names. No colour on them, and no account menu to orient them
    // with either — a spectator is not one of the two players, so DOM order is the only meaning
    // these names can carry.
    pair: SPECTATOR_PAIR_SEL,
    selfName: null,
    spectator: true,
  };

  function nameSelectors() {
    var st = (typeof GMSites !== 'undefined' && GMSites) ? GMSites.current() : null;
    var ps = st && st.playerNameSel;
    if (!ps) return GOMOKU_NAME_SEL;
    return {
      black: ps.black || [], white: ps.white || [],
      self: ps.self || [], opponent: ps.opponent || [],
      pair: ps.pair || null,
      // Which of the pair is us. papergames.io puts no colour anywhere near a name, so this
      // second signal is the only thing standing between "A VS B" and "B VS A".
      selfName: ps.selfName || [],
      spectator: false,
    };
  }

  // Names are compared here, never displayed, so the comparison is case- and space-insensitive:
  // the account menu and the player row are two different renders of the same string.
  function normName(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function cleanName(el) {
    if (!el) return null;
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (NAME_PLACEHOLDERS.indexOf(t.toLowerCase()) >= 0) return null;
    return t.slice(0, 40);
  }

  // A bare pair of names side by side, with no colour on them and no "you"/"opponent" wording.
  //
  // Two very different situations share this shape, and the caller has to know which one it is:
  //   · 观战 (gomoku.com): we are not one of the two, so DOM order is the whole meaning.
  //   · papergames.io: we ARE one of the two, and DOM order is NOT the meaning (see sites.js) —
  //     `oriented` reports whether we managed to establish which side is us.
  function pairFrom(sels) {
    if (!sels.pair) return null;
    var nodes = document.querySelectorAll(sels.pair);
    if (nodes.length < 2) return null;
    var a = cleanName(nodes[0]), b = cleanName(nodes[1]);
    if (!a || !b || a === b) return null;
    var res = { self: a, opponent: b, oriented: false, spectator: !!sels.spectator };
    if (res.spectator) return res;
    // Orient with our own nickname — read from the ACCOUNT MENU, not from the row, because the
    // row is exactly the thing whose order cannot be trusted. This must be the bare-name element:
    // every ancestor of it also holds the credit balance, so an ancestor can never match (sites.js
    // records the live structure). A miss here is not an error — it just leaves the pair in DOM
    // order, which the caller records as such.
    var me = normName(domOneOf(sels.selfName || []));
    if (me) {
      var na = normName(a), nb = normName(b);
      if (na === me && nb !== me) res.oriented = true;
      else if (nb === me && na !== me) { res.self = b; res.opponent = a; res.oriented = true; }
    }
    return res;
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

  // The names of the two sides, from the strongest source available.
  //
  // 0.4.6 §一 changed two things here and nothing else: the selectors now come from the SITE
  // (`nameSelectors()`) instead of being a gomoku-only constant, and a bare side-by-side pair is
  // a route of its own. That second part is the whole fix for papergames.io — it has no colour and
  // no "you"/"opponent" wording anywhere, so before this the record was always nameless there.
  function readNames() {
    var sels = nameSelectors();
    var out = { black: null, white: null, self: null, opponent: null, source: null,
                // 0.4.9 §一.3 — the seat USERNAMES beside the display names. Only the socket can
                // say which id belongs to which colour (`game-start` ships `players[{id,name,
                // color}]`), so every other route leaves these null — and null means "this route
                // did not supply one", NOT "this seat has no account". `resolveOpponentId()`
                // adds the two page-level routes on top.
                blackId: null, whiteId: null };

    // 1) socket — the only route that can name a COLOUR, and on gomoku.com the usual one.
    if (socketRec && socketRec.players) {
      out.black = socketRec.players.black || null;
      out.white = socketRec.players.white || null;
      if (out.black || out.white) out.source = 'socket';
    }
    if (socketRec && socketRec.playerIds) {
      out.blackId = socketRec.playerIds.black != null ? String(socketRec.playerIds.black) : null;
      out.whiteId = socketRec.playerIds.white != null ? String(socketRec.playerIds.white) : null;
    }

    // 2) DOM
    if (!out.black && !out.white) {
      var db = domOneOf(sels.black), dw = domOneOf(sels.white);
      if (db && dw) { out.black = db; out.white = dw; out.source = 'dom'; }
      else {
        // Side-by-side or not at all: a half-filled black/white pair would put a name on
        // the wrong colour, which is what the archive naming then prints.
        out.self = domOneOf(sels.self);
        out.opponent = domOneOf(sels.opponent);
        if (out.self || out.opponent) out.source = 'dom';
        else {
          var pr = pairFrom(sels);
          if (pr) {
            out.self = pr.self; out.opponent = pr.opponent;
            if (pr.spectator) {
              // 观战: the pair IS the whole answer, and it is also the one reliable DOM sign that
              // this session is a spectator. The source stays 'dom' — gomoku.com's recorded value
              // for this route must not shift in a release that is about papergames.io.
              out.spectator = true;
              out.source = 'dom';
            } else {
              // Two distinct values, because they are two distinct claims. 'dom-pair' means the
              // pair was read AND we know which side is us; 'dom-pair-order' means we know the two
              // names but NOT their orientation, and the record says so instead of pretending.
              out.source = pr.oriented ? 'dom-pair' : 'dom-pair-order';
            }
          }
        }
      }
    }
    // 3) anonymous — nothing to fill in
    if (!out.source) out.source = 'none';
    return out;
  }

  // ---------- the name memo (0.4.6 §一) ----------
  // papergames.io TEARS THE ROOM DOWN when a game ends and puts the lobby back — that is how the
  // ending is detected at all (`endOnBoardGone`, 0.4.5 §一). By the time `pollEnd` acts, its 2.5 s
  // grace period has already elapsed since the board disappeared, so `app-room-players` is usually
  // gone with it. Reading names only at finalize time would therefore find nothing and file the
  // very nameless record this release exists to fix, so the tick remembers the last good read.
  //
  // Cleared in `beginNewGame`, so a memo can only ever belong to the game it was read from.
  var nameMemo = null;

  function rememberNames() {
    var n = readNames();
    // A name that names at least one side is worth keeping; `none` is not, or the memo would be
    // overwritten by the first empty tick and never survive to the finalize.
    if (n.source !== 'none') nameMemo = n;
  }

  function playerNames() {
    var n = readNames();
    if (n.source !== 'none') return n;
    // Nothing readable right now. On a site that tears its markup down at game end that is
    // EXPECTED at the exact moment the record is built — the board and the player row left
    // together — so fall back to what the tick saw while the game was still on screen. Everywhere
    // else the DOM is the truth and the memo is deliberately not consulted.
    var st = site();
    if (nameMemo && st && st.endOnBoardGone) return nameMemo;
    return n;
  }

  // =====================================================================================
  // 0.4.9 §一.3 — the opponent's USERNAME, for the local blacklist
  // =====================================================================================
  // §1.1/§1.2 in one sentence: the blacklist has to be keyed on the site's username
  // (`playerId` — unique, stable, uneditable), because the display name is none of those. §一.3
  // names three routes to it and §六 is candid that only one of them has been confirmed against
  // the live DOM. The three are therefore tried in order, each one defensively, and the route
  // that answered is recorded on the result — a wrong id is only fixable if the route that
  // produced it is on the record.

  /** §一.3 level 1 — the page's `<meta name="playerId"> / <meta name="displayName">` pair. */
  function readPlayerMeta() {
    if (typeof GMSites === 'undefined' || !GMSites || !GMSites.playerMeta) return { id: null, name: null };
    try { return GMSites.playerMeta() || { id: null, name: null }; }
    catch (e) { return { id: null, name: null }; }
  }

  /** §一.3 level 3 — the username out of `/xx/profile/<username>`. */
  function playerIdFromProfileUrl(url) {
    if (typeof GMSites === 'undefined' || !GMSites || !GMSites.profileId) return null;
    try { return GMSites.profileId(url); }
    catch (e) { return null; }
  }

  // Ids are compared the way storage.js compares them (trim + case-fold), so the same player
  // reached by two routes cannot read as two people. Kept here as well as there because this
  // comparison guards against blocking OURSELVES — the one mistake in this feature that is worse
  // than doing nothing.
  function sameId(a, b) {
    if (a == null || b == null) return false;
    var x = String(a).trim().toLowerCase(), y = String(b).trim().toLowerCase();
    return !!x && x === y;
  }

  /**
   * Which colour the OPPONENT is, as 'B' / 'W' / null.
   *
   * This is `chatAdjSide()`'s question, asked in the same way on purpose. §1.5's sketch writes
   * `oppId = chatSenderIsBlack === true ? whiteId : blackId` — which is INVERTED against the
   * field content.js actually keeps: `chat.senderIsBlack` holds the OPPONENT's colour (the note
   * on `chatAdjSide()` spells the chain out: `senderFromPlayers` returns OUR colour and
   * `resolveSenderColour` negates it). Taken literally, the sketch would block the operator's own
   * seat in every game where the opponent held black. The polarity below is the pinned one.
   *
   * `chatAdjSide()` answers it whenever a message has been placed; when nobody has spoken and
   * the seat list named nobody, the seat NAMES are the next best evidence: the opponent's
   * display name matched against the black and white seats.
   */
  function opponentSideLetter() {
    var fromChat = chatAdjSide();
    if (fromChat) return fromChat;
    var n = playerNames();
    if (n.opponent) {
      if (n.black && normName(n.black) === normName(n.opponent)) return 'B';
      if (n.white && normName(n.white) === normName(n.opponent)) return 'W';
    }
    return null;
  }

  /** The seat username for the side that is NOT the opponent — i.e. ours. */
  function ownSeatId(oppSide) {
    var ids = (socketRec && socketRec.playerIds) || {};
    var side = oppSide === 'B' ? 'W' : (oppSide === 'W' ? 'B' : null);
    if (side === 'B' && ids.black != null) return String(ids.black);
    if (side === 'W' && ids.white != null) return String(ids.white);
    var self = socketRec && socketRec.selfId;
    return self == null ? null : String(self);
  }

  /**
   * §一.3 — the opponent's `{ id, name, how }`, or null when no route could answer.
   *
   * The route ORDER is the spec's (meta → socket → profile URL), with one guard the spec could
   * not have written because §六 leaves the question open:
   *
   *   A `<meta name="playerId">` is a per-session render of the page. On a profile page it
   *   plainly describes that profile's owner. On the GAME page — the page this feature actually
   *   runs on — the far likelier reading is that it describes the LOGGED-IN user, i.e. us, since
   *   the server rendered the page for our session. Honouring it blindly would let 「加入黑名单」
   *   write our own id into the list, and the failure is silent (the button turns red, the list
   *   has an entry, nothing looks wrong). So the meta level answers only when it can be
   *   ATTRIBUTED to the opponent: its `displayName` must match the opponent's display name, and
   *   its id must not be ours. When either guard fails the level declines and the socket — which
   *   names each seat explicitly and was always going to be right — answers instead.
   *
   * `how` is 'meta' | 'socket' | 'url'.
   */
  function resolveOpponentId() {
    var side = opponentSideLetter();
    var names = playerNames();
    var oppName = names.opponent
      || (side === 'B' ? names.black : (side === 'W' ? names.white : null))
      || null;

    // 1) the page meta — only when it demonstrably describes the opponent.
    var meta = readPlayerMeta();
    if (meta.id && meta.name && oppName &&
        normName(meta.name) === normName(oppName) && !sameId(meta.id, ownSeatId(side))) {
      return { id: meta.id, name: meta.name, how: 'meta' };
    }

    // 2) the socket seat id — authoritative, and the only route that names both seats.
    var ids = (socketRec && socketRec.playerIds) || {};
    if (side === 'B' && ids.black != null) {
      return { id: String(ids.black), name: names.black || oppName, how: 'socket' };
    }
    if (side === 'W' && ids.white != null) {
      return { id: String(ids.white), name: names.white || oppName, how: 'socket' };
    }

    // 3) the profile page's own URL, when the operator has the opponent's profile open.
    var fromUrl = playerIdFromProfileUrl(location.href);
    if (fromUrl && !sameId(fromUrl, ownSeatId(side))) {
      return { id: fromUrl, name: oppName, how: 'url' };
    }

    return null;
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
    // 0.4.4 §14 — the chat record rides along with the report, but only when there IS one. A
    // `chatAdjust` on every archive would be dead weight in the shared 10MB budget, and
    // `{asks:0,total:0}` is exactly the state a viewer can already infer from its absence.
    if (chat.asks || chat.history.length) {
      report.chatAdjust = {
        side: chatAdjSide(),
        asks: chat.asks,
        total: chat.total,
        how: chat.senderHow || null,
      };
      report.chatHistory = chat.history.slice(0, 20);
    }
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
      if (job._epoch != null) markEpochArchived(job._epoch);
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
        rule: ruleLabel(),
        suspect: S.suspect,
        outcome: record.meta.outcome,
      });
      await GMStorage.saveArchive(entry, { replaceId: job.archiveId || null });
      job.archiveId = entry.id;
      lastArchive = entry;
      lastSkip = null;
      if (job._epoch != null) markEpochArchived(job._epoch);   // 0.3.7 §一.1
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

  // 0.4.11 §一.8 — shape validation for the MAIN world -> isolated world channel.
  //
  // This is NOT a security boundary. A MAIN-world script can read and write anything on the
  // page; the real attack surface is between the page and the extension, and this wire is
  // inside the page. What it stops is an ACCIDENT: a statistics script, an ad frame or a CDN
  // shim that happens to dispatch a same-named CustomEvent would otherwise have its payload
  // parsed and merged into the captured record as if the socket had sent it. "It cannot be
  // forged on purpose" is not required; "it cannot collide by accident" is.
  var GM_EVENT_KINDS = ['move', 'reset', 'seed', 'players', 'end', 'attached', 'error'];
  var lastAcceptedCount = null;
  var lastAcceptedDropped = 0;

  function validateGmEvent(p) {
    if (!p || typeof p !== 'object') return false;
    if (GM_EVENT_KINDS.indexOf(p.kind) < 0) return false;
    var d = p.data;
    if (!d || typeof d !== 'object') return false;
    if (d.source !== 'socket') return false;
    if (!Array.isArray(d.moves)) return false;
    // `count` is the recorder's own `rec.moves.length` — a snapshot where the two disagree was
    // not assembled by the recorder.
    if (d.count !== d.moves.length) return false;
    // Within one game the board only grows, with one honest exception: hook.js PRUNES recorded
    // stones the board no longer shows and counts them in `dropped` (absorbStones). So a LOWER
    // count is legitimate exactly when that witness has grown, and `reset` — whose snapshot is
    // legitimately empty — is exempt outright. A bare `count < lastCount` reject would drop a
    // genuine resync frame, and a dropped frame is a silently wrong record: worse than the
    // collision this check exists for.
    if (p.kind !== 'reset' && lastAcceptedCount != null && d.count < lastAcceptedCount) {
      if (!(Number(d.dropped) > lastAcceptedDropped)) return false;
    }
    // Both worlds belong to one document, so the offset between their clocks should be ~0.
    // Five seconds is loose enough for a stalled frame and tight enough to catch a snapshot
    // stamped with Date.now() by someone who confused it with performance.now().
    if (d.clockNow != null && Math.abs(performance.now() - d.clockNow) > 5000) return false;
    return true;
  }

  window.addEventListener(EV_EVENT, function (e) {
    var p;
    try { p = JSON.parse(e.detail); } catch (err) { return; }
    // 0.4.4 §八 — chat rides on its own kind and carries no snapshot (see hook.js:emitChat).
    // It is checked BEFORE the shape gate: a chat frame has no `data` at all by design.
    if (p && p.kind === 'chat' && p.chat) {
      onChatMessage(p.chat.text, p.chat.fromId, 'socket:' + (p.chat.evt || '?'));
      return;
    }
    if (!validateGmEvent(p)) {
      // Dev-visible, user-invisible (§8.3). Worth a line in the console precisely because the
      // alternative failure mode is a record that is quietly wrong rather than an error.
      console.warn('[detector] 丢弃形状非法的 ' + EV_EVENT + ' 事件：kind=' +
        (p && p.kind) + ' source=' + (p && p.data && p.data.source));
      return;
    }
    lastAcceptedCount = p.data.count;
    lastAcceptedDropped = Number(p.data.dropped) || 0;

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

    // §9 — every socket frame is a chance to learn which seat we are. Doing it here (rather than
    // only when a message arrives) is what lets the operator ask the first question.
    resolveSenderColour();

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
      setLiveStopped(null);    // the record no longer matches what was stopped on
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

  // The board's intersections. 0.4.5 §一: the selector list now comes from sites.js, because
  // papergames.io's board is a <table> of td.cell-<row>-<col> and shares no class with
  // gomoku.com's. A host we do not recognise yields [] — "no board here" — rather than
  // gomoku.com's selectors applied to a stranger's page.
  function boardCells() {
    return (typeof GMSites !== 'undefined' && GMSites) ? GMSites.boardCells() : [];
  }

  function findGrid() {
    return (typeof GMSites !== 'undefined' && GMSites) ? GMSites.findGrid() : null;
  }

  // One key convention for a board point, everywhere: `row,col`, in this order. hook.js has
  // the identical `keyOf()` on the other side of the world boundary, and `toRecord` uses it
  // for dedup too — a mixed order would not break anything on its own, but the two keys
  // look interchangeable and that is how a future merge/dedup between them goes wrong.
  function cellKey(r, c) { return r + ',' + c; }

  // 0.4.5 §一 — the stone encoding is per site: gomoku.com appends a .stone.black-stone |
  // .stone.white-stone child to a played .board-intersection, while papergames.io puts an
  // <svg class="symbol"> with a circle-dark (black) / circle-light (white) inside a
  // td.cell-<row>-<col>. sites.js owns both, and owns the row flip that maps papergames'
  // top-down rows onto gomoku's bottom-up ones.
  // Returns null when the board has not been built yet (unknown) vs [] for "empty".
  function boardStones() {
    return (typeof GMSites !== 'undefined' && GMSites) ? GMSites.boardStones() : null;
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
    var st = site();
    if (!st) return false;
    var cells = boardCells();
    if (cells.length < 225) return false;
    for (var i = 0; i < cells.length; i++) if (!cells[i].querySelector(st.stoneSel)) return false;
    return true;
  }

  // 0.4.5 §一 — "there is no board here any more". A site whose board is REMOVED at game end
  // (papergames.io) uses this as its ending; the move floor keeps a page that simply has no
  // board yet from ending a game that never started.
  function boardGone() {
    return activeMoves().length >= 4 && boardCells().length === 0;
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
  // 0.4.5 §一 — sites whose board is REMOVED when the game ends (papergames.io returns to the
  // lobby). Held for a grace period because a re-render can unmount the table for a moment.
  var GONE_GRACE_MS = 2500;
  var goneSince = 0;

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
      var st = site();
      var o = document.querySelector('.game-end-overlay');
      var ep = null;
      if (o && !o.classList.contains('hidden')) {
        endGame('结算浮层');
      } else if (drawOverlay()) {
        endGame('和棋浮层');
      } else if ((ep = endProbe())) {
        // Only evaluated when every earlier branch missed, so the DOM scan happens once.
        endGame('结算文案（' + ep + '）');
      } else if (st && st.endOnBoardGone && boardGone()) {
        // 0.4.5 §一 — papergames.io takes the board away when the game ends and puts the lobby
        // back, so a board that has DISAPPEARED while we still hold a live record IS the ending.
        // Verified live (2026-09-29): aborting took `td[class*=cell-]` from 225 to 0.
        //
        // The move-count floor is what keeps a first page load — where there is no board yet —
        // from ending a game that never started, and the grace period covers a re-render that
        // unmounts the table for a frame. Nothing else resets the record here: `boardStones()`
        // answers `null` (unknown) rather than `[]` (empty) when there are no cells at all, so
        // tickDom's "board cleared" path does not fire and the moves are still there to archive.
        if (!goneSince) goneSince = performance.now();
        else if (performance.now() - goneSince > GONE_GRACE_MS) endGame('棋盘已撤下（对局结束）');
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
        goneSince = 0;
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
      // 0.4.7 §2.2: a finished job never sits below 99 whatever path it took here. The
      // percentage is only meaningful while a run is advancing, and leaving a failed run at
      // 43% made the compact face read like work in progress that had stalled — the same
      // "stuck at 99%" complaint, one branch over. `job.report` is what the panel actually
      // shows once `running()` is false; this just keeps the two consistent.
      if (job.status !== '已完成') job.progress = Math.max(job.progress || 0, 99);
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
    setLiveStopped(null);
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
      // 0.4.5 §三 / 修复4 — 开局排除 DOES apply on this path, but deliberately NOT as the
      // `if (pos < S.openingCutoff) return;` the spec sketches. The engine call is already
      // skipped: analyzeStep computes `isOpening` from the `playerIdx` we send below and returns
      // before `eng.configure`/`analyzePosition`. What the round trip still does is create the
      // step ROW — offscreen's live session is the report, `gm-step-finish` builds the archived
      // report straight out of `live.steps`, and the viewer renders one table row per entry. So
      // returning early here would silently drop the opening rows from the report and shrink its
      // `totalMoves`, which §3.5.4 ("统计结果与修复前完全一致") forbids. The message costs a
      // postMessage; the row is what the operator reads.
      // 0.4.11 §一.1 — the WHOLE board's colours, not the prefix's. offscreen compares the
      // array's length against `prefix.concat([actual])`; sending `slice(0,-1)` made the two
      // differ by one for ever, so `board` was always null and analyzeStep fell back to
      // index parity — silently right until a stone was de-duplicated, marked prejoin, or an
      // AI reference move was inserted, at which point EVERY later colour shifted by one and
      // 0.4.8's shape-first forced defence never fired on the live path. Length must equal
      // record.moves.length here.
      //
      // Hoisted into a local (rather than inlined in the message) because the SAME array has to
      // answer `side` below: `boardSides[pos]` is the colour of the move that survived, which is
      // the other half of the same fix. Two spellings of one array is how these two would drift.
      var boardSides = record.stones.map(function (s) {
        return s === 1 ? 'B' : (s === 2 ? 'W' : null);
      });
      var resp = await askOffscreen({
        type: 'gm-step',
        jobId: liveJob.id,
        reset: !!liveJob._reset,
        prefix: record.moves.slice(0, -1),
        boardSides: boardSides,
        actual: last,
        playerIdx: pos,
        // The recorded colour, not the index — and specifically the colour of the move that
        // SURVIVED de-duplication (`record.stones[pos]`), not the raw capture entry's own
        // `stone` field. §一.1: after a drop the raw entry is the ORIGINAL one while `pos` indexes
        // the kept one, so the two disagree about exactly the hands this fix is about.
        side: boardSides[pos],
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
          setLiveStopped({ moveNo: tMoveNo, reason: tReason });
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
    // 0.4.7 §2.2: set BEFORE the await, and unconditionally. The old code only reached
    // `job.progress = 100` inside the `resp.ok` branch, so a failed finish (an offscreen round
    // trip that timed out, a channel that closed) left the job at whatever the last hand
    // scored — and §2.2's report was a compact face stuck at 99%. A job that has stopped
    // reporting progress must never claim to be mid-way, whatever happened to the request.
    job.progress = 100;
    try {
      var resp = await askOffscreen({ type: 'gm-step-finish', jobId: job.id }, 3);
      if (resp.ok) {
        job.report = resp.report;
        job.status = '已完成';
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
      markEpochArchived(epoch);
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
    setLiveStopped(null);
    bumpGameEpoch();
    // 0.4.6 §一 — the remembered names belong to the game that just ended. Keeping them past this
    // point would let a papergames.io game with no readable row inherit the previous game's
    // players, which is a wrong name that looks like a right one.
    nameMemo = null;
    // 0.4.4 §七/§十二 — the chat side is per-game too: the 30s announcement window, the
    // 「本局忽略」 choice and the 提问 record all restart. `chat.lang` deliberately survives
    // (see resetChatForGame).
    resetChatForGame();
    // 0.4.9 §1.5/§2.1 — the blacklist match and the two one-shot border flashes belong to the
    // game that just ended. Carrying them over would keep the previous game's warning on screen
    // (and its red flash) against a player who may not be the one being blocked now.
    blacklistHit = null;
    blacklistCheckedEpoch = null;
    detectingStarted = false;
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
    //
    // 0.4.6 §二.2 — RTL. The panel's CSS needed almost nothing: it is built from flex rows and
    // symmetric padding, so it carries no `margin-left` / `border-right` / `text-align:left` at
    // all, and the header's button order mirrors on its own once the direction is right. Two
    // things did need attention:
    //
    //  · the anchor corner is `inset-inline-end` rather than `right`, so a fresh Arabic operator
    //    gets the panel on the mirrored side. A SAVED position still wins, because the drag code
    //    writes inline `left`/`right` — deliberately: where the operator put the panel is a
    //    physical choice and should not be re-mirrored on a language switch.
    //  · `all:initial` resets `direction` to ltr, which DEFEATS the `dir` attribute content.js
    //    sets on this host. The `dir` attribute is only a presentational hint (specificity 0) and
    //    an author declaration beats it, so the direction has to be re-asserted from the
    //    attribute itself — see the two `:host([dir=…])` rules below. Without them the panel
    //    would render left-to-right under Arabic and every logical property above would be a
    //    no-op.
    ':host{all:initial;position:fixed;top:12px;inset-inline-end:12px;width:580px;--gm-max:86vh;z-index:2147483647;display:block;',
    'font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:var(--gm-txt)}',
    // These two must come AFTER the `font:…}` above, which is what closes the `:host{` block —
    // the rule is split across two array entries, so anything inserted between them lands INSIDE
    // `:host{ … }` as a bogus declaration and takes the rest of the block down with it.
    ':host([dir="rtl"]){direction:rtl}',
    ':host([dir="ltr"]){direction:ltr}',
    // 0.4.7 §三.1 — the panel's palette, as variables so the theme attribute can swap it. The
    // dark values are the ones 0.4.6 shipped hard-coded, so an operator on the default `auto`
    // setting with a dark OS sees a byte-identical panel. `--gm-txt` / `--gm-mut` are named
    // with the prefix because `:host{all:initial}` gives the subtree no inherited custom
    // properties of its own, and a bare `--txt` would collide with nothing but read as if it
    // were the viewer's.
    //
    // `data-theme="light"` is the explicit override; `data-theme="auto"` gets the dark set
    // from the media query below. Both are declared AFTER the `:host` block above for the same
    // reason the two `dir` rules are: these are `:host([...])` selectors, and putting them
    // inside the split `:host{` block would make them bogus declarations.
    ':host{--gm-bg:#161b22;--gm-panel:#1a2029;--gm-head:#1a2029;--gm-line:#2a3441;--gm-line-soft:#22303c;',
    '--gm-txt:#e6edf3;--gm-txt-2:#c8d2dc;--gm-mut:#9aa7b4;--gm-dim:#6e7b8a;--gm-off:#4a5563;',
    '--gm-lk:#7aa2ff;--gm-in:#0d1117;--gm-bar:#0d1117;',
    // 0.4.8 §一 — the second tier. Same defect the viewer had: these were inline, so the light
    // panel went pale and left its banner, hover washes and dividers dark. `--gm-hov` is the
    // row/menu hover, `--gm-btn-hov` the neutral button hover, `--gm-info-*` the blue banner
    // (and the .t-run badge), `--gm-div` the in-panel divider.
    '--gm-hov:#243040;--gm-btn-hov:#33404f;--gm-pri-hov:#4a6cf0;--gm-div:#1b2530;',
    '--gm-info-bg:#16233d;--gm-info-line:#2f4b8f;--gm-info-fg:#cfe0ff;',
    // 0.4.10 §一.3 — the state GLOW, as a variable rather than a `box-shadow` written by the
    // state rules. Two releases learned this the hard way: 0.4.9's state rules SET `box-shadow`
    // outright, which REPLACES the panel's own drop shadow rather than adding to it, so every
    // state change also silently dropped the panel's shadow. Composing instead — the panel's
    // shadow first, then `var(--gm-glow)` — keeps both. The fallback is a fully transparent
    // shadow and NOT `none`: `box-shadow: 0 10px 34px #000, none` is an invalid list and the
    // browser drops the WHOLE declaration, i.e. the panel would lose its shadow at rest the
    // moment this was introduced. Declared once here because a glow is data ink — it is the
    // same in both themes (the state colours are).
    '--gm-glow:0 0 0 rgba(0,0,0,0)}',
    ':host([data-theme="light"]){--gm-bg:#ffffff;--gm-panel:#f5f5f5;--gm-head:#ececec;--gm-line:#d0d0d0;',
    '--gm-line-soft:#e0e0e0;--gm-txt:#1a1a1a;--gm-txt-2:#333333;--gm-mut:#555555;--gm-dim:#6b6b6b;',
    '--gm-off:#aaaaaa;--gm-lk:#2a4bd7;--gm-in:#f0f0f0;--gm-bar:#e2e2e2;',
    '--gm-hov:#ececec;--gm-btn-hov:#d8d8d8;--gm-pri-hov:#3d5fd8;--gm-div:#e0e0e0;',
    '--gm-info-bg:#e8f0fe;--gm-info-line:#a8c4f0;--gm-info-fg:#1f3f7a}',
    '@media (prefers-color-scheme: light){:host([data-theme="auto"]){--gm-bg:#ffffff;--gm-panel:#f5f5f5;',
    '--gm-head:#ececec;--gm-line:#d0d0d0;--gm-line-soft:#e0e0e0;--gm-txt:#1a1a1a;--gm-txt-2:#333333;',
    '--gm-mut:#555555;--gm-dim:#6b6b6b;--gm-off:#aaaaaa;--gm-lk:#2a4bd7;--gm-in:#f0f0f0;--gm-bar:#e2e2e2;',
    '--gm-hov:#ececec;--gm-btn-hov:#d8d8d8;--gm-pri-hov:#3d5fd8;--gm-div:#e0e0e0;',
    '--gm-info-bg:#e8f0fe;--gm-info-line:#a8c4f0;--gm-info-fg:#1f3f7a}}',
    '*{box-sizing:border-box}',
    // 0.4.9 §二.3 — the panel's border is a STATE INDICATOR. The width grew from 1px to 2px so the
    // colour can actually be read from the corner of an eye (a 1px line at the edge of a dark
    // panel is invisible), and the two transitions let every state change cross-fade rather than
    // snap. The colour itself is still the palette's `--gm-line` at rest, so an operator who
    // never sees a state change sees the panel they had.
    // The width is 4px as of 0.4.10 §一.3 (it was 2px): the state colours are data ink read from
    // the corner of an eye over a live board, and a state indicator nobody notices is the same as
    // no indicator. The `--gm-glow` slot rides AFTER the panel's own drop shadow so a state adds
    // a halo instead of losing the shadow (see the `:host` definition for that story).
    '.gm{background:var(--gm-bg);border:4px solid var(--gm-line);border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.55),var(--gm-glow,0 0 0 rgba(0,0,0,0));overflow:hidden;display:flex;flex-direction:column;max-height:var(--gm-max);position:relative;',
    'transition:border-color .3s ease,box-shadow .3s ease}',
    // 0.4.9 §二.3 — the six states, as CSS animations.
    //
    // The colours here are LITERAL and deliberately NOT themed, the same way the risk numbers
    // (`.cpnl .cv.up` #e74c3c / `.dn` #2ecc71) and `.tbadge.*` are not: the colour is the
    // meaning. A "themed" green would mean something different under 浅色 than under 深色, which
    // is precisely what a state indicator must never do. (0.4.8's rule — every colour a RULE
    // needs gets a name and a value in both palettes — is about SURFACES; data ink is exempt by
    // the same release's own note.)
    //
    // The flash keyframes start and end on the resting colour so that losing the `animationend`
    // event leaves the border at the palette colour rather than stuck mid-flash; `playFlash()`
    // additionally carries a timer for that case.
    //
    // ALL THREE FACES carry the state, which is why the selector is the HOST's `data-bs`
    // attribute and not a class on `.gm`. 缩略 (`.gmcp`) and 图标 (`.mface`) hide `.gm`
    // (display:none) — so a class on `.gm` is the one place a state indicator cannot be seen, and
    // deleting the indicator exactly when the operator shrinks the panel to glance at it is
    // backwards. One attribute on the host, three surfaces reading it: the state still has
    // exactly one home.
    //
    // `:host([data-bs=…])` is also what makes the state SURVIVE a shell rebuild. Store the state
    // in a JS variable and `renderShell()` (a language change) replaces `.gm` while the variable
    // still claims the old value — see setBorderState().
    // The breathe pulses the LINE ITSELF, between a dimmed and a full blue. Varying only the alpha
    // (what this first shipped) leaves the RGB identical at every frame, so the 2px line reads as a
    // static blue frame with a soft halo moving behind it — 「蓝色呼吸灯」 that does not visibly
    // breathe. `#3c5ee7` stays the reference colour: it is both the 就绪 solid value and the
    // breathe's brightest frame.
    // 0.4.10 §一.3 — every glow radius is the 0.4.9 number scaled by the same amount the border
    // grew (8px → 12px, 20px → 28px), and every one of them rides the `--gm-glow` slot so it can
    // only ever ADD to the panel's shadow. The keyframes deliberately do NOT animate `box-shadow`:
    // the same animation is attached to all three faces via `:is(...)`, so a `box-shadow` frame
    // would also overwrite `.mface`'s own shadow — see the `:host` definition.
    '@keyframes gm-breathe-blue{0%,100%{border-color:#2a419c}50%{border-color:#3c5ee7}}',
    ':host([data-bs=idle]){--gm-glow:0 0 12px rgba(60,94,231,.32)}',
    ':host([data-bs=idle]) :is(.gm,.gmcp,.mface){animation:gm-breathe-blue 2.8s ease-in-out infinite}',
    ':host([data-bs=ready]){--gm-glow:0 0 12px rgba(60,94,231,.5)}',
    ':host([data-bs=ready]) :is(.gm,.gmcp,.mface){border-color:#3c5ee7}',
    '@keyframes gm-flash-green{0%,100%{border-color:var(--gm-line)}50%{border-color:#2ecc71}}',
    ':host([data-bs=detecting-start]){--gm-glow:0 0 12px rgba(46,204,113,.4)}',
    ':host([data-bs=detecting-start]) :is(.gm,.gmcp,.mface){animation:gm-flash-green .4s ease-in-out 3}',
    ':host([data-bs=low]){--gm-glow:0 0 12px rgba(46,204,113,.4)}',
    ':host([data-bs=low]) :is(.gm,.gmcp,.mface){border-color:#2ecc71}',
    ':host([data-bs=suspect]){--gm-glow:0 0 12px rgba(230,126,34,.4)}',
    ':host([data-bs=suspect]) :is(.gm,.gmcp,.mface){border-color:#e67e22}',
    '@keyframes gm-flash-red{0%,100%{border-color:var(--gm-line)}50%{border-color:#e74c3c}}',
    ':host([data-bs=high-flash]){--gm-glow:0 0 12px rgba(231,76,60,.5)}',
    ':host([data-bs=high-flash]) :is(.gm,.gmcp,.mface){animation:gm-flash-red .5s ease-in-out 2}',
    ':host([data-bs=high]){--gm-glow:0 0 12px rgba(231,76,60,.5)}',
    ':host([data-bs=high]) :is(.gm,.gmcp,.mface){border-color:#e74c3c}',
    '@keyframes gm-flash-blacklist{0%,100%{border-color:var(--gm-line)}50%{border-color:#ff3b30}}',
    ':host([data-bs=blacklist]){--gm-glow:0 0 28px rgba(255,59,48,.9)}',
    ':host([data-bs=blacklist]) :is(.gm,.gmcp,.mface){animation:gm-flash-blacklist .3s ease-in-out 3}',
    // Every state is a `border-color` change and nothing else — the glow shadows this used to
    // set would have REPLACED the panel's own drop shadow (`.gm`'s `0 10px 34px rgba(0,0,0,.55)`)
    // rather than adding to it, so a state would double as "the panel lost its shadow".
    // The two smaller faces need the cross-fade too; `.gm` declares it in its own rule above.
    ':is(.gmcp,.mface){transition:border-color .3s ease}',
    // 0.4.9 §1.8 — the blacklist warning line. Red because it is the same data ink as 高风险.
    '.note.lk{color:#e74c3c}',
    // Resized: the height is explicit, so the box fills it and .body does the scrolling.
    ':host(.sized) .gm{height:100%}',
    // 0.4.0 §一.4 更新横幅。它在**流内**（没有 position:fixed/absolute），所以是把整个面板
    // 向下推而不是盖住——「不遮挡其他 UI 和按键」是规格里的关键约束。
    // 尺寸上必须配对：`.gm` 的上限是 `--gm-max`，横幅吃掉多少就从里面减掉多少（`--gm-ban`），
    // 否则一块 86vh 的面板再加一条横幅会一起顶出视口。
    '.gmban{display:none;align-items:center;gap:8px;padding:7px 10px;margin-bottom:8px;',
    'background:var(--gm-info-bg);border:1px solid var(--gm-info-line);border-radius:10px;font-size:12px;color:var(--gm-info-fg)}',
    ':host(.upd) .gmban{display:flex}',
    // 缩略态（只显示评估值）和图标态（48×48）都没有位置放横幅，也不该被它撑大。
    ':host(.mg) .gmban,:host(.cp) .gmban{display:none}',
    ':host(.upd) .gm{max-height:calc(var(--gm-max) - var(--gm-ban,0px))}',
    '.gmban .bi{font-weight:700;color:var(--gm-lk);flex:none}',
    '.gmban .bt{font-weight:600;color:var(--gm-txt)}',
    '.gmban .sp{flex:1}',
    '.gmban .blk{color:var(--gm-lk);cursor:pointer;white-space:nowrap;flex:none}',
    '.gmban .blk:hover{text-decoration:underline}',
    // Minimised: no chrome at all, just the 48x48 shield restored by a click.
    ':host(.mg) .gm{display:none}',
    '.mface{display:none;width:48px;height:48px;border-radius:12px;background:var(--gm-bg);border:1px solid var(--gm-line);',
    'box-shadow:0 6px 20px rgba(0,0,0,.5);color:var(--gm-txt);font-size:24px;line-height:46px;text-align:center;cursor:pointer}',
    '.mface:hover{border-color:var(--gm-lk)}',
    ':host(.mg) .mface{display:block}',
    // 0.3.1 缩略态：只显示评估值，点击任意处恢复完整面板。不带按钮、状态文字或进度条。
    ':host(.cp) .gm{display:none}',
    ':host(.cp) .gmcp{display:block}',
    '.gmcp{display:none;background:var(--gm-bg);border:1px solid var(--gm-line);border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.55);overflow:hidden;cursor:grab;user-select:none;touch-action:none}',
    ':host(.dragging) .gmcp{box-shadow:0 14px 40px rgba(0,0,0,.7);border-color:var(--gm-lk)}',
    '.gmcp .cprow{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:7px 12px}',
    '.gmcp .cpk{font-size:12px;color:var(--gm-mut)}',
    '.gmcp .cpv{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}',
    '.gmcp .cpbar{height:4px;background:var(--gm-in);margin:0 12px 8px}',
    '.gmcp .cpbar>i{display:block;height:100%;background:var(--gm-lk);width:0}',
    // The shrink icon is a tap target (restore); a press that travels drags it instead.
    ':host(.mg) .mface{cursor:pointer}',
    // 0.4.10 §一.3 — the three icon buttons became WORDS (「复制对局数据」「语言」「规则」; 🚫 stays a
    // glyph). Words are wider than emoji and the header is inside a 580px overlay, so it now
    // wraps instead of overflowing, and each label is kept whole — a header that broke 「复制对局
    // 数据」 across two lines mid-word would be worse than one that wrapped between buttons.
    '.hd{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 10px;background:var(--gm-panel);border-bottom:1px solid var(--gm-line);',
    'cursor:move;user-select:none;touch-action:none}',
    ':host(.dragging) .gm{box-shadow:0 14px 40px rgba(0,0,0,.7);border-color:var(--gm-lk)}',
    '.hd b{font-weight:500;font-size:13px}',
    '.hd .sp{flex:1}',
    '.hd .lk{color:var(--gm-lk);cursor:pointer;font-size:12px;white-space:nowrap}',
    '.hd .lk:hover{text-decoration:underline}',
    // 0.3.6 §2.1: 📋 is greyed out with no report to copy. It stays clickable so the click can
    // explain WHY it is greyed out (the footer says 「尚无分析结果」) instead of silently doing
    // nothing — a dead button with no feedback is the worse failure mode.
    '.hd .lk[data-copy-state=off]{color:var(--gm-off);opacity:.6}',
    '.hd .lk[data-copy-state=off]:hover{text-decoration:none}',
    '.hd .lk[data-copy-state=partial]{color:#f1c40f}',
    // Buttons inside the drag bar must not look draggable.
    '.hd .lk,.hd .x,.hd .mn{cursor:pointer}',
    '.hd .mn,.hd .x{-webkit-user-select:none;user-select:none}',
    // 0.4.5 §二 — the 🌐 / ⚙ menus. A dropdown rather than a native <select>: the header is the
    // panel's drag surface, and a select inside it swallows the drag and paints in the OS theme.
    // `position:fixed` (not absolute) so it is not clipped by the panel's own overflow, and it is
    // positioned from the button's rect at open time — which is also what lets it survive a drag
    // while open. It keeps the panel's dark palette: the panel is a page overlay with its own
    // theme, deliberately independent of the browser/IDE theme behind it.
    '.hd .lk.on{color:var(--gm-txt)}',
    '.ctx{position:fixed;z-index:5;display:none;min-width:196px;max-height:70vh;overflow:auto;',
    'padding:4px;border:1px solid var(--gm-line);border-radius:6px;background:var(--gm-panel);',
    'box-shadow:0 8px 26px rgba(0,0,0,.5);font-size:12px}',
    '.ctx.show{display:block}',
    '.ctx .it{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;',
    'color:var(--gm-txt-2);cursor:pointer;white-space:nowrap}',
    '.ctx .it:hover{background:var(--gm-hov)}',
    '.ctx .it .ck{flex:0 0 12px;color:var(--gm-lk)}',
    '.ctx .it[aria-checked=true]{color:var(--gm-txt)}',
    // 0.4.10 §二.1 — the 提问 picker's second level. A question §12 currently blocks is still
    // SHOWN, greyed, with the reason in its title: deleting it would leave the operator with an
    // empty list and no way to learn that the bank has a question they have not unlocked yet.
    // `white-space:normal` on purpose — a question is a sentence, unlike a language name.
    '.ctx .it.dis{opacity:.45;cursor:default}',
    '.ctx .it.dis:hover{background:transparent}',
    '.ctx .it.wrap{white-space:normal;line-height:1.45;max-width:280px}',
    // 0.4.11 §二.10 — a question row is TWO lines: the text that will be sent, and below it what
    // that text means in the interface language the operator is reading. `.it` is a flex ROW, so
    // the stacked layout has to be stated; specificity (two classes + the item class) beats it.
    '.ctx .it.q-item{display:block;line-height:1.4}',
    '.ctx .it.q-item .q-main{font-weight:500}',
    '.ctx .it.q-item .hint{display:block;margin-top:3px;font-size:11px;line-height:1.35;',
    'color:var(--gm-dim);white-space:normal}',
    // The picker's level header (which language, or which question) — inert, and set apart so a
    // click on it is never mistaken for a selection.
    '.ctx .cth{padding:4px 8px 6px;color:var(--gm-dim);font-size:11px;border-bottom:1px solid var(--gm-div);',
    'margin-bottom:4px;cursor:default}',
    '.x{color:var(--gm-dim);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px}',
    '.x:hover{color:var(--gm-txt)}',
    '.mn{color:var(--gm-dim);cursor:pointer;font-size:15px;line-height:1;padding:2px 6px}',
    '.mn:hover{color:var(--gm-txt)}',
    '.rz{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;color:var(--gm-dim);',
    'font-size:13px;line-height:16px;text-align:center;user-select:none;touch-action:none}',
    '.rz:hover{color:var(--gm-txt)}',
    '.body{overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}',
    '.sec{border:1px solid var(--gm-line);border-radius:8px;background:var(--gm-panel)}',
    '.sec>h3{margin:0;padding:6px 10px;font-weight:500;font-size:11px;letter-spacing:.4px;color:var(--gm-dim);border-bottom:1px solid var(--gm-line-soft)}',
    '.sec>.in{padding:9px 10px}',
    '.stats{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--gm-mut);margin-bottom:8px}',
    '.stats b{color:var(--gm-txt);font-weight:500}',
    // Permanent marker for a mid-game join — it changes how every number below should be
    // read, so it lives in the status line rather than in a note further down.
    '.warn{color:#f1c40f;border:1px solid #6b5411;background:#2a2410;border-radius:9px;padding:1px 7px;font-size:11px}',
    '.src{color:var(--gm-dim);font-size:10px;border:1px solid var(--gm-line);border-radius:8px;padding:0 6px}',
    '.bar{height:5px;background:var(--gm-in);border-radius:3px;overflow:hidden;margin:2px 0 9px}',
    '.bar>i{display:block;height:100%;background:var(--gm-lk);width:0}',
    '.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}',
    '.card{background:var(--gm-in);border:1px solid var(--gm-line-soft);border-radius:7px;padding:7px 6px;text-align:center}',
    '.card .v{font-size:19px;font-weight:500;line-height:1.25}',
    '.card .k{font-size:10px;color:var(--gm-dim);margin-top:1px}',
    '.card .s{font-size:10px;color:var(--gm-dim)}',
    '.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;align-items:start}',
    '.q{max-height:190px;overflow:auto}',
    '.qi{padding:6px 9px;border-bottom:1px solid var(--gm-line-soft);cursor:pointer;display:flex;gap:6px;align-items:center;font-size:12px}',
    '.qi:last-child{border-bottom:0}',
    '.qi:hover{background:var(--gm-hov)}',
    '.qi.on{background:var(--gm-line-soft)}',
    '.qi .no{color:var(--gm-dim);min-width:20px;flex:none}',
    '.qi .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.qi .rk{color:var(--gm-mut);font-size:11px;flex:none}',
    '.tag{font-size:10px;padding:1px 5px;border-radius:9px;border:1px solid transparent;white-space:nowrap;flex:none}',
    '.t-wait{color:var(--gm-dim);border-color:var(--gm-line-soft)}',
    '.t-run{color:var(--gm-lk);border-color:var(--gm-info-line);background:var(--gm-info-bg)}',
    '.t-done{color:#4ec97b;border-color:#245c39;background:#12291c}',
    '.t-stop{color:#f1c40f;border-color:#6b5411;background:#2a2410}',
    '.t-fail{color:#e74c3c;border-color:#6e2b24;background:#2b1614}',
    '.emp{color:var(--gm-dim);font-size:12px;padding:8px 10px}',
    '.row{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
    '.row label{width:74px;color:var(--gm-mut);font-size:12px;flex:none}',
    'select{flex:1;background:var(--gm-in);color:var(--gm-txt);border:1px solid var(--gm-line);border-radius:6px;padding:4px 6px;font:inherit;font-size:12px}',
    'input[type=number]{width:84px;background:var(--gm-in);color:var(--gm-txt);border:1px solid var(--gm-line);border-radius:6px;padding:4px 6px;font:inherit;font-size:12px}',
    'input[type=checkbox]{accent-color:var(--gm-lk)}',
    '.more{margin-top:2px;border-top:1px solid var(--gm-line-soft);padding-top:8px}',
    '.more .row label{width:74px}',
    '.btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}',
    'button{font:inherit;font-size:12px;border:0;border-radius:6px;padding:5px 11px;cursor:pointer;background:var(--gm-line);color:var(--gm-txt)}',
    'button:hover{background:var(--gm-btn-hov)}',
    'button.p{background:var(--gm-lk);color:#fff}',
    'button.p:hover{background:var(--gm-pri-hov)}',
    'button:disabled{opacity:.45;cursor:default}',
    '.ft{padding:5px 10px;border-top:1px solid var(--gm-line);color:var(--gm-dim);font-size:10px;display:flex;gap:10px}',
    '.note{color:#f1c40f;font-size:11px;margin-top:6px}',
    // ---- 0.4.4 §12/§14: the 提问记录 / 声明确认 panel ----
    // It sits between `.body` and `.ft` inside the same 580px column, so it inherits the panel's
    // width and scrolls with the rest rather than floating.
    '.cpnl{border-top:1px solid var(--gm-line);max-height:210px;overflow:auto}',
    '.cpnl .chd{padding:6px 10px;color:var(--gm-txt-2);font-size:12px;display:flex;align-items:center;border-bottom:1px solid var(--gm-line-soft)}',
    '.cpnl .chd .sp,.cpnl .cft .sp{flex:1}',
    '.cpnl .cbody{padding:8px 10px;color:var(--gm-txt-2);font-size:11px;line-height:1.5}',
    '.cpnl .ctext{margin-top:6px;padding:6px 8px;background:var(--gm-in);border:1px solid var(--gm-line-soft);border-radius:3px;color:var(--gm-mut);font-size:11px}',
    '.cpnl .cr{display:flex;gap:8px;align-items:flex-start;padding:6px 10px;border-bottom:1px solid var(--gm-div);font-size:11px}',
    '.cpnl .cq{color:var(--gm-mut);flex:0 0 46%}',
    '.cpnl .ca{color:var(--gm-txt-2);flex:1;word-break:break-word}',
    '.cpnl .cv{flex:0 0 auto;color:var(--gm-dim)}',
    '.cpnl .cv.up{color:#e74c3c}',
    '.cpnl .cv.dn{color:#2ecc71}',
    '.cpnl .cempty{padding:10px;color:var(--gm-dim);font-size:11px}',
    // §7.3 — a failed send, kept on screen after the footer's 5 seconds have gone.
    '.cpnl .cwarn{padding:6px 10px;color:#e8a33d;font-size:11px;line-height:1.5;border-top:1px solid #3a2f1c}',
    '.cpnl .cft{padding:6px 10px;color:var(--gm-dim);font-size:11px;display:flex;align-items:center;gap:8px}',
    '.cpnl .cft .lk{color:var(--gm-lk);cursor:pointer}',
    '.hd .lk[data-ask-state=off]{color:var(--gm-off);cursor:default}',
    // 0.4.9 §一.6 — the 🚫 blacklist button. Three states, in the order the operator meets them:
    //   off — the opponent is not on the list; grey, and one click (＋confirm) blocks them.
    //   on  — they are; RED, because red is the data ink for "this is the bad one" and the state
    //         has to be readable at a glance without reading the tooltip. A click unblocks.
    //   na  — there is no username to key on (spectating / a guest / a route that did not
    //         resolve). Greyed and inert, which is honest: the feature cannot work here, and a
    //         button that silently did nothing would look like a bug in the extension.
    '.hd .lk[data-lk-state=on]{color:#e74c3c}',
    '.hd .lk[data-lk-state=na]{color:var(--gm-off);opacity:.55;cursor:default}',
    '.hd .lk[data-lk-state=na]:hover{text-decoration:none}',
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
          '<span aria-hidden="true" style="color:var(--gm-dim);font-size:12px;line-height:1">⠿</span>' +
          '<b>' + esc(T('panel|白身 · 反作弊检测')) + '</b><span class="sp"></span>' +
          '<span class="lk" data-act="open-viewer">' + esc(T('panel|查看器')) + '</span>' +
          // 0.4.10 §一.3 — 📋 / 🌐 / ⚙ became words. An emoji is a picture the operator has to
          // decode, and none of the three has a settled meaning (📋 reads as "notes", 🌐 as
          // "browser"); the labels say what they do. 🚫 below stays a glyph: it is the one that
          // DOES read unambiguously, and it has to stay narrow so the header does not wrap.
          '<span class="lk" data-act="copy" data-copy-state="off" title="' +
            esc(T('copy.title')) + '">' + esc(T('panel|复制对局数据')) + '</span>' +
          // 0.4.9 §一.6 — the blacklist toggle. It ships as `na` (greyed) and is painted properly
          // by paintBlacklistButton() on the first status pass; starting grey rather than blue
          // means the one frame before the first paint cannot advertise a click that would fail.
          '<span class="lk" data-act="blacklist" data-lk-state="na" title="' +
            esc(T('panel|无法获取对手用户名，黑名单不可用')) + '">🚫</span>' +
          // 0.4.5 §二.1/§二.2 — the language and rule menus. Both are always present (unlike 提问)
          // because they are the only way to correct the two things the extension has to GUESS:
          // the interface language, and the rule when the site does not imply one.
          '<span class="lk" data-act="lang" title="' + esc(T('panel|切换语言')) +
            '">' + esc(T('panel|语言')) + '</span>' +
          '<span class="lk" data-act="rule" title="' + esc(T('panel|游戏规则')) +
            '">' + esc(T('panel|规则')) + '</span>' +
          // 0.4.4 §12 — the 提问 button. Always present so the operator can see WHY it is off
          // (its title says which of §12's five gates is closed) rather than wondering where the
          // feature went.
          '<span class="lk" data-act="ask" data-ask-state="off" title="' +
            esc(T('panel|当前不可提问（观战 / 聊天栏不可用 / 冷却中 / 风险分不足）')) +
            '">' + esc(T('panel|提问')) + '</span>' +
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
        // 0.4.4 §12/§14 — the 提问记录 / 声明确认 panel, hidden until it has something to say.
        '<div class="cpnl" data-slot="chat" style="display:none"></div>' +
        '<div class="ft"><span>Gomoku Detector v' + VERSION + '</span><span data-slot="foot"></span></div>' +
        '<div class="rz" data-act="resize" title="' + esc(T('panel|拖动调整大小')) + '">◢</div>' +
      '</div>' +
      // 0.4.5 §二 — the two dropdowns live OUTSIDE .gm so the panel's own overflow cannot clip
      // them, and both stay empty until a menu is opened (paintMenus fills the visible one).
      '<div class="ctx" data-slot="langmenu" role="menu"></div>' +
      '<div class="ctx" data-slot="rulemenu" role="menu"></div>' +
      // 0.4.10 §二.1 — the 提问 picker. It reuses `.ctx` (one dropdown implementation, two
      // levels: this box shows the language list, then the question list, and only then sends).
      '<div class="ctx" data-slot="askmenu" role="menu"></div>' +
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
    els.lk = root.querySelector('[data-act=blacklist]');
    els.ask = root.querySelector('[data-act=ask]');
    els.chatPanel = root.querySelector('[data-slot=chat]');
    els.updText = root.querySelector('[data-slot=updtext]');
    if (root.host) {
      root.host.setAttribute('lang', LANG);
      root.host.setAttribute('dir', GMI18n.dirFor(LANG));
    }
    // 0.4.5 §二 — the shell is rebuilt on a language change, which replaces the dropdown nodes;
    // an open menu cannot survive that (its anchor was the old button), so it is closed here.
    openMenu = null;
    attachMiniHandlers();
    paintCopyButton();
    paintBlacklistButton();
    paintChatButton();
    paintChatPanel();
    paintMenus();
    // Re-render happens on a language change too, and the banner's text (and therefore its
    // height, and therefore `--gm-ban`) moves with it.
    applyBanner();
  }

  // ---------- 0.4.5 §二: the 🌐 language / ⚙ rule dropdowns ----------
  var openMenu = null;      // 'lang' | 'rule' | null

  // The language list is the SAME source the viewer's #setLang uses (GMI18n.LOCALES + 'auto').
  // 0.4.6 §2.4: the labels come from `GMI18n.langLabel()`, which renders 「English（英语）」 —
  // the language's own name plus what the CURRENT language calls it. With 13 entries the bare
  // endonym list stopped being readable for anyone who does not recognise 「Монгол」 or 「Bahasa
  // Melayu」; `langLabel` is also the single place that decides the format, so this menu, the
  // viewer's dropdown and the context menu cannot drift apart.
  function menuItems(which) {
    if (which === 'lang') {
      var langs = [{ v: 'auto', label: T('set|跟随浏览器') }];
      GMI18n.LOCALES.forEach(function (code) {
        langs.push({ v: code, label: GMI18n.langLabel(code) });
      });
      return langs;
    }
    return [
      { v: 'auto', label: T('panel|自动（按站点推断）') },
      { v: '0', label: T('panel|自由（无禁手）') },
      { v: '1', label: T('panel|标准（长连不赢）') },
      { v: '2', label: T('panel|连珠（有禁手）') },
    ];
  }

  function menuCurrent(which) {
    if (which === 'lang') return S.lang || 'auto';
    return S.rule == null ? 'auto' : String(S.rule);
  }

  // ---------- 0.4.10 §二.1/§二.3 — the 提问 picker ----------
  //
  // One `.ctx` box, two levels: the language the question is SENT in, then the question itself.
  // There is deliberately no free-text input — §2.1 makes the question bank the only vocabulary,
  // because an operator who types their own line is back to putting arbitrary words in front of a
  // real opponent, and the grading tree in chat.js only understands the bank's questions.
  //
  // The language is `chat.questionLang`, which is NOT `settings.lang`: how the OPERATOR reads the
  // extension and which language they want to ADDRESS the opponent in are two different
  // questions, and §2.3 forbids the picker from touching the UI language.
  function askMenuLang() { return chat.questionLang || chat.lang || LANG; }

  // 'ask-q' is the second level of the ask menu: same box, same button, different contents.
  function menuSlot(which) { return which === 'ask-q' ? 'askmenu' : which + 'menu'; }
  function menuBtn(which) { return which === 'ask-q' ? 'ask' : which; }

  // 0.4.11 §二.10 — the question as the operator reads it here, plus what it says in the
  // language they are READING.
  // The picker may legitimately send a Japanese question while the panel is in Chinese (that is
  // §2.3's whole point), and the operator is hand-picking it to say something. Without the note
  // they have to take on trust that the line above means what they think it means — and the one
  // place that trust is least warranted is exactly where the two languages differ.
  function questionLabelHtml(q, questionLang, uiLang) {
    var text = q.text || {};
    var main = text[questionLang] || text.en || q.id;
    var note = '';
    if (questionLang !== uiLang) {
      note = text[uiLang]
        ? '<div class="hint">（' + esc(text[uiLang]) + '）</div>'
        : '<div class="hint">' + esc(T('panel|（无 {lang} 翻译）', { lang: GMI18n.langLabel(uiLang) })) + '</div>';
    }
    return '<div class="q-main">' + esc(main) + '</div>' + note;
  }

  function askMenuHtml() {
    var html = '';
    if (openMenu === 'ask') {
      var cur = askMenuLang();
      html += '<div class="cth">' + esc(T('panel|选择提问语言')) + '</div>';
      // 0.4.11 §一.6 — the bank's OWN languages, not the extension's locale list (13). See
      // questions.js: offering a locale the bank has no wording for is what made the picker
      // promise a language it could not send.
      GM_QUESTION_LANGS.forEach(function (code) {
        var on = code === cur;
        html += '<div class="it" data-act="pick-ask-lang" data-v="' + esc(code) + '"' +
          ' role="menuitemradio" aria-checked="' + on + '">' +
          '<span class="ck">' + (on ? '✓' : '') + '</span>' + esc(GMI18n.langLabel(code)) + '</div>';
      });
      if (chat.lang) {
        // Where the guess came from. A detected language and a chosen one look identical in a
        // list, and the operator is about to overrule one of them.
        html += '<div class="cth">' + esc(T('panel|当前对手语言：{lang}', { lang: chat.lang })) + '</div>';
      }
      return html;
    }
    if (openMenu !== 'ask-q') return html;

    var lang = askMenuLang();
    html += '<div class="cth">' + esc(GMI18n.langLabel(lang)) + '</div>';
    var ctx = askContext();
    for (var i = 0; i < GM_QUESTIONS.length; i++) {
      var q = GM_QUESTIONS[i];
      var why = GMChat.askBlocked(q, ctx);
      // An unknown sender colour does not block the explicit button (see askableQuestions), so it
      // is not a reason to grey a question here either.
      var ok = why === null || why === 'senderUnknown';
      html += '<div class="it wrap q-item' + (ok ? '' : ' dis') + '"' +
        (ok ? ' data-act="pick-ask-q" data-v="' + esc(q.id) + '" role="menuitem"'
            : ' title="' + esc(askBlockReason(why)) + '"') + '>' +
        questionLabelHtml(q, lang, LANG) + '</div>';
    }
    return html;
  }

  // The reasons a question is greyed. Literal `T()` arguments on purpose: this project has
  // shipped a key that was built by concatenation and therefore reached no dictionary at all
  // (see MEMORY.md), and nothing in the toolchain would have caught it.
  function askBlockReason(why) {
    if (why === 'spectating') return T('panel|观战时不提问');
    if (why === 'noChat') return T('panel|聊天栏不可用');
    if (why === 'senderUnknown') return T('panel|发送者颜色未定：可以提问，但回答不会调整 AI 率');
    if (why === 'cooldown') return T('panel|冷却中：10 秒内已发送过');
    if (why === 'alreadyAsked') return T('panel|本局已经问过这道题');
    if (why === 'alreadyAnnounced') return T('panel|本局已经发过声明');
    if (why === 'rateTooLow') return T('panel|对手 AI 率未超过 55，此题暂不可用');
    return T('panel|当前不可提问');
  }

  function paintMenus() {
    if (!root) return;
    ['lang', 'rule'].forEach(function (which) {
      var box = root.querySelector('[data-slot=' + which + 'menu]');
      if (!box) return;
      var cur = menuCurrent(which);
      var html = '';
      menuItems(which).forEach(function (it) {
        var on = it.v === cur;
        html += '<div class="it" data-act="pick-' + which + '" data-v="' + esc(it.v) + '"' +
          ' role="menuitemradio" aria-checked="' + on + '">' +
          '<span class="ck">' + (on ? '✓' : '') + '</span>' + esc(it.label) + '</div>';
      });
      box.innerHTML = html;
    });
    var askBox = root.querySelector('[data-slot=askmenu]');
    if (askBox) askBox.innerHTML = askMenuHtml();
  }

  function closeMenus() {
    if (!root) return;
    ['lang', 'rule', 'ask'].forEach(function (which) {
      var box = root.querySelector('[data-slot=' + menuSlot(which) + ']');
      if (box) box.classList.remove('show');
      var btn = root.querySelector('[data-act=' + menuBtn(which) + ']');
      if (btn) btn.classList.remove('on');
    });
    openMenu = null;
  }

  function toggleMenu(which) {
    if (!root) return;
    if (openMenu === which) { closeMenus(); return; }
    closeMenus();
    var box = root.querySelector('[data-slot=' + menuSlot(which) + ']');
    var btn = root.querySelector('[data-act=' + menuBtn(which) + ']');
    if (!box) return;
    openMenu = which;
    paintMenus();
    // Shown before measuring: offsetWidth/Height are 0 while the node is display:none, and a
    // 0-height reading would skip the flip-above-the-button branch entirely.
    box.classList.add('show');
    if (btn) btn.classList.add('on');
    var r = btn ? btn.getBoundingClientRect() : { right: 240, bottom: 40, top: 20 };
    var w = box.offsetWidth || 196, h = box.offsetHeight || 0;
    var vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    var left = Math.max(6, Math.min(r.right - w, vw - w - 6));
    var top = r.bottom + 6;
    if (h && top + h > vh - 6) top = Math.max(6, r.top - h - 6);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
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
    // 0.4.10 §一.1 — the host's two attributes have to be written FROM HERE DOWN, because this
    // is the line that creates the host. Both helpers guard on `root`, so calling them earlier
    // (as 0.4.9 did for `data-theme`) was a silent no-op: on a fresh page load neither the
    // theme nor `lang`/`dir` was ever written, and nothing but `chrome.storage.onChanged`
    // could write it later. The reported symptom was 「浅色模式刷新后回退深色」 — and it was
    // really two bugs, since an RTL locale (ar) also failed to flip on first load for the same
    // reason. `applyLang` is called a second time here on purpose: its first call (in boot())
    // resolves LANG so renderShell()'s T() is correct, and THIS call is the one that reaches
    // the host.
    applyLang(S.lang);
    applyTheme(S.theme);
    renderShell();
    (document.body || document.documentElement).appendChild(host);

    els.top = root.querySelector('[data-slot=top]');
    // 0.4.5 §二 — an open dropdown closes on a click anywhere outside the panel. composedPath()
    // rather than host.contains(): shadow content is NOT a descendant of its host in the light
    // DOM, so contains() reports every in-panel click as an outside one and the menu would shut
    // the instant it was clicked. Capture phase, so a page handler that stops propagation cannot
    // leave the menu stranded open.
    document.addEventListener('click', function (ev) {
      if (!openMenu) return;
      var path = ev.composedPath ? ev.composedPath() : [];
      if (host && path.indexOf(host) >= 0) return;
      closeMenus();
    }, true);
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
      // 0.4.5 §二 — any click that is neither on a menu nor on its button dismisses an open
      // dropdown, the way a menu is expected to behave. Done before the act dispatch so the
      // other controls keep working with a menu open.
      if (openMenu && act !== 'lang' && act !== 'rule' && act !== 'ask' &&
          act !== 'pick-lang' && act !== 'pick-rule' &&
          act !== 'pick-ask-lang' && act !== 'pick-ask-q') {
        closeMenus();
      }
      if (!act) {
        var q = t.closest && t.closest('.qi');
        if (q) { selectedId = q.getAttribute('data-id'); paint(); }
        return;
      }
      if (act === 'close') { closePanel(); return; }
      // ---- 0.4.5 §二 ----
      if (act === 'lang') { toggleMenu('lang'); return; }
      if (act === 'rule') { toggleMenu('rule'); return; }
      if (act === 'pick-lang') {
        // 'auto' is a real value here, not an absence: storage.js resolves it against the
        // browser language. The repaint is not done by hand — saveSetting fires
        // chrome.storage.onChanged, which is the one path that repaints every surface (§1.8).
        saveSetting('lang', hit.getAttribute('data-v'));
        closeMenus();
        return;
      }
      if (act === 'pick-rule') {
        var rv = hit.getAttribute('data-v');
        saveSetting('rule', rv === 'auto' ? null : parseInt(rv, 10));
        closeMenus();
        paintControls();
        return;
      }
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
      // ---- 0.4.9 §一.6 ----
      if (act === 'blacklist') { toggleBlacklist(); return; }
      // ---- 0.4.10 §二.1/§二.3 ----
      // 提问 opens the PICKER, it no longer fires the first allowed question (§2.1). The footer's
      // 「提问」 link opens the same picker — it had been dead since 0.4.4: the handler matched
      // `act === 'ask'` while the markup emitted `data-act="chat-ask"`, so the one control inside
      // the chat panel did nothing at all.
      if (act === 'ask' || act === 'chat-ask') { toggleMenu('ask'); return; }
      if (act === 'pick-ask-lang') {
        // §2.3 — the choice is remembered for the session but NEVER written to `settings.lang`;
        // the UI language is untouched, which is the whole point of the separate key.
        chat.questionLang = hit.getAttribute('data-v');
        saveChatState();
        // Stay open, second level. Repainted in place, so the box does not jump under the pointer.
        openMenu = 'ask-q';
        paintMenus();
        return;
      }
      if (act === 'pick-ask-q') {
        var qid = hit.getAttribute('data-v');
        var chosen = null;
        for (var qi = 0; qi < GM_QUESTIONS.length; qi++) {
          if (GM_QUESTIONS[qi].id === qid) { chosen = GM_QUESTIONS[qi]; break; }
        }
        closeMenus();
        if (chosen) askQuestion(chosen);
        return;
      }
      // ---- 0.4.4 §12/§14 ----
      if (act === 'chat-close') { chatOpen = false; paintChatPanel(); return; }
      if (act === 'chat-confirm-yes') {
        chat.confirmOk = true; chatOpen = false; paintChatPanel(); maybeAnnounce(); return;
      }
      if (act === 'chat-confirm-no') {
        // §12's 「本局忽略」. Recorded on the instance, not in storage: it is a per-game choice.
        chat.ignored = true; chatOpen = false; paintChatPanel(); return;
      }
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
  // =====================================================================================
  // 0.4.9 §一.5~§1.8 — the blacklist's runtime side, and §二's border state machine
  // =====================================================================================
  // One function for "the job the panel is showing". The expression used to be copy-pasted into
  // four places (paintStatus, paintCompact, currentReport, and a fifth about to be written for
  // the border), and this project has shipped a silently wrong answer that existed in three
  // copies before. Whichever job the panel is talking about has to be the same one everywhere.
  function currentJob() { return running() || findJob(selectedId) || jobs[jobs.length - 1] || null; }

  function blacklistKey(id) { return id == null ? '' : String(id).trim().toLowerCase(); }

  /** Load the store into `blacklistIds`, then repaint whatever reads it. */
  function hydrateBlacklist() {
    if (!GMStorage.loadBlacklist) return;
    GMStorage.loadBlacklist().then(function (bl) {
      var m = {};
      for (var i = 0; i < bl.players.length; i++) m[blacklistKey(bl.players[i].id)] = bl.players[i];
      blacklistIds = m;
      if (root) { paintBlacklistButton(); paintStatus(); }
      checkBlacklist();
    }).catch(function () { /* no store: the button shows `na` and nothing is lost */ });
  }

  /** The synchronous lookup the button and the status line read. Returns the entry or null. */
  function isBlacklistedSync(id) {
    var k = blacklistKey(id);
    return k ? (blacklistIds[k] || null) : null;
  }

  /**
   * §一.6 — the 🚫 button's state, which is a question about the OPPONENT's username.
   *
   * `data-lk-state` is 'on' | 'off' | 'na'. 'na' is the honest third answer §1.6 asks for: while
   * spectating, as a guest, or when no route resolved a username, the feature cannot work, so the
   * button is greyed and inert rather than advertising a click that would do nothing.
   */
  function paintBlacklistButton() {
    if (!els.lk) return;
    var opp = resolveOpponentId();
    var state = (opp && opp.id) ? (isBlacklistedSync(opp.id) ? 'on' : 'off') : 'na';
    els.lk.setAttribute('data-lk-state', state);
    els.lk.setAttribute('title',
      state === 'on' ? T('panel|移出黑名单')
      : state === 'off' ? T('panel|加入黑名单')
      : T('panel|无法获取对手用户名，黑名单不可用'));
  }

  /**
   * §1.5 — the per-game match check: is the opponent we are playing right now on the list?
   *
   * Keyed on `gameEpoch`, because the caller is the 1-second tick and `touchBlacklistEntry`
   * bumps a counter that cannot tell two ticks from two games. The mark is set only once a check
   * could actually be made, so a tick that runs before the ids arrive simply tries again.
   */
  function checkBlacklist() {
    if (blacklistCheckedEpoch === gameEpoch) return;
    var opp = resolveOpponentId();
    if (!opp || !opp.id) return;
    blacklistCheckedEpoch = gameEpoch;
    var hit = isBlacklistedSync(opp.id);
    if (!hit) {
      if (blacklistHit) { blacklistHit = null; if (root) paintStatus(); }
      return;
    }
    blacklistHit = hit;
    triggerBlacklistAlert(hit);
    if (root) paintStatus();
    // Fire and forget: the counter and the timestamp are bookkeeping, and awaiting a storage
    // round trip here would put a write in front of the alert the operator is meant to see now.
    try { GMStorage.touchBlacklistEntry(hit.id, opp.name || hit.displayName); } catch (e) {}
    blacklistIds[blacklistKey(hit.id)] = hit;
  }

  /**
   * §1.6 — the confirm-and-write behind the 🚫 click. Adding and removing are the same gesture in
   * two directions, so they share one function: the button's current state is what decides, not
   * a second flag that could disagree with it.
   */
  function toggleBlacklist() {
    var opp = resolveOpponentId();
    if (!opp || !opp.id) {
      flashFoot(T('panel|无法获取对手用户名，黑名单不可用'));
      return;
    }
    var on = !!isBlacklistedSync(opp.id);
    var vars = { name: opp.name || '?', id: opp.id };
    // §1.6's confirm. The explanation rides as its own sentence rather than inside the question,
    // so both halves are keys that can be translated as sentences — a translator handed
    // 「加入黑名单？\n\n下次匹配到该玩家时会收到提醒」 has to keep an escaped newline intact, which is
    // exactly the kind of thing that arrives broken.
    var msg = (on
      ? T('panel|将 {name}（{id}）移出黑名单？', vars)
      : T('panel|将 {name}（{id}）加入黑名单？', vars) + '\n\n' +
        T('panel|下次匹配到该玩家时会收到提醒。'));
    if (!confirm(msg)) return;
    var p = on ? GMStorage.removeFromBlacklist(opp.id)
               // 0.4.11 §一.7 — this IS the overlay, so it says so; every other caller
               // (the viewer's manual form, the importer) gets the 'manual' default.
               : GMStorage.addToBlacklist(opp.id, opp.name, null, 'overlay');
    p.then(function () {
      if (on) {
        delete blacklistIds[blacklistKey(opp.id)];
        // The match alert is about a player who is no longer blocked, so it goes too — leaving
        // 「对手在黑名单中」 on screen after the operator unblocked them would be a lie.
        if (blacklistHit && sameId(blacklistHit.id, opp.id)) blacklistHit = null;
      } else {
        blacklistIds[blacklistKey(opp.id)] = { id: opp.id, displayName: opp.name || null };
      }
      if (root) { paintBlacklistButton(); paintStatus(); }
    }).catch(function () {});
  }

  // ---- §二.4 — the border state machine ----
  //
  // The border is a second, glanceable readout of the same facts the status line spells out, so
  // it is driven from `paintStatus()` rather than from a timer of its own: one source, one paint.
  // §2.2's priority is the order of the tests below —
  //   黑名单提醒（瞬时）> 检测结果 > 检测启动 > 就绪 > 待机

  /**
   * §二.4 — apply a state. `currentBorderState` is the machine's memory; the DOM's memory is the
   * host's `data-bs` attribute, and the two are deliberately not the same thing.
   *
   * This used to be one guard — `if (state === currentBorderState) return` — and that single line
   * was the whole reason 「浮层边框行为并没有被观察到」:
   *
   *   1. `currentBorderState` starts at IDLE, so the FIRST paint (which is also IDLE — nothing is
   *      being watched) returned without touching the DOM. The resting panel had no state at all:
   *      no blue, no breathing, indistinguishable from the previous release. The resting state is
   *      the one an operator is in most of the time, which is how the feature shipped looking
   *      like it did nothing.
   *   2. A variable outlives the node it describes. `renderShell()` replaces `.gm` wholesale (a
   *      language change does exactly that) and the guard then refused to repaint the NEW node
   *      because "the state has not changed" — leaving a border with no state, permanently, until
   *      the state happened to move on its own.
   *
   * So the applied state is read back off the host instead. A fresh `.gm` under an unchanged state
   * needs no repaint, because the attribute — and therefore the CSS — never left; a state change
   * is the only thing that writes it. `currentBorderState` is kept because `paintBorderState()`
   * asks it a different question (§2.1: entering 高风险 flashes, leaving it does not).
   */
  function setBorderState(state) {
    currentBorderState = state;
    if (!root || !root.host) return;
    if (root.host.getAttribute('data-bs') === state) return;
    root.host.setAttribute('data-bs', state);
  }

  /**
   * Play a flash, then settle on `nextState`.
   *
   * `animationend` is the intended signal, and the timer is the belt: an element that is hidden
   * (the mini / compact faces hide `.gm`) never fires it, and a border stuck on a flash class
   * would sit at the keyframe's resting colour for the rest of the game — a state indicator that
   * silently stops indicating. The token makes a newer flash cancel an older one's callbacks.
   */
  function playFlash(state, nextState, ms, onDone) {
    var gm = root && root.querySelector('.gm');
    if (!gm) { if (onDone) onDone(); setBorderState(nextState); return; }
    flashToken++;
    var token = flashToken;
    flashing = true;
    setBorderState(state);
    var done = function () {
      if (token !== flashToken) return;      // a newer flash owns the border now
      gm.removeEventListener('animationend', done);
      flashing = false;                      // clear the guard BEFORE the state, or the next
      if (onDone) onDone();                  // paint would read a stale alert flag and re-flash
      setBorderState(nextState);
    };
    gm.addEventListener('animationend', done, { once: true });
    setTimeout(done, ms || 1200);
  }

  /**
   * §2.4 — the panel's state, as one of §2.1's six.
   *
   * 0.4.12 §一 — **the tests below are in §2.2's order, and that is the whole function.**
   *
   * §2.2 gives the priority explicitly: 黑名单提醒 > **检测结果** > 检测启动 > 就绪 > **待机**. §2.1's
   * table defines 待机 as 「未加入对局 或 对局已结束」, and the first version of this function tested
   * `ended` up front — so 「待机」 outranked the verdict it was supposed to sit beneath, and the
   * moment a game finished the border dropped whatever colour it was showing and went back to the
   * blue breathing. Reported from a real game: 黑方 73.5 · 高风险 / 白方 72.8 · 高风险 on the cards,
   * blue breathing on the border.
   *
   * That is the exact failure `paintBorderState`'s own comment forbids two functions down — 「the
   * border is a second, glanceable readout of the same facts the status line spells out」 — and it
   * is the worst possible moment to lose the alarm: the verdict is FINAL then, which is precisely
   * when the operator wants it. A game that has ended is not 「nothing to look at」 if a report is
   * on screen; the panel still says so, and the border has to agree with the panel.
   *
   * So 检测结果 is tested FIRST. `inGame || ended` keeps the other half of 待机 intact: with no
   * board and no finished game there is no 检测结果 to show even if a job carries one (导入回放 on
   * an empty board), and that is still 待机.
   */
  function borderStateFromPanel(cur) {
    if (blacklistAlertActive) return BORDER_STATE.BLACKLIST;
    var inGame = activeMoves().length > 0;
    var rep = (cur && (cur.report || cur.summary)) || null;
    if (rep && (inGame || ended)) {
      // 「同时检测两位玩家时，取较高风险分」 — the max, not the suspected side, because the border
      // is the panel's alarm and not the per-side verdict (which the cards carry).
      var maxRisk = Math.max(rep.black ? Number(rep.black.risk) || 0 : 0,
                             rep.white ? Number(rep.white.risk) || 0 : 0);
      if (maxRisk >= 70) return BORDER_STATE.HIGH;
      if (maxRisk >= 40) return BORDER_STATE.SUSPECT;
      return BORDER_STATE.LOW;
    }
    // 待机 covers BOTH "not in a game" and "the game is over": §2.1 lists them together, and with
    // no verdict to show they read the same way to the operator.
    if (ended) return BORDER_STATE.IDLE;
    if (!inGame) return BORDER_STATE.IDLE;
    if (!running()) return BORDER_STATE.READY;
    // 「第一次检测开始」 is a ONE-SHOT (§2.1: 「绿色闪烁 3 下 → 绿色常亮」). After it has played,
    // a run with no result yet shows the green it settled on, not another flash.
    return detectingStarted ? BORDER_STATE.LOW : BORDER_STATE.DETECT_START;
  }

  /** §2.4/§2.6 — drive the border from the same paint that draws the status line. */
  function paintBorderState(cur) {
    if (!root) return;
    if (flashing) return;                     // a flash owns the border until it finishes
    var want = borderStateFromPanel(cur);
    // Entering 高风险 flashes twice first; leaving it does not (§2.1: 「风险降级时…直接切换」),
    // which the `currentBorderState !== HIGH` test is what distinguishes.
    if (want === BORDER_STATE.HIGH && currentBorderState !== BORDER_STATE.HIGH) {
      playFlash(BORDER_STATE.HIGH_FLASH, BORDER_STATE.HIGH, FLASH_MS['high-flash']);
      return;
    }
    if (want === BORDER_STATE.DETECT_START) {
      detectingStarted = true;
      playFlash(BORDER_STATE.DETECT_START, BORDER_STATE.LOW, FLASH_MS['detecting-start']);
      return;
    }
    setBorderState(want);
  }

  /**
   * §1.8/§2.5 — the alert. Highest priority of the six states, so it interrupts whatever the
   * border was showing and hands it back afterwards.
   *
   * `nextState` is computed BEFORE `blacklistAlertActive` goes up, precisely so the hand-back is
   * the state that would have been shown without the alert, rather than the alert itself.
   */
  function triggerBlacklistAlert(entry) {
    var next = borderStateFromPanel(currentJob());
    blacklistAlertActive = true;
    playFlash(BORDER_STATE.BLACKLIST, next, FLASH_MS['blacklist'], function () {
      blacklistAlertActive = false;
    });
    console.log('[detector] 匹配到黑名单玩家：' + (entry && entry.id ? entry.id : '?') +
                (entry && entry.displayName ? '（' + entry.displayName + '）' : ''));
  }

  function riskColor(level) {
    return level === '高风险' ? '#e74c3c' : level === '可疑' ? '#f1c40f' : '#2ecc71';
  }

  function paintStatus() {
    if (!root) return;
    var moves = activeMoves();
    var inferred = countInferred(moves);
    var serverCount = socketRec ? socketRec.serverMoveNumber : null;
    var cur = currentJob();

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
        // 0.4.9 §一.3 — which route supplied the username the blacklist is keyed on. Shown only
        // when there IS one, and named because a wrong id is only fixable if the route that
        // produced it is on the record.
        (function () {
          var opp = resolveOpponentId();
          return opp ? '<span class="src" title="' +
            esc(T('panel|黑名单键：{id}（来源：{how}）', { id: opp.id, how: opp.how })) +
            '">' + esc(opp.how) + '</span>' : '';
        })() +
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
    // 0.4.9 §1.8 — the alert's other half. The border flash is the glance; this line is the
    // detail, and it names the display name AND the username so the operator can tell which of
    // two same-named players they blocked. First in the notes because it is the only one that is
    // about the person rather than about the data.
    if (blacklistHit) {
      h += '<div class="note lk">⚠ ' + esc(T('panel|对手在黑名单中：{name}（{id}）',
        { name: blacklistHit.displayName || '?', id: blacklistHit.id })) +
        (blacklistHit.note ? ' · ' + esc(blacklistHit.note) : '') + '</div>';
    }

    var rep = cur && (cur.report || cur.summary);
    h += '<div class="cards">' +
      card(T('panel|黑方'), rep && rep.black, CARD_TXT, null, 'B') +
      card(T('panel|白方'), rep && rep.white, CARD_TXT, null, 'W') +
      card(T('panel|豁免'), rep ? String(rep.forcedCount || 0) : '—', CARD_MUT, T('panel|冲四强制应手')) +
      card(T('panel|时间模式'), rep ? (rep.hasTime ? T('panel|真实间隔') : T('panel|固定预算')) : '—', CARD_MUT,
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
        risk = chatAdjusted('B', agg.black.risk) + '/' + (agg.white ? chatAdjusted('W', agg.white.risk) : 0);
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

    // 0.4.9 §一.6 / §二.4 — the two readouts this paint also owns. Both are driven from here
    // rather than from their own timers so that everything the panel says about the current
    // moment is recomputed at the same instant, from the same facts.
    paintBlacklistButton();
    paintBorderState(cur);
  }

  // `side` is optional and only meaningful for the two risk cards: 0.4.4 §13's chat adjustment
  // is folded in here, at the display, because `agg.risk` is Rapfi's own measurement and must
  // stay untouched (see the §七~§十四 note above).
  var CARD_TXT = 'var(--gm-txt)', CARD_MUT = 'var(--gm-mut)', CARD_DIM = 'var(--gm-dim)';
  function card(k, agg, color, sub, side) {
    if (!agg) return '<div class="card"><div class="v" style="color:' + CARD_DIM + '">—</div><div class="k">' + esc(k) + '</div></div>';
    if (typeof agg === 'string') {
      return '<div class="card"><div class="v" style="color:' + color + ';font-size:13px">' + esc(agg) + '</div>' +
             '<div class="k">' + esc(k) + '</div>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
    }
    var risk = side ? chatAdjusted(side, agg.risk) : fmtRisk(agg.risk);
    // Whether to print 「交流 N」 is a question about the ADJUSTMENT, not about the string, and it
    // must name the SAME side the adjustment landed on. This used to read
    // `risk !== Math.round(agg.risk)`, which is true for every unrounded float — so a game with no
    // chat at all still showed 「交流 0」. The first fix asked only `chat.total`, which put the line
    // on BOTH cards whenever any adjustment existed: the unadjusted card then paired a number that
    // had not moved with an annotation claiming it had, contradicting §13.3's 「只影响对手」.
    var adjusted = !!(side && side === chatAdjSide() && chat.total);
    return '<div class="card"><div class="v" style="color:' + riskColor(agg.level) + '">' +
      risk + '</div><div class="k">' + esc(k) + ' · ' + esc(TO('level', agg.level)) + '</div>' +
      '<div class="s">' + agg.n + ' ' + esc(T('panel|手')) +
        (adjusted ? ' · ' + esc(T('panel|交流 {d}', { d: (chat.total > 0 ? '+' : '') + chat.total })) : '') +
      '</div></div>';
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
            '<span style="color:var(--gm-dim);font-size:11px">' + esc(T('panel|ms，留空=跟随检测思考')) + '</span></div>' +
          '<div class="row"><label>' + esc(T('panel|开局排除')) + '</label>' +
            '<input type="number" min="0" max="40" data-act="set-opening" value="' + (S.openingCutoff || 0) + '">' +
            '<span style="color:var(--gm-dim);font-size:11px">' + esc(T('panel|手')) + '</span></div>' +
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
            '<span style="color:var(--gm-dim);font-size:11px">' + esc(T('panel|手，不足不存档')) + '</span></div>' +
          '<div class="row" style="margin-bottom:0"><label>' + esc(T('panel|结束自动分析')) + '</label>' +
            '<input type="checkbox" data-act="set-auto"' + (S.autoAnalyze ? ' checked' : '') + '>' +
            '<span style="color:var(--gm-dim);font-size:11px">' + esc(T('panel|对局结束时自动出报告并存档')) + '</span></div>' +
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
  // While a job runs it shows the progress percentage instead; otherwise the black/white risk
  // to one decimal (via `chatAdjusted` → `fmtRisk`), or "—" before the first analysis.
  //
  // 0.4.7 §2.2: the order of the two branches was the bug. `running()` returns `liveJob` while
  // it exists, and a live session that just hit a real live four sets `_terminal` and calls
  // liveFinish() — but liveFinish() has to await an offscreen round trip before it nulls
  // `liveJob` and sets progress to 100. In that window `running()` is still truthy and its
  // `progress` is whatever the last scored hand left it at (99, or lower), so the compact face
  // showed a percentage for a job that had already stopped. A stopped job is checked FIRST now.
  //
  // The three stop states are tested rather than one: `_terminal` (this session hit a live
  // four / 四三杀), '已完成', and '已中止' / '失败'. A job in any of them has nothing left to
  // report as progress, and the operator wants the number it produced instead.
  function paintCompact() {
    if (!root || !els.cpB) return;
    var cur = currentJob();
    var rep = cur && (cur.report || cur.summary);
    var stopped = !!(cur && (cur._terminal || cur.status === '已完成' ||
                             cur.status === '已中止' || cur.status === '失败'));
    if (running() && !stopped) {
      var p = Math.round((running().progress || 0));
      els.cpB.textContent = p + '%';
      els.cpW.textContent = T('panel|分析中');
      if (els.cpBar) els.cpBar.style.width = p + '%';
    } else if (rep) {
      els.cpB.textContent = rep.black ? chatAdjusted('B', rep.black.risk) : '—';
      els.cpW.textContent = rep.white ? chatAdjusted('W', rep.white.risk) : '—';
      if (els.cpBar) els.cpBar.style.width = '100%';
    } else {
      els.cpB.textContent = '—';
      els.cpW.textContent = '—';
      if (els.cpBar) els.cpBar.style.width = '0';
    }
  }

  // =====================================================================================
  // 0.4.4 §七~§十四 — 信息与交流 / F&Q
  //
  // Two rules shape everything below.
  //
  // (1) NOTHING here may act on the operator's behalf without the operator having said so.
  //     §7.1 describes the anti-cheat announcement as automatic, but sending words to a real
  //     opponent under the operator's name cannot be taken back, so the master switch
  //     (`settings.chatAuto`) defaults to OFF and the announcement additionally asks once per
  //     game. The 「提问」 button is exempt: that is an explicit click, not a decision the
  //     extension makes on its own.
  //
  // (2) The chat adjustment is a SEPARATE number from the engine's risk score. §13 says a wrong
  //     answer raises the AI rate, but `report.black.risk` is what Rapfi actually measured —
  //     overwriting it would make the archive lie about the analysis, and the next re-analysis
  //     would silently undo the chat. So the adjustment lives in `report.chatAdjust` and is
  //     applied at DISPLAY time by `chatAdjusted()`.
  // =====================================================================================

  var CHAT_STATE_KEY = 'chatState';
  var CHAT_ANNOUNCED_KEY = 'chatAnnounced';
  var ANNOUNCE_WINDOW_MS = 30000;    // §7.1 进入对局 30 秒内
  var ASK_TIMEOUT_MS = 60000;        // §12 发送 → 等 60 秒
  var SEND_RETRIES = 3;              // §7.3 三次重试失败 → 记 note
  // A sentinel for "the DOM observer says this node is one of ours". It cannot be a real id —
  // the socket path compares ids as strings — so it is a value no server would ever send.
  var CHAT_SELF = '__gm_self';

  // The §7.3 selector list, verbatim, plus a last-resort scan for any visible text field inside
  // a chat-ish container. Unverified against the live site — §7.3 is the only source we have.
  var CHAT_INPUT_SEL = [
    '#chat-input',
    '.chat-input',
    '[class*="chat"] textarea',
    '[class*="chat"] input[type="text"]',
    '[contenteditable="true"][class*="chat"]',
    'textarea[placeholder*="hat"]',
    'input[placeholder*="hat"]',
  ].join(', ');

  var chat = {
    lang: null,             // §8.2 chatLang — independent of settings.lang
    // 0.4.10 §2.3 — the language a QUESTION is sent in, chosen in the picker. A third, separate
    // key: `lang` is what the OPPONENT speaks (detected), `settings.lang` is what the OPERATOR
    // reads, and this is what we address them in. §2.3 is explicit that picking it must not move
    // the UI language, so it cannot be folded into either of the other two.
    questionLang: null,
    senderIsBlack: null,    // §9 — null = unknown, which BLOCKS any adjustment
    senderHow: null,
    // The seat identity `senderIsBlack` was computed from. When it changes (a rematch swaps
    // colours, or the seat names arrive after the first frame) the answer is recomputed.
    resolvedKey: null,
    asks: 0,
    total: 0,
    history: [],            // §14 提问记录
    lastSentAt: 0,
    // §7.3 — did any message of OURS actually reach the box this game? `announced` only records
    // that we tried, and the anchor (§9 level 3) must not claim a statement went out when the
    // send failed. Set in sendChatWithRetry's success path.
    sentAny: false,
    lastReply: null,
    // §7.3 — why the last send attempt failed ('noInput' | 'stuck' | 'throw'), or null. Kept so
    // the panel can explain itself after the footer's 5 seconds are up, instead of a send
    // failing invisibly — which is the reported symptom («信息未能正常发送»).
    lastSendWhy: null,
    gameStartAt: 0,
    announced: false,
    confirmShown: false,
    pending: null,          // the question we are waiting on: {q, askedAt, stage}
    ignored: false,         // §12 「本局忽略」
    confirmOk: false,       // the operator said yes to the announcement this game
    promptShown: false,
    repliedTo: {},          // de-dupes the socket+DOM double intake of one message
  };

  function resetChatForGame() {
    chat.senderIsBlack = null;
    chat.senderHow = null;
    chat.resolvedKey = null;
    chat.asks = 0;
    chat.total = 0;
    chat.history = [];
    chat.lastSentAt = 0;
    chat.sentAny = false;
    chat.lastSendWhy = null;
    chat.lastReply = null;
    chat.gameStartAt = performance.now();
    chat.announced = false;
    chat.confirmShown = false;
    chat.confirmOk = false;
    chat.pending = null;
    chat.ignored = false;
    chat.promptShown = false;
    chat.repliedTo = {};
    // `lang` survives a game on purpose (§8.2 stores it): an opponent who spoke Japanese in the
    // last game is still likely to speak it in this one. §2.3's `questionLang` survives for the
    // same reason — re-picking a language before every question would be busywork.
  }

  function loadChatState() {
    // 0.4.8 §2: the opponent's language is a fact about THIS browser session, not about the
    // profile — it used to sit in `local`, where it survived a restart and answered the next
    // opponent in the previous one's language. The session area forgets it when the browser
    // closes, which is the correct lifetime.
    var area = sessionArea();
    if (!area || !area.get) return;
    try {
      area.get([CHAT_STATE_KEY], function (r) {
        var st = (r && r[CHAT_STATE_KEY]) || {};
        if (st.lang) chat.lang = st.lang;
        if (st.questionLang) chat.questionLang = st.questionLang;
      });
    } catch (e) { /* no storage (a stripped build) — chatLang simply stays null */ }
  }

  function saveChatState() {
    var area = sessionArea();
    if (!area || !area.set) return;
    try {
      var o = {}; o[CHAT_STATE_KEY] = { lang: chat.lang, questionLang: chat.questionLang };
      area.set(o);
    } catch (e) {}
  }

  // ---------- §7.3 transport ----------

  // 0.4.5 §一 — the site's own selector list first (gomoku.com's list is byte-for-byte the one
  // that used to be hardcoded here), then a last-resort scan that is deliberately
  // site-agnostic: papergames.io's field is a Material textarea whose only stable handle is
  // 「Write a message...」, which the /messag/i test below catches even if the class changes.
  function chatInputEl() {
    var el = (typeof GMSites !== 'undefined' && GMSites) ? GMSites.chatInputEl() : null;
    if (el) return el;
    el = document.querySelector(CHAT_INPUT_SEL);
    if (el) return el;
    // Last resort: a visible text field whose own or ancestor class/placeholder mentions chat.
    var all = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (!n.offsetParent) continue;
      var hint = (n.className || '') + ' ' + (n.getAttribute('placeholder') || '') + ' ' +
        ((n.parentElement && n.parentElement.className) || '');
      if (/chat|messag/i.test(String(hint))) return n;
    }
    return null;
  }

  function chatAvailable() { return !!chatInputEl(); }

  function isTextInput(el) {
    var tag = String(el.tagName || '').toUpperCase();
    return tag === 'TEXTAREA' || tag === 'INPUT';
  }

  /** What the box currently holds — the only honest signal that a send happened. */
  function boxText(el) {
    if (!el) return '';
    return isTextInput(el) ? String(el.value == null ? '' : el.value).trim()
                           : String(el.textContent || '').trim();
  }

  /**
   * Write through the PROTOTYPE's value setter, not `input.value = …`.
   *
   * React (and Vue on some builds) installs its own `value` accessor on the element instance and
   * remembers the last value it rendered. Assigning through that instance descriptor updates the
   * DOM but leaves the framework's state at "", so the app's change handler runs with an EMPTY
   * message and the send silently does nothing — which is exactly the reported symptom. Calling
   * the native setter makes the framework's own dirty-check see a real change.
   */
  function setNativeValue(el, text) {
    var proto = null;
    var tag = String(el.tagName || '').toUpperCase();
    // `window`, not a bare `g`: content.js has no such alias (there are two function-scoped
    // `var g` locals elsewhere in this file, and reaching for either from here would be a
    // ReferenceError — caught by sendChat's try/catch and reported as 'throw', i.e. every
    // send failing for a reason that has nothing to do with the page).
    if (tag === 'TEXTAREA') proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    else if (tag === 'INPUT') proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
  }

  /**
   * Enter, as a full sequence with a readable `keyCode`.
   *
   * `new KeyboardEvent('keydown', { keyCode: 13 })` ignores keyCode — the spec drops it and the
   * event ends up with 0 — so a site that switches on `e.keyCode` (most do) sees nothing. The
   * property is redefined after construction to put 13 back.
   */
  function pressEnter(el) {
    var kd = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true,
    });
    try { Object.defineProperty(kd, 'keyCode', { get: function () { return 13; } }); } catch (e) {}
    try { Object.defineProperty(kd, 'which', { get: function () { return 13; } }); } catch (e) {}
    el.dispatchEvent(kd);
    // If the site consumed the keydown it has already sent; the rest is for the ones that
    // listen on keypress/keyup instead.
    el.dispatchEvent(new KeyboardEvent('keypress', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true,
    }));
    el.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true,
    }));
  }

  var SEND_BTN_WORD = /^(send|发送|送出|傳送|送信|보내기|отправить|envoyer|senden)$/i;

  /** The button a human would click if Enter did nothing. */
  function sendButtonNear(el) {
    var box = el.parentElement;
    for (var up = 0; up < 4 && box; up++) {
      var btns = box.querySelectorAll('button, [role="button"], a.btn, a[class*="send"]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (!b.offsetParent) continue;
        var cls = String(b.className || '') + ' ' + String(b.id || '');
        if (SEND_BTN_WORD.test(String(b.textContent || '').trim()) || /send/i.test(cls)) return b;
      }
      box = box.parentElement;
    }
    return null;
  }

  /**
   * §7.3 — DOM write + simulated Enter, deliberately NOT `socket.emit`. Emitting would need the
   * exact event name and payload the server expects, and getting it wrong is indistinguishable
   * from a protocol violation; typing into the box exercises the same path a human does.
   *
   * `done(ok, why)` is asynchronous because the result is VERIFIED rather than assumed: a chat
   * box that accepted the message is cleared by the app, so text still sitting there after a beat
   * means nothing was sent. The old version returned `true` for merely having dispatched events,
   * so every failure was reported as a success and no retry ever ran.
   */
  function sendChat(text, done) {
    var input = chatInputEl();
    if (!input) { chat.lastSendWhy = 'noInput'; done(false, 'noInput'); return; }
    try {
      input.focus();
      if (isTextInput(input)) {
        setNativeValue(input, text);
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertText', data: text,
        }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertText', data: text,
        }));
      }
      pressEnter(input);
    } catch (e) {
      chat.lastSendWhy = 'throw';
      done(false, 'throw');
      return;
    }
    setTimeout(function () {
      if (boxText(input) !== text) { chat.lastSendWhy = null; done(true, 'sent'); return; }
      var btn = sendButtonNear(input);
      if (!btn) { chat.lastSendWhy = 'stuck'; done(false, 'stuck'); return; }
      try { btn.click(); } catch (e2) {}
      setTimeout(function () {
        var ok = boxText(input) !== text;
        chat.lastSendWhy = ok ? null : 'stuck';
        done(ok, ok ? 'sent' : 'stuck');
      }, 150);
    }, 120);
  }

  /**
   * §7.3 — three attempts, then give up for the rest of the game and say why.
   *
   * The ONE place a send is known to have landed. `lastSentAt` (§12's 10-second 「已发过」 gate)
   * and `sentAny` (§9 level 3's anchor) are both set here and nowhere else, so "did anything we
   * sent actually go out" has a single answer.
   */
  function sendChatWithRetry(text, onFail, onSent) {
    var n = 0;
    (function attempt() {
      sendChat(text, function (ok, why) {
        if (ok) {
          chat.lastSentAt = performance.now();
          chat.sentAny = true;
          if (onSent) onSent();
          return;
        }
        if (++n >= SEND_RETRIES) {
          if (onFail) onFail(why);
          return;
        }
        setTimeout(attempt, 1200);
      });
    })();
  }

  // ---------- §9 sender identification ----------

  function detectSender(fromId) {
    // Level 1 — socket. §9 says `game-start` ships `players[{id, name, color}]` AND a `selfId`;
    // this compares the two by ID first, falling back to the name. The ids only arrive because
    // hook.js now forwards `playerIds` — it used to keep just the names, which silently made the
    // primary level unreachable on the one payload the spec names as its source.
    var names = playerNames();
    var players = null;
    if (socketRec && socketRec.players) {
      var ids = socketRec.playerIds || {};
      players = [
        { id: ids.black != null ? ids.black : null, name: socketRec.players.black, color: 'black' },
        { id: ids.white != null ? ids.white : null, name: socketRec.players.white, color: 'white' },
      ];
    }
    var bySocket = GMChat.senderFromPlayers(players, (socketRec && socketRec.selfId) || null,
      names.self || null);
    if (bySocket != null) return { isBlack: bySocket, how: 'socket' };
    // Level 2 — DOM seat names vs our own displayed name.
    var byDom = GMChat.senderFromNames(names.self || null, names.black || null, names.white || null);
    if (byDom != null) return { isBlack: byDom, how: 'dom' };
    // Level 3 — the anchor. `sentAny` is set only where a send is known to have landed, so the
    // anchor is not claimed on the strength of an attempt that failed.
    if (chat.sentAny) {
      // Our own colour is the one we are NOT, and we cannot say which we are — so the anchor
      // resolves the opponent's colour only when our own is already known. It is not, or we
      // would have returned above. Record the fact instead of guessing.
      return { isBlack: null, how: 'anchor-unresolved' };
    }
    return { isBlack: null, how: 'unknown' };
  }

  /**
   * §9 — resolve the OPPONENT's colour proactively, from the socket or the DOM, instead of
   * waiting for them to speak first.
   *
   * This is the difference between the feature working and not. `chat.senderIsBlack` used to be
   * assigned in exactly one place — inside `onChatMessage`, i.e. only once a message had already
   * arrived — while §12's `senderUnknown` gate blocks the 「提问」 button on it. So the operator
   * could not send the first message, and the only thing that could break the deadlock was the
   * opponent speaking unprompted. The socket already knows both seats at `game-start`; ask it.
   *
   * Idempotent and cheap. It recomputes when the identity it resolved FROM changes, because a
   * rematch can swap colours and the seat names can arrive after the first frame — a stale answer
   * that stuck would send every adjustment to the wrong side.
   */
  function senderKey() {
    var pl = (socketRec && socketRec.players) || {};
    var ids = (socketRec && socketRec.playerIds) || {};
    var nm = playerNames();
    // The seat IDS are part of the key, not just the names: two players can share a display name
    // (and a guest has none at all), while an id is what the socket actually matched on.
    return [(socketRec && socketRec.selfId) || '', pl.black || '', pl.white || '',
            ids.black == null ? '' : ids.black, ids.white == null ? '' : ids.white,
            nm.self || ''].join('|');
  }

  function resolveSenderColour() {
    var key = senderKey();
    if (key !== chat.resolvedKey) {
      chat.resolvedKey = key;
      // Only discard an answer that came from the seats themselves. One derived from the
      // announcement anchor does not depend on the seat list, so it survives a key change.
      if (chat.senderHow == null || chat.senderHow === 'socket' || chat.senderHow === 'dom') {
        chat.senderIsBlack = null;
        chat.senderHow = null;
      }
    }
    if (chat.senderIsBlack != null) return chat.senderIsBlack;
    var who = detectSender(null);
    if (who && who.isBlack != null) {
      chat.senderIsBlack = !who.isBlack;
      chat.senderHow = who.how;
    }
    return chat.senderIsBlack;
  }

  // ---------- message intake ----------

  function isSelfMessage(fromId) {
    var selfId = socketRec && socketRec.selfId;
    if (fromId == null || selfId == null) return null;
    return String(fromId) === String(selfId);
  }

  /**
   * One entry point for both transports (socket event and DOM observer). The two can deliver the
   * SAME message, so a short-lived de-dupe window keys on the text.
   */
  function onChatMessage(text, fromId, via) {
    if (!text) return;
    var t = String(text).trim();
    if (!t) return;
    var now = performance.now();
    for (var k in chat.repliedTo) {
      if (!chat.repliedTo.hasOwnProperty(k)) continue;
      if (now - chat.repliedTo[k] > 8000) delete chat.repliedTo[k];
    }
    if (chat.repliedTo[t]) return;
    chat.repliedTo[t] = now;

    // Our own message: the anchor. It tells us the chat works, and nothing else.
    if (fromId === CHAT_SELF || isSelfMessage(fromId) === true) {
      // 0.5.0 §3.2 — matched against EVERY wording of the statement, not only the English one.
      // The operator can now send it by hand in any of the bank's eight languages, and a miss
      // here is silent: the automatic sender would simply never learn that its statement landed.
      if (GMChat.announceTexts().indexOf(t) >= 0) chat.announced = true;
      return;
    }

    var who = detectSender(fromId);
    if (who.isBlack != null && chat.senderIsBlack == null) {
      // We are the other seat.
      chat.senderIsBlack = !who.isBlack;
      chat.senderHow = who.how;
    }

    handleOpponentMessage(t, now);
  }

  function handleOpponentMessage(text, now) {
    // §8.1/§8.2 — the language of the incoming message drives the reply language, and it is
    // remembered so the NEXT question is asked in it too.
    var lang = GMChat.detectLang(text);
    if (lang) {
      chat.lang = lang;
      saveChatState();
    } else if (!chat.lang) {
      // §8.3 乱码 / 无法识别 → ask where they are from, once.
      if (chat.lastReply !== 'whereFrom') {
        var ask = GMChat.pickReply('en', 'whereFrom', null, now);
        if (ask) {
          chat.lastReply = 'whereFrom';
          autoSend(ask);
        }
      }
      return;
    }

    // §13 — a question is outstanding: this is the answer.
    if (chat.pending) { gradePending(text, now); return; }

    // §8.3 — otherwise a plain reply in their language, at most one per 10s.
    if (!S.chatAuto) return;
    var reply = GMChat.pickReply(chat.lang || 'en', 'greet', chat.lastReply, now);
    if (!reply) return;
    chat.lastReply = reply;
    autoSend(reply);
  }

  /**
   * §7.3 — say WHY a send did not go through.
   *
   * The spec's literal note is 「聊天栏不可用，已跳过声明」 for every failure. That wording is what
   * made the operator's report («信息未能正常发送») impossible to act on: a chat box that is
   * present and swallows the message is a different fault from a box that is not there at all,
   * and the spec's own §7.3 code cannot tell them apart because it never checks. The reason is
   * also kept in `chat.lastSendWhy`, which the question panel prints — the footer only holds for
   * five seconds, and the operator reads the panel.
   */
  function sendFailFoot(why) {
    flashFoot(T('panel|发送失败：{why}。消息未发出。', { why: TO('sendWhy', why || 'stuck') }));
    if (why === 'noInput') logChatCandidates();
    paintChatPanel();
  }

  /**
   * §7.3 — when the box cannot be found, record what IS on the page.
   *
   * §7.3's selector list is the only source we have and it is explicitly unverified, so a failed
   * lookup is exactly the moment to learn the site's real markup — and the operator is the only
   * one who can see the console. Called only from the failure path (never from `chatAvailable()`,
   * which runs every second), so it cannot spam. Console output stays Chinese and untranslated
   * (§1.7).
   */
  function logChatCandidates() {
    try {
      var all = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
      var seen = [];
      for (var i = 0; i < all.length && seen.length < 8; i++) {
        var n = all[i];
        if (!n.offsetParent) continue;
        var cls = String(n.className || '').trim().split(/\s+/).filter(Boolean).join('.');
        var ph = n.getAttribute('placeholder');
        seen.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (cls ? '.' + cls : '') +
          (ph ? ' [placeholder=' + ph + ']' : ''));
      }
      console.log('[detector] 找不到聊天输入框；页面上可见的文本输入候选：' +
        (seen.length ? seen.join(' | ') : '（一个都没有）'));
    } catch (e) { /* a stripped document — nothing to report */ }
  }

  function autoSend(text) {
    sendChatWithRetry(text, sendFailFoot);
  }

  // ---------- §12/§13 the question flow ----------

  function opponentRisk() {
    var rep = currentReport();
    if (!rep) return null;
    var side = chatAdjSide();
    if (!side) return null;
    var agg = side === 'B' ? rep.black : rep.white;
    return agg && agg.risk != null ? Math.round(agg.risk) : null;
  }

  /**
   * The §12 gate context. ONE copy: the askable list, the picker's greying and the auto-prompt
   * all read it, and a second copy is where a gate silently stops matching the others (this
   * project has had three separate "three copies of one answer" defects).
   */
  function askContext() {
    // §9 — refresh before deciding. The seat list may have arrived since the last tick, and this
    // is the one gate the operator can do nothing about from the UI.
    resolveSenderColour();
    var rep = currentReport();
    var opening = (socketRec && socketRec.opening) || (rep && rep.opening) || null;
    return {
      now: performance.now(),
      rate: opponentRisk() == null ? 0 : opponentRisk(),
      spectating: !!(socketRec && socketRec.spectator),
      chatAvailable: chatAvailable(),
      senderIsBlack: chat.senderIsBlack,
      lastSentAt: chat.lastSentAt,
      askedIds: chat.history.map(function (h) { return h.qid; }),
      // 0.5.0 §3.2 — the statement's second entry point has its own record, so the picker has to
      // be told about it separately. See chat.js:askBlocked.
      announced: !!chat.announced,
      // Not read by askBlocked — the callers need them to label their own output.
      _rate: opponentRisk(),
      _openingCode: opening && (opening.code || (typeof opening === 'string' ? opening : null)),
    };
  }

  /**
   * The questions §12 currently allows.
   *
   * `allowUnknownColour` is passed by the 提问 picker and by nothing else. §12 lists
   * 发送者颜色未定 among the disable conditions and it must stay one for the AUTO prompt, which has
   * to name the side whose rate crossed 65%. The explicit picker is a different case: §9 already
   * guarantees that an unknown colour moves NOBODY's AI rate (the answer is only recorded as a
   * note), and without this exception the picker can never fire the FIRST message — the colour is
   * resolved from the seat list or from a message of ours, and we cannot send one until we send
   * one. That circle is exactly the operator's report («问题没有发送途径»).
   */
  function askableQuestions(allowUnknownColour) {
    // §9 — the refresh happens HERE and not only inside askContext(), because this is the entry
    // point whose answer decides whether the 提问 control is live, and it is called from the 1s
    // tick (paintChatButton) as well as from the picker. It is idempotent and costs a comparison.
    resolveSenderColour();
    var ctx = askContext();
    var out = [];
    for (var i = 0; i < GM_QUESTIONS.length; i++) {
      var q = GM_QUESTIONS[i];
      var why = GMChat.askBlocked(q, ctx);
      if (why === null || (allowUnknownColour && why === 'senderUnknown')) {
        out.push({ q: q, rate: ctx._rate, code: ctx._openingCode });
      }
    }
    return out;
  }

  /**
   * 0.4.10 §2.3/§5.2 — the question's text in one chosen language.
   *
   * Returns `{q, text, exact}`: `exact` is false when this language has no translation of this
   * question and `textOf` fell back (to a sibling locale or to English), which the caller turns
   * into a note. The distinction cannot be recovered from `text` alone, and sending the wrong
   * language silently — to a real opponent, in a feature whose whole premise is language — is
   * exactly the kind of silent failure this project keeps having to design against.
   */
  function pickQuestion(lang, id) {
    var q = null;
    for (var i = 0; i < GM_QUESTIONS.length; i++) {
      if (GM_QUESTIONS[i].id === id) { q = GM_QUESTIONS[i]; break; }
    }
    if (!q) return null;
    var exact = !!(q.text && q.text[lang]);
    var text = GMChat.textOf(q.text, lang);
    return text ? { q: q, text: text, exact: exact } : null;
  }

  function askQuestion(q, lang) {
    if (!q) return;
    if (!chatAvailable()) { flashFoot(T('panel|聊天栏不可用，已跳过声明')); return; }
    // The colour may legitimately still be unknown here (see askableQuestions) — §9 keeps the
    // answer from moving any AI rate in that case, so this is a warning, not a gate.
    var unknownColour = chat.senderIsBlack == null;
    var sendLang = lang || askMenuLang();
    var picked = pickQuestion(sendLang, q.id) || { q: q, text: GMChat.textOf(q.text, sendLang), exact: false };
    if (!picked.text) return;
    chat.pending = { q: q, lang: sendLang, askedAt: performance.now(), stage: 'asked' };
    sendChatWithRetry(picked.text, function (why) {
      // Nothing went out, so do not sit waiting 60 seconds for an answer that cannot come.
      chat.pending = null;
      sendFailFoot(why);
    }, function () {
      // Counted only once the message really left — a failed attempt did not ask anything.
      chat.asks++;
      if (unknownColour) flashFoot(T('panel|发送者颜色未确定，本次问答不调整 AI 率'));
      else if (!picked.exact) flashFoot(T('panel|该题没有 {lang} 版本，已发送回退文本', { lang: sendLang }));
      paintChatPanel();
    });
    paintChatPanel();
  }

  function gradePending(text, now) {
    var p = chat.pending;
    if (!p) return;
    var rep = currentReport();
    var opening = (socketRec && socketRec.opening) || (rep && rep.opening) || null;
    var code = opening && (opening.code || (typeof opening === 'string' ? opening : null));
    var ctx = {
      rate: opponentRisk() == null ? 0 : opponentRisk(),
      rateLine: GMChat.RATE_LINE,
      openingNames: code ? GMChat.openingAnswerNames(code) : [],
      answeredFollowUp: p.stage === 'followup',
    };
    var g = GMChat.grade(p.q, text, ctx);

    // The 「yes」 branch earns a second question rather than a verdict.
    if (g.verdict === 'followup' && g.followUp) {
      p.stage = 'followup';
      p.askedAt = now;
      // 0.4.10 §2.3 — the follow-up goes out in the language the QUESTION was sent in, not in
      // `chat.lang`. The two differ whenever the operator overrode the detected language in the
      // picker, and answering 「我是初学者…」 in a third language mid-exchange reads as a glitch.
      var follow = GMChat.textOf(g.followUp, p.lang || chat.lang || LANG);
      if (follow) sendChatWithRetry(follow, sendFailFoot);
      recordChat(p.q, text, 'followup', 0, p.lang);
      paintChatPanel();
      return;
    }

    // §9 — with the sender unplaced there is nobody to adjust, and §9's instruction for that
    // state is 「只记 note」. The verdict is still recorded (it is evidence), but with a delta of 0
    // and without touching the budget: `chatAdjusted` would refuse to apply it anyway, so adding
    // it here would make the panel's 「累计调整」 advertise a change that never happens.
    var unplaced = chat.senderIsBlack == null;
    var applied = unplaced ? { ok: false, delta: 0 } : GMChat.applyBudget(chat.history, g.delta);
    if (applied.ok) chat.total += applied.delta;
    recordChat(p.q, text, g.verdict, applied.ok ? applied.delta : 0, p.lang);
    chat.pending = null;

    if (g.thanks) {
      var thanks = GMChat.pickReply(p.lang || chat.lang || 'en', 'thanks', null, now);
      if (thanks) sendChatWithRetry(thanks, sendFailFoot);
    }
    paintChatPanel();
    paintStatus();
  }

  function recordChat(q, answer, verdict, delta, lang) {
    chat.history.push({
      qid: q.id,
      // The question AS SENT — so the 提问记录 shows what the opponent actually received rather
      // than a fresh lookup in whatever language happens to be selected later.
      q: GMChat.textOf(q.text, lang || chat.lang || LANG),
      answer: String(answer || '').slice(0, 200),
      verdict: verdict,
      delta: delta,
      at: Date.now(),
    });
    if (chat.history.length > 20) chat.history.shift();
  }

  /**
   * The panel's one risk formatter.
   *
   * `report.black.risk` is Rapfi's own arithmetic and arrives at full precision — 17.3215408586938
   * — which is what the two cards used to print, because `chatAdjusted` handed the untouched float
   * straight back whenever it had no adjustment to apply. One decimal is the operator's call
   * (2026-09-29): enough to see the chat adjustment move the number, not enough to pretend the
   * engine resolves hundredths.
   *
   * It returns a STRING on purpose. Every caller puts the result into `textContent` or into an
   * HTML string, and returning a string keeps the rounding in ONE place instead of at four call
   * sites — which is how the raw float escaped in the first place.
   */
  function fmtRisk(risk) {
    if (risk == null) return risk;
    var v = Number(risk);
    return isFinite(v) ? v.toFixed(1) : risk;
  }

  /**
   * §13.3 — the ONE side the chat adjustment lands on, or `null` while the sender is unplaced.
   *
   * 「只影响对手」 ⇒ this is the OPPONENT's side, and `chat.senderIsBlack` holds the sender's —
   * i.e. the opponent's — colour. So `true` means the opponent is black and the side that moves is
   * BLACK. The chain that makes 'B' correct rather than 'W':
   *   • `senderFromPlayers(players, selfId, selfName)` matches the seat whose id/name is OURS and
   *     returns OUR colour (pinned in verify-044 §6: `senderFromPlayers(players, 'a1') === true`,
   *     labelled 「selfId → black」);
   *   • `resolveSenderColour` then negates it (`chat.senderIsBlack = !who.isBlack`), so what lands
   *     in the field is the OPPONENT's colour and never ours.
   * This ternary used to read `true ? 'W'`, which sent every adjustment — and the automatic
   * prompt's risk lookup — to the player who had NOT answered, directly against §13.3.
   *
   * A single helper because this expression used to be copy-pasted verbatim into three places
   * (the archive record, the auto-prompt's risk lookup, and the display). Three copies of a
   * mapping that a single character can invert is three chances to blame the wrong player, and
   * two of them had no test at all.
   */
  function chatAdjSide() {
    return chat.senderIsBlack === true ? 'B' : (chat.senderIsBlack === false ? 'W' : null);
  }

  /**
   * §13.3 — the adjustment, applied at DISPLAY time only (see the note at the top).
   *
   * Note this is NOT the same question as "was there an adjustment": the caller must ask
   * `chatAdjSide()` for WHICH card moves and `chat.total` for whether any does. It used to
   * compare the returned value against `Math.round(agg.risk)`, which is always unequal for a
   * float — so every card claimed 「交流 0」 even with nothing adjusted. See `card()` below.
   */
  function chatAdjusted(side, risk) {
    if (risk == null) return risk;
    var v = Number(risk);
    if (!isFinite(v)) return risk;
    if (side === chatAdjSide() && chat.total) v = Math.max(0, Math.min(100, v + chat.total));
    return fmtRisk(v);
  }

  // ---------- §7 the announcement ----------

  function maybeAnnounce() {
    if (!S.chatAuto || chat.announced || chat.ignored) return;
    // 0.4.10 §2.2 — the narrower switch. It is checked AFTER the master one so that turning
    // 自动发送 off still silences everything, and it gates THIS function only: the 提问 picker is
    // an explicit click by the operator and is deliberately unaffected (§2.2's last line).
    if (!S.autoSendAnnouncement) return;
    if (chat.gameStartAt && performance.now() - chat.gameStartAt > ANNOUNCE_WINDOW_MS) return;
    // §7.1 身份为 registered. A guest or a spectator never announces.
    if (!socketRec || socketRec.guest || socketRec.spectator) return;
    if (!chatAvailable()) return;
    if (!chat.confirmShown) {
      // The operator's decision (2026-09-29): the first send of each game is confirmed. After
      // that the switch alone governs, so a 10-game session is not 10 dialogs.
      chat.confirmShown = true;
      showChatConfirm();
      return;
    }
    if (!chat.confirmOk) return;
    // Set BEFORE the send: the send is asynchronous (it verifies itself over ~120–270ms) while
    // `maybeAnnounce` runs once a second, so without this the next tick would start a second
    // statement while the first is still in flight.
    //
    // It is deliberately NOT reset on failure. The spec is 「三次重试失败 → 浮层记 note，不再重试」
    // — one attempt per game. Resetting it here (as it used to) let `maybeAnnounce` re-enter on
    // every tick for the rest of the 30-second window, i.e. up to ~60 sends at a live opponent.
    chat.announced = true;
    // `markAnnounced` rides the SUCCESS callback rather than running immediately: §7.1's
    // `chatAnnounced = { roomId, at }` is what stops a second statement in the same room, and
    // writing it before the send is known to have landed would record a statement that never
    // went out as delivered.
    // 0.4.4 §7.2 is unchanged by 0.5.0 §3.2: the AUTOMATIC statement is fixed English and does
    // not follow settings.lang. The language is now passed explicitly instead of being baked
    // into a chat.js constant, because the same text is also offered as a question the operator
    // can send by hand in their chosen language.
    sendChatWithRetry(GMChat.announceText('en'), sendFailFoot, markAnnounced);
  }

  function markAnnounced() {
    try {
      var o = {};
      o[CHAT_ANNOUNCED_KEY] = { roomId: (socketRec && socketRec.roomId) || null, at: Date.now() };
      chrome.storage.local.set(o);
    } catch (e) {}
  }

  // ---------- §12 auto-prompt ----------

  function maybePromptQuestion() {
    if (!S.chatAuto || chat.ignored || chat.promptShown || chat.pending) return;
    var rate = opponentRisk();
    if (!GMChat.shouldPrompt(rate)) return;
    chat.promptShown = true;
    flashFoot(T('panel|被怀疑方 AI 率 {rate}%，可发送验证题', { rate: rate }));
  }

  // ---------- the overlay UI ----------

  var chatOpen = false;

  var lastAskState = null;
  function paintChatButton() {
    if (!els.ask) return;
    // Same permissive list as the button's own handler — an 'off' state here would grey the
    // button out (`.hd .lk[data-ask-state=off]` is `cursor:default`) and make the handler's
    // exception unreachable, which is the whole bug this pair of changes fixes.
    var ok = askableQuestions(true).length > 0;
    var st = ok ? 'on' : 'off';
    // `tickChat` calls this every second, so the DOM is only touched when the answer changes.
    if (st === lastAskState) return;
    lastAskState = st;
    els.ask.setAttribute('data-ask-state', st);
    els.ask.setAttribute('title', ok
      ? T('panel|向对手提问，用五子棋常识区分 AI 与人类高手')
      : T('panel|当前不可提问（观战 / 聊天栏不可用 / 冷却中 / 风险分不足）'));
  }

  /**
   * The chat clock, once a second. Every step re-checks its own gate, so running it while
   * nothing is happening costs a few comparisons.
   */
  function tickChat() {
    if (chat.pending && performance.now() - chat.pending.askedAt > ASK_TIMEOUT_MS) {
      // §13.4 — 超时未答 = empty, delta 0. It is still RECORDED: "we asked and got nothing" is
      // evidence the operator wants to see even though it moves no number.
      var p = chat.pending;
      chat.pending = null;
      recordChat(p.q, '', 'empty', 0);
      paintChatPanel();
    }
    startChatObserver();
    // §9 — the DOM path (our own displayed name) can become readable a beat after the socket
    // frame, so give it a cheap second chance every tick; it returns at once once resolved.
    resolveSenderColour();
    maybeAnnounce();
    maybePromptQuestion();
    if (root) paintChatButton();
  }

  // §8 — the DOM fallback for reading messages. Scoped to the chat container rather than
  // `document.body`: the game page mutates constantly (clocks, board, score) and a body-wide
  // observer would run this handler hundreds of times a second.
  var chatObserver = null;
  function startChatObserver() {
    if (chatObserver) return;
    var input = chatInputEl();
    if (!input) return;
    var box = null, n = input;
    for (var i = 0; i < 4 && n; i++) {
      n = n.parentElement;
      if (n && /chat|messag/i.test(String(n.className || ''))) { box = n; break; }
    }
    if (!box) return;
    chatObserver = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var el = added[j];
          if (!el || el.nodeType !== 1) continue;
          var txt = String(el.textContent || '').trim();
          if (!txt || txt.length > 500) continue;
          // The node's own class/id is the only sender hint the DOM offers. §9's level 2 resolves
          // the COLOUR from the seat names; this only answers "is it one of ours?".
          var hint = String(el.className || '') + ' ' + String(el.id || '') + ' ' +
            String((el.dataset && (el.dataset.user || el.dataset.sender || el.dataset.name)) || '');
          onChatMessage(txt, /self|own|mine|me\b/i.test(hint) ? CHAT_SELF : null, 'dom');
        }
      }
    });
    chatObserver.observe(box, { childList: true, subtree: true });
  }

  function paintChatPanel() {
    if (!els.chatPanel) return;
    if (!chatOpen) { els.chatPanel.innerHTML = ''; els.chatPanel.style.display = 'none'; return; }
    els.chatPanel.style.display = '';
    var rows = '';
    for (var i = chat.history.length - 1; i >= 0; i--) {
      var h = chat.history[i];
      rows += '<div class="cr"><span class="cq">' + esc(h.q) + '</span>' +
        '<span class="ca">' + esc(h.answer) + '</span>' +
        '<span class="cv ' + (h.delta > 0 ? 'up' : (h.delta < 0 ? 'dn' : '')) + '">' +
        esc(TO('verdict', h.verdict)) + (h.delta ? ' ' + (h.delta > 0 ? '+' : '') + h.delta : '') +
        '</span></div>';
    }
    els.chatPanel.innerHTML =
      '<div class="chd">' + esc(T('panel|提问记录')) + '<span class="sp"></span>' +
        '<span class="lk" data-act="chat-close">' + esc(T('panel|收起')) + '</span></div>' +
      (rows || '<div class="cempty">' + esc(T('panel|还没有提问记录')) + '</div>') +
      // §7.3 — a send that failed stays visible here. The footer's note is gone after 5 seconds
      // and this panel is what the operator is looking at when they wonder why nothing arrived.
      (chat.lastSendWhy
        ? '<div class="cwarn">' + esc(T('panel|发送失败：{why}。消息未发出。',
            { why: TO('sendWhy', chat.lastSendWhy) })) + '</div>'
        : '') +
      '<div class="cft">' + esc(T('panel|提问 {n} 次 · 累计调整 {d}', { n: chat.asks, d: chat.total })) +
        '<span class="sp"></span>' +
        '<span class="lk" data-act="chat-ask">' + esc(T('panel|提问')) + '</span></div>';
  }

  function showChatConfirm() {
    if (!els.chatPanel) return;
    chatOpen = true;
    els.chatPanel.style.display = '';
    els.chatPanel.innerHTML =
      '<div class="chd">' + esc(T('panel|自动发送反作弊声明')) + '</div>' +
      '<div class="cbody">' + esc(T('panel|即将向对手发送这条英文声明，发送后无法撤回：')) +
        '<div class="ctext">' + esc(GMChat.announceText('en')) + '</div></div>' +
      '<div class="cft"><span class="sp"></span>' +
        '<span class="lk" data-act="chat-confirm-no">' + esc(T('panel|本局忽略')) + '</span>' +
        '<span class="lk" data-act="chat-confirm-yes">' + esc(T('panel|发送')) + '</span></div>';
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
    var cur = currentJob();
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
        // 0.4.10 §一.1 — compare BEFORE `S = v`, and against the STORED value rather than the
        // live attribute: the attribute is the applied result and reading it back would make
        // the check depend on whether some other surface had already written it.
        var themeChanged = v.theme !== S.theme;
        S = v;
        if (!root) return;
        // §1.8: a language change invalidates the SHELL, not just the values in it — every
        // label in it was baked into the DOM by shellHtml(). So it takes a rebuild. It also
        // has to win over the "operator is typing" guard below: nobody is typing into a panel
        // they just switched language on, and skipping the rebuild would leave half the panel
        // in the old language until the next move.
        if (langChanged) { applyLang(S.lang); renderShell(); paint(); return; }
        // §三.1: the theme is a pure attribute swap on the host, so it needs no shell rebuild —
        // but it does have to beat the `root.activeElement` guard below, because a theme change
        // made from the viewer (or another tab) should land even while this panel has focus.
        if (themeChanged) applyTheme(S.theme);
        if (root.activeElement) paintStatus(); else paint();
      });
    });
  }

  function boot() {
    // Before build(): shellHtml() reads T(), so the locale must be resolved first or the very
    // first paint flashes Chinese before the listener can correct it. This call only sets the
    // module's LANG + locale; the HOST it would also tag does not exist yet.
    applyLang(S.lang);
    // build() itself applies `lang`/`dir` and `data-theme` once the shadow host exists — see
    // the note inside it (0.4.10 §一.1). They must NOT be called before it: both no-op.
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
  // 0.4.8 §2: restore the session facts before anything can ask about them. Fire-and-forget —
  // every reader copes with the pre-restore value, so a late arrival can only add information.
  hydrateSession();
  // 0.4.9 §一.4 — the blacklist mirror. Same fire-and-forget reasoning: the button starts at
  // `na` and the match check simply retries, so a late arrival can only add information.
  hydrateBlacklist();
  loadChatState();
  resetChatForGame();
  setInterval(function () {
    startDomObserver();
    tickDom();
    tickStall();
    pollEnd();
    // 0.4.6 §一 — remember the player names while they are still on screen; papergames.io takes
    // its player row away together with the board, and the record is built after that.
    rememberNames();
    // 0.4.9 §1.5 — the blacklist match. Once per game (it is keyed on gameEpoch), and it can
    // only answer after `rememberNames()` has had a chance to see the seat list.
    checkBlacklist();
    // 0.4.4 — the chat clock. All three are cheap and idempotent; each re-checks its own gate.
    tickChat();
  }, 1000);
})();
