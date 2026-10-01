/* Gomoku Detector — 0.3.3 sample-driven learner.
 *
 * WHAT "LEARNING" MEANS HERE
 * --------------------------
 * Rapfi is a fixed-weight WASM build. There is no fine-tuning hook, no gradient, no
 * training loop — and pretending otherwise would produce a feature that quietly does
 * nothing. So the learning lives one layer up, in the DETECTOR'S POST-PROCESSING, which
 * is the only part of the pipeline this project actually owns:
 *
 *   A. thresholds  the cut lines that turn a measured rate into a 0..1 sub-score
 *                  (the aTop1 / aAcpl / aOut ramps, the 高风险 / 可疑 risk cuts)
 *   B. weights     how much each sub-score contributes to the risk total
 *   C. features    a library of feature vectors taken from human-confirmed AI moves,
 *                  matched against new games by cosine similarity
 *
 * Everything is plain statistics over the operator's annotations: weighted F1 grid
 * search for A, weighted AUC for B, nearest-neighbour similarity for C. No ML runtime.
 *
 * WHAT THIS FILE DEPENDS ON
 * -------------------------
 * Nothing at load time. It reads GMStorage.DEFAULT_WEIGHTS / DEFAULT_THRESHOLDS when
 * storage.js is present (the browser) and falls back to an identical local copy when it
 * is not (a Node test harness) — so the numbers live in exactly one authoritative place
 * in the browser, and the fallback is provably the same six/four constants.
 *
 * THE MIRROR RULE
 * ---------------
 * `subscoresForSide()` below recomputes app.js's sideAggregate sub-terms (aTop1, aAcpl,
 * aSharp, aOut, aDesperate, aTime — plus, since 0.4.2, aEvasion and aWinBlunder, and the same
 * exclusion of evasion hands from the six). It is a deliberate copy: learn.js must be usable
 * without app.js (and app.js without learn.js). If you change a ramp in one, change it
 * in the other — both read their anchors from the same DEFAULT_THRESHOLDS object, so
 * only the *shape* of the formula is duplicated, not the numbers.
 */
