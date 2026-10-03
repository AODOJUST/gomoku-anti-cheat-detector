/* probes.js — 0.5.7-Alpha 探针匹配: the built-in probe library and its matcher.
 *
 * A probe is a LOCAL tactical motif, not a whole-board position. That is the one design decision
 * this file makes, and it is forced: a hand-authored 15×15 position has essentially zero chance of
 * ever occurring in a real game (gomoku positions are astronomically many), so a whole-board library
 * would make 探针匹配 structurally 0 — the exact failure `无用冲四` shipped with from 0.4.7 to 0.5.6
 * (see app.js's `markFourRuns` header). A motif matches wherever it occurs.
 *
 * A motif is written in terms of TWO roles, never absolute colours, because gomoku is colour-
 * symmetric: `T` is the THREATENER (the opponent, from the player's point of view) and the player
 * under judgement is whoever is not `T`. The matcher binds `T` to the real colour, so one motif
 * covers both sides of every game.
 *
 * ── 0.5.7-Alpha: the motif changed, the structure did not ───────────────────────────────────────
 *
 * 0.5.7 encoded family ① as a 冲四 — four `T` stones in a clear 5-cell window — and the machine's
 * move was the window's one empty cell. 0.5.7-Alpha replaces it with the **四三杀** shape:
 *
 *   · a four  (`T` stones in a 5-cell window with one gap) on ONE line, AND
 *   · an independent `_XXX_` open three on ANOTHER line,
 *   · the two lines chosen so the four's five-point and the three's two live-four points do NOT
 *     coincide — otherwise blocking the four would also break the three and the motif would not be
 *     a 四三杀 at all.
 *
 * `machine` is still the four's one gap: a shallow search answers the immediate five, which is the
 * whole reason the shape is worth probing.
 *
 * WHY THE CHANGE. 0.5.7's 冲四 motif and its `noBlunder` were THE SAME MEASUREMENT (see the ⚠ at the
 * bottom of this header), so the two weights sat on one signal. 0.5.7-Alpha retired that signal and
 * re-pointed this library at a shape that needs the defender to see two lines at once.
 *
 * ⚠⚠ MEASURED, AND IT MATTERS: 「本方持有四 + 活三」 occurs on only **0.38%** of analysed hands in the
 * operator's 65-archive corpus (4 hands of 1040), against 15% for the old 冲四 library. So this
 * library matches almost nothing, and `probeMatch`'s weight was set to **0** in the same release
 * (see app.js BASE_WEIGHTS note 2). The library is kept correct and loaded rather than deleted —
 * `scoreStep` still stamps `probeSeen`/`probeHit`, the panel still has its row, and the day a corpus
 * contains these positions the term is one weight change away from being live again.
 *
 * ── What is in here, and what is NOT ────────────────────────────────────────────────────────────
 *
 * §1.3③ names three families. Measured against what the detector can actually decide:
 *
 *   · 唯一防守点 — ENCODED, as the 四三杀 shape above. Ten canonical shapes — the four's gap at each
 *     of its five window positions, written once along `x` and once along the diagonal — × the
 *     matcher's eight symmetries = 80 oriented probes. (Both base directions are needed: the eight
 *     square-lattice symmetries never map an axis to a diagonal. See the note on the library.)
 *
 *   · 双威胁选择 — NOT ENCODED, and the reason is not effort. `expectedMachine` is defined as 「浅层
 *     搜索会选的挡点」 — the move a SPECIFIC web engine picks. That is not derivable from the board;
 *     it is a property of playgomokuonline's Minimax at some depth, and any value this file invented
 *     for it would be a guess wearing the costume of data. It becomes encodable the day someone
 *     records one: run the positions through the site's strongest level, store the reply, and add
 *     them here in the same format.
 *
 *   · 败势顽抗 — NOT ENCODED, for the same reason plus a second one: 「败势」 is a judgement about the
 *     position's VALUE, which needs the engine, and the family's whole content is "which move does a
 *     shallow engine choose when lost" — again an engine property, not a board property.
 *
 * ⚠ HISTORICAL, kept because it explains 0.5.7-Alpha: under 0.5.7 every 冲四 has exactly one blocking
 * point, so family ①'s `probeHit` was true on precisely the hands `noBlunder` counted as answered
 * and its `probeSeen` on precisely the hands `noBlunder` counted as threats. Measured on the same 65
 * archives / 127 sides the two moved together, and the two weights (0.12 + 0.15) sat on ONE
 * measurement — a finding rather than a bug, and the reason both were retired together.
 */
