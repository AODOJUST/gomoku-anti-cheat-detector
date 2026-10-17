/* Gomoku Detector — 模糊搜索的匹配核心。唯一一份。
 *
 * WHAT THIS IS
 * ------------
 * One function pair — `score(query, text)` and `matches(query, texts)` — and the four families of
 * evidence it draws on. It is deliberately UI-free and storage-free: it never sees an archive, a
 * DOM node or a `T()` string, so the same answers are available to the viewer, to a suite, and to
 * a `node` one-liner on a corpus file.
 *
 * ⚠⚠ ONE IMPLEMENTATION, AND THE CALLER DOES NOT GET A SECOND ONE. The archive list narrows
 * through `GMStorage.filterArchives`, so that is where `f.query` is honoured (storage.js reaches
 * for this global by name, the same way it reaches for GMArchiveDB / GMEngines). A UI that
 * filtered the array itself would give `renderList` and `visibleArchivePage` two different ideas
 * of "what is on screen", and the first symptom would be 全选 ticking cards the operator cannot
 * see. Nothing here is exported in a "filter this list" shape on purpose.
 *
 * THE FOUR FAMILIES (and why they are ranked the way they are)
 * -----------------------------------------------------------
 *   1. direct   — the folded query sits inside the folded text (whole text, or one of its words),
 *                 or is a subsequence of it. This is what people mean by 搜索, and it is the only
 *                 family that can highlight anything, so it scores highest.
 *   2. pinyin   — the text read as 拼音 ("zhangsan") or as 首字母 ("zs"). Ranked just under a
 *                 direct hit: 「zs」 finding 「张三」 is exactly right, but it is a guess about what
 *                 the operator meant rather than a piece of the name they typed.
 *   3. distance — Levenshtein, for typos. Only on a length-matched pair, and only from 3 letters
 *                 up; below that a single edit IS the whole word, so every 2-letter query would
 *                 match every 3-letter word.
 *   4. token    — bigram Dice between the query and the best word of the text. Word-order- and
 *                 separator-insensitive ("san zhang" ↔ "Zhang, San"). Lowest of the four.
 *
 * COARSE THEN FINE. A query is first put to family 1, which is a couple of `indexOf` calls. Only
 * if that fails are the romanised forms built, and only if THOSE fail is the quadratic work
 * (edit distance, bigram sets) done. So a list of 1000 archives costs one pass of string
 * containment per archive in the common case, and the per-archive forms are memoised anyway.
 *
 * ⚠ The score is a MAX over the families, not a sum. A sum would make a text that is weakly
 * similar in four ways outrank a text that is exactly equal in one, which is the wrong answer to
 * 「which archive did I mean」 and unreadable when it has to be explained.
 */
