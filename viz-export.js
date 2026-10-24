/* viz-export.js — 1.0.8 快照五号 §一：把一份或一组 `report` 画成**自包含 HTML**。
 *
 * 只在扩展页加载（viewer.html）：它读的是存档/样本里已经存好的 `report`，
 * 以及 tagWiki 的两个「唯一读者」（当前三档线与证据门槛）。
 *
 * ⚠⚠ 四条设计红线，每一条都是本项目已经付过一次学费的：
 *
 *  1. **不写死权重键表**。信号清单与顺序来自 `report.<side>.contributions` 的键 ——
 *     那份对象是 app.js 当年按 BASE_WEIGHTS 造出来的，所以它**天生与这份报告同代**。
 *     抄一份 17 键清单进来会立刻过期（`winBlunder` 已在 1.0.8 快照二号整项删除，
 *     而 `_archive/_viz-sample.cjs` 里那份还留着 `sim`）。名称走 `TO('learn.weight', k)`，
 *     那是设置面板、学习器表格、标签百科三处共同使用的那一个键。
 *
 *  2. **不写死 85 / 50 / 8**。三档线与证据门槛各走 `GM_TAG_WIKI.band('riskHigh'|'riskMid')`
 *     与 `GM_TAG_WIKI.minHands()` —— 那两个函数读 app.js 的 BASE_THRESHOLDS / MIN_AI_HANDS，
 *     是这两个数字唯一的出口。写死一次，下一版调阈值就静默印旧数。
 *
 *  3. **不自己推判词**。等级读 `side.level`，类型读 `types[side].type`。`classifySide` 在
 *     「段数 / 最长段」那张表之前还有一条「深度 × 节奏」的早退分支，照着段数自己推会推错
 *     （65 手那局白方 lowRuns=2 却被判 evasiveAi，就是这么错的）。
 *
 *  4. **「无上限组有哪五项」不写死**：标注用 `bonusByKey` 的键 —— 这份报告**真的兑现了**
 *     加分的那几项。既是事实，又不受权重表变动影响。
 *
 * ⚠ `countsForSide()` 是 app.js `countsForSide()` 的镜像（THE MIRROR RULE）：五个条件必须
 * 逐字一致。它不能被省掉 —— 报告只给每侧一个 n，而明细表要逐手标「计入」。所以镜像之后
 * 立刻用 n 对账，对不上就抛错（`assertCounts`），绝不画一页自相矛盾的图。
 */