(function (g) {
  'use strict';
  if (g.GMLearn) return;

  var FALLBACK_WEIGHTS = {
    top1: 0.20, acpl: 0.08, sharp: 0.22, out: 0.27, desperate: 0.08, time: 0.15,
    evasion: 0.06, winBlunder: 0.04,
    // 0.4.7 §1.1: the useless-four-run surcharge. See app.js BASE_WEIGHTS for the reasoning
    // behind 0.05 (§1.1 names 0.05 twice and compares it to `desperate`, which is 0.08).
    uselessFour: 0.05,
    // 0.4.8 §1.2: the two 唯一手 streak surcharges. Same status as the three above — added on
    // top of the six, so they are learned inside the surcharge budget rather than normalised
    // with the base. See app.js BASE_WEIGHTS for why §1.2's single 1.00 table is not adopted.
    sharpStreak: 0.04,
    sharpTotal: 0.03,
    // 0.5.2 §1.1.4/§1.2.4: the two pool surcharges. Same status as the five above, and same
    // reason §1.1.4's 「缩小到总和 1.00」 is not adopted (see app.js BASE_WEIGHTS).
    goodPool: 0.03,
    liveThree: 0.03,
  };
  var FALLBACK_THRESHOLDS = {
    // 0.4.3 §1.1: the ramp aTop1 reads. top1Lo/top1Hi stay for a pre-0.4.3 archive and for the
    // `opts.legacyTop1` comparison path, but nothing the detector runs reads them any more.
    // 0.4.7 §1.2: Lo 0.50 -> 0.45.
    topProxLo: 0.45, topProxHi: 0.90,
    top1Lo: 0.72, top1Hi: 0.90,
    acplLo: 0.003, acplHi: 0.015,
    sharpHitLo: 0.65, sharpHitSpan: 0.35,
    outTop5Hi: 0.03,
    riskHigh: 70, riskMid: 40,
    simWeight: 0.10,
    // 0.4.2 §4.3
    evasionLoss: 0.20, goodLoss: 0.05, evasionMin: 3, evasionReg: 0.35, winningWR: 0.85,
    // 0.4.3 §1.6
    typeAiMin: 75, typeSuspectMin: 55, typeProMin: 45, typeExpertMin: 30,
    // 0.4.7 §1.1
    fourVcfWR: 0.90, fourLostWR: 0.10,
  };

  // 0.3.3 §3.5. Kept in sync with storage.js (which the viewer reads to gate the button);
  // repeated here so the learner refuses a bad run even when called directly.
  var MIN_SAMPLES = 5;
  var LOW_SAMPLES = 20;

  var BASE_KEYS = ['top1', 'acpl', 'sharp', 'out', 'desperate', 'time'];
  // 0.4.2 §2.3: the two evasion terms are a SURCHARGE — they add to the risk score instead of
  // taking a share of it (see app.js BASE_WEIGHTS for why). So they are learned inside their
  // own budget rather than normalised together with the six: normalising all eight to 1 would
  // scale the six down to ~0.9 and drop every score by 10%, which is exactly what 0.4.2
  // §2.6 #6 forbids. The two groups are therefore normalised separately, to 1.00 and 0.10.
  //
  // 0.4.7 §1.1 puts `uselessFour` in the SURCHARGE group too, and for the same reason: it is
  // added on top of the six, so folding it into the base budget would take a slice out of
  // Top1/ACPL/… and move every existing score. The surcharge budget is now 0.15 (0.06 + 0.04
  // + 0.05), read off the defaults by `group()` below, so adding the key here is all the
  // wiring the learner needs.
  var EVASION_KEYS = ['evasion', 'winBlunder', 'uselessFour', 'sharpStreak', 'sharpTotal',
                      // 0.5.2 §1.1.4/§1.2.4 — the surcharge budget is read off the defaults by
                      // `group()` below, so listing the two keys here is the whole wiring.
                      'goodPool', 'liveThree'];
  var WEIGHT_KEYS = BASE_KEYS.concat(EVASION_KEYS);

  // 0.5.2 §1.1/§1.2 — the two pool thresholds, mirrored from app.js (GOOD_POOL_MIN /
  // LIVE_POOL_MIN). learn.js is a separate module and cannot import app.js, so they are repeated
  // here; verify-055 asserts the two files agree, so an edit to one cannot move without the
  // other being reported.
  var GOOD_POOL_MIN = 3;
  var LIVE_POOL_MIN = 2;

  var WEIGHT_LABEL = {
    top1: 'Top1 吻合', acpl: 'ACPL 均损', sharp: '唯一手', out: 'Top5 之外',
    desperate: '将败冲四', time: '时间规律',
    evasion: '回避手', winBlunder: '将胜乱下',
    // 0.4.7 §1.1
    uselessFour: '无用冲四',
    // 0.4.8 §1.2
    sharpStreak: '唯一手连续', sharpTotal: '唯一手累计',
    // 0.5.2 §1.1.4/§1.2.4
    goodPool: '好点池', liveThree: '活三好手',
  };
  var THRESHOLD_LABEL = {
    topProxLo: '接近度下界', topProxHi: '接近度上界',
    top1Lo: 'Top1 下界', top1Hi: 'Top1 上界',
    acplLo: 'ACPL 优（低损）', acplHi: 'ACPL 差（高损）',
    sharpHitLo: '唯一手命中下界', sharpHitSpan: '唯一手跨度',
    outTop5Hi: 'Top5 之外 上界',
    riskHigh: '高风险线', riskMid: '可疑线', simWeight: '特征库权重',
    evasionLoss: '回避手损失阈值', goodLoss: '好棋损失上限',
    evasionMin: '规律性最小回避数', evasionReg: '规律性标准差上限',
    winningWR: '将胜胜率阈值',
    // 0.4.3 §1.6
    typeAiMin: 'AI 档线', typeSuspectMin: '疑似AI 档线',
    typeProMin: '职业选手 档线', typeExpertMin: '高手玩家 档线',
    // 0.4.7 §1.1
    fourVcfWR: '冲四 VCF 胜率线', fourLostWR: '冲四 必败胜率线',
  };

  // ---------- small stats helpers ----------
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  // 0.5.2 §1.1.4/§1.2.4 — the longest run of a per-hand pool figure over a sequence. Absent or
  // non-numeric reads as 0, which is what makes a pre-0.5.2 archive score 0 on both new terms.
  function maxOf(list, key) {
    var m = 0;
    for (var i = 0; i < list.length; i++) {
      var v = list[i][key];
      if (isFinite(v) && v > m) m = v;
    }
    return m;
  }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function r4(x) { return Math.round(x * 10000) / 10000; }
  function clone(o) { var r = {}; for (var k in o) r[k] = o[k]; return r; }
  function merge(base, patch) {
    var r = clone(base);
    if (patch) for (var k in patch) if (patch[k] != null) r[k] = patch[k];
    return r;
  }
  // Only merge the keys we know about — a hand-edited or older learnedParams entry must not
  // be able to inject an unknown field into the detector's maths.
  function mergeKnown(base, patch) {
    var r = clone(base);
    if (patch) for (var k in base) if (patch[k] != null && isFinite(patch[k])) r[k] = patch[k];
    return r;
  }

  function pearson(xs, ys) {
    var n = xs.length;
    if (n < 3) return 0;
    var mx = mean(xs), my = mean(ys), num = 0, dx = 0, dy = 0;
    for (var i = 0; i < n; i++) {
      var a = xs[i] - mx, b = ys[i] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    if (!dx || !dy) return 0;
    return num / Math.sqrt(dx * dy);
  }

  // 0.4.3 §1.1, mirrored from app.js stepProximity(): how close this hand came to the engine's
  // first choice. 0.4.7 §1.2 makes it three tiers — 1.0 = Top1, 0.80 = Top2-5, 0.50 = Top6-8
  // (only reachable on a >6s hand, see app.js nbestFor), 0 = further down. Both 0.3.1 terms
  // that used to read a binary top-1 hit read this now, which is what stops a side that keeps
  // landing on Top2-T5 from scoring as if it had no engine agreement at all.
  //
  // THE MIRROR RULE: this must stay identical to app.js's copy. The two are tested against
  // each other (verify-047) precisely because a silent divergence here would mean the learner
  // trains weights for a formula the detector does not run.
  function proximity(s) {
    if (s.top1) return 1.0;
    if (s.top5) return 0.80;
    if (s.top8) return 0.50;
    return 0;
  }

  // Higher input -> higher sub-score. Guarded so a learned lo/hi pair can never divide by
  // zero or invert (an inverted ramp would silently score a suspicious game as clean).
  function rampUp(v, lo, hi) {
    if (!(hi > lo)) return v >= hi ? 1 : 0;
    return clamp((v - lo) / (hi - lo), 0, 1);
  }
  // Lower input -> higher sub-score (loss, out-of-top5 rate).
  function rampDown(v, lo, hi) {
    if (!(hi > lo)) return v <= lo ? 1 : 0;
    return clamp((hi - v) / (hi - lo), 0, 1);
  }

  function defaultWeights() {
    var w = (g.GMStorage && g.GMStorage.DEFAULT_WEIGHTS) || FALLBACK_WEIGHTS;
    return clone(w);
  }
  function defaultThresholds() {
    var t = (g.GMStorage && g.GMStorage.DEFAULT_THRESHOLDS) || FALLBACK_THRESHOLDS;
    return clone(t);
  }

  // ---------- sample role / weight (0.3.3 §3.3) ----------
  // A sample's role decides which side of the classifier it feeds. Only the explicit
  // game-level tags count: inferring "this was an AI game" from a handful of AI步骤 marks
  // would let a single annotation relabel the whole game and poison both classes.
  function sampleRole(s) {
    var tags = (s && s.tags) || [];
    if (tags.indexOf('AI 样本') >= 0 || tags.indexOf('AI样本') >= 0) return 'ai';
    if (tags.indexOf('人类样本') >= 0) return 'human';
    return null;
  }

  // 0.3.5 §3.4: the role of ONE SIDE, which is what 黑方AI / 白方AI exist to express. A game
  // where only black was an AI used to be unlabellable — 双方样本 says which moves are
  // evidence, not who played them, and 人类样本 would have called black's hands human too.
  //
  // Priority is explicit: the side tag is the more precise claim, so it decides that side
  // outright (even against a contradictory game-level tag — with 人类样本 + 黑方AI the side
  // tag wins for black); the game-level tag is the fallback for the sides it does not name.
  // Returns 'ai' | 'human' | null (null = this sample says nothing about that side).
  function sideRole(s, side) {
    var tags = (s && s.tags) || [];
    var sideAI = side === 'B' ? tags.indexOf('黑方AI') >= 0
               : side === 'W' ? tags.indexOf('白方AI') >= 0
               : false;
    if (sideAI) return 'ai';
    // 人类样本 names a human game, so it covers BOTH untagged sides — which is what makes
    // 「人类样本 + 白方AI」 work: black is the human, white is not.
    if (tags.indexOf('人类样本') >= 0) return 'human';
    return sampleRole(s);
  }

  // 标准样本 ×1.5 (a verified reference), 存疑样本 ×0.5 (the operator is unsure, so it
  // gets a vote but not a loud one). Anything else ×1.
  function sampleWeight(s) {
    var tags = (s && s.tags) || [];
    if (tags.indexOf('存疑样本') >= 0) return 0.5;
    if (tags.indexOf('标准样本') >= 0) return 1.5;
    return 1;
  }

  // 黑方打谱样本 -> only black's moves are evidence; 白方 -> white's; 双方样本 -> both.
  function sideFilter(s) {
    var tags = (s && s.tags) || [];
    if (tags.indexOf('黑方打谱样本') >= 0) return 'B';
    if (tags.indexOf('白方打谱样本') >= 0) return 'W';
    return null;
  }

  function annOf(s) {
    return (s && s.annotations && typeof s.annotations === 'object') ? s.annotations : {};
  }
  function labelsOf(s, moveNo) {
    var a = annOf(s)[moveNo];
    return (a && Array.isArray(a.labels)) ? a.labels : [];
  }

  // ---------- C: feature vectors ----------
  // A step's fingerprint, every component already normalised to 0..1 so a plain cosine
  // similarity is meaningful without a separate scaler. `gap` (the margin between the
  // engine's best and second-best candidate) and `bestWR` (the position evaluation) are
  // reconstructed from the stored candidate list, which is what the archive keeps.
  var SIM_KEYS = ['top1', 'top3', 'top5', 'loss', 'isSharp', 'bestWR', 'gap', 'moveNo', 'thinkMs'];
  var SIM_LABEL = ['Top1', 'Top3', 'Top5', '胜率差', '唯一手', '局面评估', '候选分差', '手数', '耗时'];

  function stepGap(step) {
    var c = (step && step.cands) || [];
    if (c.length < 2 || c[0].winrate == null || c[1].winrate == null) return 0;
    return Math.max(0, c[0].winrate - c[1].winrate);
  }

  function featureVector(step) {
    var mn = step.moveNo == null ? 0 : step.moveNo;
    var tk = step.thinkMs == null ? 5000 : step.thinkMs;
    return [
      step.top1 ? 1 : 0,
      step.top3 ? 1 : 0,
      step.top5 ? 1 : 0,
      step.loss == null ? 0 : clamp(step.loss, 0, 1),
      step.isSharp ? 1 : 0,
      step.bestWR == null ? 0.5 : clamp(step.bestWR, 0, 1),
      clamp(stepGap(step), 0, 1),
      clamp(mn, 0, 60) / 60,
      clamp(tk, 0, 10000) / 10000,
    ];
  }

  function featureMatch(a, b) {
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  // Every human-confirmed AI move becomes one library entry (0.3.3 §3.2 C). Entries from
  // a whole game tagged AI样本 count too — the tag IS a human confirmation, just at game
  // granularity.
  function buildFeatureLibrary(samples, opts) {
    opts = opts || {};
    var lib = [];
    (samples || []).forEach(function (s) {
      var role = sampleRole(s);
      var sf = sideFilter(s);
      var steps = (s.report && s.report.steps) || [];
      steps.forEach(function (step) {
        if (!step || !step.analyzed) return;
        if (sf && step.side !== sf) return;
        // 0.3.5 §3.4: `role` is the game-level answer, `sideRole` the per-side one — either
        // can say "AI", and a hand annotated AI步骤 says it about itself regardless.
        var isAI = labelsOf(s, step.moveNo).indexOf('AI步骤') >= 0
          || role === 'ai' || sideRole(s, step.side) === 'ai';
        if (!isAI) return;
        lib.push({ sampleId: s.id, moveNo: step.moveNo, side: step.side, v: featureVector(step) });
      });
    });
    return lib;
  }

  // Marks steps whose fingerprint matches a known AI move. Returns how many were marked;
  // the flag lands on the step itself (`aiSimilar` / `aiSim`) so the report and the step
  // table can show it without a second pass.
  //
  // WHY 0.92 IS A LOOSE LINE, AND WHY THAT IS FINE
  // ---------------------------------------------
  // The engine is time-budgeted, so it is NOT reproducible: `analyzePosition` returns
  // whatever iterative deepening reached when the clock ran out. Two runs over the same
  // position with identical options can disagree on `loss` and `bestWR`, and can even flip
  // `top1` to a different best move. Measured on the 8-move fixture in probe-033-sim.cjs:
  // two identical 300ms runs scored cosines 1.0, 0.9998, 0.9978, 0.9989, 0.5854, 0.7484,
  // 0.8670, 0.9844 against each other — one run flagged top1 on move 7, the other did not.
  //
  // So a library entry built from a game does NOT self-match at exactly 1.0 later. Two of
  // those eight steps fell below this threshold. That is the honest ceiling of this
  // technique, not a bug: the same 9-dim vector is compared, the same numbers are stored
  // (slimReport round-trips losslessly — verified in the same probe), and the difference
  // comes entirely from the engine's own variance.
  //
  // This is exactly why the fingerprint match claims only `simWeight` (default 0.10) of the
  // risk score instead of being decisive, and why it is a ring on the board rather than a
  // verdict. Do not "fix" a low hit rate by lowering this number to 0.5 — at that distance
  // an unrelated human move also matches, and the term stops carrying information.
  function matchFeatures(steps, library, threshold) {
    var th = threshold == null ? 0.92 : threshold;
    var hit = 0;
    (steps || []).forEach(function (step) {
      step.aiSimilar = false;
      step.aiSim = null;
      if (!library || !library.length || !step.analyzed) return;
      var v = featureVector(step);
      var best = 0;
      for (var i = 0; i < library.length; i++) {
        var sim = featureMatch(v, library[i].v);
        if (sim > best) best = sim;
      }
      step.aiSim = r4(best);
      if (best >= th) { step.aiSimilar = true; hit++; }
    });
    return hit;
  }

  // ---------- A: per-metric threshold, weighted F1 grid search ----------
  // Faithful to 0.3.3 §3.2 A (grid 0.05..0.95 step 0.05, maximise F1), with the two
  // additions the spec asks for elsewhere: sample weights (§3.3) and the 黑方/白方 打谱
  // side filter.
  var METRIC_FN = {
    top1: function (s) { return s.top1 ? 1 : 0; },
    // 0.4.3 §1.1: the same grade the risk model consumes, so the F1 grid search reports a cut
    // for the number the detector actually uses instead of for the retired top-1 rate.
    proximity: function (s) { return proximity(s); },
    top3: function (s) { return s.top3 ? 1 : 0; },
    top5: function (s) { return s.top5 ? 1 : 0; },
    loss: function (s) { return s.loss == null ? null : s.loss; },
    bestWR: function (s) { return s.bestWR == null ? null : s.bestWR; },
    gap: function (s) { return stepGap(s); },
    isSharp: function (s) { return s.isSharp ? 1 : 0; },
    outsideTop5: function (s) { return s.outsideTop5 ? 1 : 0; },
    desperate: function (s) { return s.desperate ? 1 : 0; },
  };
  var METRIC_KEYS = Object.keys(METRIC_FN);

  function collectMetricSamples(samples, metric) {
    var fn = METRIC_FN[metric];
    if (!fn) return null;
    var pos = [], neg = [];
    (samples || []).forEach(function (s) {
      var w = sampleWeight(s);
      var sf = sideFilter(s);
      var steps = (s.report && s.report.steps) || [];
      steps.forEach(function (step) {
        if (sf && step.side !== sf) return;
        var v = fn(step);
        if (v == null || !isFinite(v)) return;
        var labels = labelsOf(s, step.moveNo);
        // 0.3.5 §3.4: the class comes from THIS side's role, so a 「白方AI」 game feeds the
        // positive set from white's hands and says nothing about black's — which is the
        // whole point of tagging a side rather than the game. An explicit AI步骤 annotation
        // still wins: it is a claim about this hand, not about who was playing.
        var sr = sideRole(s, step.side);
        if (sr === 'ai' || labels.indexOf('AI步骤') >= 0) pos.push({ v: v, w: w });
        else if (sr === 'human' || labels.indexOf('人类样本') >= 0) neg.push({ v: v, w: w });
      });
    });
    return { pos: pos, neg: neg };
  }

  function optimizeThreshold(samples, metric) {
    var c = collectMetricSamples(samples, metric);
    if (!c || !c.pos.length || !c.neg.length) return null;
    var grid = [];
    for (var t = 0.05; t <= 0.9501; t += 0.05) {
      var tp = 0, fp = 0, fn = 0;
      for (var i = 0; i < c.pos.length; i++) { if (c.pos[i].v >= t) tp += c.pos[i].w; else fn += c.pos[i].w; }
      for (var j = 0; j < c.neg.length; j++) { if (c.neg[j].v >= t) fp += c.neg[j].w; }
      var precision = (tp + fp) ? tp / (tp + fp) : 0;
      var recall = (tp + fn) ? tp / (tp + fn) : 0;
      var f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
      grid.push({ t: +t.toFixed(2), f1: f1 });
    }
    var mid = (mean(c.pos.map(function (p) { return p.v; })) + mean(c.neg.map(function (n) { return n.v; }))) / 2;
    var best = pickCut(grid, mid);
    return { metric: metric, threshold: best.t, f1: best.f1, pos: c.pos.length, neg: c.neg.length };
  }

  // Among the grid points that reach the best F1, take the one nearest `mid` — the midpoint
  // of the two class means, i.e. the maximum-margin choice. Without this tie-break a
  // perfectly separable dataset returns the FIRST qualifying grid point: on the risk grid
  // that is 20, which would label almost every game 高风险 even though every cut in the
  // gap scored identically. The tie-break turns "a cut that works" into "the cut that is
  // furthest from both classes".
  function pickCut(grid, mid) {
    var bestF1 = -Infinity;
    for (var i = 0; i < grid.length; i++) if (grid[i].f1 > bestF1) bestF1 = grid[i].f1;
    var best = grid[0], bestD = Infinity;
    for (var j = 0; j < grid.length; j++) {
      if (grid[j].f1 < bestF1 - 1e-9) continue;
      var d = Math.abs(grid[j].t - mid);
      if (d < bestD) { bestD = d; best = grid[j]; }
    }
    return best;
  }

  // ---------- B: sub-score weights from AUC ----------
  // 0.4.2 §2.3: the per-side evasion figures, mirroring app.js's evasionStats(). `all` is the
  // side's whole scored sequence (evasions included); the caller passes it because the main
  // statistics use the sequence with the evasions taken OUT of it.
  function evasionFigures(all, th) {
    var count = 0, winBlunders = 0, regularity = 0, i;
    for (i = 0; i < all.length; i++) if (all[i].evasion) count++;
    var minEv = th.evasionMin != null ? th.evasionMin : 3;
    if (count >= minEv) {
      var positions = [];
      for (i = 0; i < all.length; i++) if (all[i].evasion) positions.push(i);
      var gaps = [];
      for (i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
      if (gaps.length) {
        var gm = mean(gaps), gs = 0;
        for (i = 0; i < gaps.length; i++) gs += Math.pow(gaps[i] - gm, 2);
        var std = Math.sqrt(gs / gaps.length);
        var regMax = th.evasionReg != null ? th.evasionReg : 0.35;
        regularity = gm > 0 ? clamp(1 - std / gm / Math.max(1e-6, regMax), 0, 1) : 0;
      }
    }
    var winWR = th.winningWR != null ? th.winningWR : 0.85;
    var lossMin = th.evasionLoss != null ? th.evasionLoss : 0.20;
    for (i = 0; i < all.length; i++) {
      var s = all[i];
      if (s.bestWR != null && s.bestWR >= winWR && s.loss != null && s.loss >= lossMin) winBlunders++;
    }
    return { count: count, regularity: regularity, winBlunders: winBlunders };
  }

  // app.js's per-side sub-terms, recomputed here (see THE MIRROR RULE at the top).
  function subscoresForSide(rep, side, hasTime, th) {
    var all = ((rep && rep.steps) || []).filter(function (x) {
      return x.side === side && !x.isOpening && x.analyzed && !x.forcedDefense;
    });
    // 0.4.2 §2.3: the main six are computed over the sequence WITHOUT the evasion hands, exactly
    // as sideAggregate() does. A sample archived before 0.4.2 has no `evasion` field at all, so
    // this is a no-op for it — which is what keeps an old corpus training the same way.
    var steps = all.filter(function (x) { return !x.evasion; });
    if (!steps.length) return null;
    var top1 = mean(steps.map(function (x) { return x.top1 ? 1 : 0; }));
    var topProx = mean(steps.map(proximity));
    var losses = steps.map(function (x) { return x.loss; }).filter(function (v) { return v != null; });
    var meanLoss = mean(losses);
    var sharp = steps.filter(function (x) { return x.isSharp; });
    // 0.4.3 §1.1: graded, exactly as app.js computes it. A sharp hand that landed on Top2-3 is
    // engine-like precision and used to be scored as zero.
    var sharpHit = sharp.length ? mean(sharp.map(proximity)) : null;
    var outTop5 = mean(steps.map(function (x) { return x.outsideTop5 ? 1 : 0; }));
    var desperateCount = steps.filter(function (x) { return x.desperate; }).length;

    var time = null;
    if (hasTime) {
      var tm = steps.map(function (x) { return x.thinkMs; }).filter(function (v) { return v != null; });
      if (tm.length >= 3) {
        var meanT = mean(tm);
        var stdT = Math.sqrt(mean(tm.map(function (v) { return Math.pow(v - meanT, 2); })));
        var corrLoss = pearson(steps.map(function (x) { return x.thinkMs || 0; }),
                               steps.map(function (x) { return x.loss || 0; }));
        time = { meanT: meanT, stdT: stdT, corrLoss: corrLoss };
      }
    }

    var aTop1 = rampUp(topProx, th.topProxLo, th.topProxHi);
    var aAcpl = rampDown(meanLoss, th.acplLo, th.acplHi);
    var aSharp = sharp.length >= 3
      ? clamp((sharpHit - th.sharpHitLo) / Math.max(0.05, th.sharpHitSpan), 0, 1) : 0.5;
    var aOut = rampDown(outTop5, 0, th.outTop5Hi);
    var aDesperate = clamp(desperateCount / 3, 0, 1);
    var aTime = 0.5;
    if (time) {
      var flat = clamp(1 - time.stdT / (time.meanT + 1), 0, 1);
      var uncorr = clamp(1 - Math.abs(time.corrLoss), 0, 1);
      aTime = 0.6 * flat + 0.4 * uncorr;
    }
    var ev = evasionFigures(all, th);
    var aEvasion = clamp(ev.count / 5, 0, 1) * 0.5 +
                   ev.regularity * clamp(ev.count / 4, 0, 1) * 0.5;
    var aWinBlunder = clamp(ev.winBlunders / 3, 0, 1);
    // 0.4.7 §1.1, mirrored from app.js sideAggregate(): the useless-four surcharge. Counted as
    // RUNS, not hands, so this has to walk the side's sequence and count transitions rather
    // than filter. Read off `fourRuns.useless` where the report carries it (0.4.7+), otherwise
    // derived from the per-step flags an older archive does have — the same "read both shapes"
    // rule the rest of this file follows.
    var uselessRuns = countFourRuns(steps, 'useless');
    var aUselessFour = clamp(uselessRuns / 2, 0, 1);
    // 0.4.8 §1.2, mirrored from app.js sideAggregate(): the two 唯一手 streak terms. Computed
    // over `all` — the same population app.js's sharpStreakStats() walks (this side's scored,
    // non-opening, non-forced-defence hands) — which is deliberately NOT `steps`: the evasion
    // filter above belongs to the six, and a sharp hand is evidence whether or not an evasion
    // sat beside it.
    var ss = sharpStreakFigures(all);
    // 0.5.2 §1.3.2, mirrored from app.js sideAggregate(): both curves are exponential now. The
    // learner has to move with the detector or it would fit weights against a curve the detector
    // no longer uses — and the two would drift silently, each staying internally consistent.
    var aSharpStreak = ss.maxStreak >= 3 ? clamp((Math.pow(1.3, ss.maxStreak - 2) - 1) / 5, 0, 1) : 0;
    var aSharpTotal = ss.streakHits >= 3 ? clamp((Math.pow(1.15, ss.streakHits - 2) - 1) / 8, 0, 1) : 0;
    // 0.5.2 §1.1.4/§1.2.4, mirrored from app.js sideAggregate(): the two pool terms. Read off the
    // per-hand values slimStep() persists rather than re-walked here — both walks live in app.js
    // and a second copy is how this project has gone wrong before. The population is `steps`, the
    // evasion-excluded list, which is what app.js takes its max over.
    //
    // An archive written before 0.5.2 carries neither field, so both max to 0 and such a sample
    // trains exactly as it did — the same "read both shapes" rule the rest of this file follows.
    var gpMax = maxOf(steps, 'goodPool');
    var aGoodPool = gpMax >= GOOD_POOL_MIN ? clamp((gpMax - 2) / 10, 0, 1) : 0;
    var ltMax = maxOf(steps, 'liveThreePool');
    var aLiveThree = ltMax >= LIVE_POOL_MIN
      ? clamp((Math.pow(1.3, ltMax - 1) - 1) / 4, 0, 1) : 0;
    return {
      top1: aTop1, acpl: aAcpl, sharp: aSharp, out: aOut, desperate: aDesperate, time: aTime,
      evasion: aEvasion, winBlunder: aWinBlunder, uselessFour: aUselessFour,
      sharpStreak: aSharpStreak, sharpTotal: aSharpTotal,
      goodPool: aGoodPool, liveThree: aLiveThree,
      // raw, un-ramped aggregates — the ramp anchors are learned from these
      n: steps.length, rawTop1: top1, rawTopProx: topProx, rawLoss: meanLoss,
      rawSharpHit: sharpHit, rawOutTop5: outTop5,
      hasSharp: sharp.length >= 3,
      evasionCount: ev.count, evasionRegularity: ev.regularity, winBlunderCount: ev.winBlunders,
      uselessFourCount: steps.filter(function (x) { return x.fourKind === 'useless'; }).length,
      uselessFourRuns: uselessRuns,
      sharpStreakMax: ss.maxStreak, sharpStreakHits: ss.streakHits,
      goodPoolMax: gpMax, liveThreeMax: ltMax,
    };
  }

  // 0.4.8 §1.2: the longest run of top-1 sharp hands and the total number of such hits, over a
  // sequence already filtered to one side's scored/non-opening/non-forced hands. A sharp hand
  // that missed the top move breaks the run; a non-sharp hand leaves it standing (it is
  // neither a hit nor a failure to hit). An archive written before 0.4.8 carries `isSharp` and
  // `top1` already, so this recomputes exactly what app.js would and the old corpus trains the
  // same way.
  function sharpStreakFigures(seq) {
    var maxStreak = 0, streakHits = 0, current = 0;
    for (var i = 0; i < seq.length; i++) {
      var s = seq[i];
      if (s.isSharp && s.top1) {
        current++;
        streakHits++;
        if (current > maxStreak) maxStreak = current;
      } else if (s.isSharp && !s.top1) {
        current = 0;
      }
    }
    return { maxStreak: maxStreak, streakHits: streakHits };
  }

  // 0.4.7 §1.1: how many useless-four RUNS this sequence contains. The per-step flags carry
  // the run's LENGTH (`fourRun`), so a run is counted where its length differs from the
  // previous hand's; a non-four hand resets the comparison to 0, which is what separates two
  // adjacent same-length runs. An archive written before 0.4.7 has neither field, so this
  // returns 0 for it and the term is exactly 0 — the same "old corpus trains the same way"
  // property the evasion filter above has.
  function countFourRuns(steps, kind) {
    var n = 0, prev = 0;
    for (var i = 0; i < steps.length; i++) {
      var x = steps[i];
      var len = (x.fourKind === kind && isFinite(x.fourRun)) ? x.fourRun : 0;
      if (len && len !== prev) n++;
      prev = len;
    }
    return n;
  }

  // Per (sample, side) sub-scores split by the sample's role. Shared by optimizeWeights,
  // optimizeRampThresholds and optimizeRiskCuts so all three see exactly one dataset.
  function collectAggregates(samples, th) {
    var pos = [], neg = [];
    (samples || []).forEach(function (s) {
      var w = sampleWeight(s);
      var sf = sideFilter(s);
      var hasTime = !!(s.report && s.report.hasTime);
      ['B', 'W'].forEach(function (side) {
        if (sf && side !== sf) return;
        // 0.3.5 §3.4: decided per SIDE, so 「黑方AI」 contributes a positive from black and
        // nothing from white instead of being skipped as "a game with no role".
        var sr = sideRole(s, side);
        if (!sr) return;
        var sub = subscoresForSide(s.report, side, hasTime, th);
        if (!sub) return;
        (sr === 'ai' ? pos : neg).push({ sub: sub, w: w, sampleId: s.id, side: side });
      });
    });
    return { pos: pos, neg: neg };
  }

  // Weighted probability that a random positive outranks a random negative; ties count
  // half, which is the standard treatment and matters here because most sub-scores are
  // clipped at 0 or 1 and ties are common.
  function weightedAUC(pos, neg) {
    var num = 0, den = 0;
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < neg.length; j++) {
        var w = pos[i].w * neg[j].w;
        den += w;
        var d = pos[i].v - neg[j].v;
        num += w * (d > 0 ? 1 : (d === 0 ? 0.5 : 0));
      }
    }
    return den ? num / den : 0.5;
  }

  function optimizeWeights(samples, opts) {
    opts = opts || {};
    var th = mergeKnown(defaultThresholds(), opts.thresholds);
    var agg = collectAggregates(samples, th);
    if (!agg.pos.length || !agg.neg.length) return null;

    var aucs = {};
    WEIGHT_KEYS.forEach(function (k) {
      aucs[k] = weightedAUC(
        agg.pos.map(function (p) { return { v: p.sub[k], w: p.w }; }),
        agg.neg.map(function (n) { return { v: n.sub[k], w: n.w }; }));
    });

    // A term that separates the two classes keeps its edge; one that does not is pushed to
    // a floor rather than to zero. Zero would let the learner collapse the risk score onto
    // a single term and throw away every other piece of evidence — the floor keeps all eight
    // in the sum, so a weak dataset degrades to "roughly uniform", never to "one metric".
    //
    // 0.4.2 §2.3: TWO sums, not one. The six share a budget of 1.00 and the two evasion terms
    // share their own — the sum of their defaults, 0.10. Normalising all eight in one sum
    // would hand the six ~0.9 of their former share and drop every score by 10%, so a learned
    // run with no evasion at all would score lower than an unlearned one, which is exactly
    // what §2.6 #6 forbids. Each budget is read off the defaults, so changing a default weight
    // moves its group's budget with it.
    var dw = defaultWeights();
    var group = function (keys) {
      var raw = {}, sum = 0, budget = 0, i;
      for (i = 0; i < keys.length; i++) {
        raw[keys[i]] = Math.max(0.02, aucs[keys[i]] - 0.5);
        sum += raw[keys[i]];
        budget += (dw[keys[i]] || 0);
      }
      var out = {};
      for (i = 0; i < keys.length; i++) out[keys[i]] = sum ? r4(raw[keys[i]] / sum * budget) : 0;
      return out;
    };
    var weights = group(BASE_KEYS), evW = group(EVASION_KEYS);
    EVASION_KEYS.forEach(function (k) { weights[k] = evW[k]; });
    return { weights: weights, aucs: aucs, pos: agg.pos.length, neg: agg.neg.length };
  }

  // ---------- A': ramp anchors from the annotation ----------
  // The per-metric grid search above answers "where should the cut be on this one number".
  // The detector, though, consumes RAMPS (aTop1 = (top1 - Lo)/(Hi - Lo)). So the ramp is
  // anchored on the class means: Lo = the human mean, Hi = the AI mean. When the two means
  // are the wrong way round (or indistinguishable) the default anchor is kept — a learned
  // anchor that inverts the ramp would score a suspicious game as clean.
  function optimizeRampThresholds(samples, base) {
    base = mergeKnown(defaultThresholds(), base);
    var agg = collectAggregates(samples, base);
    if (!agg.pos.length || !agg.neg.length) return null;
    var out = {};

    // 0.4.3 §1.1: anchored on the PROXIMITY means, because proximity is what the ramp reads
    // now. Anchoring the old top-1 rate here would emit a pair of cuts the detector never
    // consults — a "learned" run that silently changed nothing, which is worse than no run.
    // The retired top1Lo/top1Hi keep whatever value they already had.
    var mp = mean(agg.pos.map(function (p) { return p.sub.rawTopProx; }));
    var mn = mean(agg.neg.map(function (n) { return n.sub.rawTopProx; }));
    if (mp - mn > 0.02) { out.topProxLo = r3(mn); out.topProxHi = r3(Math.max(mn + 0.05, mp)); }

    var lp = mean(agg.pos.map(function (p) { return p.sub.rawLoss; }));
    var ln = mean(agg.neg.map(function (n) { return n.sub.rawLoss; }));
    if (ln - lp > 0.002) { out.acplLo = r4(lp); out.acplHi = r4(ln); }

    var sp = agg.pos.filter(function (p) { return p.sub.hasSharp; });
    var sn = agg.neg.filter(function (n) { return n.sub.hasSharp; });
    if (sp.length && sn.length) {
      var hp = mean(sp.map(function (p) { return p.sub.rawSharpHit; }));
      var hn = mean(sn.map(function (n) { return n.sub.rawSharpHit; }));
      if (hp - hn > 0.02) { out.sharpHitLo = r3(hn); out.sharpHitSpan = r3(Math.max(0.05, hp - hn)); }
    }

    var op = mean(agg.pos.map(function (p) { return p.sub.rawOutTop5; }));
    var on = mean(agg.neg.map(function (n) { return n.sub.rawOutTop5; }));
    if (on - op > 0.002) { out.outTop5Hi = r4(on); }

    return out;
  }

  function riskOfSub(sub, weights) {
    var r = 0;
    WEIGHT_KEYS.forEach(function (k) { r += (weights[k] || 0) * sub[k]; });
    // Clamped to mirror app.js sideAggregate() exactly: the two evasion weights sit ON TOP of
    // the six, so an evasion-heavy side can add up past 1.0. Without the clamp here the risk
    // cut search could place 高风险 above 100 — a line the real score can never cross.
    return clamp(100 * r, 0, 100);
  }

  // The 高风险 cut, chosen as the F1-optimal split of the learned risk score across AI
  // games vs human games. The 可疑 cut keeps the default 40:70 ratio — it is a "worth a
  // second look" line, not a classification decision, so there is no F1 to maximise.
  function optimizeRiskCuts(samples, weights, thresholds) {
    var th = mergeKnown(defaultThresholds(), thresholds);
    var agg = collectAggregates(samples, th);
    if (!agg.pos.length || !agg.neg.length) return null;
    var pos = agg.pos.map(function (p) { return { v: riskOfSub(p.sub, weights), w: p.w }; });
    var neg = agg.neg.map(function (n) { return { v: riskOfSub(n.sub, weights), w: n.w }; });

    var grid = [];
    for (var t = 20; t <= 95.0001; t += 1) {
      var tp = 0, fp = 0, fn = 0;
      for (var i = 0; i < pos.length; i++) { if (pos[i].v >= t) tp += pos[i].w; else fn += pos[i].w; }
      for (var j = 0; j < neg.length; j++) { if (neg[j].v >= t) fp += neg[j].w; }
      var precision = (tp + fp) ? tp / (tp + fp) : 0;
      var recall = (tp + fn) ? tp / (tp + fn) : 0;
      var f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
      grid.push({ t: t, f1: f1 });
    }
    var mid = (mean(pos.map(function (p) { return p.v; })) + mean(neg.map(function (n) { return n.v; }))) / 2;
    var best = pickCut(grid, mid);
    var riskHigh = Math.round(best.t);
    var out = { riskHigh: riskHigh, riskMid: Math.round(riskHigh * 40 / 70), f1: best.f1 };
    // 0.4.3 §1.6: the same F1-optimal AI/human cut is the honest anchor for the AI band's lower
    // edge (§1.6 asks for these cuts to be learnable), and the three lower edges keep the §1.6
    // LADDER relative to it — so the whole ladder moves together instead of letting two bands
    // land on the same point. A degenerate corpus that would collapse or invert the ladder
    // keeps the defaults: three bands sharing one number is worse than not learning at all.
    var dAi = th.typeAiMin - th.riskHigh;
    var dSus = th.typeAiMin - th.typeSuspectMin;
    var dPro = th.typeAiMin - th.typeProMin;
    var dExp = th.typeAiMin - th.typeExpertMin;
    var aiMin = clamp(Math.round(riskHigh + dAi), 1, 99);
    var susMin = clamp(aiMin - dSus, 1, 99);
    var proMin = clamp(aiMin - dPro, 1, 99);
    var expMin = clamp(aiMin - dExp, 1, 99);
    if (aiMin > susMin && susMin > proMin && proMin > expMin) {
      out.typeAiMin = aiMin; out.typeSuspectMin = susMin;
      out.typeProMin = proMin; out.typeExpertMin = expMin;
    }
    return out;
  }

  // ---------- orchestrator (0.3.3 §3.4) ----------
  // Manual only: the operator presses 重新学习. `opts.current` is the previously stored
  // learnedParams (or null) and becomes the "before" snapshot the UI diffs against.
  function runLearning(samples, opts) {
    opts = opts || {};
    var list = (samples || []).filter(function (s) {
      return s && s.report && ((s.report.steps || []).length > 0);
    });
    var sampleCount = list.length;
    if (sampleCount < MIN_SAMPLES) {
      return { ok: false, reason: 'too-few', sampleCount: sampleCount, need: MIN_SAMPLES };
    }

    var baseW = defaultWeights();
    var baseT = defaultThresholds();
    var beforeW = (opts.current && opts.current.weights) ? mergeKnown(baseW, opts.current.weights) : baseW;
    var beforeT = (opts.current && opts.current.thresholds) ? mergeKnown(baseT, opts.current.thresholds) : baseT;

    // B first: the risk cuts and the reported F1 both need the new weights.
    var wt = optimizeWeights(list, { thresholds: baseT });
    var weights = wt ? wt.weights : clone(beforeW);

    // A': ramp anchors. Anchored off the BASE thresholds (not the learned ones) so the
    // aggregates used to pick them are computed the same way the detector will compute
    // them afterwards, then the risk cut is chosen on the final weights + thresholds.
    var ramp = optimizeRampThresholds(list, baseT) || {};
    var thresholds = mergeKnown(beforeT, ramp);
    var cuts = optimizeRiskCuts(list, weights, thresholds);
    if (cuts) {
      thresholds.riskHigh = cuts.riskHigh;
      thresholds.riskMid = cuts.riskMid;
      // 0.4.3 §1.6: the band edges ride along with the 高风险 line. Only present when the
      // learnt ladder stayed strictly ordered (see optimizeRiskCuts); otherwise the defaults
      // stand.
      ['typeAiMin', 'typeSuspectMin', 'typeProMin', 'typeExpertMin'].forEach(function (k) {
        if (cuts[k] != null) thresholds[k] = cuts[k];
      });
    }

    // A: per-metric cut lines. Reported and stored for the diff table and for the feature
    // library's threshold, but the detector consumes the ramps above — these answer
    // "where would a single-number decision rule put the cut", which is what the operator
    // asked for and what the spec's grid search computes.
    var metricThresholds = {};
    METRIC_KEYS.forEach(function (m) {
      var r = optimizeThreshold(list, m);
      if (r) metricThresholds[m] = { threshold: r.threshold, f1: r3(r.f1), pos: r.pos, neg: r.neg };
    });

    // C: the AI-move fingerprint library.
    var features = buildFeatureLibrary(list);

    return {
      ok: true,
      trainedAt: Date.now(),
      sampleCount: sampleCount,
      // 0.3.3 §3.5: a run under 20 samples is allowed but flagged unreliable.
      reliable: sampleCount >= LOW_SAMPLES,
      weights: weights,
      thresholds: thresholds,
      metricThresholds: metricThresholds,
      aucs: wt ? wt.aucs : null,
      posCount: wt ? wt.pos : 0,
      negCount: wt ? wt.neg : 0,
      features: features,
      featureCount: features.length,
      before: { weights: beforeW, thresholds: beforeT },
      f1: cuts ? r3(cuts.f1) : null,
      // The one thing that silently produces a no-op: no sample carries a role tag, so
      // there is no positive/negative split to learn from. 0.3.5: the per-side tags count
      // here too — 「黑方AI」 alone is enough to train on black's hands.
      // §1.7 决策 3: the learner runs in the offscreen document, where the UI language is
      // irrelevant, so this travels as an `__i18n:` code and the viewer renders it with
      // GMI18n.trError(). The Chinese text lives in locale/zh-CN.js as `learn.noRoleTags`.
      note: wt ? null : '__i18n:learn.noRoleTags',
    };
  }

  // ---------- diff helpers for the UI (0.3.3 §3.4 学习结果展示) ----------
  function diffWeights(before, after) {
    return WEIGHT_KEYS.map(function (k) {
      var b = (before && before[k] != null) ? before[k] : null;
      var a = (after && after[k] != null) ? after[k] : null;
      return {
        key: k, label: WEIGHT_LABEL[k] || k, labelKey: 'learn.weight.' + k,
        before: b, after: a,
        delta: (b != null && a != null) ? r4(a - b) : null,
      };
    });
  }

  var THRESHOLD_KEYS = ['topProxLo', 'topProxHi',
                        // 0.3.1's top-1 cuts. Retired from the detector in 0.4.3 §1.1 but still
                        // stored and still listed, so an operator comparing an old learnedParams
                        // with a new one can see that nothing here was silently repurposed.
                        'top1Lo', 'top1Hi', 'acplLo', 'acplHi', 'sharpHitLo', 'sharpHitSpan',
                        'outTop5Hi', 'riskHigh', 'riskMid',
                        // 0.4.2 §4.3
                        'evasionLoss', 'goodLoss', 'evasionMin', 'evasionReg', 'winningWR',
                        // 0.4.3 §1.6
                        'typeAiMin', 'typeSuspectMin', 'typeProMin', 'typeExpertMin',
                        // 0.4.7 §1.1
                        'fourVcfWR', 'fourLostWR'];

  function diffThresholds(before, after) {
    return THRESHOLD_KEYS.map(function (k) {
      var b = (before && before[k] != null) ? before[k] : null;
      var a = (after && after[k] != null) ? after[k] : null;
      return {
        key: k, label: THRESHOLD_LABEL[k] || k, labelKey: 'learn.threshold.' + k,
        before: b, after: a,
        delta: (b != null && a != null) ? r4(a - b) : null,
      };
    });
  }

  var API = {
    MIN_SAMPLES: MIN_SAMPLES,
    LOW_SAMPLES: LOW_SAMPLES,
    BASE_KEYS: BASE_KEYS,
    // 0.4.2 §2.3: the two evasion weights are learned in their own budget, so anything that
    // wants to walk "every weight" wants WEIGHT_KEYS, not BASE_KEYS.
    EVASION_KEYS: EVASION_KEYS,
    WEIGHT_KEYS: WEIGHT_KEYS,
    METRIC_KEYS: METRIC_KEYS,
    SIM_KEYS: SIM_KEYS,
    SIM_LABEL: SIM_LABEL,
    WEIGHT_LABEL: WEIGHT_LABEL,
    THRESHOLD_LABEL: THRESHOLD_LABEL,
    defaultWeights: defaultWeights,
    defaultThresholds: defaultThresholds,
    sampleRole: sampleRole,
    // 0.3.5 §3.4
    sideRole: sideRole,
    sampleWeight: sampleWeight,
    sideFilter: sideFilter,
    stepGap: stepGap,
    // 0.4.3 §1.1: exported so a test can assert the mirror against app.js's stepProximity
    // directly instead of inferring it from a risk number.
    proximity: proximity,
    featureVector: featureVector,
    featureMatch: featureMatch,
    buildFeatureLibrary: buildFeatureLibrary,
    matchFeatures: matchFeatures,
    optimizeThreshold: optimizeThreshold,
    optimizeWeights: optimizeWeights,
    optimizeRampThresholds: optimizeRampThresholds,
    optimizeRiskCuts: optimizeRiskCuts,
    subscoresForSide: subscoresForSide,
    riskOfSub: riskOfSub,
    weightedAUC: weightedAUC,
    runLearning: runLearning,
    diffWeights: diffWeights,
    diffThresholds: diffThresholds,
    THRESHOLD_KEYS: THRESHOLD_KEYS,
  };

  g.GMLearn = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : self);
