/* sites.js — the per-site adapter layer (0.4.5 §一).
 *
 * Everything site-specific lives here: URL matching, the board DOM, the stone encoding, the chat
 * field, the end-of-game hints, and whether the socket is worth watching. `content.js` and
 * `hook.js` keep every line of the recording / analysis / archive pipeline and only ask this file
 * "what does the board look like on this host?".
 *
 * Loaded in BOTH worlds: `hook.js` runs in the page's MAIN world at document_start and needs the
 * same config, so the manifest lists this file before `hook.js` (MAIN) and before `content.js`
 * (isolated). One config, two consumers — a second copy would be the thing that drifts.
 *
 * WHY THE CONFIG IS A LIST OF FULL SELECTORS rather than the `boardRoot` + `cellSel` composition
 * the spec sketched: `boardCells()` and `findGrid()` have to keep answering with EXACTLY the same
 * element they do today on gomoku.com (a MutationObserver is attached to `findGrid()`'s result, so
 * a different element changes which subtree is watched). An ordered list of full selectors
 * reproduces today's four-step fallback literally; composing a root and a cell class cannot.
 */
(function (g) {
  'use strict';
  if (g.GMSites) return;

  // Every supported board is 15x15, and the whole pipeline (SIZE / COL / coordToShare) assumes
  // it. Kept here as well as in app.js because cellRC needs it in BOTH worlds, and app.js is not
  // loaded into the MAIN world. Declared before SITES because the configs below close over it.
  var SIZE = 15;

  var SITES = {
    gomoku: {
      id: 'gomoku',
      label: 'gomoku.com',
      hostRe: /^(www\.)?gomoku\.com$/,
      isRenju: function () { return /\/renju/i.test(location.pathname); },

      // online.js builds .board-intersection[data-row][data-col] cells and appends a single
      // .stone.black-stone | .stone.white-stone child to the played ones. Most specific first:
      // the play page's container, the 观战 page's (a separate document with its own
      // spectate.js), any grid container, then the bare intersection class.
      cellsSel: [
        '#online-player-board .board-intersection',
        '#spectate-board .board-intersection',
        '.board-grid-container .board-intersection',
        '.board-intersection',
      ],
      gridSel: [
        '#online-player-board .board-grid-container',
        '#spectate-board .board-grid-container',
        '.board-grid-container',
        '.spectator-board .board-grid-container',
      ],
      stoneSel: '.stone',
      stoneIsBlack: function (el) { return el.classList.contains('black-stone'); },
      stoneIsWhite: function (el) { return el.classList.contains('white-stone'); },
      // gomoku.com's class names ARE gomoku colours (black-stone / white-stone), so the class
      // decides. See `colourFromOrder` in boardStones() for the other kind of site.
      colourFromOrder: false,
      emptyCellCls: null,
      // data-row counts UP from the bottom (row 0 = share A1); app.js's y counts DOWN from the
      // top and `toRecord` does `14 - row`. See the note on papergames' cellRC below.
      cellRC: function (cell) {
        return { row: parseInt(cell.dataset.row, 10), col: parseInt(cell.dataset.col, 10) };
      },

      // Identical to content.js's old CHAT_INPUT_SEL, in the same order — this list is the
      // behaviour being preserved, not a new guess.
      chatInput: [
        '#chat-input',
        '.chat-input',
        '[class*="chat"] textarea',
        '[class*="chat"] input[type="text"]',
        '[contenteditable="true"][class*="chat"]',
        'textarea[placeholder*="hat"]',
        'input[placeholder*="hat"]',
      ],
      endOverlays: ['.game-end-overlay', '.game-draw-overlay', '.game-result-draw'],
      // The board stays on screen after the game ends, so an empty board is NOT an ending here.
      endOnBoardGone: false,
      watchSocket: true,

      // ---- 0.4.9 §一.3: the player-username routes ----
      //
      // §1.2 is the whole reason these exist: the blacklist must key on the USERNAME
      // (`playerId` — stable, unique, uneditable), not the display name. §一.3 gives three
      // routes and the spec is explicit that the first two still need F12 confirmation on the
      // GAME page (the profile page's `<meta name="playerId">` was confirmed; the game page's
      // was not). They are listed here rather than in content.js so that a correction is one
      // edit in one file — the 0.4.5 rule.
      //
      // `playerMeta` is read by `readPlayerMeta()` on whatever page the operator is on. NOTE,
      // and content.js guards on this: a meta pair on a GAME page most plausibly describes the
      // LOGGED-IN user, since the page is rendered per session. The pair is therefore only
      // attributed to the opponent when its display name actually matches the opponent's —
      // otherwise a blacklist click would block the operator themselves.
      playerMeta: {
        id: ['meta[name="playerId"]', 'meta[name="player-id"]', 'meta[property="og:playerId"]'],
        name: ['meta[name="displayName"]', 'meta[name="display-name"]',
               'meta[name="playerName"]', 'meta[property="og:playerName"]'],
      },
      // The `/zh-cn/profile/<username>` route. Anchored on the path segment, not the host, and
      // the capture stops at `/` or `?` so a query string cannot become part of the id.
      profileUrlRe: /\/profile\/([^\/?#]+)/,
    },

    papergames: {
      id: 'papergames',
      label: 'papergames.io',
      hostRe: /^(www\.)?papergames\.io$/,
      // No renju mode. The operator can still pin 连珠 by hand from the panel's ⚙ menu (0.4.5 §二),
      // which is what `settings.rule` exists for.
      isRenju: function () { return false; },

      // ---- verified live against papergames.io on 2026-09-29 (recon-papergames-*.cjs) ----
      // Angular + Angular Material. The board is a real <table class="table-board"> of
      // 15x15 = 225 cells, each `td.cell-<row>-<col>` where row 0 is the TOP row and col 0 the
      // LEFT column (a table renders top-down). `.clickable` marks an empty/legal cell, so it
      // disappears once a cell is played.
      cellsSel: [
        'table.table-board td[class*="cell-"]',
        'td[class*="cell-"]',
      ],
      gridSel: ['table.table-board'],
      // A played cell holds exactly one <svg class="symbol"> wrapping one <circle>, and the
      // circle's class is the ONLY colour signal:
      //   circle-dark  fill #2C3E50 (dark navy) — the BLACK stone
      //   circle-light fill #18BC9C (teal)      — the WHITE stone
      // Which is which was settled by play, not by the class name: with the probe never clicking,
      // the robot opened on the centre point and its stone was `circle-dark`, and in gomoku the
      // side that moves first is black. (The "white" stone really is teal — that is this site's
      // palette, not a second black.)
      stoneSel: 'svg.symbol',
      stoneIsBlack: function (el) {
        var c = el.querySelector ? el.querySelector('circle') : null;
        return !!c && c.classList.contains('circle-dark');
      },
      stoneIsWhite: function (el) {
        var c = el.querySelector ? el.querySelector('circle') : null;
        return !!c && c.classList.contains('circle-light');
      },

      // ---- 0.4.5 §一, two corrections the live site forced (see the notes below) ----
      //
      // (a) `.clickable` means EMPTY. papergames renders a mouse-hover PREVIEW as
      //     `svg.symbol > circle.circle-light` on the cell under the cursor — the same markup a
      //     real white stone has — and the cell keeps `.clickable` while it does. Verified: with
      //     the cursor parked on an empty cell, the first version of boardStones() returned
      //     `[{row:14,col:0,stone:2}]` for a board that was actually empty, and `[]` as soon as
      //     the cursor moved off. A phantom stone anywhere the mouse rests is a corrupted move
      //     list, so a cell that still carries `.clickable` is skipped outright. Real stones lose
      //     the class (verified on cell-5-3 / cell-8-6 after being played).
      //
      // (b) The circle class is the PLAYER's colour, not a gomoku colour. `circle-light` is the
      //     human's badge colour and `circle-dark` is the robot's (read off the site's own two
      //     `circle.shape` badges, which sit in each player's row), and the board renders each
      //     stone in its owner's badge colour. But WHO MOVES FIRST IS NOT FIXED: sampling both
      //     clocks every second showed the robot opening on 7-7 with its own clock running
      //     (robot 04:59 / us 05:00), and in other sessions an empty board with OUR clock running
      //     (us 04:58 / robot 05:00) — the ticking clock is the side on the move, so the site
      //     really does hand the first move to either colour. A fixed `dark => black` mapping is
      //     therefore wrong in roughly half of all sessions, and it fails SILENTLY: a record with
      //     black and white swapped analyses perfectly well and means nothing.
      colourFromOrder: true,
      emptyCellCls: 'clickable',
      // papergames numbers rows from the TOP, gomoku.com from the BOTTOM, and everything
      // downstream is written against gomoku's convention: `toRecord` stores `14 - row` and
      // app.js's y is 0 at the top (`shareToCoord`: "y:0=top -> number = SIZE - y"). So the row
      // has to be flipped here, once, or every archived papergames game is mirrored — and a
      // mirrored board is not a visibly broken one, just a silently wrong analysis.
      cellRC: function (cell) {
        var m = /cell-(\d+)-(\d+)/.exec(String(cell.className));
        if (!m) return { row: null, col: null };
        return { row: (SIZE - 1) - parseInt(m[1], 10), col: parseInt(m[2], 10) };
      },

      // <textarea placeholder="Write a message..." aria-label="Write a message...">. Angular
      // Material's DefaultValueAccessor listens for `input`, so the existing native-setter +
      // input-event send path works unchanged (confirmed by writing to it live).
      chatInput: [
        'textarea[placeholder*="message" i]',
        'textarea[aria-label*="message" i]',
        '[class*="chat"] textarea',
        '[class*="chat"] input[type="text"]',
      ],

      // ---- player names, verified live 2026-09-29 (recon-046-*.cjs) ----
      //
      // The spec proposed `.player-black .player-name`, `[data-color="black"] .name`, `#player-name`,
      // `#opponent-name` and friends. NONE of them exist on this site — every one would fail, and
      // the failure is silent (the archive just keeps saying "unnamed game"). What is really there:
      //
      //   <app-room-players><div class="container players-container"><div class="row">
      //     <div class="col-6 ...">            <- side A, ALWAYS circle-light
      //       <app-player-symbol><svg><circle class="shape circle-light" r="35">
      //       <div class="... d-flex flex-column text-end">
      //         <span class="text-truncate cursor-pointer">NAME</span>
      //     <div class="col-6 ... flex-row-reverse">   <- side B, ALWAYS circle-dark
      //       ... same shape, no `text-end`, mirrored
      //
      // TWO facts had to be established by playing, and both kill the obvious implementation:
      //
      //  (a) THE COLUMN ORDER IS THE SIDE, NOT US. col-6 #0 is always `circle-light` and #1 always
      //      `circle-dark` — but which of the two is the local player VARIES. In three robot games
      //      our nick sat in #0; against a human opponent it sat in #1 with the opponent in #0.
      //      So "first name = self" (the spec's `pair` route) is wrong in exactly the human games,
      //      and wrong SILENTLY: "A VS B" with the two names swapped reads perfectly well.
      //  (b) The circle class is the SIDE colour, not a gomoku colour (see `colourFromOrder`), so
      //      it cannot be turned into black/white either. The two names are therefore recorded as
      //      self/opponent — a claim we can actually support — and NOT as black/white.
      //
      // The one reliable "which of these is me" signal on the page is the ACCOUNT MENU in the
      // sidebar, which shows our own nickname. Its box is 0x0 while the sidebar is collapsed, but
      // the text is in the DOM, which is all a name read needs.
      //
      // VERIFIED live (2026-09-29, probe-046-selfname*): the menu is
      //   app-user-menu > button > span.mdc-button__label > span.user-profile
      //     > div.name-credit > [ div (the nickname), div.credit ("2000" + a coin icon) ]
      // and the trap is that EVERY ancestor's `textContent` is polluted — `app-user-menu`,
      // `span.user-profile` and `div.name-credit` all read "detectorprobe 2000", nickname AND
      // credit balance. Only the nickname's own div holds the bare name, so `selfName` must stay
      // on that one; matching against an ancestor would compare "detectorprobe 2000" against
      // "detectorprobe" and silently fail to orient the pair. (`:not(.credit)` rather than
      // `:first-child` so a reordered template still resolves.) The menu exists only INSIDE a
      // room — the lobby has no `app-user-menu` at all — which is fine, since the pair is only
      // readable in a room either.
      playerNameSel: {
        // The two sides, in DOM order. Read as a PAIR — a half-filled pair would put a name on
        // the wrong side, which is what the archive title then prints.
        pair: 'app-room-players .col-6 span.text-truncate',
        // Our own nickname, from the account menu. Used only to decide which of the pair is us.
        // Order matters: the bare-name div first, and NO polluted-ancestor fallback — an
        // ancestor can never match, so listing one would only look like a working fallback.
        selfName: ['app-user-menu .name-credit > div:not(.credit)',
                   '.name-credit > div:not(.credit)',
                   'app-user-menu .user-profile .name-credit > div:not(.credit)'],
        // Deliberately empty: this site carries no colour on a player's name anywhere, so a
        // black/white or in-row self/opponent selector would be a guess that silently mismatches.
        black: [],
        white: [],
        self: [],
        opponent: [],
      },
      // No end overlay is listed on purpose. The one dialog the recon could reach is
      // `app-confirm-leave-dialog` — the ABORT confirmation ("Are you sure you want to
      // continue?"), which is not an ending — and the real result dialog could not be observed
      // without playing a full game. Guessing a class here would be worse than listing none:
      // `endProbe()`'s generic 「再来一局 / play again / draw」 scan is site-agnostic and already
      // covers a result dialog, and `endOnBoardGone` below covers the ending structurally.
      endOverlays: [],
      // VERIFIED: when a papergames game ends the board is torn down and the app returns to the
      // lobby — after aborting, `td[class*=cell-]` went from 225 to 0 and the URL was back at
      // /en/gomoku. So a board that has DISAPPEARED while we still hold a live record is the
      // ending. (gomoku.com keeps its board on screen, hence false there.)
      endOnBoardGone: true,
      // ---- 0.4.9 §一.3 ----
      // Deliberately absent, and the spec says so: neither the meta tags nor the profile URL
      // shape have been confirmed on this site (its player rows carry no id on the DOM at all —
      // see playerNameSel below). An invented selector here would not fail loudly; it would
      // quietly block whoever happened to match. `resolveOpponentId()` reads both fields
      // defensively (`|| []` / null), so an absent config means "this route does not exist
      // here", and on papergames the socket level is absent too (watchSocket: false), leaving
      // the blacklist button correctly greyed out rather than wrong. Confirming them is the same
      // F12 job §六 asks for on gomoku.com.
      //
      // Stage 1 (0.4.5 §1.2): DOM only. The site DOES use Socket.IO — the recon caught
      // `wss://papergames.io/socket.io/?EIO=4&transport=websocket` — but it does not expose
      // `window.io` or `window.socket`, so hook.js cannot attach to it the way it does on
      // gomoku.com. Stage 2 would have to patch `window.WebSocket` instead of reading a global.
      watchSocket: false,
      socketEvents: {
        move: 'move-made',
        end: ['game-end', 'game-over', 'game-ended'],
        start: ['game-start', 'game-reset'],
        names: ['game-start', 'player-info'],
        sync: 'game-state-sync',
      },
    },
  };

  // Every supported board is 15x15, and the whole pipeline (SIZE / COL / coordToShare) assumes
  // it. Kept here as well as in app.js because cellRC needs it in BOTH worlds, and app.js is not
  // loaded into the MAIN world.
  function current() {
    var host = location.hostname;
    for (var k in SITES) {
      if (SITES[k].hostRe.test(host)) return SITES[k];
    }
    return null;
  }

  function boardCells() {
    var site = current();
    if (!site) return [];
    for (var i = 0; i < site.cellsSel.length; i++) {
      var cells = document.querySelectorAll(site.cellsSel[i]);
      if (cells.length) return cells;
    }
    return [];
  }

  function findGrid() {
    var site = current();
    if (!site) return null;
    for (var i = 0; i < site.gridSel.length; i++) {
      var el = document.querySelector(site.gridSel[i]);
      if (el) return el;
    }
    // A wrapper we do not recognise still has the cells as its children — the intersections ARE
    // the board, so their parent is the honest last resort.
    var cells = boardCells();
    return cells.length ? cells[0].parentNode : null;
  }

  function isRenju() {
    var site = current();
    return site ? site.isRenju() : false;
  }

  // Which circle class is black, for sites whose classes are PLAYER colours rather than gomoku
  // colours (see `colourFromOrder` in the papergames config).
  //
  // The rule is gomoku's own invariant, not the site's: black moves first, so on any legal board
  // count(black) is either equal to count(white) or exactly one greater. Whichever colour has
  // more stones IS black — no class name involved. Counts are equal only right after white has
  // replied, where they cannot decide it, so the answer is cached: the first snapshot with an
  // unequal count settles the mapping, and every later snapshot reuses it. Each unequal snapshot
  // overwrites the cache, so a new game — whose first mover may be the other colour — re-resolves
  // as soon as one colour has a stone more than the other, which is the case immediately after
  // black's opening move.
  var colourCache = { blackIsDark: null };

  function resolveBlackIsDark(dark, light) {
    if (dark !== light) {
      colourCache.blackIsDark = dark > light;
      return colourCache.blackIsDark;
    }
    // Equal counts: black has moved and white has just replied, so this snapshot cannot say which
    // colour black is. Reuse the last resolution; failing that there is nothing honest left but
    // the site's own "dark" stone.
    if (colourCache.blackIsDark != null) return colourCache.blackIsDark;
    return true;
  }

  /** The board's stones, in the collector's shape. 1 = black, 2 = white, 0 = empty/unknown. */
  function boardStones() {
    var site = current();
    if (!site) return null;
    var cells = boardCells();
    if (!cells.length) return null;

    // Pass 1: the stones, each tagged with the site's own colour, so the black/white mapping can
    // be resolved from the whole board before anything is labelled.
    var found = [];
    var dark = 0, light = 0;
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      // A cell the site still calls empty carries a hover preview, not a stone.
      if (site.emptyCellCls && cell.classList && cell.classList.contains(site.emptyCellCls)) continue;
      var st = cell.querySelector(site.stoneSel);
      if (!st) continue;
      var isB = site.stoneIsBlack(st);
      var isW = !isB && site.stoneIsWhite(st);
      if (!isB && !isW) continue;
      var rc = site.cellRC(cell);
      if (rc.row == null || rc.col == null || isNaN(rc.row) || isNaN(rc.col)) continue;
      if (isB) dark++; else light++;
      found.push({ row: rc.row, col: rc.col, dark: isB });
    }
    if (!found.length) return [];

    // Pass 2: label them. `dark`/`light` so far are the SITE's colours; on a `colourFromOrder`
    // site the count rule decides which of the two is gomoku's black.
    var blackIsDark = site.colourFromOrder ? resolveBlackIsDark(dark, light) : true;
    var out = [];
    for (var j = 0; j < found.length; j++) {
      out.push({ row: found[j].row, col: found[j].col, stone: found[j].dark === blackIsDark ? 1 : 2 });
    }
    return out;
  }

  /** The chat field, best selector first. Null when the site has none on this page. */
  function chatInputEl() {
    var site = current();
    if (!site) return null;
    for (var i = 0; i < site.chatInput.length; i++) {
      var el = document.querySelector(site.chatInput[i]);
      if (el) return el;
    }
    return null;
  }

  // ---- 0.4.9 §一.3: the two page-level username routes ----
  // Both are site configuration, so both are answered HERE and nowhere else. content.js keeps the
  // decision (which route wins, and whether the answer may be attributed to the opponent); this
  // file only knows what the page looks like.

  /** The `<meta name="playerId"> / <meta name="displayName">` pair, or {id:null,name:null}. */
  function playerMeta() {
    var out = { id: null, name: null };
    var site = current();
    if (!site || !site.playerMeta) return out;
    var first = function (sels) {
      if (!sels) return null;
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        // `getAttribute('content')` rather than `.content`: the property exists only on a real
        // HTMLMetaElement, and a namespaced/unexpected tag would otherwise throw a TypeError
        // inside a page we do not control.
        var v = el && el.getAttribute ? el.getAttribute('content') : null;
        if (v != null && String(v).trim()) return String(v).trim();
      }
      return null;
    };
    out.id = first(site.playerMeta.id);
    out.name = first(site.playerMeta.name);
    return out;
  }

  /** The username out of `/xx/profile/<username>`, or null. */
  function profileId(url) {
    var site = current();
    if (!site || !site.profileUrlRe) return null;
    var m = site.profileUrlRe.exec(String(url == null ? '' : url));
    if (!m || !m[1]) return null;
    var s = String(m[1]).trim();
    // A profile URL ends in the username; a trailing slash or a stray path segment is not one.
    return s ? decodeURIComponent(s) : null;
  }

  g.GMSites = {
    current: current,
    boardCells: boardCells,
    findGrid: findGrid,
    isRenju: isRenju,
    boardStones: boardStones,
    chatInputEl: chatInputEl,
    playerMeta: playerMeta,
    profileId: profileId,
    SIZE: SIZE,
    list: SITES,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