(function (root) {
  'use strict';

  /* ---------------- 语言 ---------------- */
  function T(key, vars) {
    return root.GMI18n ? root.GMI18n.t(key, vars) : String(key).slice(String(key).indexOf('|') + 1);
  }
  function TO(ns, value) {
    return root.GMI18n ? root.GMI18n.tOr(ns, value) : String(value == null ? '' : value);
  }
  // 三档线与证据门槛的唯一出口（tagWiki 读 app.js 的两个常量）。
  function band(key) {
    var w = root.GM_TAG_WIKI;
    var v = w && typeof w.band === 'function' ? w.band(key) : null;
    return typeof v === 'number' ? v : null;
  }
  function minHands() {
    var w = root.GM_TAG_WIKI;
    var v = w && typeof w.minHands === 'function' ? w.minHands() : null;
    return typeof v === 'number' ? v : null;
  }
  // ⚠ 取不到就**喊出来**，绝不拿 85 / 50 / 8 顶上。写死一次的代价不是「数字错了」，而是
  // 「数字对了」，然后在下一次调阈值时静默留在旧值上 —— 而这一页看起来完全正常。
  // 调用方是 `vizExport()` 的 try/catch，它会把这句话原样 alert 给用户。
  function needBand(key) {
    var v = band(key);
    if (typeof v !== 'number') throw new Error(T('viz|三档线取不到（{k}）：tagWiki 或 BASE_THRESHOLDS 没加载。', { k: key }));
    return v;
  }
  function needMinHands() {
    var v = minHands();
    if (typeof v !== 'number') throw new Error(T('viz|证据门槛取不到：tagWiki.minHands() 没给出数字。'));
    return v;
  }

  /* ---------------- 基础工具 ---------------- */
  var C = {
    B: '#2f6fed', W: '#e2574c',
    top1: '#e8a013', top3: '#4b8bf5', top5: '#a9c4ea', out: '#e2574c', na: '#dfe3e9',
    high: '#e2574c', mid: '#e0a020', low: '#37a86b',
  };
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n1(v, d) {
    if (v == null || (typeof v === 'number' && !isFinite(v))) return '—';
    return Number(v).toFixed(d == null ? 1 : d);
  }
  function pct(v) {
    if (v == null || !isFinite(Number(v))) return '—';
    return (Number(v) * 100).toFixed(1) + '%';
  }
  function fmtInt(v) { return v == null ? '—' : String(v); }
  function levelColor(lv) {
    return lv === '高风险' ? C.high : (lv === '可疑' ? C.mid : C.low);
  }
  function typeName(t) {
    if (!t) return '—';
    return TO('type', t);
  }
  // 分数的上界 = 100 × 有效权重之和。这个数字 **不写死** —— storage.js 的
  // `SIGNAL_WEIGHT_SUM_MAX` 就是它（app.js 也是这么读的），写死 150 会在换表那版静默印旧数。
  function ceiling() {
    var s = root.GMStorage && root.GMStorage.SIGNAL_WEIGHT_SUM_MAX;
    // 同上：取不到就喊，不拿 1.5 顶上。
    if (typeof s !== 'number') throw new Error(T('viz|权重上限取不到：GMStorage.SIGNAL_WEIGHT_SUM_MAX 没加载。'));
    return 100 * s;
  }
  function levelName(lv) {
    if (!lv) return '—';
    return TO('level', lv);
  }
  // 规则是**专名**（Freestyle / Standard / Renju），不进词典 —— 它同时也是 storage 里存的
  // 身份值，翻译它等于改数据。
  function ruleLabel(r) {
    var k = String(r == null ? '' : r).toLowerCase();
    return { freestyle: 'Freestyle', standard: 'Standard', renju: 'Renju', 0: 'Freestyle', 1: 'Standard', 2: 'Renju' }[k] || '—';
  }
  function stamp(d) {
    if (!d) return '—';
    var s = String(d);
    return s.replace('T', ' ').replace(/\..*$/, '');
  }

  /* ---------------- 判据镜像（⚠ THE MIRROR RULE） ---------------- */
  // 与 app.js `countsForSide()` 的五个条件逐条对应。改那边的任何一条，这里必须同改，
  // 并且 verify-113 用「逐字段对照源码」的静态判据守着，而不是靠人记得。
  function countsForSide(s, side) {
    return !!s && s.side === side && !!s.analyzed && !s.isOpening &&
      !s.forcedDefense && !s.fourRunExempt && !s.farFourExempt;
  }
  function assertCounts(rep, sides) {
    var steps = rep.steps || [];
    ['B', 'W'].forEach(function (k) {
      var n = 0;
      for (var i = 0; i < steps.length; i++) if (countsForSide(steps[i], k)) n++;
      var got = sides[k] && sides[k].n;
      if (got != null && n !== got) {
        throw new Error('有效手数对不上：' + k + ' 镜像 ' + n + ' / 报告 ' + got);
      }
    });
  }

  function tierOf(s) {
    if (!s || !s.analyzed) return 'na';
    if (s.top1) return 'top1';
    if (s.top3) return 'top3';
    if (s.top5) return 'top5';
    return 'out';
  }
  function tierLabel(t) {
    return { top1: 'TOP1', top3: T('viz|前三'), top5: T('viz|前五'), out: T('viz|未进前五'), na: T('viz|未分析') }[t] || t;
  }

  /* ---------------- 输入规整 ---------------- */
  function sigKeys(rep) {
    var out = [], seen = {};
    ['black', 'white'].forEach(function (sk) {
      var c = (rep[sk] && rep[sk].contributions) || {};
      Object.keys(c).forEach(function (k) {
        if (!seen[k]) { seen[k] = 1; out.push(k); }
      });
    });
    return out;
  }
  function playersOf(entry) {
    var p = entry.players || (entry.record && entry.record.meta && entry.record.meta.players) || {};
    return { black: p.black || null, white: p.white || null, self: p.self || null };
  }
  function sumContrib(a, keys) {
    var t = 0;
    for (var i = 0; i < keys.length; i++) t += Number((a.contributions || {})[keys[i]]) || 0;
    return t;
  }

  /* ---------------- 单局：双方卡片 ---------------- */
  function sideCard(rep, k, pl, opts) {
    var a = rep[k === 'B' ? 'black' : 'white'];
    if (!a) return '';
    var ty = (rep.types || {})[k] || {};
    var keys = opts.keys;
    var lv = a.level || '';
    var isB = k === 'B';
    var nm = isB ? pl.black : pl.white;
    var isSelf = nm && nm === pl.self;
    var base = a.baseScore == null ? 0 : Number(a.baseScore);
    var bonus = a.bonusScore == null ? 0 : Number(a.bonusScore);
    var risk = Number(a.risk) || 0;
    var ceil = opts.ceil;
    var bonusPct = (base + bonus) > 0 ? (bonus / (base + bonus)) * 100 : 0;
    var hits = { top1: 0, top3: 0, top5: 0, out: 0, na: 0 };
    var steps = rep.steps || [];
    for (var i = 0; i < steps.length; i++) if (steps[i].side === k) hits[tierOf(steps[i])]++;
    var mh = opts.minHands;
    var hasSplit = a.baseScore != null || a.bonusScore != null;

    return '' +
'<div class="sc" style="--side:' + (isB ? C.B : C.W) + ';--lv:' + levelColor(lv) + '">' +
  '<div class="sc-h"><span class="who">' + esc(isB ? T('viz|黑方') : T('viz|白方')) + ' · ' + esc(nm || '—') + '</span>' +
    (isSelf ? '<span class="me">' + esc(T('viz|自己')) + '</span>' : '') + '</div>' +
  '<div class="sc-main">' +
    '<div class="score">' + n1(risk) + '<span class="of">/ ' + n1(ceil, 0) + '</span></div>' +
    '<div class="verdict"><span class="lvl">' + esc(levelName(lv)) + '</span>' +
      '<span class="type">' + esc(typeName(ty.type)) + '</span></div>' +
  '</div>' +
  (hasSplit ?
  '<div class="split"><div class="split-bar">' +
    '<div class="sb-base" style="width:' + (100 - bonusPct).toFixed(1) + '%"></div>' +
    '<div class="sb-bonus" style="width:' + bonusPct.toFixed(1) + '%"></div>' +
  '</div><div class="split-leg"><span>' + esc(T('viz|基础分')) + ' <b>' + n1(base) + '</b></span>' +
    '<span>' + esc(T('viz|无上限加分')) + ' <b style="color:#c07a00">+' + n1(bonus) + '</b></span></div></div>' : '') +
  '<div class="sc-grid">' +
    '<div><span class="k">' + esc(T('viz|有效手数')) + '</span><span class="v">' + a.n +
      (mh == null ? '' : '<em class="' + (a.n >= mh ? 'ok' : 'no') + '">' +
        (a.n >= mh ? T('viz|≥{n} 可判', { n: mh }) : T('viz|<{n} 不判', { n: mh })) + '</em>') + '</span></div>' +
    '<div><span class="k">TOP1</span><span class="v">' + pct(a.top1) + '</span></div>' +
    '<div><span class="k">' + esc(T('viz|前三')) + '</span><span class="v">' + pct(a.top3) + '</span></div>' +
    '<div><span class="k">' + esc(T('viz|前五')) + '</span><span class="v">' + pct(a.top5) + '</span></div>' +
    '<div><span class="k">' + esc(T('viz|平均损失')) + '</span><span class="v">' + n1(a.meanLoss) + '</span></div>' +
    '<div><span class="k">' + esc(T('viz|好点率')) + '</span><span class="v">' + pct(a.goodRatio) + '</span></div>' +
  '</div>' +
  '<div class="sc-foot">' + esc(T('viz|命中分布')) + '：TOP1 ' + hits.top1 + ' · ' +
    esc(T('viz|前三')) + ' ' + hits.top3 + ' · ' + esc(T('viz|前五')) + ' ' + hits.top5 + ' · ' +
    esc(T('viz|未进前五')) + ' ' + hits.out + ' · ' + esc(T('viz|未分析')) + ' ' + hits.na +
    (ty.lowSteps ? ' · <span class="warnish">' + esc(T('viz|低手数 {n} 手／{r} 段', { n: ty.lowSteps, r: ty.lowRuns })) + '</span>' : '') +
  '</div>' +
'</div>';
  }

  /* ---------------- 单局：信号贡献 ---------------- */
  function secSignals(rep, pl, opts) {
    var keys = opts.keys;
    if (!keys.length) return '';
    var vals = [];
    ['B', 'W'].forEach(function (k) {
      var a = rep[k === 'B' ? 'black' : 'white'];
      if (!a) return;
      keys.forEach(function (key) { vals.push(Number((a.contributions || {})[key]) || 0); });
    });
    var maxV = Math.max.apply(null, vals.concat([1]));
    var rowH = 26, colW = 520, gap = 64, W = colW * 2 + gap;
    var top = 46, H = top + keys.length * rowH + 30;
    var BAR_MAX = 326, LAB_W = 108, BAR_X = 124, VAL_X = 514;

    function col(k, x0) {
      var a = rep[k === 'B' ? 'black' : 'white'];
      if (!a) return '';
      var isB = k === 'B';
      var c = isB ? C.B : C.W;
      var soft = isB ? '#bccce8' : '#f0cbc7';
      var bonus = a.bonusByKey || {};
      var nm = isB ? pl.black : pl.white;
      var rows = keys.map(function (key, i) {
        var v = Number((a.contributions || {})[key]) || 0;
        var unb = Object.prototype.hasOwnProperty.call(bonus, key);
        var wpx = v <= 0 ? 0 : Math.max((v / maxV) * BAR_MAX, 2.5);
        var y = top + i * rowH;
        var lbl = v > 0 ? '#43505f' : '#c6cdd7';
        return '<g>' +
          '<text x="' + (x0 + LAB_W) + '" y="' + (y + 11) + '" text-anchor="end" font-size="10.5" fill="' + lbl +
            '" font-weight="' + (unb ? 600 : 400) + '">' + esc(TO('learn.weight', key)) + '</text>' +
          (unb ? '<circle cx="' + (x0 + LAB_W + 7) + '" cy="' + (y + 7.5) + '" r="2.2" fill="#d9a213"/>' : '') +
          (v > 0
            ? '<rect x="' + (x0 + BAR_X) + '" y="' + (y + 3) + '" width="' + wpx + '" height="9" rx="2" fill="' + (unb ? c : soft) + '"/>'
            : '<line x1="' + (x0 + BAR_X) + '" y1="' + (y + 7.5) + '" x2="' + (x0 + BAR_X + 9) + '" y2="' + (y + 7.5) + '" stroke="#e9edf3" stroke-width="2"/>') +
          '<text x="' + (x0 + VAL_X) + '" y="' + (y + 11) + '" text-anchor="end" font-size="10" fill="' +
            (v > 0 ? '#6b7787' : '#c6cdd7') + '" font-family="ui-monospace,Consolas,monospace">' + (v > 0 ? n1(v) : '0') + '</text>' +
        '</g>';
      }).join('');
      var base = a.baseScore == null ? 0 : Number(a.baseScore);
      var bon = a.bonusScore == null ? 0 : Number(a.bonusScore);
      return '<g>' +
        '<text x="' + (x0 + LAB_W) + '" y="18" text-anchor="end" font-size="11.5" font-weight="650" fill="' + c + '">' +
          esc((isB ? T('viz|黑方') : T('viz|白方')) + ' · ' + (nm || '—')) + '</text>' +
        '<text x="' + (x0 + VAL_X) + '" y="18" text-anchor="end" font-size="10.5" fill="#8894a5">' +
          esc(T('viz|合计')) + ' <tspan font-weight="600" fill="#1b2028">' + n1(base + bon) + '</tspan></text>' +
        rows +
        '<text x="' + (x0 + LAB_W) + '" y="' + (H - 8) + '" text-anchor="end" font-size="10.5" fill="#8894a5">' +
          esc(T('viz|基础')) + ' ' + n1(base) + ' ＋ ' + esc(T('viz|无上限')) + ' ' + n1(bon) + '</text>' +
        '<text x="' + (x0 + VAL_X) + '" y="' + (H - 8) + '" text-anchor="end" font-size="11" font-weight="600" fill="' + c + '">' +
          esc(T('viz|分数 {v}', { v: n1(Number(a.risk) || 0) })) + '</text>' +
      '</g>';
    }

    return '<section class="card">' +
      '<h2>' + esc(T('viz|一、信号贡献：{k} 项，两人各付了多少', { k: keys.length })) + '</h2>' +
      '<p class="note">' + T('viz|<b>●</b> 标的是这份报告里真的兑现了无上限加分的项：过了 60% 激活后按 ×(1+5n/100) 放大，最高 3 倍，所以同样一份权重能兑现出远超自身额度的分。浅色的条不在这个组里，封顶就是它的权重 × 100。') + '</p>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + esc(T('viz|信号贡献')) + '">' +
        '<line x1="' + (colW + gap / 2) + '" y1="6" x2="' + (colW + gap / 2) + '" y2="' + (H - 24) + '" stroke="#eaedf3"/>' +
        col('B', 0) + col('W', colW + gap) +
      '</svg></section>';
  }

  /* ---------------- 单局：逐手时间轴 ---------------- */
  function secTimeline(rep, opts) {
    var steps = rep.steps || [];
    if (!steps.length) return '';
    var W = 1180, padL = 46, padR = 18;
    var plotW = W - padL - padR;
    var cut = rep.openingCutoff || 0;
    var colW = plotW / steps.length;
    function X(i) { return padL + i * colW + colW / 2; }

    var wrTop = 30, wrH = 110;
    var bY = 168, wY = 200, barH = 24;
    var H = 268;

    function pathOf(field) {
      var segs = [], k = 0;
      steps.forEach(function (s, i) {
        if (s[field] == null) return;
        segs.push((k ? 'L' : 'M') + X(i).toFixed(1) + ',' + (wrTop + (1 - s[field]) * wrH).toFixed(1));
        k++;
      });
      return segs.join(' ');
    }

    var bands = { B: '', W: '' };
    steps.forEach(function (s, i) {
      var t = tierOf(s);
      var y = s.side === 'B' ? bY : wY;
      var x = padL + i * colW;
      bands[s.side === 'W' ? 'W' : 'B'] += '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + Math.max(colW - 1.2, 1) +
        '" height="' + barH + '" fill="' + C[t] + '" rx="1.5"><title>' +
        esc(T('viz|第 {m} 手', { m: s.moveNo }) + ' ' + (s.side === 'B' ? T('viz|黑') : T('viz|白')) + ' ' + (s.actualStr || '') +
          ' — ' + tierLabel(t) + (countsForSide(s, s.side) ? '' : ' · ' + T('viz|不计入'))) + '</title></rect>';
    });

    var ticks = [];
    for (var m = 5; m <= steps.length; m += 5) {
      var i = m - 1;
      ticks.push('<line x1="' + X(i) + '" y1="' + wrTop + '" x2="' + X(i) + '" y2="' + (wY + barH) + '" stroke="#eef1f6"/>' +
        '<text x="' + X(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="9.5" fill="#98a2b0">' + m + '</text>');
    }
    var gridY = [0, 0.25, 0.5, 0.75, 1].map(function (v) {
      return '<line x1="' + padL + '" y1="' + (wrTop + (1 - v) * wrH) + '" x2="' + (W - padR) + '" y2="' + (wrTop + (1 - v) * wrH) + '" stroke="#f1f4f8"/>' +
        '<text x="' + (padL - 6) + '" y="' + (wrTop + (1 - v) * wrH + 3.5) + '" text-anchor="end" font-size="9" fill="#a4adb9">' + (v * 100) + '%</text>';
    }).join('');

    var lx = padL;
    var legend = [['top1', 'TOP1'], ['top3', T('viz|前三')], ['top5', T('viz|前五')], ['out', T('viz|未进前五')], ['na', T('viz|未分析')]]
      .map(function (pair) {
        var g = '<rect x="' + lx + '" y="8" width="9" height="9" rx="1.5" fill="' + C[pair[0]] + '"/>' +
          '<text x="' + (lx + 13) + '" y="16" font-size="10" fill="#6b7787">' + esc(pair[1]) + '</text>';
        lx += 13 + String(pair[1]).length * 10 + 16;
        return g;
      }).join('');
    var extra = '<g transform="translate(' + lx + ',0)">' +
      '<line x1="0" y1="12.5" x2="16" y2="12.5" stroke="#3b4657" stroke-width="1.6"/>' +
      '<text x="20" y="16" font-size="10" fill="#6b7787">' + esc(T('viz|实际手胜率')) + '</text>' +
      '<line x1="86" y1="12.5" x2="102" y2="12.5" stroke="#9aa6b6" stroke-width="1.4" stroke-dasharray="3 2"/>' +
      '<text x="106" y="16" font-size="10" fill="#6b7787">' + esc(T('viz|引擎首选')) + '</text></g>';

    var cutX = cut > 0 ? X(cut - 0.5) : null;
    return '<section class="card">' +
      '<h2>' + esc(T('viz|二、{n} 手逐手看：落在哪一档', { n: steps.length })) + '</h2>' +
      '<p class="note">' + T('viz|每格是一手棋。上面是实际手胜率（实线）与引擎首选兑现后的胜率（虚线），两条线的缝就是这一手亏掉的部分；下方两条色带是命中档位。灰色格是没被分析的。') + '</p>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + esc(T('viz|逐手档位')) + '">' +
        gridY +
        '<path d="' + pathOf('bestWR') + '" fill="none" stroke="#9aa6b6" stroke-width="1.2" stroke-dasharray="3 2"/>' +
        '<path d="' + pathOf('actualWR') + '" fill="none" stroke="#3b4657" stroke-width="1.7"/>' +
        (cutX == null ? '' : '<line x1="' + cutX + '" y1="' + (wrTop - 6) + '" x2="' + cutX + '" y2="' + (wY + barH) + '" stroke="#c9a227" stroke-width="1.2" stroke-dasharray="4 3"/>' +
          '<text x="' + (cutX + 4) + '" y="' + (wY + barH + 13) + '" font-size="9.5" fill="#a8871a">' + esc(T('viz|↑ 开场截止 {n} 手', { n: cut })) + '</text>') +
        '<text x="' + (padL - 6) + '" y="' + (bY + barH / 2 + 3.5) + '" text-anchor="end" font-size="10.5" fill="' + C.B + '" font-weight="600">' + esc(T('viz|黑')) + '</text>' +
        '<text x="' + (padL - 6) + '" y="' + (wY + barH / 2 + 3.5) + '" text-anchor="end" font-size="10.5" fill="' + C.W + '" font-weight="600">' + esc(T('viz|白')) + '</text>' +
        bands.B + bands.W + ticks.join('') + legend + extra +
        '<text x="' + (W - padR) + '" y="' + (H - 8) + '" text-anchor="end" font-size="9.5" fill="#98a2b0">' + esc(T('viz|手序 →')) + '</text>' +
      '</svg></section>';
  }

  /* ---------------- 单局：棋盘 ---------------- */
  function secBoard(rep, pl, opts) {
    var steps = rep.steps || [];
    if (!steps.length) return '';
    var N = 15, cell = 30, pad = 26;
    var W = pad * 2 + cell * (N - 1);
    function px(c) { return pad + c * cell; }
    function py(r) { return pad + (N - 1 - r) * cell; }
    var grid = [];
    for (var i = 0; i < N; i++) {
      grid.push('<line x1="' + pad + '" y1="' + (pad + i * cell) + '" x2="' + (W - pad) + '" y2="' + (pad + i * cell) + '" stroke="#dfe4ec"/>');
      grid.push('<line x1="' + (pad + i * cell) + '" y1="' + pad + '" x2="' + (pad + i * cell) + '" y2="' + (W - pad) + '" stroke="#dfe4ec"/>');
    }
    var stars = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]].map(function (rc) {
      return '<circle cx="' + px(rc[1]) + '" cy="' + py(rc[0]) + '" r="2.2" fill="#b9c2cf"/>';
    }).join('');

    var termMove = (rep.terminal && rep.terminal.moveNo) || null;
    var stones = steps.map(function (s) {
      var pos = s.actual || [0, 0];
      var t = tierOf(s);
      var isB = s.side === 'B';
      var ring = t === 'top1' ? C.top1 : (t === 'out' ? C.out : null);
      var ringW = t === 'top1' ? 1.3 : 2.3;
      var ringO = t === 'top1' ? 0.5 : 0.95;
      var isLast = s.moveNo === termMove;
      return '<g><title>' + esc(T('viz|第 {m} 手', { m: s.moveNo }) + ' · ' +
          (isB ? T('viz|黑方') : T('viz|白方')) + ' ' + (pl[isB ? 'black' : 'white'] || '') + ' · ' + (s.actualStr || '') +
          ' / ' + (s.bestStr || '—') + ' · ' + tierLabel(t) +
          (countsForSide(s, s.side) ? ' · ' + T('viz|计入') : ' · ' + T('viz|不计入'))) + '</title>' +
        (ring ? '<circle cx="' + px(pos[1]) + '" cy="' + py(pos[0]) + '" r="13.6" fill="none" stroke="' + ring +
          '" stroke-width="' + ringW + '" opacity="' + ringO + '"/>' : '') +
        (isLast ? '<circle cx="' + px(pos[1]) + '" cy="' + py(pos[0]) + '" r="15.2" fill="none" stroke="#2b3038" stroke-width="1.2" stroke-dasharray="3 2"/>' : '') +
        '<circle cx="' + px(pos[1]) + '" cy="' + py(pos[0]) + '" r="11.6" fill="' + (isB ? '#24292f' : '#ffffff') +
          '" stroke="' + (isB ? '#11151a' : '#b9c2cf') + '" stroke-width="1"/>' +
        '<text x="' + px(pos[1]) + '" y="' + (py(pos[0]) + 3.4) + '" text-anchor="middle" font-size="9.5" font-weight="600" fill="' +
          (isB ? '#ffffff' : '#3b4657') + '" font-family="ui-monospace,Consolas,monospace">' + s.moveNo + '</text></g>';
    }).join('');

    function statBox(k) {
      var isB = k === 'B';
      var t = { top1: 0, top3: 0, top5: 0, out: 0, na: 0 };
      var total = 0, counted = 0;
      steps.forEach(function (s) {
        if (s.side !== k) return;
        total++;
        t[tierOf(s)]++;
        if (countsForSide(s, k)) counted++;
      });
      var nm = isB ? pl.black : pl.white;
      return '<div class="bs ' + (isB ? 'b' : 'w') + '">' +
        '<div class="bs-h">' + esc((isB ? T('viz|黑方') : T('viz|白方')) + ' · ' + (nm || '—')) + '</div>' +
        '<div class="bs-row"><span>' + esc(T('viz|总手数')) + '</span><span class="n">' + total + '</span></div>' +
        '<div class="bs-row"><span>' + esc(T('viz|计入有效手数')) + '</span><span class="n">' + counted + '</span></div>' +
        '<div class="bs-sep">' + esc(T('viz|档位分布（按全部手计）')) + '</div>' +
        ['top1', 'top3', 'top5', 'out', 'na'].map(function (key) {
          return '<div class="bs-row"><span><span class="dot" style="background:' + C[key] + '"></span>' +
            esc(tierLabel(key)) + '</span><span class="n">' + t[key] + '</span></div>';
        }).join('') +
      '</div>';
    }

    var meta = (opts.meta || {});
    var mm = meta.opening || {};
    return '<section class="card">' +
      '<h2>' + esc(T('viz|三、棋盘：{n} 手落点', { n: steps.length })) + '</h2>' +
      '<p class="note">' + T('viz|子上的数字是手序。<b>金色外环</b>＝这一手就是引擎首选（TOP1），<b>红色外环</b>＝没进前五，虚线圆＝终局那一手。右侧的档位分布按<b>全部手</b>计，与卡片里的命中率不是同一个口径 —— 强制应手必然是 TOP1，而它们已被剔出有效手数。') +
        (mm.fullName ? ' ' + esc(T('viz|开局')) + '：' + esc(mm.fullName) + '（' + esc(mm.category || '—') + ' · ' + esc(mm.code || '—') + '）。' : '') +
      '</p>' +
      '<div class="boardwrap">' +
        '<svg viewBox="0 0 ' + W + ' ' + W + '" width="100%" role="img" aria-label="' + esc(T('viz|棋盘')) + '">' +
          '<rect x="0" y="0" width="' + W + '" height="' + W + '" fill="#fbf8f1" rx="6"/>' +
          grid.join('') + stars + stones +
          '<text x="' + pad + '" y="' + (W - 8) + '" font-size="9" fill="#a4adb9">A</text>' +
          '<text x="' + (W - pad - 6) + '" y="' + (W - 8) + '" font-size="9" fill="#a4adb9">O</text>' +
          '<text x="6" y="' + (pad + 4) + '" font-size="9" fill="#a4adb9">15</text>' +
          '<text x="8" y="' + (W - pad + 4) + '" font-size="9" fill="#a4adb9">1</text>' +
        '</svg>' +
        '<div class="boardstats">' + statBox('B') + statBox('W') + '</div>' +
      '</div></section>';
  }

  /* ---------------- 单局：低手数段 ---------------- */
  function secLowRuns(rep, pl) {
    var steps = rep.steps || [];
    var segs = rep.segments || {};
    if (!steps.length || (!(segs.B || []).length && !(segs.W || []).length)) return '';
    var W = 1180, padL = 62, padR = 24, plotW = W - padL - padR;
    var colW = plotW / steps.length;
    var rowH = 34, top = 40;
    var H = top + 2 * rowH + 40;

    function ranEvasive(side) {
      var ty = (rep.types || {})[side] || {};
      return ty.suspect === 'ai';
    }

    function row(side, y0) {
      var isB = side === 'B';
      var c = isB ? C.B : C.W;
      var ran = ranEvasive(side);
      var g = '';
      (segs[side] || []).forEach(function (sg) {
        var x = padL + sg.from * colW;
        var w = (sg.to - sg.from + 1) * colW;
        var low = sg.kind === 'low';
        g += '<rect x="' + x.toFixed(1) + '" y="' + y0 + '" width="' + w.toFixed(1) + '" height="' + (rowH - 12) + '" rx="3" fill="' +
          (low ? (isB ? '#dbe5f7' : '#f7dcd9') : '#eff2f7') + '" stroke="' + (low ? (isB ? '#b8cbec' : '#eec3bd') : 'none') + '">' +
          '<title>' + esc((isB ? T('viz|黑方') : T('viz|白方')) + ' ' + (low ? T('viz|低手数段') : T('viz|高手数段')) +
            ' · ' + T('viz|第 {a}–{b} 手', { a: sg.from + 1, b: sg.to + 1 })) + '</title></rect>';
        if (low && ran) {
          var cnt = 0;
          for (var i = sg.from; i <= sg.to; i++) {
            var s = steps[i];
            if (s && s.side === side && countsForSide(s, side)) cnt++;
          }
          if (cnt > 0) {
            g += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y0 + rowH - 16) + '" text-anchor="middle" font-size="9.5" font-weight="600" fill="' +
              (isB ? C.B : C.W) + '">' + esc(T('viz|{n} 手', { n: cnt })) + '</text>';
          }
        }
      });
      steps.forEach(function (s, i) {
        if (s.side !== side) return;
        var cx = padL + i * colW + colW / 2;
        var counted = countsForSide(s, side);
        g += '<circle cx="' + cx.toFixed(1) + '" cy="' + (y0 + (rowH - 12) / 2) + '" r="' + (counted ? 2.6 : 1.6) + '" fill="' +
          (counted ? c : '#c3cbd7') + '" opacity="' + (counted ? 0.95 : 0.8) + '"><title>' +
          esc(T('viz|第 {m} 手', { m: s.moveNo }) + ' · ' + (counted ? T('viz|计入') : T('viz|不计入'))) + '</title></circle>';
      });
      g += '<text x="' + (padL - 8) + '" y="' + (y0 + (rowH - 12) / 2 + 3.5) + '" text-anchor="end" font-size="10.5" font-weight="600" fill="' + c + '">' +
        esc(isB ? T('viz|黑') : T('viz|白')) + '</text>';
      return g;
    }

    function chip(side) {
      var isB = side === 'B';
      var c = isB ? C.B : C.W;
      var a = rep[isB ? 'black' : 'white'] || {};
      var ty = (rep.types || {})[side] || {};
      var nm = isB ? pl.black : pl.white;
      var ran = ranEvasive(side);
      function cell(k, v, dim) {
        return '<div><span class="k">' + esc(k) + '</span><span class="v' + (dim ? ' dim' : '') + '">' + v + '</span></div>';
      }
      var grid = cell(T('viz|低手数段数'), ran ? fmtInt(ty.lowRuns) : T('viz|未计算'), !ran) +
        cell(T('viz|最长一段'), ran ? esc(T('viz|{n} 手', { n: fmtInt(ty.lowMax) })) : T('viz|未计算'), !ran) +
        cell(T('viz|低手数总计'), ran ? esc(T('viz|{n} 手', { n: fmtInt(ty.lowSteps) })) : T('viz|未计算'), !ran) +
        cell(T('viz|深度档'), fmtInt(a.evasiveDeep)) +
        cell(T('viz|节奏分'), n1(a.evasiveRhythm, 2));
      return '<div class="ev ' + (isB ? 'b' : 'w') + '" style="--side:' + c + '">' +
        '<div class="ev-h"><span>' + esc((isB ? T('viz|黑方') : T('viz|白方')) + ' · ' + (nm || '—')) + '</span>' +
          '<span class="ev-type">' + esc(typeName(ty.type)) + '</span></div>' +
        '<div class="ev-grid">' + grid + '</div>' +
        (ran ? '' : '<div class="ev-note">' + T('viz|这一侧没有跑「规避型」那套分类 —— 分数落在可疑档，判词直接由分数带给出，所以三段低手数的读数是<b>未计算</b>，不是 0。色块照画，因为它是引擎分段的事实。') + '</div>') +
      '</div>';
    }

    return '<section class="card">' +
      '<h2>' + esc(T('viz|四、低手数段：判词依据摆在哪')) + '</h2>' +
      '<p class="note">' + T('viz|彩色块是低手数段，灰块是高手数段；圆点是该方的每一手，<b>实心</b>＝计入有效手数。块里的数字是这一段里真正计入该方样本的手数 —— 只有跑过规避分类的一侧才有。⚠ 判词是<b>产品直接给出的</b>，这里只陈列它读到的数，<b>不复算</b>：判词先走一条「深度 × 节奏」的分支，照着段数自己推会推错。') + '</p>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="' + esc(T('viz|低手数段')) + '">' +
        row('B', top) + row('W', top + rowH) +
        '<text x="' + padL + '" y="' + (H - 8) + '" font-size="9.5" fill="#98a2b0">' + esc(T('viz|手序 →')) + '</text>' +
        '<text x="' + (W - padR) + '" y="' + (H - 8) + '" text-anchor="end" font-size="9.5" fill="#98a2b0">' + steps.length + '</text>' +
      '</svg>' +
      '<div class="evrow">' + chip('B') + chip('W') + '</div></section>';
  }

  /* ---------------- 单局：逐手明细 ---------------- */
  function flagChips(s) {
    var out = [];
    if (s.isSharp) out.push([T('viz|唯一手'), '#4b8bf5']);
    if (s.forcedDefense) out.push([T('viz|强制'), '#8894a5']);
    if (s.four) out.push([T('viz|冲四'), '#b07cd6']);
    if (s.fourRunExempt) out.push([T('viz|四连豁免'), '#b07cd6']);
    if (s.farFourExempt) out.push([T('viz|远点豁免'), '#b07cd6']);
    if (s.evasion) out.push([T('viz|规避'), '#e2574c']);
    if (s.desperate) out.push([T('viz|绝境'), '#8b6c3f']);
    if (s.missedBlock) out.push([T('viz|漏挡'), '#e2574c']);
    if (s.isGood) out.push([T('viz|好点'), '#37a86b']);
    if (s.isOpening) out.push([T('viz|开场'), '#b3bbc7']);
    return out.map(function (p) {
      return '<span class="chip" style="--c:' + p[1] + '">' + esc(p[0]) + '</span>';
    }).join('');
  }

  function secTable(rep) {
    var steps = rep.steps || [];
    if (!steps.length) return '';
    var rows = steps.map(function (s) {
      var t = tierOf(s);
      var inc = countsForSide(s, s.side);
      var loss = s.loss;
      var cls = loss == null ? '' : (loss >= 0.12 ? 'bad' : (loss >= 0.04 ? 'warn' : ''));
      return '<tr class="' + (inc ? '' : 'dim') + '">' +
        '<td class="num">' + s.moveNo + '</td>' +
        '<td><span class="side ' + (s.side === 'B' ? 'b' : 'w') + '">' + esc(s.side === 'B' ? T('viz|黑') : T('viz|白')) + '</span></td>' +
        '<td class="mono">' + esc(s.actualStr || '') + '</td>' +
        '<td class="mono">' + esc(s.bestStr || '—') + '</td>' +
        '<td class="num">' + pct(s.actualWR) + '</td>' +
        '<td class="num">' + pct(s.bestWR) + '</td>' +
        '<td class="num ' + cls + '">' + (loss == null ? '—' : (loss * 100).toFixed(1) + '%') + '</td>' +
        '<td><span class="tier" style="--c:' + C[t] + '">' + esc(tierLabel(t)) + '</span></td>' +
        '<td class="num">' + (inc ? '✓' : '') + '</td>' +
        '<td class="flags">' + flagChips(s) + '</td>' +
      '</tr>';
    }).join('');
    return '<section class="card">' +
      '<h2>' + esc(T('viz|五、逐手明细')) + '</h2>' +
      '<p class="note">' + T('viz|「损失」＝引擎首选胜率 − 实际手胜率，按百分点显示。灰色行不计入有效手数（开场 / 强制应手 / 四连豁免 / 远点豁免）—— 它们照常显示，只是不参与算分；「计入」列打勾的就是报表里那个 n 的组成。') + '</p>' +
      '<div class="tblwrap"><table><thead><tr>' +
        ['viz|手', 'viz|方', 'viz|落子', 'viz|引擎首选', 'viz|实际胜率', 'viz|首选胜率', 'viz|损失', 'viz|档位', 'viz|计入', 'viz|标记']
          .map(function (k) { return '<th>' + esc(T(k)) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></section>';
  }

  /* ---------------- 单局：怎么读 ---------------- */
  function secHowTo(rep, opts) {
    var hi = opts.high, mid = opts.mid, mh = opts.minHands;
    var b = rep.black || {}, w = rep.white || {};
    var items = [
      T('viz|分数不是百分比：它是 {k} 项信号乘权重求和，上限是 100 × 有效权重之和（本版 ⇒ {ceil}）。当前黑 {b} / 白 {w} 就是这个尺度上的位置。',
        { k: opts.keys.length, ceil: n1(opts.ceil, 0), b: n1(b.risk), w: n1(w.risk) }),
      T('viz|斜纹那段是「无上限加分」。它抬的是高分段（激活过 60% 才兑现），不是全体 —— 所以两条分数分布之间不该出现整体平移。'),
      (hi == null || mid == null)
        ? T('viz|三档线与证据门槛由本版产品决定，这一页读不到就不再印具体数字。')
        : T('viz|三档线是 {hi} / {mid}；判词另有一道证据门槛 n ≥ {n}，分数够而手数不够的侧不给判词。',
            { hi: hi, mid: mid, n: mh == null ? '—' : mh }),
      T('viz|这份结论只说明「像」，不说明「是」：分数由引擎复算，判定阈值可调，误报永远不为零。'),
    ];
    return '<section class="card read">' +
      '<h2>' + esc(T('viz|这一页怎么读')) + '</h2>' +
      '<ol>' + items.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol></section>';
  }

  /* ---------------- 共同样式 ---------------- */
  function css() {
    return '' +
'  :root{--bg:#f4f6f9;--card:#fff;--line:#e4e8ef;--ink:#1b2028;--ink2:#4a5563;--mute:#8894a5;' +
'    --B:' + C.B + ';--W:' + C.W + ';--high:' + C.high + ';--mid:' + C.mid + ';--low:' + C.low + '}' +
'  *{box-sizing:border-box}' +
'  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}' +
'  .wrap{max-width:1220px;margin:0 auto;padding:28px 20px 56px}' +
'  header.top{margin-bottom:18px}' +
'  h1{margin:0 0 6px;font-size:21px;line-height:1.35;font-weight:650;letter-spacing:-0.01em}' +
'  .sub{color:var(--mute);font-size:12.5px}' +
'  .metabar{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:12px}' +
'  .metabar span{background:#fff;border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:11.5px;color:var(--ink2)}' +
'  .metabar b{color:var(--ink);font-weight:600}' +
'  .cards{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0}' +
'  @media(max-width:860px){.cards{grid-template-columns:1fr}}' +
'  .sc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px 14px;border-top:3px solid var(--lv);box-shadow:0 1px 2px rgba(20,30,50,.04)}' +
'  .sc-h{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--mute)}' +
'  .sc-h .who{font-weight:600;color:var(--ink2)}' +
'  .sc-h .me{background:#eef3ff;color:var(--B);border-radius:999px;padding:1px 8px;font-size:10.5px}' +
'  .sc-main{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:6px 0 10px}' +
'  .score{font-size:38px;font-weight:680;letter-spacing:-0.02em;line-height:1.05;color:var(--lv)}' +
'  .score .of{font-size:13px;font-weight:400;color:var(--mute);margin-left:4px;letter-spacing:0}' +
'  .verdict{text-align:right;line-height:1.35}' +
'  .lvl{display:block;font-size:12.5px;font-weight:600;color:var(--lv)}' +
'  .type{display:block;font-size:11.5px;color:var(--mute)}' +
'  .split{margin:2px 0 10px}' +
'  .split-bar{display:flex;height:7px;border-radius:4px;overflow:hidden;background:#eef1f6}' +
'  .sb-base{background:var(--side);opacity:.75}' +
'  .sb-bonus{background:repeating-linear-gradient(45deg,#e8a013,#e8a013 4px,#f3c46a 4px,#f3c46a 8px)}' +
'  .split-leg{display:flex;justify-content:space-between;font-size:10.5px;color:var(--mute);margin-top:4px}' +
'  .sc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 6px;border-top:1px solid var(--line);padding-top:10px}' +
'  .sc-grid .k{display:block;font-size:10.5px;color:var(--mute)}' +
'  .sc-grid .v{display:block;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}' +
'  .sc-grid em{font-style:normal;font-size:10px;font-weight:400;margin-left:4px;padding:0 5px;border-radius:999px}' +
'  .sc-grid em.ok{background:#eaf6ee;color:#2c8a52}' +
'  .sc-grid em.no{background:#fdeeee;color:#c24141}' +
'  .sc-foot{margin-top:9px;padding-top:8px;border-top:1px dashed var(--line);font-size:10.5px;color:var(--mute)}' +
'  .warnish{color:#c07a00}' +
'  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px 20px;margin-bottom:14px;box-shadow:0 1px 2px rgba(20,30,50,.04)}' +
'  h2{margin:0 0 6px;font-size:15px;font-weight:640;letter-spacing:-0.005em}' +
'  .note{margin:0 0 14px;font-size:11.8px;color:var(--mute);line-height:1.75}' +
'  .note b{color:var(--ink2);font-weight:600}' +
'  .boardwrap{display:grid;grid-template-columns:minmax(0,520px) 1fr;gap:22px;align-items:start}' +
'  @media(max-width:820px){.boardwrap{grid-template-columns:1fr}}' +
'  .boardstats{display:grid;grid-template-columns:1fr;gap:10px}' +
'  .bs{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:12px}' +
'  .bs.b{border-left:3px solid var(--B)}.bs.w{border-left:3px solid var(--W)}' +
'  .bs-h{font-weight:600;font-size:12.5px;margin-bottom:6px}' +
'  .bs-row{display:flex;justify-content:space-between;color:var(--ink2);padding:1.5px 0;font-variant-numeric:tabular-nums}' +
'  .bs-row .n{font-weight:600;color:var(--ink)}' +
'  .bs-sep{margin:7px 0 2px;padding-top:6px;border-top:1px dashed var(--line);font-size:9.5px;color:#a4adb9}' +
'  .dot{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:6px;vertical-align:1px}' +
'  .tblwrap{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:10px}' +
'  table{width:100%;border-collapse:collapse;font-size:12px}' +
'  th{position:sticky;top:0;background:#f8fafc;text-align:left;font-weight:600;color:var(--ink2);padding:8px;border-bottom:1px solid var(--line);white-space:nowrap;font-size:11px;z-index:1}' +
'  td{padding:5px 8px;border-bottom:1px solid #f1f4f8;vertical-align:middle}' +
'  tr.dim{color:#a9b3c0}tr.dim .tier{opacity:.6}' +
'  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}' +
'  td.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px}' +
'  td.num.bad{color:var(--high);font-weight:600}td.num.warn{color:#b8860b}' +
'  .side{display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:5px;font-size:10.5px}' +
'  .side.b{background:#24292f;color:#fff}.side.w{background:#fff;border:1px solid #c9d0da;color:#3b4657}' +
'  .tier{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;color:var(--c);background:color-mix(in srgb,var(--c) 12%,#fff);white-space:nowrap}' +
'  .chip{display:inline-block;font-size:10px;padding:0 6px;margin:1px 3px 1px 0;border-radius:999px;color:var(--c);background:color-mix(in srgb,var(--c) 10%,#fff);white-space:nowrap}' +
'  .evrow{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}' +
'  @media(max-width:760px){.evrow{grid-template-columns:1fr}}' +
'  .ev{border:1px solid var(--line);border-radius:10px;padding:10px 12px}' +
'  .ev.b{border-left:3px solid var(--B)}.ev.w{border-left:3px solid var(--W)}' +
'  .ev-h{display:flex;justify-content:space-between;align-items:baseline;font-size:12px;font-weight:600;margin-bottom:8px}' +
'  .ev-type{font-size:11px;font-weight:500;color:var(--side)}' +
'  .ev-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}' +
'  .ev-grid .k{display:block;font-size:10px;color:var(--mute)}' +
'  .ev-grid .v{display:block;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}' +
'  .ev-grid .v.dim{color:#c0c7d2;font-weight:500;font-size:12px}' +
'  .ev-note{margin-top:9px;padding-top:8px;border-top:1px dashed var(--line);font-size:10.5px;color:var(--mute);line-height:1.7}' +
'  .ev-note b{color:var(--ink2)}' +
'  .read ol{margin:0;padding-left:20px;font-size:12.5px;color:var(--ink2);line-height:1.85}' +
'  .read code{background:#f2f5f9;border-radius:4px;padding:0 4px;font-size:11.5px}' +
'  footer{color:var(--mute);font-size:11px;text-align:center;margin-top:22px;line-height:1.8}' +
'  /* ---- 多局 ---- */' +
'  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin:16px 0}' +
'  .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}' +
'  .kpi .k{font-size:10.5px;color:var(--mute);display:block}' +
'  .kpi .v{font-size:23px;font-weight:660;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}' +
'  .kpi .u{font-size:11px;color:var(--mute);font-weight:400;margin-left:3px}' +
'  .rank{margin:0;padding:0;list-style:none}' +
'  .rank li{display:grid;grid-template-columns:150px 1fr 62px;gap:10px;align-items:center;padding:4px 0;font-size:11.5px}' +
'  .rank .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink2)}' +
'  .rank .track{position:relative;height:16px;background:#f2f5f9;border-radius:4px;overflow:hidden}' +
'  .rank .fill{position:absolute;left:0;top:0;height:8px;border-radius:3px}' +
'  .rank .fill.b{top:1px}.rank .fill.w{top:9px;opacity:.85}' +
'  .rank .sc{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;font-family:ui-monospace,Consolas,monospace}' +
'  .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--mute);margin:0 0 10px}' +
'  .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:1px;font-style:normal}' +
'  .gtable{width:100%;border-collapse:collapse;font-size:12px}' +
'  .gtable th{position:sticky;top:0;background:#f8fafc;text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap;font-size:11px;color:var(--ink2)}' +
'  .gtable td{padding:6px 8px;border-bottom:1px solid #f1f4f8}' +
'  .gtable td.nm{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink2)}' +
'  .gtable td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}' +
'  .gtable tr:hover td{background:#fafbfd}';
  }

  /* ---------------- 单局入口 ---------------- */
  function buildSingle(entry, opts) {
    opts = opts || {};
    var rep = (entry && entry.report) || null;
    if (!rep) throw new Error('report 缺失');
    var keys = sigKeys(rep);
    var hi = needBand('riskHigh'), mid = needBand('riskMid');
    var o = {
      keys: keys,
      ceil: ceiling(),
      high: hi, mid: mid,
      minHands: needMinHands(),
      meta: (entry.record && entry.record.meta) || {},
    };
    var pl = playersOf(entry);
    assertCounts(rep, { B: rep.black, W: rep.white });

    var meta = o.meta;
    var eng = rep.engine || {};
    var term = rep.terminal || {};
    var nm = meta.opening || {};
    var title = entry.name || meta.roomId || T('viz|未命名');
    var subParts = [
      opts.fromSample ? T('viz|样本') : T('viz|存档'),
      entry.id ? String(entry.id) : '',
      T('viz|规则') + ' ' + ruleLabel(entry.rule || meta.rule),
      T('viz|分析于') + ' ' + stamp(rep.createdAt || entry.createdAt),
    ].filter(Boolean).join(' · ');

    var bar = [
      [T('viz|房间'), meta.roomId || '—'],
      [T('viz|开局'), nm.fullName || nm.name || '—'],
      [T('viz|总手数'), String((rep.steps || []).length) + ' / ' + T('viz|计分') + ' ' + (rep.scoredCount || 0)],
      [T('viz|终局'), term.moveNo ? T('viz|第 {m} 手', { m: term.moveNo }) + ' · ' + (term.reason || '—') : '—'],
      [T('viz|引擎'), (eng.name || '—') + (eng.threadNum ? ' · ' + eng.threadNum + T('viz|线程') : '')],
      [T('viz|机型判定'), meta.identity || '—'],
    ].map(function (p) {
      return '<span>' + esc(p[0]) + ' <b>' + esc(p[1]) + '</b></span>';
    }).join('');

    var html = '<!DOCTYPE html>\n<html lang="' + esc(opts.lang || 'zh-CN') + '">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
      '<title>' + esc(title) + ' · ' + esc(T('viz|检测报告')) + '</title>\n<style>\n' + css() + '\n</style>\n</head>\n<body>\n<div class="wrap">\n' +
      '<header class="top"><h1>' + esc(title) + '</h1><div class="sub">' + esc(subParts) + '</div>' +
      '<div class="metabar">' + bar + '</div></header>\n' +
      '<div class="cards">' + sideCard(rep, 'B', pl, o) + sideCard(rep, 'W', pl, o) + '</div>\n' +
      (opts.signals === false ? '' : secSignals(rep, pl, o)) +
      (opts.timeline === false ? '' : secTimeline(rep, o)) +
      (opts.board === false ? '' : secBoard(rep, pl, o)) +
      (opts.lowRuns === false ? '' : secLowRuns(rep, pl)) +
      (opts.table === false ? '' : secTable(rep)) +
      secHowTo(rep, o) +
      '<footer>' + T('viz|由 {id} 的 report 直接派生 · 引擎 Rapfi-WASM · 本报告信号 {k} 项 · 生成于 {at}',
        { id: entry.id || '—', k: keys.length, at: stamp(new Date().toISOString()) }) + '</footer>\n' +
      '</div>\n</body>\n</html>\n';
    return html;
  }

  /* ---------------- 多局入口 ---------------- */
  function buildMulti(entries, opts) {
    opts = opts || {};
    var list = (entries || []).filter(function (e) { return e && e.report; });
    if (!list.length) throw new Error('没有可导出的对局');
    var hi = needBand('riskHigh'), mid = needBand('riskMid');
    var mh = needMinHands();

    // 每局一个摘要行；风险按「该局较大的那一侧」排序（与存档列表的 maxRisk 同口径）。
    var rows = list.map(function (e) {
      var rep = e.report;
      var b = rep.black || {}, w = rep.white || {};
      var pl = playersOf(e);
      var types = rep.types || {};
      var maxRisk = Math.max(Number(b.risk) || 0, Number(w.risk) || 0);
      // 多局页不标「逐手计入」，但全表里那一列 n 就是镜像的产物 —— 一样对一次账，
      // 免得单局页把这一局拦下、汇总页却照印，两页对同一局给出不同的手数。
      try { assertCounts(rep, { B: b, W: w }); }
      catch (err) { throw new Error((e.name || T('viz|未命名')) + '：' + err.message); }
      return { e: e, rep: rep, b: b, w: w, pl: pl, types: types, maxRisk: maxRisk,
        moves: (rep.steps || []).length };
    }).sort(function (x, y) { return y.maxRisk - x.maxRisk; });

    var sideTotal = 0, sideHigh = 0, sideMid = 0, sideLow = 0, aiCalls = 0, sumRisk = 0;
    rows.forEach(function (r) {
      [['B', r.b], ['W', r.w]].forEach(function (p) {
        if (!p[1] || p[1].risk == null) return;
        var rk = Number(p[1].risk) || 0;
        sideTotal++; sumRisk += rk;
        if (rk >= hi) sideHigh++;
        else if (rk >= mid) sideMid++;
        else sideLow++;
        if (((r.types[p[0]] || {}).type || '') && /Ai$/.test((r.types[p[0]] || {}).type || '')) aiCalls++;
      });
    });

    function kpi(k, v, u) {
      return '<div class="kpi"><span class="k">' + esc(k) + '</span><span class="v">' + v +
        (u ? '<span class="u">' + esc(u) + '</span>' : '') + '</span></div>';
    }

    var kpis = '<div class="kpis">' +
      kpi(T('viz|对局'), String(rows.length)) +
      kpi(T('viz|参评侧'), String(sideTotal)) +
      kpi(T('viz|高风险'), String(sideHigh), '≥' + Math.round(hi)) +
      kpi(T('viz|可疑'), String(sideMid), '≥' + Math.round(mid)) +
      kpi(T('viz|低风险'), String(sideLow)) +
      kpi(T('viz|判 AI'), String(aiCalls), 'n≥' + mh) +
      kpi(T('viz|平均分'), sideTotal ? n1(sumRisk / sideTotal) : '—') +
    '</div>';

    // §1 排行：每局一条轨道，黑在上白在下
    var trackMax = Math.max.apply(null, rows.map(function (r) { return r.maxRisk; }).concat([1]));
    var rank = '<ul class="rank">' + rows.map(function (r) {
      function barOf(v, cls) {
        var p = Math.max(0, Math.min(100, (Number(v) || 0) / trackMax * 100));
        return '<div class="fill ' + cls + '" style="width:' + p.toFixed(1) + '%;background:' + (cls === 'b' ? C.B : C.W) + '"></div>';
      }
      return '<li><span class="nm" title="' + esc(r.e.name || '') + '">' + esc(r.e.name || T('viz|未命名')) + '</span>' +
        '<span class="track">' + barOf(r.b.risk, 'b') + barOf(r.w.risk, 'w') + '</span>' +
        '<span class="sc">' + n1(r.maxRisk, 0) + '</span></li>';
    }).join('') + '</ul>';

    var rankSec = '<section class="card"><h2>' + esc(T('viz|一、风险排行（每局取较大的一侧）')) + '</h2>' +
      '<div class="legend"><span><i style="background:' + C.B + '"></i>' + esc(T('viz|黑方')) + '</span>' +
      '<span><i style="background:' + C.W + '"></i>' + esc(T('viz|白方')) + '</span>' +
      '<span>' + esc(T('viz|最高 {v}', { v: n1(trackMax, 0) })) + '</span></div>' +
      '<p class="note">' + T('viz|排行按每局<b>较大的一侧</b>排序 —— 与存档列表的「AI 率」同一口径。同一条轨道上蓝（黑）在上、红（白）在下，长度就是分数。三档线 {hi} / {mid}。', { hi: hi == null ? '—' : hi, mid: mid == null ? '—' : mid }) + '</p>' +
      rank + '</section>';

    // §2 双方散点：x=黑，y=白
    var SW = 560, SH = 400, sp0 = 46;
    var scMax = Math.max(trackMax, 1);
    function sx(v) { return sp0 + (v / scMax) * (SW - sp0 - 18); }
    function sy(v) { return SH - sp0 - (v / scMax) * (SH - sp0 - 18); }
    var pts = rows.map(function (r) {
      var col = (Number(r.maxRisk) >= hi) ? C.high
        : (Number(r.maxRisk) >= mid) ? C.mid : C.low;
      return '<circle cx="' + sx(Number(r.b.risk) || 0).toFixed(1) + '" cy="' + sy(Number(r.w.risk) || 0).toFixed(1) +
        '" r="5" fill="' + col + '" fill-opacity="0.75" stroke="#fff" stroke-width="1"><title>' +
        esc((r.e.name || '') + ' · ' + T('viz|黑方') + ' ' + n1(r.b.risk) + ' / ' + T('viz|白方') + ' ' + n1(r.w.risk)) +
        '</title></circle>';
    }).join('');
    var diag = '<line x1="' + sx(0) + '" y1="' + sy(0) + '" x2="' + sx(scMax) + '" y2="' + sy(scMax) + '" stroke="#e4e8ef" stroke-dasharray="4 3"/>';
    var cutLines = '';
    [[hi, C.high], [mid, C.mid]].forEach(function (p) {
      if (p[0] == null) return;
      cutLines += '<line x1="' + sx(p[0]) + '" y1="' + sy(0) + '" x2="' + sx(p[0]) + '" y2="' + sy(scMax) + '" stroke="' + p[1] + '" stroke-opacity="0.35" stroke-dasharray="3 3"/>' +
        '<line x1="' + sx(0) + '" y1="' + sy(p[0]) + '" x2="' + sx(scMax) + '" y2="' + sy(p[0]) + '" stroke="' + p[1] + '" stroke-opacity="0.35" stroke-dasharray="3 3"/>';
    });
    var scatter = '<section class="card"><h2>' + esc(T('viz|二、每一局落在哪：黑方 × 白方')) + '</h2>' +
      '<p class="note">' + T('viz|一个点是一局：横轴黑方、纵轴白方。虚对角线是两侧同分，彩色虚线是三档线。落在右上角的两侧都高，最值得先看；点色按这一局较大的那一侧着色。') + '</p>' +
      '<svg viewBox="0 0 ' + SW + ' ' + SH + '" width="100%" style="max-width:620px" role="img" aria-label="' + esc(T('viz|双方散点')) + '">' +
        '<rect x="' + sp0 + '" y="18" width="' + (SW - sp0 - 18) + '" height="' + (SH - sp0 - 18) + '" fill="#fbfcfe" stroke="#eef1f6"/>' +
        diag + cutLines + pts +
        '<text x="' + (sp0 - 8) + '" y="' + sy(0) + '" text-anchor="end" font-size="9.5" fill="#98a2b0">0</text>' +
        '<text x="' + (sp0 - 8) + '" y="' + (sy(scMax) + 4) + '" text-anchor="end" font-size="9.5" fill="#98a2b0">' + n1(scMax, 0) + '</text>' +
        '<text x="' + sx(0) + '" y="' + (SH - sp0 + 16) + '" font-size="9.5" fill="#98a2b0">0</text>' +
        '<text x="' + sx(scMax) + '" y="' + (SH - sp0 + 16) + '" text-anchor="end" font-size="9.5" fill="#98a2b0">' + n1(scMax, 0) + '</text>' +
        '<text x="' + ((SW - 18 + sp0) / 2) + '" y="' + (SH - 8) + '" text-anchor="middle" font-size="10" fill="#8894a5">' + esc(T('viz|黑方分数')) + '</text>' +
        '<text x="12" y="' + ((SH - sp0 + 18) / 2) + '" font-size="10" fill="#8894a5" transform="rotate(-90 12 ' + ((SH - sp0 + 18) / 2) + ')" text-anchor="middle">' + esc(T('viz|白方分数')) + '</text>' +
      '</svg></section>';

    // §3 全表
    var table = '<section class="card"><h2>' + esc(T('viz|三、{n} 局全表', { n: rows.length })) + '</h2>' +
      '<p class="note">' + T('viz|判词列只印产品给出的那一句（两侧各一）。「n」是有效手数 —— 门槛以下的侧分数再高也不给判词。') + '</p>' +
      '<div class="tblwrap" style="max-height:none"><table class="gtable"><thead><tr>' +
        ['viz|对局', 'viz|手数', 'viz|黑方分数', 'viz|白方分数', 'viz|判词', 'viz|n', 'viz|终局']
          .map(function (k) { return '<th>' + esc(T(k)) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(function (r) {
        function cellOf(k, a) {
          var lv = a.level || '';
          var ty = (r.types[k] || {}).type;
          return '<td><span style="color:' + levelColor(lv) + ';font-weight:600">' + n1(a.risk, 0) + '</span> ' +
            '<span style="color:#8894a5;font-size:11px">' + esc(levelName(lv)) + (ty ? ' · ' + esc(typeName(ty)) : '') + '</span></td>';
        }
        var term = r.rep.terminal;
        return '<tr><td class="nm" title="' + esc(r.e.name || '') + '">' + esc(r.e.name || T('viz|未命名')) + '</td>' +
          '<td class="num">' + r.moves + '</td>' +
          cellOf('B', r.b) + cellOf('W', r.w) +
          '<td>' + esc(typeName((r.types.B || {}).type)) + ' / ' + esc(typeName((r.types.W || {}).type)) + '</td>' +
          '<td class="num">' + (r.b.n == null ? '—' : r.b.n) + ' / ' + (r.w.n == null ? '—' : r.w.n) + '</td>' +
          '<td>' + esc(term && term.moveNo ? T('viz|第 {m} 手', { m: term.moveNo }) + ' · ' + (term.reason || '—') : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';

    // §4 每局摘要（只给分数条与判词，不铺逐手图）
    var brief = '<section class="card"><h2>' + esc(T('viz|四、逐局摘要')) + '</h2>' +
      '<p class="note">' + T('viz|每局两条分数条：长度按全批最高分归一，颜色就是三档。要看逐手与信号明细，请对这一局单独导出（勾选一局即得单局页）。') + '</p>' +
      rows.map(function (r) {
        function mini(k) {
          var a = r[k === 'B' ? 'b' : 'w'];
          if (!a || a.risk == null) return '';
          var lv = a.level || '';
          return '<div class="mini-row"><span class="mini-k">' + esc(k === 'B' ? T('viz|黑方') : T('viz|白方')) + '</span>' +
            '<span class="mini-bar"><i style="width:' + Math.min(100, (Number(a.risk) || 0) / trackMax * 100).toFixed(1) + '%;background:' + levelColor(lv) + '"></i></span>' +
            '<span class="mini-v">' + n1(a.risk) + '</span>' +
            '<span class="mini-lv" style="color:' + levelColor(lv) + '">' + esc(levelName(lv)) + ' · ' + esc(typeName((r.types[k] || {}).type)) + '</span></div>';
        }
        return '<div class="mini"><div class="mini-h">' + esc(r.e.name || T('viz|未命名')) +
          '<span class="mini-m">' + r.moves + ' ' + esc(T('viz|手')) + '</span></div>' +
          mini('B') + mini('W') + '</div>';
      }).join('') +
      '</section>';

    var title = T('viz|对局数据可视化 · {n} 局', { n: rows.length });
    var html = '<!DOCTYPE html>\n<html lang="' + esc(opts.lang || 'zh-CN') + '">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
      '<title>' + esc(title) + '</title>\n<style>\n' + css() +
      '\n.mini{border:1px solid var(--line);border-radius:10px;padding:9px 12px;margin-bottom:9px}' +
      '\n.mini-h{font-size:12px;font-weight:600;margin-bottom:5px;display:flex;justify-content:space-between;gap:10px}' +
      '\n.mini-m{font-weight:400;color:var(--mute);font-size:11px}' +
      '\n.mini-row{display:grid;grid-template-columns:38px 1fr 52px 150px;gap:8px;align-items:center;font-size:11px;padding:1.5px 0}' +
      '\n.mini-k{color:var(--mute)}' +
      '\n.mini-bar{height:7px;background:#f2f5f9;border-radius:4px;overflow:hidden}' +
      '\n.mini-bar i{display:block;height:7px;border-radius:4px}' +
      '\n.mini-v{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace}' +
      '\n.mini-lv{font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '\n</style>\n</head>\n<body>\n<div class="wrap">\n' +
      '<header class="top"><h1>' + esc(title) + '</h1>' +
      '<div class="sub">' + esc(T('viz|生成于') + ' ' + stamp(new Date().toISOString())) +
      ' · ' + esc(T('viz|口径：三档 {hi}/{mid}，证据门槛 n≥{n}', { hi: hi == null ? '—' : hi, mid: mid == null ? '—' : mid, n: mh == null ? '—' : mh })) +
      '</div></header>\n' +
      kpis + rankSec + scatter + table + brief +
      '<section class="card read"><h2>' + esc(T('viz|这一页怎么读')) + '</h2><ol>' +
        '<li>' + T('viz|这是<b>多局汇总</b>，不是某一局的报告：排行与散点说的是「哪几局最值得看」，逐手细节要回到单局页。') + '</li>' +
        '<li>' + T('viz|「判 AI」只数真正给出了 AI 系判词（弱AI / 疑似AI / 规避型）的侧，并且要求有效手数过门槛；分数高而手数不够的侧不算 —— 那正是门槛在挡的东西。') + '</li>' +
        '<li>' + T('viz|不同批次的分析可能用不同的权重表（历史档案就是当时那张表算的），所以跨批次的分数<b>不可直接并列</b>；同一批里可以。') + '</li>' +
      '</ol></section>' +
      '<footer>' + T('viz|共 {n} 局 · 由各局 report 直接派生 · 生成于 {at}', { n: rows.length, at: stamp(new Date().toISOString()) }) + '</footer>\n' +
      '</div>\n</body>\n</html>\n';
    return html;
  }

  root.GMViz = {
    buildSingle: buildSingle,
    buildMulti: buildMulti,
    countsForSide: countsForSide,
    sigKeys: sigKeys,
    css: css,
  };
})(typeof self !== 'undefined' ? self : this);