(function (root) {
  'use strict';

  var SIZE = 15;   // app.js's board size. Mirrored rather than imported: this file is loaded on its
                   // own by the suite and by any harness that only wants the matcher.

  // ---- the library -------------------------------------------------------------------------
  //
  // `stones`  — [dx, dy, role] with role 'T' (the threatener). All of a motif's stones are `T`; the
  //             player is the other colour by construction. A 四三杀 motif has SEVEN: the four's
  //             four, plus the three's three.
  // `window`  — the cells that must be EXACTLY as the motif says: every listed cell is either a
  //             `stones` entry or required empty. This is what keeps a motif from matching a
  //             different position that merely happens to contain the same stones somewhere else.
  //             A 四三杀 window has TEN cells: the four's 5-cell window, plus the three's 3 stones
  //             and its TWO open ends. ⚠ The ends must be listed — leaving them out would let the
  //             motif match a 眠三, which is not a 四三杀 threat at all.
  // `machine` — where the shallow search plays, in the same relative coordinates. For a 四三杀 that
  //             is the FOUR's one gap: the immediate five is what a one-ply search answers.
  // `human`   — the beginner's common error. `null` means "any point other than `machine`", which is
  //             the honest description for a forced block: there is nothing else to do, so every
  //             other move is the error. ⚠ For the 四三杀 shape the interesting error is 「只堵四」,
  //             and `null` cannot express it — see the family note above; it is not encodable
  //             without a recorded engine, so it is not guessed at here.
  //
  // ⚠ WHY EACH GAP POSITION APPEARS TWICE (once along `x`, once along `x = y`). The eight symmetries
  // below are the isometries of the SQUARE LATTICE, and they map the horizontal axis to the vertical
  // and the two diagonals to each other — but never an axis to a diagonal. So an axis-aligned motif
  // can only ever match a horizontal or vertical line, and a diagonal four would go unrecognised.
  // Two base directions × five gap positions = the ten canonical shapes, and the symmetries then
  // cover all four line directions. (Under the 0.5.7 冲四 library the axis-only half matched 90 of
  // the 1084 analysed hands and the diagonal half took it to 167, 8% → 15%.)
  var PROBES = [
    // ---- the four along `x` (y = 0), the open three along `x` three rows down (y = 3) ----
    // The three sits at (0..2, 3) with both ends empty, i.e. `_XXX_`. Its live-four points are
    // (-1,3) and (3,3); the four's five-point is the gap below. They never coincide.
    { id: 'probe-fourthree-block-01', family: 'fourThreeBlock',
      stones: [[1, 0, 'T'], [2, 0, 'T'], [3, 0, 'T'], [4, 0, 'T'],
               [0, 3, 'T'], [1, 3, 'T'], [2, 3, 'T']],
      window: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
               [-1, 3], [0, 3], [1, 3], [2, 3], [3, 3]],
      machine: [0, 0], human: null },
    { id: 'probe-fourthree-block-02', family: 'fourThreeBlock',
      stones: [[0, 0, 'T'], [2, 0, 'T'], [3, 0, 'T'], [4, 0, 'T'],
               [0, 3, 'T'], [1, 3, 'T'], [2, 3, 'T']],
      window: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
               [-1, 3], [0, 3], [1, 3], [2, 3], [3, 3]],
      machine: [1, 0], human: null },
    { id: 'probe-fourthree-block-03', family: 'fourThreeBlock',
      stones: [[0, 0, 'T'], [1, 0, 'T'], [3, 0, 'T'], [4, 0, 'T'],
               [0, 3, 'T'], [1, 3, 'T'], [2, 3, 'T']],
      window: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
               [-1, 3], [0, 3], [1, 3], [2, 3], [3, 3]],
      machine: [2, 0], human: null },
    { id: 'probe-fourthree-block-04', family: 'fourThreeBlock',
      stones: [[0, 0, 'T'], [1, 0, 'T'], [2, 0, 'T'], [4, 0, 'T'],
               [0, 3, 'T'], [1, 3, 'T'], [2, 3, 'T']],
      window: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
               [-1, 3], [0, 3], [1, 3], [2, 3], [3, 3]],
      machine: [3, 0], human: null },
    { id: 'probe-fourthree-block-05', family: 'fourThreeBlock',
      stones: [[0, 0, 'T'], [1, 0, 'T'], [2, 0, 'T'], [3, 0, 'T'],
               [0, 3, 'T'], [1, 3, 'T'], [2, 3, 'T']],
      window: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
               [-1, 3], [0, 3], [1, 3], [2, 3], [3, 3]],
      machine: [4, 0], human: null },
    // The same five along the main diagonal — see the ⚠ above for why they are not redundant.
    // The four runs along (1,1); the three runs along (1,1) too but offset to (3,0)..(5,2), so the
    // two lines are parallel and disjoint. The three's ends are (2,-1) and (6,3).
    { id: 'probe-fourthree-block-11', family: 'fourThreeBlock',
      stones: [[1, 1, 'T'], [2, 2, 'T'], [3, 3, 'T'], [4, 4, 'T'],
               [3, 0, 'T'], [4, 1, 'T'], [5, 2, 'T']],
      window: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4],
               [2, -1], [3, 0], [4, 1], [5, 2], [6, 3]],
      machine: [0, 0], human: null },
    { id: 'probe-fourthree-block-12', family: 'fourThreeBlock',
      stones: [[0, 0, 'T'], [2, 2, 'T'], [3, 3, 'T'], [4, 4, 'T'],
               [3, 0, 'T'], [4, 1, 'T'], [5, 2, 'T']],
      window: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4],
               [2, -1], [3, 0], [4, 1], [5, 2], [6, 3]],
      machine: [1, 1], human: null },
    { id: 'probe-fourthree-block-13', family: 'fourThreeBlock',
      stones: [[0, 0, 'T'], [1, 1, 'T'], [3, 3, 'T'], [4, 4, 'T'],
               [3, 0, 'T'], [4, 1, 'T'], [5, 2, 'T']],
      window: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4],
               [2, -1], [3, 0], [4, 1], [5, 2], [6, 3]],
      machine: [2, 2], human: null },
    { id: 'probe-fourthree-block-14', family: 'fourThreeBlock',
      stones: [[0, 0, 'T'], [1, 1, 'T'], [2, 2, 'T'], [4, 4, 'T'],
               [3, 0, 'T'], [4, 1, 'T'], [5, 2, 'T']],
      window: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4],
               [2, -1], [3, 0], [4, 1], [5, 2], [6, 3]],
      machine: [3, 3], human: null },
    { id: 'probe-fourthree-block-15', family: 'fourThreeBlock',
      stones: [[0, 0, 'T'], [1, 1, 'T'], [2, 2, 'T'], [3, 3, 'T'],
               [3, 0, 'T'], [4, 1, 'T'], [5, 2, 'T']],
      window: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4],
               [2, -1], [3, 0], [4, 1], [5, 2], [6, 3]],
      machine: [4, 4], human: null },
  ];

  // ---- the eight symmetries of the square --------------------------------------------------
  //
  // Four rotations × {identity, reflection}, as integer 2×2 matrices acting on [dx, dy]:
  // [a, b, c, d] maps (dx, dy) -> (a·dx + b·dy, c·dx + d·dy). Integer arithmetic throughout, so a
  // transformed coordinate is exact — no rounding to get wrong.
  var TRANSFORMS = [
    [1, 0, 0, 1],    // identity
    [0, -1, 1, 0],   // 90°
    [-1, 0, 0, -1],  // 180°
    [0, 1, -1, 0],   // 270°
    [-1, 0, 0, 1],   // mirror across the vertical axis
    [1, 0, 0, -1],   // mirror across the horizontal axis
    [0, 1, 1, 0],    // mirror across the main diagonal
    [0, -1, -1, 0],  // mirror across the anti-diagonal
  ];

  /**
   * Does `board` hold any probe, and if so did `side` play the move the shallow search would?
   *
   * `board` is the position BEFORE the hand (app.js's `prevBoard`), `side` is the player to move,
   * `actual` is [x, y]. Returns `{ seen, hit, id }` — `seen: false` when no motif occurs, which is
   * the ordinary case and the one the caller must not read as "missed".
   *
   * Only the FIRST match is reported. A hand can contain more than one motif (a 双四 is two), and
   * counting it twice would weight the hand twice for one decision; the first is taken in library
   * order, which is stable.
   */
  function matchProbe(board, side, actual) {
    var miss = { seen: false, hit: false, id: null };
    if (!board || !board.length) return miss;
    if (side !== 'B' && side !== 'W') return miss;
    var opp = side === 'B' ? 'W' : 'B';

    // One pass over the board into a colour map keyed by `x * SIZE + y`, plus the threatener's own
    // squares — the only anchors worth trying, since a motif's first stone is always the
    // threatener's.
    var colour = {};
    var anchors = [];
    for (var i = 0; i < board.length; i++) {
      var s = board[i];
      if (!s || s.x == null || s.y == null) continue;
      colour[s.x * SIZE + s.y] = s.side;
      if (s.side === opp) anchors.push([s.x, s.y]);
    }
    if (!anchors.length) return miss;

    for (var p = 0; p < PROBES.length; p++) {
      var probe = PROBES[p];
      var s0 = probe.stones[0];
      for (var t = 0; t < TRANSFORMS.length; t++) {
        var m = TRANSFORMS[t];
        // The offset that puts the transformed first stone on the anchor, computed once per
        // (probe, transform, anchor).
        for (var a = 0; a < anchors.length; a++) {
          var ax = anchors[a][0], ay = anchors[a][1];
          var s0x = m[0] * s0[0] + m[1] * s0[1];
          var s0y = m[2] * s0[0] + m[3] * s0[1];
          var ox = ax - s0x, oy = ay - s0y;
          if (!fitsWindow(probe, m, ox, oy, colour, opp)) continue;
          // Matched. The machine's move is `machine` under the same transform and offset.
          var mx = m[0] * probe.machine[0] + m[1] * probe.machine[1] + ox;
          var my = m[2] * probe.machine[0] + m[3] * probe.machine[1] + oy;
          var hit = !!(actual && actual[0] === mx && actual[1] === my);
          return { seen: true, hit: hit, id: probe.id };
        }
      }
    }
    return miss;
  }

  // Every cell of `window`, transformed and offset, must be inside the board and must agree with the
  // motif: a `stones` cell carries the threatener's colour, any other cell is empty.
  function fitsWindow(probe, m, ox, oy, colour, opp) {
    for (var i = 0; i < probe.window.length; i++) {
      var wx = m[0] * probe.window[i][0] + m[1] * probe.window[i][1] + ox;
      var wy = m[2] * probe.window[i][0] + m[3] * probe.window[i][1] + oy;
      if (wx < 0 || wx >= SIZE || wy < 0 || wy >= SIZE) return false;
      var want = null;
      for (var j = 0; j < probe.stones.length; j++) {
        if (probe.stones[j][0] === probe.window[i][0] && probe.stones[j][1] === probe.window[i][1]) {
          want = opp; break;
        }
      }
      var got = colour[wx * SIZE + wy];
      if (want === null ? got != null : got !== want) return false;
    }
    return true;
  }

  // How many ORIENTED probes the library describes — the number the release notes quote, and the
  // one that answers §1.3③'s 「20–30 个探针局面」. TEN canonical shapes (five gap positions × the two
  // base directions) × eight symmetries = 80. 0.5.7-Alpha changed the SHAPES, not the count.
  var ORIENTED = PROBES.length * TRANSFORMS.length;

  var API = {
    PROBES: PROBES,
    TRANSFORMS: TRANSFORMS,
    matchProbe: matchProbe,
    CANONICAL: PROBES.length,
    ORIENTED: ORIENTED,
    SIZE: SIZE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.GMProbes = API;
})(typeof globalThis !== 'undefined' ? globalThis
   : (typeof window !== 'undefined' ? window : this));
