/* Gomoku Detector — 26 Renju openings (RIF), as a shared classic script.
 *
 * Loaded by BOTH the page content script (manifest content_scripts) and viewer.html, so it
 * publishes one global: `GMOpening`. No modules — content scripts cannot use them.
 *
 * ---------------------------------------------------------------------------
 * How the table is keyed (this is the whole difficulty)
 * ---------------------------------------------------------------------------
 * A Renju opening is the first three stones: black 1 at tengen (h8), white 2 somewhere in
 * the central 3x3, black 3 somewhere in the central 5x5. There are 8 x 24 = 192 such
 * placements but only 26 openings, because the board's symmetry group (D4: 4 rotations +
 * 4 reflections) identifies them — the NAME is a property of the shape, not of where the
 * shape sits or how it is turned.
 *
 * So the lookup normalises the shape instead of enumerating 192 cases:
 *   1. rotate so that white 2 sits at the canonical offset (0,-1) [direct: white is
 *      orthogonally adjacent] or (1,-1) [indirect: white is diagonally adjacent];
 *      rotations act simply transitively on the four neighbours of each kind, so exactly
 *      one of the four maps white onto the canonical offset.
 *   2. the rotations preserving that offset are {identity, one reflection}, so mirror the
 *      shape if needed to land black 3 in a fixed fundamental domain
 *      (direct: dx >= 0 · indirect: dx + dy >= 0).
 *   3. black 3's offset is now a canonical key — 13 of them per family, 26 in total.
 *
 * Coordinates are the app's own: `[x, y]` with x = column (a..o -> 0..14) and y = row
 * counted DOWNWARD (y = 0 is the top line, y = 14 the bottom). Viewing `x` as the board
 * letter and `y` as (15 - the board number) makes `coordToShare()` in app.js an identity.
 *
 * ---------------------------------------------------------------------------
 * Provenance of the 13 + 13 offsets
 * ---------------------------------------------------------------------------
 * The key -> name mapping cannot be guessed (the obvious "白2朝上 + 黑3正上方 = 寒星"
 * reading is wrong: 寒星/花月/金星/新月 are the SAME opening seen from four rotations).
 * It was read off two independent sources and cross-checked:
 *   - a per-opening ASCII board dump for all 26 openings, D1..D13 and I1..I13, each
 *     showing black 1 / white 2 / black 3 (this fixes every offset), and
 *   - the published RIF strength evaluation of all 26 (sure-win / advantage / equal), used
 *     as the ordering check: 寒星 90, 花月 100, 游星 -100, 浦月 100, 彗星 -100 …
 * Both agree on the pairing of every number with every name, so the table below is
 * self-consistent with the published D/I numbering.
 *
 * NOTE: gomoku.com's Renju path is what these are shown for. Freestyle games are detected
 * the same way (the first three stones do not care about the rule), which is why the caller
 * does not pass a rule in.
 */
