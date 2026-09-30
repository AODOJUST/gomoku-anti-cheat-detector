// Gomoku Anti-Cheat Detector — MAIN-world hook (runs in the page's own JS context).
//
// Why this file exists: gomoku.com exposes its Socket.IO client as `window.socket`
// (online.js, "將 socket 暴露到全局作用域"). The socket carries an authoritative,
// chronologically ordered move stream — which the DOM does NOT: stones only carry
// data-row / data-col, never a move number, and a full-board redraw erases even the
// arrival order. A content script's isolated world cannot touch page objects, so this
// hook runs with "world": "MAIN" and forwards a JSON string to the isolated world via
// CustomEvents.
//
// Joining a game that is ALREADY RUNNING (spectating) is the one case the socket
// cannot help with: no `move-made` fires for moves played before we attached, and the
// server's `game-state-sync` only ships the resulting board, not the move list. So the
// hook reconciles against the board and splits the record in two:
//
//   inferred block  — stones recovered from a board render. The SET is exact,
//                     the ORDER within it is unknowable. Never scored; replayed
//                     only so that later positions are evaluated correctly.
//                     It normally LEADS the observed block, with one exception: a
//                     snapshot that is exactly one move ahead of us is the newest
//                     stone, so it goes at the tail and its own event can confirm it.
//   observed block  — moves actually seen arrive on the socket. Exact order,
//                     exact intervals.
//
// Telling a render apart from a move matters: a render is a *batch* of stones
// appearing with no socket event behind it, a move is a single one. While the socket
// is live we therefore never absorb a lone unexplained stone — that is a move whose
// event is still in flight, and the socket will report it.
(function () {
  if (window.__gmHook) return;
  window.__gmHook = true;

  var EV_EVENT = '__gm_event';   // hook -> content script (live notifications)
  var EV_REQ = '__gm_req';       // content script -> hook (ask for current record)
  var EV_RESP = '__gm_resp';     // hook -> content script (record reply)

  var BOARD_SIZE = 15;
  var BLACK = 1, WHITE = 2;
  var POLL_MS = 400;
  var EMPTY_RESET_MS = 1500;     // board empty this long => game really was reset

  var rec = null;

  // Player names survive a rematch: the reset handlers below rebuild `rec`, so the
  // names learned from the previous game-start are carried in here. Without this the
  // second game of a series would archive as "黑72/白85" with no names.
  var knownPlayers = { black: null, white: null };
  // 0.4.4 §九 — the seat IDS, carried across a rematch for the same reason.
  //
  // `game-start` ships `players[{ id, name, color }]` (the recon note in the comments below has
  // said so since 0.3.x) and this file used to keep only the NAME, throwing the id away. That is
  // precisely the field §9's socket level needs: `selfId` is an id, and an id cannot be compared
  // with a name — so the primary identification route was unreachable on the one payload the
  // spec names as its source, and a nameless guest could never be identified at all.
  var knownIds = { black: null, white: null };
  var knownRoom = null;

  function rememberPlayers(p) {
    if (!p) return;
    if (p.black) knownPlayers.black = p.black;
    if (p.white) knownPlayers.white = p.white;
  }

  function rememberIds(p) {
    if (!p) return;
    if (p.black != null) knownIds.black = p.black;
    if (p.white != null) knownIds.white = p.white;
  }

  function reset(reason) {
    rec = {
      moves: [],                 // ordered; inferred:true => order unknown
      ended: false,
      end: null,
      attached: false,
      startedAt: performance.now(),
      source: 'socket',
      reason: reason,
      serverMoveNumber: null,    // authoritative count from game-state-sync
      seedSource: null,          // 'server' | 'dom' | null
      dropped: 0,                // stones forgotten because the board lost them
      replayed: 0,               // duplicate events ignored (socket reconnect replays)
      players: { black: knownPlayers.black, white: knownPlayers.white },
      playerIds: { black: knownIds.black, white: knownIds.white },
      nameSource: knownPlayers.black || knownPlayers.white ? 'socket' : null,
      roomId: knownRoom,
      winner: null,
      draw: false,               // game ended with no winner (board full / agreement)
      // WHICH event name ended the game. The site has been observed to use several
      // (game-end / game-over / game-result), and "the game never ended" is exactly the
      // symptom of a name we do not listen to — so the name that did fire is kept, not
      // just the fact that one did.
      endEvent: null,
      // Session kind, from the socket's own payloads. Guest and spectator games behave
      // differently downstream (a guest game can end with none of the usual end channels),
      // and this is the only machine-readable source for it — the DOM badge is a guess by
      // comparison. See content.js's detectIdentity() for how the two are combined.
      guest: false,
      spectator: false,
    };
  }
  reset('init');

  function keyOf(m) { return m.row + ',' + m.col; }
  function inferredCount() {
    var n = 0;
    for (var i = 0; i < rec.moves.length; i++) if (rec.moves[i].inferred) n++;
    return n;
  }

  // ---------- board read (the MAIN world shares the page's DOM) ----------
  // 0.4.5 §一 — the selectors and the stone encoding now come from sites.js, which the manifest
  // injects into this same world ahead of hook.js. On gomoku.com that is exactly the
  // .board-intersection[data-row][data-col] / .stone.black-stone this used to hardcode; on
  // papergames.io it is a <table> of td.cell-<row>-<col> whose stone is an <svg class="symbol">
  // wrapping a circle-dark (black) / circle-light (white).
  //
  // `null` still means "no board here / not built yet" and `[]` means "empty", which is the
  // distinction absorbStones() and the empty-board watchdog are written against.
  //
  // A MISSING sites.js is a different thing entirely and must not look the same: the read
  // abstains, and since `null` is a legitimate answer the whole DOM-seeding path goes quiet —
  // every stone already on the board is simply never recorded, with no error anywhere. (That is
  // exactly what verify-midgame caught when its harness injected hook.js alone: 0 stones, no
  // throw.) Warn once so a packaging regression is visible instead of silent.
  var warnedNoSites = false;
  function readBoardDom() {
    if (typeof GMSites === 'undefined' || !GMSites) {
      if (!warnedNoSites) {
        warnedNoSites = true;
        console.warn('[detector] sites.js is not loaded in the MAIN world — board reads will abstain');
      }
      return null;
    }
    return GMSites.boardStones();
  }

  // ---------- reconciliation ----------
  // Absorb a board snapshot: everything we recorded that is still on the board is
  // kept, everything on the board we cannot account for goes into the inferred
  // block. Returns how many stones were absorbed.
  function absorbStones(stones, src) {
    var onBoard = {};
    for (var i = 0; i < stones.length; i++) onBoard[keyOf(stones[i])] = true;

    // Stones we recorded but the board no longer shows (reset / undo / new game).
    var kept = [];
    for (var j = 0; j < rec.moves.length; j++) {
      if (onBoard[keyOf(rec.moves[j])]) kept.push(rec.moves[j]);
      else rec.dropped++;
    }
    if (kept.length !== rec.moves.length) {
      // Keep the invariant that unknown-order stones lead the record.
      var inf = [], obs = [];
      for (var d = 0; d < kept.length; d++) (kept[d].inferred ? inf : obs).push(kept[d]);
      kept = inf.concat(obs);
    }
    rec.moves = kept;

    var have = {};
    for (var k = 0; k < rec.moves.length; k++) have[keyOf(rec.moves[k])] = true;

    var fresh = [];
    for (var q = 0; q < stones.length; q++) {
      if (!have[keyOf(stones[q])]) fresh.push(stones[q]);
    }
    if (!fresh.length) return 0;

    // Order inside the block is arbitrary by construction — it exists only so the
    // board replays correctly. Rule: colours alternate (black first, as the rules
    // require) and each colour is drawn in row-major order. That keeps the move
    // INDEX -> SIDE mapping correct for every move, including these, which is what
    // per-side aggregation needs.
    fresh.sort(function (a, b) {
      return (a.row - b.row) || (a.col - b.col) || (a.stone - b.stone);
    });
    var blacks = [], whites = [];
    for (var f = 0; f < fresh.length; f++) {
      if (fresh[f].stone === WHITE) whites.push(fresh[f]); else blacks.push(fresh[f]);
    }
    var block = [];
    while (blacks.length || whites.length) {
      if (blacks.length) block.push(blacks.shift());
      if (whites.length) block.push(whites.shift());
    }

    for (var b = 0; b < block.length; b++) {
      block[b].inferred = true;
      block[b].t = null;              // no timing information exists for them
      block[b].from = src;
    }
    // Where the block goes depends on WHICH snapshot this is.
    //
    // A `game-state-sync` that accounts for exactly "everything we already have + this one
    // stone" is a snapshot of the CURRENT position, so that stone is the newest move and
    // belongs AFTER the observed ones. Appending it is what makes its in-flight `move-made`
    // confirmable at all: the move-made handler below only takes a real timestamp for an
    // inferred stone with nothing observed after it, so a stone parked in the leading block
    // can never be confirmed. Before this, the snapshot's stone kept `t = null` forever and
    // the report told the operator it had no order when in fact the socket had just said so.
    //
    // The `block.length === 1` test is deliberate: with two or more fresh stones their order
    // relative to each other is unknown, and with a gap (`... !== serverMoveNumber`) the
    // snapshot may have reached back past moves we already observed — in both cases the
    // stones are not demonstrably the newest, so they keep leading the record.
    //
    // Everything else (a render, or a snapshot with a gap) reflects an earlier-or-equal
    // position, so the inferred block leads the observed one.
    var current = (src === 'server' && block.length === 1 &&
                   typeof rec.serverMoveNumber === 'number' &&
                   rec.moves.length + 1 === rec.serverMoveNumber);
    rec.moves = current ? rec.moves.concat(block) : block.concat(rec.moves);
    rec.seedSource = src;
    return block.length;
  }

  function countFresh(stones) {
    var have = {};
    for (var i = 0; i < rec.moves.length; i++) have[keyOf(rec.moves[i])] = true;
    var n = 0;
    for (var j = 0; j < stones.length; j++) if (!have[keyOf(stones[j])]) n++;
    return n;
  }

  // ---------- snapshot / emit ----------
  // Two moves of the same colour in a row cannot happen: black starts and play alternates.
  // Reported so the collector can warn while the game is still running.
  function orderIssues() {
    var n = 0;
    for (var i = 1; i < rec.moves.length; i++) {
      if (rec.moves[i].stone && rec.moves[i].stone === rec.moves[i - 1].stone) n++;
    }
    return n;
  }

  function snapshot() {
    var out = [];
    for (var i = 0; i < rec.moves.length; i++) {
      var m = rec.moves[i];
      out.push({
        row: m.row, col: m.col, stone: m.stone,
        // 0.4.1 §三.2: the ABSOLUTE performance.now(), not `m.t - rec.startedAt`.
        //
        // Two clocks stamp moves: this one, and content.js's own `performance.now()` for the
        // stones it reads off the board. Subtracting `startedAt` here put the socket's times
        // on a per-GAME origin (re-created on every reset) while the DOM's stayed on the
        // page's, so a difference taken across the two was meaningless. Emitting the raw
        // value puts both on the page's origin, and `clockNow` below lets content.js prove
        // it rather than assume it.
        t: (typeof m.t === 'number') ? Math.round(m.t) : null,
        inferred: !!m.inferred,
      });
    }
    return {
      source: 'socket',
      // When this snapshot was built, on THIS clock. content.js pairs it with its own
      // `performance.now()` to derive the offset between the two (they are two JS worlds of
      // one document, so the offset should be ~0 — but "should be" is exactly what a silent
      // clock disagreement would break).
      clockNow: Math.round(performance.now()),
      ended: rec.ended,
      end: rec.end,
      endEvent: rec.endEvent || null,
      attached: !!rec.attached,
      count: rec.moves.length,
      inferredCount: inferredCount(),
      seedSource: rec.seedSource,
      serverMoveNumber: rec.serverMoveNumber,
      dropped: rec.dropped,
      replayed: rec.replayed,
      orderIssues: orderIssues(),
      players: rec.players,
      // 0.4.4 §九 — the ids beside the names, so content.js can match `selfId` against a real
      // seat id instead of only against a display name. Same `{black, white}` shape.
      playerIds: rec.playerIds,
      nameSource: rec.nameSource,
      // 0.4.4 §九 — captured opportunistically; see takeSelfId(). null means "the site never told
      // us", which the content script treats as "fall back to DOM / anchor", never as "no one".
      selfId: rec.selfId == null ? null : rec.selfId,
      roomId: rec.roomId,
      winner: rec.winner,
      draw: !!rec.draw,
      guest: !!rec.guest,
      spectator: !!rec.spectator,
      moves: out,
    };
  }

  function emit(kind) {
    try {
      window.dispatchEvent(new CustomEvent(EV_EVENT, { detail: JSON.stringify({ kind: kind, data: snapshot() }) }));
    } catch (e) {}
  }

  // 0.4.4 §八 — chat rides on its own kind instead of inside `snapshot()`. It is not part of the
  // game record, it arrives far more often than a move, and folding it in would make every
  // listener re-parse the whole move list once per message.
  function emitChat(chat) {
    try {
      window.dispatchEvent(new CustomEvent(EV_EVENT, { detail: JSON.stringify({ kind: 'chat', chat: chat }) }));
    } catch (e) {}
  }

  window.addEventListener(EV_REQ, function (e) {
    try {
      window.dispatchEvent(new CustomEvent(EV_RESP, { detail: JSON.stringify({ rid: e.detail, data: snapshot() }) }));
    } catch (err) {}
  });

  // ---------- socket ----------
  function attach(sock) {
    rec.attached = true;

    ['game-start', 'game-reset', 'game-restart', 'rematch-start'].forEach(function (evt) {
      sock.on(evt, function () { reset(evt); emit('reset'); });
    });

    // ---- player names ----
    // Recon result (online.js): `game-start` ships `data.players = [{ id, name, color }]`
    // where color is 'black' | 'white', which is the ONLY place the name -> side mapping
    // exists. The DOM only ever shows "you" vs "opponent" with no colour attached, so it
    // is kept as a last-resort fallback in content.js rather than used here.
    //
    // The shape is normalised defensively: a payload has been seen as an array, and the
    // server may as easily send an object keyed by colour or two top-level fields. All
    // three are accepted, because a wrong guess here silently costs every game its names.
    // Guest / spectator flags, read off the same identity payloads the names come from.
    // Each spelling is a separate test because they are all guesses at a field name nobody
    // documented; a wrong guess costs only the label, and the label is what the record's
    // `meta.identity` exists for. Returns 'guest' | 'spectator' | null.
    function identityOf(d) {
      if (!d) return null;
      if (d.spectator || d.isSpectator || d.spectating || d.mode === 'spectator') return 'spectator';
      var arr = Array.isArray(d.players) ? d.players : [];
      var i;
      for (i = 0; i < arr.length; i++) {
        var p = arr[i] || {};
        if (p.spectator || p.isSpectator) return 'spectator';
      }
      if (d.guest || d.isGuest || d.accountType === 'guest' || d.userType === 'guest') return 'guest';
      for (i = 0; i < arr.length; i++) {
        var q = arr[i] || {};
        // Explicit flags only. "no account id" would be the other natural tell, but a
        // payload that simply omits the field would then label EVERY game a guest game —
        // a badge that is always on says nothing, so the heuristics stop at the flags.
        if (q.guest || q.isGuest || q.type === 'guest' || q.accountType === 'guest') return 'guest';
      }
      return null;
    }

    function takeNames(d) {
      var got = false;
      if (!d) return got;

      // (a) [{ id, name, color }]  — the shape recon confirmed
      //
      // 0.4.9 §一.3 wants this route to yield the opponent's USERNAME (`playerId`) for the local
      // blacklist, and it already does — the id is parked in `rec.playerIds[side]` below and
      // forwarded as `playerIds` in `snapshot()`. The spec spells the field `players.blackId` /
      // `players.whiteId`; that is the same fact under a different name, and writing it in both
      // places would be the 「three copies of one answer」 mistake this project has shipped three
      // times. `playerIds` is the copy that exists; content.js's `resolveOpponentId()` reads it.
      if (Array.isArray(d.players)) {
        for (var i = 0; i < d.players.length; i++) {
          var p = d.players[i];
          if (!p) continue;
          var nm = p.name || p.playerName || p.nickname || null;
          // 0.4.4 §九 — the id, under the spellings a server might use for it.
          var pid = p.id != null ? p.id
                  : (p.playerId != null ? p.playerId : (p.uid != null ? p.uid : null));
          var side = (p.color === 'black' || p.color === 1) ? 'black'
                   : ((p.color === 'white' || p.color === 2) ? 'white' : null);
          if (!side) continue;
          // A payload with an id but no name still counts as "got": §9 can identify the seat
          // from the id alone, and the guest case has no name to fall back on.
          if (nm) { rec.players[side] = nm; got = true; }
          if (pid != null) { rec.playerIds[side] = pid; got = true; }
        }
      }

      // (b) { players: { black, white } }
      if (!got && d.players && !Array.isArray(d.players) &&
          (d.players.black || d.players.white)) {
        rec.players.black = d.players.black || rec.players.black;
        rec.players.white = d.players.white || rec.players.white;
        got = true;
      }

      // (c) top level: { black: name, white: name }
      if (d.black || d.white) {
        rec.players.black = d.black || rec.players.black;
        rec.players.white = d.white || rec.players.white;
        got = true;
      }

      // A single-player update (rename / avatar refresh) restates one side.
      var one = d.playerName || d.name;
      if (!got && one && (d.playerColor === 'black' || d.playerColor === 'white')) {
        rec.players[d.playerColor] = one;
        got = true;
      }
      return got;
    }

    function onNames(evt) {
      return function (d) {
        if (!d) return;
        if (d.roomId) { rec.roomId = d.roomId; knownRoom = d.roomId; }
        var kind = identityOf(d);
        if (!takeNames(d) && !kind) return;
        if (kind) {
          if (kind === 'spectator') rec.spectator = true; else rec.guest = true;
        }
        if (rec.players.black || rec.players.white) rec.nameSource = 'socket';
        rememberPlayers(rec.players);
        rememberIds(rec.playerIds);
        emit('players');
      };
    }

    // Every event that has ever carried player identity. Cheap to listen to: `on()` on a
    // Socket.IO client is a no-op for events the server never sends.
    ['game-start', 'game-init', 'game-joined', 'rematch-start', 'player-info',
     'player-info-updated', 'players-updated'].forEach(function (evt) {
      sock.on(evt, onNames(evt));
    });

    // ---- 0.4.4 §九 level 1: which of the two seats is us ----
    // The recon note records that `game-start` ships `players = [{ id, name, color }]` but not
    // whether it also ships a `selfId`. Rather than guess, it is captured from ANY event that
    // carries one, and `null` is a legitimate answer — the content script then falls through to
    // the DOM and the announcement-anchor levels instead of blaming a random player.
    function takeSelfId(d) {
      if (!d) return false;
      var v = d.selfId != null ? d.selfId : (d.self && d.self.id);
      if (v == null) return false;
      if (rec.selfId === v) return false;
      rec.selfId = v;
      return true;
    }

    // ---- 0.4.4 §八: reading the opponent's chat ----
    // The socket carries a message BEFORE the DOM paints it and with the sender attached, so it
    // is the better source; the content script keeps a MutationObserver as the fallback for the
    // case where the site sends chat over a channel we did not guess. The event NAME is not
    // documented anywhere we can see, hence the list — subscribing to an event the server never
    // sends costs nothing on a Socket.IO client.
    var CHAT_EVENTS = ['chat-message', 'chat-msg', 'chat', 'message', 'new-message',
      'room-message', 'receive-message', 'chat-received'];

    function takeChat(d, evt) {
      if (!d) return;
      var text = typeof d === 'string' ? d
        : (d.text || d.message || d.content || d.msg ||
           (d.data && (d.data.text || d.data.message)) || null);
      if (typeof text !== 'string' || !text.replace(/\s+/g, '')) return;
      var from = d.from != null ? d.from
        : (d.sender != null ? d.sender
          : (d.userId != null ? d.userId : (d.playerId != null ? d.playerId : null)));
      emitChat({ text: String(text).slice(0, 500), fromId: from == null ? null : String(from), evt: evt });
    }

    function onChat(evt) { return function (d) { takeChat(d, evt); }; }

    CHAT_EVENTS.forEach(function (evt) { sock.on(evt, onChat(evt)); });

    // The same `onNames` list is where a selfId would ride along, so run it from there too.
    ['game-start', 'game-init', 'game-joined', 'rematch-start'].forEach(function (evt) {
      sock.on(evt, function (d) { if (takeSelfId(d)) emit('players'); });
    });

    sock.on('move-made', function (d) {
      if (!d || typeof d.row !== 'number' || typeof d.col !== 'number') return;
      var k = keyOf(d);
      // Already on record? Then this is not a new move. The judgement that matters is
      // whether we may CONFIRM the existing entry:
      //   * observed before -> nothing to do. (A reconnecting socket replays the whole
      //     history; re-stamping those would rewrite every interval to ~0ms and destroy
      //     the timing statistics the detector runs on.)
      //   * inferred, with nothing observed after it -> the snapshot got there first; take
      //     the real timestamp. This is the newest stone, so confirming it keeps the record
      //     in order. absorbStones() places a snapshot that is exactly one move ahead of us
      //     at the TAIL for this reason — a stone left in the leading block can never be
      //     confirmed, because every observed move sits after it.
      //   * inferred, but with observed moves after it -> a replay of an older move.
      //     Confirming it would move it out of the leading block and break the invariant
      //     the record's order depends on, so ignore it.
      for (var i = rec.moves.length - 1; i >= 0; i--) {
        if (keyOf(rec.moves[i]) !== k) continue;
        if (!rec.moves[i].inferred && typeof rec.moves[i].t === 'number') { rec.replayed++; return; }
        var trailing = true;
        for (var j = i + 1; j < rec.moves.length; j++) {
          if (!rec.moves[j].inferred) { trailing = false; break; }
        }
        if (!trailing) { rec.replayed++; return; }
        rec.moves[i].inferred = false;
        rec.moves[i].t = performance.now();
        emit('move');
        return;
      }
      rec.moves.push({ row: d.row, col: d.col, stone: d.stoneType, t: performance.now(), inferred: false });
      emit('move');
    });

    // A draw is the missing case in the original handler: the server can end a game with
    // `winner: null` (or the string 'draw'), and the old code stored that verbatim, so
    // everywhere downstream "no winner" was indistinguishable from "payload was empty and
    // the event never really fired". Normalising it here — `winner: null` plus an explicit
    // `draw: true` — is what lets the collector treat a drawn game as a finished game
    // instead of waiting forever for a winner that will never arrive.
    function isDrawWinner(w) {
      if (w == null) return true;
      if (typeof w === 'string') {
        var t = w.toLowerCase();
        return t === '' || t === 'draw' || t === 'tie' || t === 'none' || t === 'null';
      }
      return false;
    }
    function takeEnd(d, evt) {
      d = d || {};
      var winner = d.winner != null ? d.winner
                 : d.winnerColor != null ? d.winnerColor
                 : d.winColor != null ? d.winColor
                 : null;
      rec.ended = true;
      rec.draw = isDrawWinner(winner);
      rec.endEvent = evt || null;
      rec.end = {
        type: d.type || d.reason || d.result || (rec.draw ? 'draw' : 'unknown'),
        winner: winner,
        reason: d.reason || d.type || null,
        event: evt || null,
      };
      rec.winner = rec.draw ? null : winner;
      emit('end');
    }
    // Draws have been reported under their own event name on other sockets; attach the
    // same handler so an unfamiliar spelling still closes the game.
    // `game-finished` / `match-end` are not used by gomoku.com today (its online.js only
    // listens to `game-end`) — they are kept because "the game never ended" is the exact
    // symptom of a name we do not listen to, and the cost of an extra no-op listener is 0.
    // `spectate-game-end` IS real, but only on the 观战 page, whose spectate.js keeps its
    // socket in a closure and never sets `window.socket` — so this hook cannot attach
    // there; it is listed for the day that changes.
    ['game-end', 'game-over', 'game-ended', 'game-draw', 'game-result',
     'game-finished', 'match-end', 'spectate-game-end'].forEach(function (evt) {
      sock.on(evt, function (d) { takeEnd(d, evt); });
    });

    // ---- endings that never announce themselves ----
    // online.js has several paths that set its OWN `gameActive = false` and stop the clock
    // without ever emitting `game-end`:
    //   * player-disconnected                      -> showPlayerDisconnected()
    //   * player-disconnected { noContest: true }  -> "this game will not count"
    //   * resume-failed                            -> the room was reclaimed while away
    // Guest games hit the first two constantly (anonymous opponents abandon mid-game), and
    // the detector then sat at 采集中 forever with no report — the 场景② symptom. The one
    // case that must NOT be read as an ending is a disconnect that carries `forfeitInSec`:
    // the server is then holding the seat and the opponent may still return, which
    // `player-reconnected` confirms.
    //
    // Recorded as an abandonment, not a draw: nobody won, and calling it 和棋 would be a
    // different lie from calling it 未知 (`meta.outcome` stays 'unknown').
    function takeAbandon(evt, reason) {
      if (rec.ended) return;
      rec.ended = true;
      rec.draw = false;
      rec.winner = null;
      rec.endEvent = evt || null;
      rec.end = { type: 'abandoned', winner: null, reason: reason || null, event: evt || null };
      emit('end');
    }

    sock.on('player-disconnected', function (d) {
      d = d || {};
      if (typeof d.forfeitInSec === 'number' && d.forfeitInSec > 0) return;   // seat held
      takeAbandon('player-disconnected', d.noContest ? 'no-contest' : 'opponent-left');
    });
    sock.on('resume-failed', function () { takeAbandon('resume-failed', 'resume-failed'); });

    // Authoritative board. This is what a joining spectator receives, and it is the
    // only channel that reports the true move count without a move list.
    sock.on('game-state-sync', function (d) {
      if (!d || d.code !== 'OK' || !Array.isArray(d.board)) return;
      if (typeof d.moveNumber === 'number') rec.serverMoveNumber = d.moveNumber;
      var stones = [];
      for (var r = 0; r < BOARD_SIZE; r++) {
        var rowv = d.board[r];
        for (var c = 0; c < BOARD_SIZE; c++) {
          var v = (rowv && rowv[c]) || 0;
          if (v) stones.push({ row: r, col: c, stone: v });
        }
      }
      if (!stones.length) return;
      if (absorbStones(stones, 'server') > 0) emit('seed');
    });

    emit('attached');
  }

  // Watchdog for the board while the socket is live: covers a game-state-sync that
  // never arrives, and notices a board that was cleared without a reset event.
  var emptySince = 0;
  function pollBoard() {
    var stones = readBoardDom();
    if (!stones) return;

    if (!stones.length) {
      if (rec.moves.length) {
        var now = performance.now();
        if (!emptySince) emptySince = now;
        else if (now - emptySince > EMPTY_RESET_MS) { emptySince = 0; reset('empty-board'); emit('reset'); }
      }
      return;
    }
    emptySince = 0;

    var fresh = countFresh(stones);
    // Nothing recorded yet: this is the whole pre-existing board -> seed it.
    // Otherwise only a batch means a render; a lone new stone is a move the socket
    // is about to report, and absorbing it would lose its real timestamp.
    if (!rec.moves.length || fresh >= 2) {
      if (absorbStones(stones, 'dom') > 0) emit('seed');
    }
  }

  // online.js builds the socket inside its own DOMContentLoaded handler, so we poll.
  //
  // 0.4.5 §一 — a site that does not put its socket on the page declares `watchSocket: false` and
  // this loop never starts. papergames.io is that site: the recon caught its Socket.IO handshake
  // (`wss://papergames.io/socket.io/?EIO=4&transport=websocket`) but the client lives inside an
  // Angular service, so `window.socket` and `window.io` are both undefined and there is nothing
  // here to attach to. Polling for two minutes to attach to nothing is pure noise, and DOM
  // collection carries that site on its own. A missing GMSites keeps the old behaviour.
  var watchSocket = true;
  try {
    if (typeof GMSites !== 'undefined' && GMSites && GMSites.current()) {
      watchSocket = GMSites.current().watchSocket !== false;
    }
  } catch (e) { watchSocket = true; }
  if (!watchSocket) return;

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var s = window.socket;
    if (s && typeof s.on === 'function') {
      clearInterval(timer);
      try { attach(s); } catch (e) { emit('error'); }
      // Seed immediately: if the board was drawn before we attached, the first poll
      // is what recovers the moves we never saw.
      try { pollBoard(); } catch (e) {}
      setInterval(function () { try { pollBoard(); } catch (e) {} }, POLL_MS);
      return;
    }
    if (tries > 600) clearInterval(timer); // ~2 min, then give up (single-player has no socket)
  }, 200);
})();