(function (g) {
  'use strict';
  if (g.GMSearch) return;

  // 0.5 is the operator-facing answer to 「when is it a match」. Every family's scale below is
  // calibrated so that 0.5 means "a human would accept this" and the families can be compared:
  // see the per-family notes for what each anchor means.
  var THRESHOLD = 0.5;

  // -------------------------------------------------------------------------
  // Normalisation
  // -------------------------------------------------------------------------

  // ⚠⚠ NFKC FIRST, and it is not cosmetic: the same name can arrive with a full-width Ｚ, a
  // half-width 7 and an ideographic space (U+3000) depending on which OS/IME the other player
  // typed it on, and `chrome.storage` keeps whatever arrived. Folding at match time means one
  // copy of the name in storage can still be found by one query.
  //
  // After that, any run of characters that is not a letter, a digit or a pictograph becomes a
  // single space.
  // ⚠ `\p{L}` / `\p{N}` rather than `[a-z0-9]`: names are not ASCII. A Cyrillic, kana or Hangul
  // name folded to "" would be unsearchable by its own characters, which is a silent failure —
  // the card would still be visible in the list, just never findable.
  // ⚠⚠ `\p{Extended_Pictographic}` is there for the same reason, and it is measured rather than
  // imagined: the corpus contains a player called 「ciu7🐟」. Without it the query 「🐟」 folded to
  // "" — which `score` reads as 「还没搜」 and answers with the WHOLE list, so the operator sees
  // every archive and no reason to think the search did nothing. A pictograph in a name is content.
  function fold(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, ' ')
      .trim();
  }

  // fold() with the separators gone, for the comparisons where the boundary between words is what
  // we are trying to see past ("Zhang San" and "zhangsan" are the same answer).
  function tight(s) { return fold(s).replace(/ /g, ''); }

  // -------------------------------------------------------------------------
  // 拼音 / 首字母
  // -------------------------------------------------------------------------
  // The tables are `search-pinyin.js` — a GENERATED file (see `_tools/_gen-pinyin-table.cjs`).
  // Two of them, read once and inverted here:
  //   GMPinyinTable  音节 -> 字   主音，每字恰好一次
  //   GMPinyinExtra  音节 -> 字   多音字的其余读音（3755 个一级汉字里有 1064 个）
  var rev = null;        // char -> primary syllable        (romanize / initials)
  var reads = null;      // char -> [primary, …extras]      (the segment matcher)

  function invert() {
    if (rev) return rev;
    rev = Object.create(null);
    reads = Object.create(null);
    var T = g.GMPinyinTable;
    if (T) {
      for (var syl in T) {
        var chars = T[syl];
        for (var i = 0; i < chars.length; i++) {
          // ⚠ NOT `if (!rev[ch])`: that is a truthiness test on a string whose value is the
          // syllable, and it happens to work — but it also means the first group to claim a
          // character wins by object-key insertion order rather than by anything meaningful.
          // The generated table has no duplicates (asserted at generation time); this guard is
          // only here so a hand-edited table cannot make the answer depend on key order.
          var ch = chars.charAt(i);
          if (rev[ch] === undefined) rev[ch] = syl;
        }
      }
    }
    // ⚠⚠ The extra map is read SECOND and only ever APPENDS, so the primary reading stays the
    // first entry. Ordering matters: `romanize` takes the primary, and a merged map whose order
    // depended on key iteration is exactly the arbitrary choice the two-map split exists to avoid.
    var X = g.GMPinyinExtra;
    if (X) {
      for (var syl2 in X) {
        var more = X[syl2];
        for (var j = 0; j < more.length; j++) {
          var c2 = more.charAt(j);
          if (rev[c2] === syl2) continue;             // listed as an extra AND as the primary?
          if (!reads[c2]) reads[c2] = rev[c2] !== undefined ? [rev[c2]] : [];
          if (reads[c2].indexOf(syl2) < 0) reads[c2].push(syl2);
        }
      }
    }
    // Characters with exactly one reading still need an entry, so the matcher can tell 「one known
    // reading」 from 「not a Chinese character at all」 — those two take different branches.
    for (var k in rev) if (!reads[k]) reads[k] = [rev[k]];
    return rev;
  }

  // The text written in 拼音, character by character: a character the table knows becomes its
  // syllable, anything else is passed through as itself.
  //
  // ⚠ THE FALLBACK IS THE WHOLE POINT OF 「精简」. The table covers GB2312 level 1 (3755 字), so a
  // traditional or rare character is NOT a hole in the search — it stays in the output as itself
  // and still matches a literal substring query. What is lost for that one character is only its
  // reading. Verified by the suite: 「小明」 romanises to "xiaoming" and an unknown character to
  // itself, and neither case throws.
  //
  // ⚠⚠ It uses the PRIMARY reading only, and that is no longer a limitation — it used to be one.
  // 「对面赶紧投降」 romanised to "…touJIANG", so the query 「touxiang」 (the correct pinyin) found
  // nothing. The fix is not here: `readingsFit` below walks the name character by character and
  // accepts ANY reading of each, which is the only way to be right about 多音字 without choosing.
  // This function stays single-valued because its other job is to be ONE candidate string for the
  // distance and token families, and those need a string, not a lattice.
  function romanize(s) {
    var r = invert();
    var src = String(s == null ? '' : s).normalize('NFKC').toLowerCase();
    var out = '';
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (ch === ' ') { out += ' '; continue; }
      var syl = r[ch];
      out += syl === undefined ? ch : syl;
    }
    // Only the 拼音 is collapsed: two characters that share a syllable boundary must join
    // ("张三" -> "zhangsan", not "zhang san"), because a query typed as one run of letters is the
    // common case and the space would break every `indexOf`.
    return out.replace(/[^\p{L}\p{N}]+/gu, '');
  }

  // 首字母: the first letter of each character's syllable. Non-Chinese characters contribute
  // themselves, so 「张三abc」 -> "zsa".
  function initials(s) {
    var r = invert();
    var src = String(s == null ? '' : s).normalize('NFKC').toLowerCase();
    var out = '';
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (!/[\p{L}\p{N}]/u.test(ch)) continue;
      var syl = r[ch];
      out += syl === undefined ? ch : syl.charAt(0);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 分段匹配：逐字消耗查询串（多音字的唯一正确处理方式）
  // -------------------------------------------------------------------------
  // `units` is one array of options per character of the name: a known Chinese character offers its
  // readings, anything else offers itself. The question is 「can `q` be read as the concatenation
  // of one option per character, in order」.
  //
  // ⚠⚠ WHY THIS IS NOT A LOOP OVER READINGS-STRINGS. The alternatives are 2^1064. A name of three
  // 多音字 has 8 readings, and a lattice is the honest shape of the answer — so this walks the
  // QUERY instead: a set of reachable offsets, advanced one character at a time. O(len × readings)
  // per name, and no string is ever materialised for a reading that cannot be used.
  //
  // Returns 'full' (the query consumed every character), 'prefix' (it ran out exactly on a
  // character boundary — 「zhangs」 finds 「zhangsan」), or '' for no match.
  function readingsFit(q, units) {
    if (!q || !units.length) return '';
    var cur = [0];
    var i, j, k, opts, next;
    for (i = 0; i < units.length; i++) {
      opts = units[i];
      if (!opts || !opts.length) return '';
      next = [];
      for (j = 0; j < cur.length; j++) {
        for (k = 0; k < opts.length; k++) {
          var o = opts[k];
          if (o && q.slice(cur[j], cur[j] + o.length) === o) {
            var at = cur[j] + o.length;
            if (next.indexOf(at) < 0) next.push(at);
          }
        }
      }
      if (!next.length) return '';
      // ⚠ Checked after EVERY character, not only at the end: that is what makes 「san」 find
      // 「sanzhang」. Returning on the first boundary reached is safe because a later 'full' match
      // would have to consume these same characters again, which cannot happen once the query is
      // already fully consumed.
      if (next.indexOf(q.length) >= 0) return i === units.length - 1 ? 'full' : 'prefix';
      cur = next;
    }
    return '';
  }

  // Per-character option lists for one name, built once per text (see `forms`).
  //   syl: the readings themselves      -> query 「touxiang」 against 「投降」
  //   ini: their first letters          -> query 「tx」      against 「投降」
  // A character the table does not know offers ITSELF for both, which is what keeps an unknown or
  // non-Chinese name matching a literal query.
  function unitLists(tightText) {
    var r = invert();
    var syl = [], ini = [];
    for (var i = 0; i < tightText.length; i++) {
      var ch = tightText.charAt(i);
      var list = reads[ch];
      if (list && list.length) {
        syl.push(list);
        var firsts = [];
        for (var k = 0; k < list.length; k++) {
          var f = list[k].charAt(0);
          if (firsts.indexOf(f) < 0) firsts.push(f);
        }
        ini.push(firsts);
      } else {
        syl.push([ch]);
        ini.push([ch]);
      }
    }
    return { syl: syl, ini: ini };
  }

  // -------------------------------------------------------------------------
  // Edit distance
  // -------------------------------------------------------------------------
  // Plain Levenshtein over two rows. Bounded by `max` so a hopeless pair stops early instead of
  // walking the whole matrix — with 1000 archives × several words each, the early exit is the
  // difference between a keystroke and a stall.
  function editDistance(a, b, max) {
    a = String(a); b = String(b);
    if (a === b) return 0;
    var la = a.length, lb = b.length;
    if (!la) return lb;
    if (!lb) return la;
    if (Math.abs(la - lb) > max) return max + 1;
    var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var lo = Math.max(1, i - max), hi = Math.min(lb, i + max);
      // Outside the band the value is only ever used as "too far", so the ends are saturated.
      if (lo > 1) cur[lo - 1] = max + 1;
      var best = max + 1;
      for (j = lo; j <= hi; j++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        cur[j] = v;
        if (v < best) best = v;
      }
      if (hi < lb) cur[hi + 1] = max + 1;
      if (best > max) return max + 1;
      var t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }

  // -------------------------------------------------------------------------
  // Token set: bigram Dice
  // -------------------------------------------------------------------------
  // 2 · |A ∩ B| / (|A| + |B|) over character bigrams. Chosen over edit distance for this family
  // because it is insensitive to WHERE the difference is: 「san zhang」 vs 「zhang san」 keeps all
  // its bigrams and scores high, while edit distance calls it far away.
  function bigrams(s) {
    var m = Object.create(null), n = 0;
    for (var i = 0; i < s.length - 1; i++) {
      var b = s.slice(i, i + 2);
      if (m[b]) { m[b]++; } else { m[b] = 1; }
      n++;
    }
    return { m: m, n: n };
  }

  function dice(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    var A = bigrams(a), B = bigrams(b);
    if (!A.n || !B.n) return 0;
    var hit = 0;
    var small = A.n <= B.n ? A : B, big = small === A ? B : A;
    for (var k in small.m) if (big.m[k]) hit += Math.min(small.m[k], big.m[k]);
    return (2 * hit) / (A.n + B.n);
  }

  // -------------------------------------------------------------------------
  // The families
  // -------------------------------------------------------------------------

  // Family 1 — direct. Anchors: equal 1.00 · prefix 0.95 · whole-text substring 0.90 ·
  // word-equal 0.95 · word-prefix 0.85 · subsequence 0.55–0.80 by density.
  //
  // ⚠ The subsequence layer is the one that can invent a match, so it is fenced twice: three
  // letters minimum, and the matched span may be at most twice the query (a 3-letter query inside
  // a 40-letter name is a coincidence, not a memory of it).
  function familyDirect(q, ft) {
    if (!q || !ft) return 0;
    if (ft === q) return 1;
    var i = ft.indexOf(q);
    if (i === 0) return 0.95;
    if (i > 0) return 0.9;

    // ⚠ The word loop and the subsequence scan both walk the FOLDED text, so the space fold()
    // inserted between 「Zhang」 and 「San」 is a character like any other. That is deliberate: it
    // is what lets 「zhangsan」 find 「Zhang San」 — the separator is exactly what the operator
    // cannot see when they type, so it must not be able to block a match. `ft.split(' ')` also
    // means "token" is defined once, by fold(), rather than again here.
    var w = ft.split(' ');
    var best = 0;
    for (var k = 0; k < w.length; k++) {
      var tok = w[k];
      if (!tok) continue;
      if (tok === q) return 0.95;
      if (tok.indexOf(q) === 0) best = Math.max(best, 0.85);
      else if (tok.indexOf(q) > 0) best = Math.max(best, 0.8);
    }

    if (q.length >= 3) {
      var j = 0, first = -1, last = -1;
      for (var p = 0; p < ft.length && j < q.length; p++) {
        if (ft.charAt(p) === q.charAt(j)) {
          if (first < 0) first = p;
          last = p; j++;
        }
      }
      if (j === q.length) {
        var span = last - first + 1;
        if (span <= q.length * 2) best = Math.max(best, 0.55 + 0.25 * (q.length / span));
      }
    }
    return best;
  }

  // Family 2 — 拼音 and 首字母. Anchors: full-pinyin equal 0.95 · prefix 0.90 · containment 0.85 ·
  // initials equal 0.90 · initials containment 0.80.
  //
  // ⚠⚠ Everything here needs `q.length >= 2`. A one-letter query equal to a one-character name's
  // initial would otherwise score 0.90 on a single letter (「l」 → 「李」 at 0.9, beating a real
  // 0.85 word match) — i.e. the shortest, weakest query would get the strongest score.
  // ⚠ The cost of rom+ini+两套 unit 表 is paid only when family 1 missed, which is what keeps the
  // cascade cheap for the ordinary case (a typed substring).
  //
  // ⚠⚠ This takes the ALREADY DERIVED forms (`m`) rather than a text, and there is one reason: the
  // derived forms are memoised per text, and a version that recomputed them from `t` would be a
  // second implementation of the same ranking sitting right next to the one that is actually used.
  // It would agree today and drift tomorrow — the exact shape of the 「多份拷贝」 bugs this project
  // has already paid for.
  //
  // The two `readingsFit` calls are the 多音字-aware path; the `rom` / `ini` string tests below are
  // kept because they answer one question the walk cannot — CONTAINMENT in the middle of a name
  // (「anjin」 inside 「对面赶紧投降」 = "duimianANJINtoujiang"), which the walk only ever checks
  // from the first character.
  function familyPinyin(q, m) {
    if (q.length < 2) return 0;
    var best = 0;

    var f = readingsFit(q, m.sylUnits);
    if (f === 'full') best = 0.95;
    else if (f === 'prefix') best = 0.9;

    if (m.rom) {
      if (m.rom === q) best = Math.max(best, 0.95);
      else if (m.rom.indexOf(q) === 0) best = Math.max(best, 0.9);
      else if (m.rom.indexOf(q) > 0) best = Math.max(best, 0.85);
    }

    var g2 = readingsFit(q, m.iniUnits);
    if (g2 === 'full') best = Math.max(best, 0.9);
    else if (g2 === 'prefix') best = Math.max(best, 0.8);

    if (m.iniUnits) {
      if (m.ini === q) best = Math.max(best, 0.9);
      else if (m.ini.indexOf(q) >= 0) best = Math.max(best, 0.8);
    }
    return best;
  }

  // Family 3 — typos. The ratio is 1 − d/len over the longer of the two, and it is only allowed
  // to speak when the two are within one character of each other: 「zhangsan」 vs 「zhangsna」,
  // never 「zhang」 vs 「zhangsan123」 (whose ratio is meaningless because the length difference is
  // the whole signal).
  //
  // ⚠⚠ It runs over every CANDIDATE FORM, not just the literal text. Measured on the corpus, the
  // missing-letter case 「zhangsn」 scored 0.000 when this only saw 「张三」 — the typo the family
  // exists to forgive was invisible to it, because the operator mistyped the PINYIN and the text
  // is not in Latin letters at all. Adding 「zhangsan」 (the romanised form) to the candidates took
  // it to 0.875. A test that only ever used Latin names would have called the broken version
  // green.
  //
  // ⚠⚠ HOW MANY EDITS ARE ALLOWED DEPENDS ON THE WORD, and both bounds were written after a
  // measurement, not before:
  //   · three letters minimum, and it was very nearly four. The tempting argument is 「at three, one
  //     edit is a THIRD of the word」 — but raising the floor to four was MEASURED to cost recall on
  //     real data and buy nothing: the corpus name 「雨爱」 (拼音 "yuai") could no longer be found
  //     after a dropped letter ("yui" → 0.000), because the pinyin family sees the typo but not the
  //     length, and the token family's Dice is only 0.4. The case the floor was supposed to fix
  //     (「san」 → 「shan」, 0.75) is answered by the SUBSEQUENCE layer, not by this one, so the floor
  //     never affected it at all. A bound that costs a real name and changes no measured answer is
  //     not a safety measure, it is a guess — see §5b of `verify-070.cjs`.
  //   · one edit up to six letters, two from seven. A flat two edits let 「zhang」 find 「wang」
  //     (张 vs 王 — two real surnames, 0.600, a match). At five letters 2/5 = 40% of the word, and
  //     that is not a typo any more. Seven is where two edits becomes defensible, and it is also
  //     exactly what a TRANSPOSITION costs (「zhangsna」 for 「zhangsan」 is 2 edits, 0.750).
  var DIST_MIN = 3;
  var DIST_TWO_EDITS_FROM = 7;

  function familyDistance(q, cands) {
    if (q.length < DIST_MIN || !cands.length) return 0;
    var maxEdits = q.length >= DIST_TWO_EDITS_FROM ? 2 : 1;
    var best = 0;
    for (var k = 0; k < cands.length; k++) {
      var c = cands[k];
      if (!c) continue;
      if (Math.abs(c.length - q.length) > maxEdits) continue;
      var d = editDistance(q, c, maxEdits);
      if (d > maxEdits) continue;
      var ratio = 1 - d / Math.max(q.length, c.length);
      if (ratio > best) best = ratio;
    }
    return best;
  }

  // Family 4 — token set. Anchors: an identical word 1.00 (already caught by family 1, kept here
  // so `score` alone is never weaker than its parts) · otherwise Dice, but only from TOKEN_FLOOR
  // up.
  //
  // ⚠⚠ WHY THIS FAMILY HAS ITS OWN, HIGHER BAR. `THRESHOLD` is a shared acceptance line, and a
  // family may only emit a score that means the same thing as everyone else's. A Dice of 0.5 does
  // NOT: it says 「you and I have half our bigrams in common」, and two unrelated five-letter words
  // do that by accident. Measured, not imagined — 「wangwu」 vs 「zhangwei」 is exactly 0.500
  // (shared: an, ng, gw out of 5 × 7 bigrams), so with a bare `>= THRESHOLD` the query 「wangwu」
  // found a player called 张伟. The same 0.5 on a 20-letter name would be real evidence, which is
  // why this is a floor on the FAMILY rather than a change to the global threshold: the weaker
  // the evidence, the more of it is required before it is allowed to speak.
  var TOKEN_FLOOR = 0.6;

  function familyToken(q, cands) {
    if (q.length < 2 || !cands.length) return 0;
    var best = 0;
    for (var k = 0; k < cands.length; k++) {
      if (!cands[k]) continue;
      var d = dice(q, cands[k]);
      if (d > best) best = d;
    }
    return best >= TOKEN_FLOOR ? best : 0;
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  // ⚠ Memoised per TEXT, not per (query, text) pair: one keystroke re-scores every archive against
  // a different query, so it is the derived forms that are worth keeping.
  //
  // ⚠⚠ The cap has to be bigger than the corpus, or the cache thrashes. The arithmetic: the
  // archive cap is 1000 (GMStorage.MAX_ARCHIVES) and one archive offers up to six searchable
  // strings, so a full library is ~6000 entries per keystroke-pass. A cap of 4000 — the size this
  // started at — would be exceeded on the FIRST pass of a full library and then clear itself on
  // every subsequent one, i.e. it would be pure overhead that looked like an optimisation.
  // 12000 = 2 × the worst case, and `memoN` is reset with the cache so the two cannot drift.
  var MEMO_MAX = 12000;
  var memo = Object.create(null);
  var memoN = 0;
  function forms(t) {
    var hit = memo[t];
    if (hit) return hit;
    var flat = tight(t);
    var ft = fold(t);
    var rom = romanize(t);
    var ini = initials(t);
    var units = unitLists(flat);
    // One deduped candidate list, built once, shared by families 3 and 4 — the list IS the
    // definition of 「what forms this name can be searched as」, and a second one built elsewhere
    // would be the usual silent divergence.
    var cands = [];
    var seen = Object.create(null);
    if (flat) { cands.push(flat); seen[flat] = 1; }
    var ws = ft ? ft.split(' ') : [];
    for (var i = 0; i < ws.length; i++) {
      if (ws[i] && !seen[ws[i]]) { cands.push(ws[i]); seen[ws[i]] = 1; }
    }
    if (rom && !seen[rom]) { cands.push(rom); seen[rom] = 1; }
    if (ini && !seen[ini]) { cands.push(ini); seen[ini] = 1; }

    var f = { ft: ft, rom: rom, ini: ini, cands: cands, sylUnits: units.syl, iniUnits: units.ini };
    if (memoN >= MEMO_MAX) { memo = Object.create(null); memoN = 0; }
    memo[t] = f; memoN++;
    return f;
  }

  /** Best score in 0..1 for one text. See the family anchors above for what the numbers mean. */
  function score(query, text) {
    var q = tight(query);
    // ⚠ An empty query is not "nothing matches": it is 「the operator has not searched yet」, and
    // the caller must keep the whole list. Returning 0 here would be read by any `> 0` caller as
    // "hide everything", which is the loudest possible wrong answer.
    if (!q) return 1;
    var t = String(text == null ? '' : text);
    if (!t) return 0;

    // Stage 1 — the cheap one. Everything here is `indexOf` on one string.
    var ft = fold(t);
    var direct = familyDirect(q, ft);
    if (direct >= 0.85) return direct;         // a real substring hit cannot be beaten

    // Stage 2 — the derived forms (paid for once per text, then cached).
    var m = forms(t);
    var best = familyPinyin(q, m);
    if (direct > best) best = direct;
    if (best >= 0.8) return best;

    // Stage 3 — the quadratic families.
    var dist = familyDistance(q, m.cands);
    if (dist > best) best = dist;
    var tok = familyToken(q, m.cands);
    if (tok > best) best = tok;
    return best;
  }

  /** The best score over several candidate strings of one record (name · both players · …). */
  function bestOf(query, texts) {
    var best = 0;
    for (var i = 0; i < texts.length; i++) {
      var s = score(query, texts[i]);
      if (s > best) best = s;
      if (best >= 1) break;
    }
    return best;
  }

  /** The one question the callers ask. An empty query matches everything (see `score`). */
  function matches(query, texts) {
    if (!tight(query)) return true;
    return bestOf(query, texts) >= THRESHOLD;
  }

  g.GMSearch = {
    THRESHOLD: THRESHOLD,
    fold: fold,
    tight: tight,
    romanize: romanize,
    initials: initials,
    editDistance: editDistance,
    dice: dice,
    score: score,
    bestOf: bestOf,
    matches: matches,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMSearch;
})(typeof globalThis !== 'undefined' ? globalThis : self);