(function (g) {
  'use strict';
  if (g.GMOpening) return;

  var CENTER = 7;                       // tengen (h8) in app coordinates

  // Canonical offsets. See the header: these two keys, plus the fundamental domain below,
  // are what turn 192 placements into 26 names.
  var CANON_DIRECT = [0, -1];
  var CANON_INDIRECT = [1, -1];

  // D4, rotations only. Each is a function of one offset.
  var ROT = [
    function (p) { return [p[0], p[1]]; },        // 0°
    function (p) { return [-p[1], p[0]]; },       // 90°
    function (p) { return [-p[0], -p[1]]; },      // 180°
    function (p) { return [p[1], -p[0]]; },       // 270°
  ];

  // code -> name for both families, in the published D1..D13 / I1..I13 order.
  var DIRECT_NAMES = ['寒星', '溪月', '疏星', '花月', '残月', '雨月', '金星',
                      '松月', '丘月', '新月', '瑞星', '山月', '游星'];
  var INDIRECT_NAMES = ['长星', '峡月', '恒星', '水月', '流星', '云月', '浦月',
                        '岚月', '银月', '明星', '斜月', '名月', '彗星'];

  // Canonical black-3 offsets, indexed the same way as the name arrays. Keyed "dx,dy".
  // Direct (white at (0,-1), dx >= 0):
  //   (0,-2) (1,-2) (2,-2) | (1,-1) (2,-1) | (1,0) (2,0) | (0,1) (1,1) (2,1) | (0,2) (1,2) (2,2)
  // Indirect (white at (1,-1), dx + dy >= 0):
  //   (2,-2) (2,-1) (2,0) (2,1) (2,2) | (1,0) (1,1) (1,2) | (0,1) (0,2) | (-1,1) (-1,2) | (-2,2)
  var DIRECT_KEYS = ['0,-2', '1,-2', '2,-2', '1,-1', '2,-1', '1,0', '2,0',
                     '0,1', '1,1', '2,1', '0,2', '1,2', '2,2'];
  var INDIRECT_KEYS = ['2,-2', '2,-1', '2,0', '2,1', '2,2', '1,0', '1,1',
                       '1,2', '0,1', '0,2', '-1,1', '-1,2', '-2,2'];

  function buildTable(prefix, category, names, keys) {
    var table = {};
    for (var i = 0; i < names.length; i++) {
      table[keys[i]] = { code: prefix + (i + 1), name: names[i], category: category };
    }
    return table;
  }

  var DIRECT = buildTable('D', '直止', DIRECT_NAMES, DIRECT_KEYS);
  var INDIRECT = buildTable('I', '斜止', INDIRECT_NAMES, INDIRECT_KEYS);

  // ---------- lookup ----------
  function offset(p) { return [p[0] - CENTER, p[1] - CENTER]; }

  // Meta carries the mid-join flags under three different names across builds
  // (0.2.6 record: unorderedCount / inferredCount; report: incomplete). Any of them means
  // the first stones in the array are not the first stones of the game, so the ORDER is not
  // recoverable. 0.4.2 §一 narrows what that costs: the ROLES may still be recoverable from
  // the positions (see normalizeRoles), so this now sends detectOpening down the
  // role-by-position path instead of refusing outright.
  function orderUnknown(meta) {
    if (!meta) return false;
    if (meta.incomplete) return true;
    if (meta.unorderedCount > 0) return true;
    if (meta.inferredCount > 0) return true;
    return false;
  }

  // ---------- reading the input (0.4.2 §1.3) ----------
  // `moves` holds either [x,y] arrays — the original contract — or {x,y,side} objects. A side
  // comes from, in order: the point's own `side`; `meta.stones[i]`, which uses the same
  // 1 = black / 2 = white encoding as `record.stones` (the authority on colour) and is what
  // makes a mid-join's roles recoverable at all; and index parity as the last resort, which is
  // only right when the list really does start at move 1.
  function pointAt(p) {
    if (!p) return null;
    if (Array.isArray(p)) return (p.length >= 2) ? [p[0], p[1]] : null;
    if (typeof p === 'object' && p.x != null && p.y != null) return [p.x, p.y];
    return null;
  }
  function sideAt(moves, meta, i) {
    var p = moves[i];
    if (p && typeof p === 'object' && !Array.isArray(p) && p.side) return p.side;
    var st = meta && meta.stones;
    if (st) { if (st[i] === 1) return 'B'; if (st[i] === 2) return 'W'; }
    return (i % 2 === 0) ? 'B' : 'W';
  }

  // ---------- 0.4.2 §一: roles by POSITION, not by order ----------
  // Black 1 is pinned to tengen by the definition of an opening, white 2 is the only stone of
  // the other colour, and black 3 is what is left. So once the STONES are known, "which one
  // came first" stops deciding anything (§1.2 关键观察) — which is what lets a mid-join be
  // identified at all. Whatever position cannot decide, this refuses to guess.
  //
  // 2 stones: only the family is determined, from white's direction away from tengen.
  function detectFamily(moves, meta) {
    if (!moves || moves.length !== 2) return null;
    var b = null, w = null, i;
    for (i = 0; i < 2; i++) {
      var p = pointAt(moves[i]);
      if (!p) return null;
      if (sideAt(moves, meta, i) === 'B') b = p; else w = p;
    }
    if (!b || !w) return null;
    if (b[0] !== CENTER || b[1] !== CENTER) return null;
    var dx = w[0] - CENTER, dy = w[1] - CENTER;
    // White 2 is one of the 8 neighbours, so the Chebyshev distance is exactly 1.
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return null;
    // Orthogonal -> direct (直止); diagonal -> indirect (斜止). The same test lookupTriple
    // applies below, so the two stages can never disagree about a shape's family.
    return (dx === 0 || dy === 0) ? '直止' : '斜止';
  }

  // 3 stones with an unrecoverable order -> { m1, m2, m3 }, or null when the position does not
  // pin the roles: there must be exactly two black stones and one white one, and black 1 must
  // be the single black stone on tengen. Ambiguity (no black on tengen, or two) refuses.
  function normalizeRoles(moves, meta) {
    if (!moves || moves.length !== 3) return null;
    var blacks = [], whites = [], i;
    for (i = 0; i < 3; i++) {
      var p = pointAt(moves[i]);
      if (!p) return null;
      (sideAt(moves, meta, i) === 'B' ? blacks : whites).push(p);
    }
    if (blacks.length !== 2 || whites.length !== 1) return null;
    var tengen = [];
    for (i = 0; i < blacks.length; i++) {
      if (blacks[i][0] === CENTER && blacks[i][1] === CENTER) tengen.push(blacks[i]);
    }
    if (tengen.length !== 1) return null;
    return { m1: tengen[0], m2: whites[0],
             m3: (blacks[0] === tengen[0]) ? blacks[1] : blacks[0] };
  }

  // The 26-name table walk, shared by the ordered and the role-recovered path so the two can
  // never disagree about what a given triple means.
  function lookupTriple(m1, m2, m3) {
    if (!m1 || !m2 || !m3) return null;

    // Black 1 must be at tengen, or this is not one of the 26 openings at all (a game that
    // started elsewhere, an imported record, a rotated/partial capture).
    if (m1[0] !== CENTER || m1[1] !== CENTER) return null;

    var w = offset(m2);
    // White 2 must be one of the 8 neighbours: Chebyshev distance exactly 1.
    if (Math.max(Math.abs(w[0]), Math.abs(w[1])) !== 1) return null;

    var b = offset(m3);
    // Black 3 must be inside the central 5x5.
    if (Math.abs(b[0]) > 2 || Math.abs(b[1]) > 2) return null;
    if (b[0] === 0 && b[1] === 0) return null;                 // tengen is black 1
    if (b[0] === w[0] && b[1] === w[1]) return null;           // that point is white 2

    var direct = (w[0] === 0 || w[1] === 0);
    var canon = direct ? CANON_DIRECT : CANON_INDIRECT;

    // Step 1: the one rotation that puts white 2 on the canonical offset.
    for (var i = 0; i < ROT.length; i++) {
      var t = ROT[i](w);
      if (t[0] === canon[0] && t[1] === canon[1]) { b = ROT[i](b); break; }
    }
    // Step 2: the one remaining symmetry is a reflection; use it to reach the domain.
    if (direct) {
      if (b[0] < 0) b = [-b[0], b[1]];
    } else if (b[0] + b[1] < 0) {
      b = [-b[1], -b[0]];
    }

    var hit = (direct ? DIRECT : INDIRECT)[b[0] + ',' + b[1]];
    if (!hit) return null;                 // no orbit here — not a legal opening
    return { category: hit.category, name: hit.name, code: hit.code,
             fullName: hit.category + '·' + hit.name, stage: 'opening' };
  }

  // The family as a one-letter code, so a capture that only knows the family can still be
  // filed under 直止 / 斜止 without inventing a name for it (0.4.2 §4.1).
  var FAMILY_CODE = { '直止': 'D', '斜止': 'I' };
  function familyCode(category) { return FAMILY_CODE[category] || null; }

  // moves: [[x,y] | {x,y,side}, ...] — the game's moves, in play order when it is known.
  // meta: optional { unorderedCount | inferredCount | incomplete, stones }.
  // Returns { category, name, code, fullName, stage } or null — never a guess.
  //
  // 0.4.2 §1.3 gives it two stages:
  //   stage 'opening'  3 stones whose roles are known — in order, or recovered from position
  //   stage 'family'   2 stones: only 直止 / 斜止 is determined, `name` and `code` are null
  function detectOpening(moves, meta) {
    if (!moves) return null;
    var n = moves.length;

    if (n === 2) {
      var fam = detectFamily(moves, meta);
      if (!fam) return null;
      return { category: fam, name: null, code: null, fullName: fam, stage: 'family' };
    }
    if (n < 3) return null;

    if (orderUnknown(meta)) {
      // Only a 3-stone board pins the roles. With more stones on the board "black 3" is not
      // identifiable inside the set — a later black stone sits in the same central 5x5 — so a
      // mid-join onto a full board still refuses: a wrong name is worse than no name.
      if (n !== 3) return null;
      var t = normalizeRoles(moves, meta);
      return t ? lookupTriple(t.m1, t.m2, t.m3) : null;
    }

    return lookupTriple(pointAt(moves[0]), pointAt(moves[1]), pointAt(moves[2]));
  }

  // ---------- presentation helpers ----------
  // code -> entry, built once. Archives store only the three-character code, so the name
  // has to be recoverable from it without walking the key tables.
  var BY_CODE = {};
  (function () {
    [DIRECT, INDIRECT].forEach(function (t) {
      for (var k in t) {
        BY_CODE[t[k].code] = { code: t[k].code, name: t[k].name, category: t[k].category,
                               fullName: t[k].category + '·' + t[k].name };
      }
    });
  })();

  function byCode(code) { return (code && BY_CODE[code]) || null; }

  function t(key, vars) {
    return (typeof GMI18n !== 'undefined') ? GMI18n.t(key, vars) : (vars ? key : key);
  }
  function currentLocale() {
    return (typeof GMI18n !== 'undefined') ? GMI18n.getLocale() : 'zh-CN';
  }
  // "直止·寒星" / "直止·寒星（Cold Star）" from either a stored opening object or a bare code
  // (archives keep the code only, so the name has to be recoverable from it).
  //
  // §1.7 决策 1 has two halves, and §1.9 验收 4 pins the exact shape: 「直止·寒星（Cold Star）」.
  // The CATEGORY (直止 / 斜止) stays Chinese in every locale — it is part of the RIF term rather
  // than a description of it, so rendering "Direct·寒星（Cold Star）" fails that acceptance item.
  // The specific opening name keeps its Chinese form and parenthesises the local one beside it,
  // because a loose translation of 寒星 is worse than no translation at all.
  //
  // The CJK family (zh-CN / zh-TW / ja / ko) is the exception: there the RIF 汉字 IS the local
  // name — 寒星 is 寒星 in Japanese — so the name is printed alone with no redundant 「（寒星）」.
  // (ko reads 直止 as 직지, but §1.9 验收 4 specifies the Chinese category for 非中文环境, so it
  // stays 直止.)
  var CJK_FAMILY = { 'zh-CN': 1, 'zh-TW': 1, ja: 1, ko: 1 };

  function label(opening, locale) {
    if (!opening) return null;
    // 0.4.2 §1.4: a family-only capture. The name is genuinely not recoverable, and saying so
    // is the point — 「直止（大类，具体开局待定）」 rather than a plausible-looking guess. The
    // category stays Chinese in every locale for the same reason as below: it IS the RIF term.
    if (typeof opening === 'object' && opening.stage === 'family' && opening.category) {
      // `open|…`, not a dotted `open.…` key: dotted keys are for lookups built at runtime
      // (`t(g.labelKey)` in tree() below), and the key extractor reads every literal `t('…')`
      // as an `ns|text` pair — a literal dotted key would be filed with an empty text and
      // reported as a missing translation forever.
      return opening.category + '（' + t('open|大类，具体开局待定') + '）';
    }
    var o = byCode(typeof opening === 'string' ? opening : opening && opening.code);
    // A stored object with a name but no resolvable code (an archive written by an older
    // build) still has its Chinese name — better that than dropping the label entirely.
    if (!o) {
      if (typeof opening === 'object' && opening.fullName) return opening.fullName;
      return typeof opening === 'string' ? opening : null;
    }
    var l = locale || currentLocale();
    var local = t('opening.' + o.code);
    var cat = o.category;
    // `local === o.name` is the case for ja / ko (they deliberately reuse the RIF 汉字) and for
    // zh-CN, whose table simply mirrors the source: both mean "the local form adds nothing".
    var name = (local && local !== o.name) ? local : o.name;
    if (CJK_FAMILY[l]) return cat + '·' + name;
    if (!local || local === o.name) return cat + '·' + o.name;
    return cat + '·' + o.name + '（' + local + '）';
  }

  // The three-level filter tree (全部 / 大类 / 具体开局) that the archive list renders.
  // `label` is a key now, not a finished string: the tree is built once at load time, before
  // the stored language has been read, so it must not freeze today's language into the data.
  var TREE = [
    { category: '直止', code: 'D', labelKey: 'open.allDirect',
      items: DIRECT_NAMES.map(function (n, i) { return { code: 'D' + (i + 1), name: n }; }) },
    { category: '斜止', code: 'I', labelKey: 'open.allIndirect',
      items: INDIRECT_NAMES.map(function (n, i) { return { code: 'I' + (i + 1), name: n }; }) },
  ];

  function tree() {
    return TREE.map(function (g) {
      return {
        category: g.category, code: g.code, label: t(g.labelKey),
        items: g.items.map(function (it) {
          return { code: it.code, name: it.name, label: label(it.code) };
        }),
      };
    });
  }

  g.GMOpening = {
    CENTER: CENTER,
    detectOpening: detectOpening,
    // 0.4.2 §一: the two role-by-position helpers, exported so the tests can drive them
    // directly instead of only through detectOpening's dispatch.
    detectFamily: detectFamily,
    normalizeRoles: normalizeRoles,
    lookupTriple: lookupTriple,
    familyCode: familyCode,
    byCode: byCode,
    label: label,
    TREE: TREE,
    tree: tree,
    DIRECT: DIRECT,
    INDIRECT: INDIRECT,
    DIRECT_NAMES: DIRECT_NAMES,
    INDIRECT_NAMES: INDIRECT_NAMES,
    ORDER_UNKNOWN: orderUnknown,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMOpening;
})(typeof globalThis !== 'undefined' ? globalThis : self);
