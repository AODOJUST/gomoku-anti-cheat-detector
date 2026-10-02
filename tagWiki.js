/* 0.5.3 §1.4 标签百科 — the data behind the 「标签介绍」 modal.
 *
 * Four vocabularies are documented here, and they come from four different places, so each
 * entry points back at its own source rather than restating it:
 *
 *   preset — `storage.js` PRESET_TAGS   (9)  what a SAVED SAMPLE is
 *   ann    — `storage.js` ANN_LABELS    (7)  what the operator marked on one HAND
 *   type   — `app.js` classifySide/riskBand (7)  what the detector concluded about one SIDE
 *   signal — `app.js` BASE_WEIGHTS      (13) what the risk score is built out of
 *
 * ---------------------------------------------------------------------------------------
 * Why the bodies are INLINE BILINGUAL and not `locale/*.js` rows
 * ---------------------------------------------------------------------------------------
 * Same reason 0.4.10's TUTORIAL is (see viewer.js): the dictionary tables are generated from
 * `_tools/i18n-ui.js`, every key there must carry all 12 translations, and `gen-locale --check`
 * fails the moment one is missing. §1.4.3 asks for 13 languages but says 「MVP 阶段中英先行」 —
 * a deliberately half-translated corpus with an explicit fallback is the only shape that can be
 * done on purpose. The 11 other languages read English until someone translates them.
 *
 * The NAME of each entry is the one part that IS a dictionary row, because it already exists:
 * `tag.*` (9), `ann.*` (7), `type.*` (7) and `learn.weight.*` (13) are all fully populated, and
 * the learning panel already shows those same words. The encyclopedia agreeing with the panel
 * it sits next to matters more than agreeing with §1.4.2's prose table, which spells four of
 * them differently (`Top-1` / `ACPL` / `时间模式` / `好点积累池` against the shipped
 * `Top1 吻合` / `ACPL 均损` / `时间规律` / `好点池`).
 *
 * ---------------------------------------------------------------------------------------
 * Why the NUMBERS are not written down here
 * ---------------------------------------------------------------------------------------
 * §1.4.2's tables print a weight for every signal and a cut for every band, and the figures they
 * print have gone stale more than once: a release rebalances `BASE_WEIGHTS` and the prose table is
 * not re-derived from it. Quoting the current numbers here would make this file stale the same way
 * — and it is not a comment that only maintainers read, it is a page the operator reads. An
 * encyclopedia that states a number the detector does not use is worse than one that states no
 * number at all.
 *
 * So no entry stores a figure. It stores the KEY it can be read from (`weightKey` / `bandLo` /
 * `bandHi`) and the impact line carries a `{w}` / `{lo}` / `{hi}` placeholder that the renderer
 * fills in from the live table. `weight()` and `band()` below are the only readers, and they
 * return null rather than a guess when the table is out of reach — in which case the renderer
 * prints an em dash. "No number" beats "a wrong number", and a number can never drift.
 *
 * ---------------------------------------------------------------------------------------
 * Why three entries say 「仅记录」
 * ---------------------------------------------------------------------------------------
 * §1.4.2 claims a learning effect for every annotation. Three of them do not exist in the code:
 * `判断准确` (+1 threshold), `判断错误` (-1 threshold) and `无用冲四` (序列分类参考) are stored
 * and never read — `learn.js` consumes exactly one annotation, `AI步骤` (learn.js:320, 409),
 * and the two game-level sample tags. Writing the spec's claim into the product would document
 * a feature nobody implemented, so those entries carry `applied: false` and say so plainly. The
 * renderer shows a 「仅记录」 chip for them. If the learner ever starts reading them, flip the
 * flag — the verify suite asserts the flag agrees with what learn.js actually reads.
 */
var GM_TAG_WIKI = (function () {
  'use strict';

  // Category ids, in the filter chips' order. The LABELS are not here: they are `T()` calls in
  // viewer.js's `twCatLabel()`, because a key held in this file would be computed at the call
  // site (`T(c.label)`) and `_tools/keys.cjs` only sees literals — a computed key never reaches
  // the generated tables, so every non-Chinese locale would print the Chinese category name.
  var CATS = [
    { id: 'preset' },
    { id: 'ann' },
    { id: 'type' },
    { id: 'signal' },
  ];

  // ---------------------------------------------------------------------------------------
  // Entries.
  //
  //   id         stable slug, used for nothing but debugging and the suite's lookup
  //   cat        one of CATS[].id
  //   nameNs     namespace for TO(ns, val) — the display name
  //   nameVal    the value within that namespace
  //   applied    false => the effect is NOT implemented; the modal shows 「仅记录」
  //   weightKey  read the figure from BASE_WEIGHTS[key]         (signals only)
  //   bandLo     read the lower cut from BASE_THRESHOLDS[key]   (bands only, null = 0)
  //   bandHi     read the upper cut from BASE_THRESHOLDS[key]   (bands only, null = 100)
  //   zh/en      { meaning, usage, impact }; impact may carry {w} / {lo} / {hi}
  // ---------------------------------------------------------------------------------------
  var ENTRIES = [

    // =====================================================================================
    // 预设标签 — storage.js PRESET_TAGS. A game-level (or side-level) claim about a SAMPLE.
    // =====================================================================================
    {
      id: 'preset-standard', cat: 'preset', nameNs: 'tag', nameVal: '标准样本', applied: true,
      zh: {
        meaning: '检测结果与人工判断完全一致——操作者核对过，认为检测器这一局的结论是对的。',
        usage: '作为高可信度的参考样本；批量导入时优先采纳，也是衡量检测器准不准的基准。',
        impact: '学习权重 ×1.5（learn.js:246）。样本库中权重最高的一档。',
      },
      en: {
        meaning: 'The detector\'s verdict and the operator\'s judgement agree completely — the result was checked by hand and accepted.',
        usage: 'Use as a high-confidence reference. Preferred during bulk import, and the baseline for judging whether the detector is accurate.',
        impact: 'Learning weight ×1.5 (learn.js:246). The highest tier in the sample library.',
      },
    },
    {
      id: 'preset-doubt', cat: 'preset', nameNs: 'tag', nameVal: '存疑样本', applied: true,
      zh: {
        meaning: '检测结果与人工判断存在分歧——操作者认为结论不对，但还不足以断定错在哪里。',
        usage: '保留下来供后续复核，同时压低它对学习的影响，避免一个没想清楚的判断带偏参数。',
        impact: '学习权重 ×0.5（learn.js:245）。仍然是有效样本，只是说了半句话。',
      },
      en: {
        meaning: 'The detector\'s verdict and the operator\'s judgement disagree — the result is believed wrong, but not yet wrong enough to say why.',
        usage: 'Keep it for later review, but damp its influence on learning so an unresolved judgement cannot drag the parameters around.',
        impact: 'Learning weight ×0.5 (learn.js:245). Still a valid sample, just a half-statement.',
      },
    },
    {
      id: 'preset-black', cat: 'preset', nameNs: 'tag', nameVal: '黑方打谱样本', applied: true,
      zh: {
        meaning: '这一局只研究黑方，白方的着手不作为证据。',
        usage: '拿到一份只有黑方值得分析的棋谱时用——比如对手分享了黑方的对局记录。',
        impact: '侧过滤：只把黑方的着手送进学习（learn.js:253）。',
      },
      en: {
        meaning: 'Only black is under study in this game; white\'s moves are not evidence.',
        usage: 'Use when only one side is worth analysing — e.g. someone shared a record of black\'s games alone.',
        impact: 'Side filter: only black\'s moves enter learning (learn.js:253).',
      },
    },
    {
      id: 'preset-white', cat: 'preset', nameNs: 'tag', nameVal: '白方打谱样本', applied: true,
      zh: {
        meaning: '这一局只研究白方，黑方的着手不作为证据。',
        usage: '与「黑方打谱样本」对称，用于只有白方值得分析的对局。',
        impact: '侧过滤：只把白方的着手送进学习（learn.js:253）。',
      },
      en: {
        meaning: 'Only white is under study in this game; black\'s moves are not evidence.',
        usage: 'The mirror of 黑方打谱样本, for a game where only white is worth analysing.',
        impact: 'Side filter: only white\'s moves enter learning (learn.js:253).',
      },
    },
    {
      id: 'preset-both', cat: 'preset', nameNs: 'tag', nameVal: '双方样本', applied: true,
      zh: {
        meaning: '双方都是研究对象，两侧各自独立评估。',
        usage: '默认情形。注意它说的是「哪些着手算证据」，不是「谁在开 AI」——后者用黑方AI / 白方AI。',
        impact: '无侧过滤：两侧的着手都进入学习。',
      },
      en: {
        meaning: 'Both sides are under study, each assessed on its own.',
        usage: 'The default. Note it says which moves count as evidence, not who was running an AI — that is what 黑方AI / 白方AI are for.',
        impact: 'No side filter: both sides\' moves enter learning.',
      },
    },
    {
      id: 'preset-ai', cat: 'preset', nameNs: 'tag', nameVal: 'AI 样本', applied: true,
      zh: {
        meaning: '确认这一局是 AI 走出来的。',
        usage: '用于扩充正样本，让检测器见过更多「像 AI」的棋。',
        impact: '学习时整局作正样本（learn.js:216）。',
      },
      en: {
        meaning: 'This game is confirmed to have been played by an AI.',
        usage: 'Use it to grow the positive class so the detector sees more AI-looking play.',
        impact: 'The whole game is a positive sample during learning (learn.js:216).',
      },
    },
    {
      id: 'preset-human', cat: 'preset', nameNs: 'tag', nameVal: '人类样本', applied: true,
      zh: {
        meaning: '确认这一局是人类走出来的。',
        usage: '负样本来源，作用同样重要——没有它，检测器只会越来越敏感。',
        impact: '学习时整局作负样本（learn.js:217）。标了它，未被单独标注的另一方也按人类处理。',
      },
      en: {
        meaning: 'This game is confirmed to have been played by a human.',
        usage: 'The source of negative samples, and just as important — without them the detector only ever gets more sensitive.',
        impact: 'The whole game is a negative sample during learning (learn.js:217). It also covers the untagged side.',
      },
    },
    {
      id: 'preset-black-ai', cat: 'preset', nameNs: 'tag', nameVal: '黑方AI', applied: true,
      zh: {
        meaning: '黑方使用了 AI——只对黑方下这个结论。',
        usage: '「只有一方开 AI」的对局。0.3.5 之前这种局面无法标注：双方样本说的是哪些着手算证据，'
             + '而人类样本会把黑方也一并算成人类。',
        impact: '分侧正样本：黑方的着手进正样本，白方不受影响（learn.js:231）。',
      },
      en: {
        meaning: 'Black used an AI — the claim is about black only.',
        usage: 'For games where just one side cheated. Before 0.3.5 these were unlabellable: 双方样本 says which moves are evidence, and 人类样本 would have called black human too.',
        impact: 'Per-side positive: black\'s moves become positives, white is untouched (learn.js:231).',
      },
    },
    {
      id: 'preset-white-ai', cat: 'preset', nameNs: 'tag', nameVal: '白方AI', applied: true,
      zh: {
        meaning: '白方使用了 AI——只对白方下这个结论。',
        usage: '与「黑方AI」对称。可以和「人类样本」同时使用，表达「黑方是人、白方不是」。',
        impact: '分侧正样本：白方的着手进正样本，黑方不受影响（learn.js:232）。',
      },
      en: {
        meaning: 'White used an AI — the claim is about white only.',
        usage: 'The mirror of 黑方AI. Combine with 人类样本 to say "black was human, white was not".',
        impact: 'Per-side positive: white\'s moves become positives, black is untouched (learn.js:232).',
      },
    },

    // =====================================================================================
    // 人工标注 — storage.js ANN_LABELS. A claim about ONE HAND, stored per move number.
    // =====================================================================================
    {
      id: 'ann-correct', cat: 'ann', nameNs: 'ann', nameVal: '判断准确', applied: false,
      zh: {
        meaning: '人工核对后认为，检测器对这一步的判断是对的。',
        usage: '逐手复核时标记，用来记录分歧出在哪里。',
        impact: '仅记录。当前版本没有任何代码读取这个标注——它不会影响学习。',
      },
      en: {
        meaning: 'Checked by hand: the detector judged this hand correctly.',
        usage: 'Mark it while reviewing hand by hand, to record where the disagreements are.',
        impact: 'Recorded only. Nothing in the current build reads this label — it does not affect learning.',
      },
    },
    {
      id: 'ann-wrong', cat: 'ann', nameNs: 'ann', nameVal: '判断错误', applied: false,
      zh: {
        meaning: '人工核对后认为，检测器对这一步的判断是错的。',
        usage: '逐手复核时标记。这个标注的长期价值最高——它是「检测器在哪里犯错」的唯一一手记录。',
        impact: '仅记录。当前版本没有任何代码读取这个标注——它不会影响学习。',
      },
      en: {
        meaning: 'Checked by hand: the detector judged this hand wrongly.',
        usage: 'Mark it while reviewing hand by hand. Long term this is the most valuable annotation — it is the only per-hand record of where the detector goes wrong.',
        impact: 'Recorded only. Nothing in the current build reads this label — it does not affect learning.',
      },
    },
    {
      id: 'ann-aistep', cat: 'ann', nameNs: 'ann', nameVal: 'AI步骤', applied: true,
      zh: {
        meaning: '人工确认这一步是 AI 走出来的。',
        usage: '在「检测器没看出来」的局部上补标，把一个整体结论细化到具体着手。',
        impact: '作为该步的正样本进入特征库（learn.js:320、409）。这是当前唯一被学习逻辑读取的人工标注。',
      },
      en: {
        meaning: 'Confirmed by hand: this single hand was played by an AI.',
        usage: 'Use it to fill in the spots the detector missed, turning a whole-game verdict into a per-hand one.',
        impact: 'Feeds the feature library as a positive for that hand (learn.js:320, 409). The only annotation the learner currently reads.',
      },
    },
    {
      id: 'ann-four', cat: 'ann', nameNs: 'ann', nameVal: '冲四', applied: false,
      zh: {
        meaning: '这一步是冲四——中性描述，不含评价。',
        usage: '用来把「冲四」和「无用冲四」分开：一步冲四本身可能是合理的抢攻，也可能是败势里的拖延。'
             + '两个标注可以同时存在，这正是把它们拆开的意义。',
        impact: '仅记录，不计分。',
      },
      en: {
        meaning: 'This hand is a four-chase (冲四) — a neutral description, not a criticism.',
        usage: 'Exists so 冲四 and 无用冲四 can be told apart: a chase can be a legitimate attack or a delay in a lost position. Both labels can be on at once, which is the point of splitting them.',
        impact: 'Recorded only; no score effect.',
      },
    },
    {
      id: 'ann-useless-four', cat: 'ann', nameNs: 'ann', nameVal: '无用冲四', applied: false,
      zh: {
        meaning: '无意义的冲四——已经败势，冲四只是拖延，不构成威胁。',
        usage: '和「冲四」搭配使用，标出那些看起来像进攻、实际不改变结果的着手。',
        impact: '仅记录，不计分。检测器另有一个同名的自动信号（见「无用冲四」检测信号），'
             + '两者独立：自动信号按连续段统计，人工标注按单步记录。',
      },
      en: {
        meaning: 'A pointless four-chase — the position was already lost, so the chase delays without threatening.',
        usage: 'Pairs with 冲四 to mark the moves that look like an attack but change nothing.',
        impact: 'Recorded only; no score effect. The detector has a separate automatic signal of the same name (see the 无用冲四 signal entry) — they are independent: the signal counts runs, this label marks single hands.',
      },
    },
    {
      id: 'ann-doubt', cat: 'ann', nameNs: 'ann', nameVal: '可疑', applied: false,
      zh: {
        meaning: '人工觉得可疑，但还拿不准。',
        usage: '一个弱标记。它的用途是「先记下来」，避免一次拿不准的复核被忘掉。',
        impact: '仅记录，不计分。注意它与风险档位「可疑」（55–74 分）同名但无关：'
             + '一个是人工在单步上的犹豫，一个是检测器对整方的结论。',
      },
      en: {
        meaning: 'The operator finds it suspicious but is not sure.',
        usage: 'A weak mark. Its job is "write it down now" so an inconclusive review is not forgotten.',
        impact: 'Recorded only; no score effect. Note it shares its name with the 可疑 risk band (55–74) but is unrelated: one is a human hesitating over a hand, the other the detector\'s verdict on a side.',
      },
    },
    {
      id: 'ann-exempt', cat: 'ann', nameNs: 'ann', nameVal: '豁免', applied: false,
      zh: {
        meaning: '人工确认这一步是当时唯一的防点。',
        usage: '用作核对样本：检测器自己有一条自动的「冲四豁免」规则（差距 ≥ 0.15 且走的是首选），'
             + '那条规则是启发式的，会错。人工标注独立记录，才能反过来检验它，而不是被它覆盖。',
        impact: '仅记录。检测器的自动豁免规则独立生效，与本标注互不覆盖。',
      },
      en: {
        meaning: 'Confirmed by hand: this hand was the only defence available.',
        usage: 'A validation sample. The detector has its own automatic four-chase exemption rule (gap ≥ 0.15 and the move is top-1), and that rule is a heuristic — it will be wrong sometimes. Recording the human mark separately is what lets it be checked rather than overwritten.',
        impact: 'Recorded only. The automatic exemption rule applies independently and does not overwrite this label.',
      },
    },

    // =====================================================================================
    // AI 分类 — app.js classifySide(). A verdict about ONE SIDE, derived from the risk score
    // plus the SHAPE of the dips below Top5 (0.4.7 §1.3).
    // =====================================================================================
    {
      id: 'type-lowai', cat: 'type', nameNs: 'type', nameVal: 'lowAi', applied: true,
      bandLo: 'typeAiMin', bandHi: null,
      zh: {
        meaning: '风险分 ≥ {lo}，且全程没有掉出前 5 候选的着手——一条 low 段都没有。',
        usage: '最直白的一类 AI：整局都走在引擎的候选里，没有试图掩饰。',
        impact: '决定归档与界面展示的结论类型。归档筛选按此分类所在的风险分判断。',
      },
      en: {
        meaning: 'Risk ≥ {lo} with no dip below the top-5 candidates anywhere — not a single low run.',
        usage: 'The plainest kind of AI: it stays inside the engine\'s candidates the whole game and never tries to hide.',
        impact: 'Sets the verdict shown in the archive and the UI. Archive filtering keys off the risk score this band sits in.',
      },
    },
    {
      id: 'type-evasive', cat: 'type', nameNs: 'type', nameVal: 'evasiveAi', applied: true,
      bandLo: 'typeAiMin', bandHi: null,
      zh: {
        meaning: '风险分 ≥ {lo}，且恰好有单个短的 low 段（1–2 步）。',
        usage: '一次「探个头又缩回去」的破绽：整体是 AI 的棋，但中间故意走了几步差的。',
        impact: '决定归档与界面展示的结论类型。',
      },
      en: {
        meaning: 'Risk ≥ {lo} with exactly one short low run (1–2 hands).',
        usage: 'One peek out and back: AI play throughout, with a couple of deliberately bad moves in the middle.',
        impact: 'Sets the verdict shown in the archive and the UI.',
      },
    },
    {
      id: 'type-strong-evasive', cat: 'type', nameNs: 'type', nameVal: 'strongEvasiveAi', applied: true,
      bandLo: 'typeAiMin', bandHi: null,
      zh: {
        meaning: '风险分 ≥ {lo}，且要么有多个 low 段，要么有一段长达 3 步以上。',
        usage: '掩饰得更用力的一类。反复进出前 5 候选，是刻意规避的形态。',
        impact: '决定归档与界面展示的结论类型。',
      },
      en: {
        meaning: 'Risk ≥ {lo} with either several low runs or one run of 3+ hands.',
        usage: 'A more deliberate disguise — repeatedly stepping out of the top-5 candidates and back.',
        impact: 'Sets the verdict shown in the archive and the UI.',
      },
    },
    {
      id: 'type-suspect', cat: 'type', nameNs: 'type', nameVal: 'suspectAi', applied: true,
      bandLo: 'typeSuspectMin', bandHi: 'typeAiMin',
      zh: {
        meaning: '风险分 ≥ {lo} 且 < {hi}。',
        usage: '不足以断定是 AI，但明显不像随手下的棋。这一档最需要人工复核。',
        impact: '决定归档与界面展示的结论类型。默认回放过滤的上界（54）就落在这档之下，'
             + '所以默认设置不会把「可疑」拦下来。',
      },
      en: {
        meaning: 'Risk ≥ {lo} and < {hi}.',
        usage: 'Not enough to call it AI, but clearly not casual play either. This is the band that most needs a human look.',
        impact: 'Sets the verdict shown in the archive and the UI. The default archive filter\'s ceiling (54) sits just below this band, so the default setting never blocks a 可疑 game.',
      },
    },
    {
      id: 'type-pro', cat: 'type', nameNs: 'type', nameVal: 'pro', applied: true,
      bandLo: 'typeProMin', bandHi: 'typeSuspectMin',
      zh: {
        meaning: '风险分 ≥ {lo} 且 < {hi}。',
        usage: '职业棋手的水准。强到会被误判，但还没有 AI 的特征形态。',
        impact: '决定归档与界面展示的结论类型。',
      },
      en: {
        meaning: 'Risk ≥ {lo} and < {hi}.',
        usage: 'Professional level — strong enough to be mistaken for an AI, but without the tell-tale shape.',
        impact: 'Sets the verdict shown in the archive and the UI.',
      },
    },
    {
      id: 'type-expert', cat: 'type', nameNs: 'type', nameVal: 'expert', applied: true,
      bandLo: 'typeExpertMin', bandHi: 'typeProMin',
      zh: {
        meaning: '风险分 ≥ {lo} 且 < {hi}。',
        usage: '高水平玩家。',
        impact: '决定归档与界面展示的结论类型。',
      },
      en: {
        meaning: 'Risk ≥ {lo} and < {hi}.',
        usage: 'A strong amateur.',
        impact: 'Sets the verdict shown in the archive and the UI.',
      },
    },
    {
      id: 'type-normal', cat: 'type', nameNs: 'type', nameVal: 'normal', applied: true,
      bandLo: null, bandHi: 'typeExpertMin',
      zh: {
        meaning: '风险分 < {hi}。',
        usage: '普通对局。绝大多数对局都在这一档。',
        impact: '决定归档与界面展示的结论类型。',
      },
      en: {
        meaning: 'Risk < {hi}.',
        usage: 'Ordinary play. The overwhelming majority of games land here.',
        impact: 'Sets the verdict shown in the archive and the UI.',
      },
    },

    // =====================================================================================
    // 检测信号 — app.js BASE_WEIGHTS. The thirteen terms the risk score is summed from.
    //
    // The first six are the 基础统计 (0.4.2's top1/acpl/sharp/out/desperate/time); the remaining
    // seven are the 行为信号, each exactly 0 on a game that shows no such pattern. Through 0.5.4
    // the six were the whole budget and the seven rode on top as surcharges; 0.5.5 §1.3 made the
    // WHOLE table one budget, and 0.5.6 补增 §三 replaced that budget with the operator's own table
    // — exactly 1.30 as shipped, which is the whole 130% ceiling, and an operator may not go above
    // it. So neither group is "the" budget, and the total is not 1.00 any more either: the split AND
    // the total are per-release decisions, which is exactly why the figures below are read live.
    // Each entry reads its own figure from `weightKey`, which is the only reason this paragraph can
    // describe the model without repeating a number that will move.
    // =====================================================================================
    {
      id: 'signal-top1', cat: 'signal', nameNs: 'learn.weight', nameVal: 'top1',
      applied: true, weightKey: 'top1',
      zh: {
        meaning: '实际走法与引擎首选的一致程度。不是「命中率」那么简单——0.4.3 起用的是'
             + '分档接近度：首选记 1.0、2–5 名记 0.80、6–8 名记 0.50，再取均值后过斜坡。',
        usage: '最基础的一项。它单独说明不了什么，但它是所有其他信号的对照组。',
        impact: '权重 {w}，基础统计六项之一。',
      },
      en: {
        meaning: 'How closely the played moves match the engine\'s first choice. Not a plain hit rate — since 0.4.3 it reads a graded proximity: top-1 scores 1.0, ranks 2–5 score 0.80, ranks 6–8 score 0.50, and the mean goes through a ramp.',
        usage: 'The most basic term. On its own it proves little, but it is the control group for everything else.',
        impact: 'Weight {w}, one of the six base statistics.',
      },
    },
    {
      id: 'signal-acpl', cat: 'signal', nameNs: 'learn.weight', nameVal: 'acpl',
      applied: true, weightKey: 'acpl',
      zh: {
        meaning: '平均胜率损失（Average Centipawn Loss 的胜率版本）——每一步相对引擎最佳着手的胜率跌幅。',
        usage: '衡量「下得有多准」的整体水平。人类越强，这一项越低。',
        impact: '权重 {w}，基础统计六项之一。',
      },
      en: {
        meaning: 'Average win-rate loss — how much win probability each move gives up against the engine\'s best.',
        usage: 'The overall measure of how accurately the side played. Stronger humans score lower.',
        impact: 'Weight {w}, one of the six base statistics.',
      },
    },
    {
      id: 'signal-sharp', cat: 'signal', nameNs: 'learn.weight', nameVal: 'sharp',
      applied: true, weightKey: 'sharp',
      zh: {
        meaning: '「唯一手」命中率——引擎最佳与次优差距 ≥ 0.12 的那些步里，实际走了首选的比例。'
             + '样本少于 3 步时该分项固定为 0.5（无信息）。',
        usage: '最有说服力的一项：普通玩家在唯一手局面里会选错，引擎不会。',
        impact: '权重 {w}，基础统计六项之一。',
      },
      en: {
        meaning: 'The 唯一手 hit rate — among hands where the engine\'s best and second-best differ by ≥ 0.12, the share where the top move was actually played. With fewer than 3 such hands the term is fixed at 0.5 (no information).',
        usage: 'The most persuasive term: an ordinary player picks wrong in a unique-move position, an engine does not.',
        impact: 'Weight {w}, one of the six base statistics.',
      },
    },
    {
      id: 'signal-out', cat: 'signal', nameNs: 'learn.weight', nameVal: 'out',
      applied: true, weightKey: 'out',
      zh: {
        meaning: '掉出前 5 候选的着手占比。',
        usage: '与「唯一手」互补：唯一手看它抓不抓得住对的一步，这一项看它会不会走出引擎根本没考虑的一步。',
        impact: '权重 {w}，基础统计六项之一。',
      },
      en: {
        meaning: 'The share of hands played outside the engine\'s top-5 candidates.',
        usage: 'The complement of 唯一手: that one asks whether it finds the right move, this one whether it plays something the engine never considered.',
        impact: 'Weight {w}, one of the six base statistics.',
      },
    },
    {
      id: 'signal-desperate', cat: 'signal', nameNs: 'learn.weight', nameVal: 'desperate',
      applied: true, weightKey: 'desperate',
      zh: {
        meaning: '败势下的无谓冲四。3 次即满值。',
        usage: '人类在必败局面里会「挣扎」——连续冲四试图制造混乱；引擎会安静地走最顽强的一步。',
        impact: '权重 {w}，基础统计六项之一。',
      },
      en: {
        meaning: 'Pointless four-chases from a losing position. Three of them saturate the term.',
        usage: 'Humans thrash when lost — chasing fours to create confusion. An engine quietly plays the most stubborn move instead.',
        impact: 'Weight {w}, one of the six base statistics.',
      },
    },
    {
      id: 'signal-time', cat: 'signal', nameNs: 'learn.weight', nameVal: 'time',
      applied: true, weightKey: 'time',
      zh: {
        meaning: '落子间隔的规律性：60% 看间隔是否稳定，40% 看间隔与胜率损失是否不相关。',
        usage: '引擎的耗时由搜索量决定，与局面难度无关；人的思考时间会跟着局面走。'
             + '没有计时数据时该分项固定为 0.5。',
        impact: '权重 {w}，基础统计六项之一。',
      },
      en: {
        meaning: 'The regularity of move intervals: 60% whether the gaps are steady, 40% whether they are uncorrelated with win-rate loss.',
        usage: 'An engine\'s time is set by search volume, not by how hard the position is; a human\'s thinking time follows the position. With no timing data the term is fixed at 0.5.',
        impact: 'Weight {w}, one of the six base statistics.',
      },
    },
    {
      id: 'signal-evasion', cat: 'signal', nameNs: 'learn.weight', nameVal: 'evasion',
      applied: true, weightKey: 'evasion',
      zh: {
        meaning: '回避手：前后都是高分、中间突然走出臭棋的形态。一半看数量，一半看这种形态出现得有多规律。'
             + '5 次且节奏均匀时满值。',
        usage: '0.4.2 引入。针对「故意走几步差的来降低整体风险分」这种规避策略。',
        impact: '权重 {w}，行为信号之一。没有回避手时该分项为 0，'
             + '因此不改变旧对局的分数。',
      },
      en: {
        meaning: 'Evasion hands: a good move, a sudden blunder, then a good move again. Half the term counts how many, half how evenly they are spaced. Five of them on a regular rhythm saturate it.',
        usage: 'Added in 0.4.2, aimed squarely at "play a few bad moves on purpose to drag the overall score down".',
        impact: 'Weight {w}, one of the behaviour signals. It is exactly 0 with no evasion hands.',
      },
    },
    {
      id: 'signal-win-blunder', cat: 'signal', nameNs: 'learn.weight', nameVal: 'winBlunder',
      applied: true, weightKey: 'winBlunder',
      zh: {
        meaning: '将胜乱下：已经胜势却走出明显劣着。3 次即满值。',
        usage: '与「回避手」成对出现——一个是败势里突然走好，一个是胜势里突然走坏，'
             + '都是「故意」的痕迹。',
        impact: '权重 {w}，行为信号之一。无此形态时为 0。',
      },
      en: {
        meaning: 'Blundering while winning: a clearly inferior move played from a won position. Three of them saturate it.',
        usage: 'Pairs with 回避手 — one is suddenly playing well while lost, the other suddenly playing badly while winning. Both are traces of intent.',
        impact: 'Weight {w}, one of the behaviour signals. Zero when the pattern is absent.',
      },
    },
    {
      id: 'signal-useless-four', cat: 'signal', nameNs: 'learn.weight', nameVal: 'uselessFour',
      applied: true, weightKey: 'uselessFour',
      zh: {
        meaning: '必败方的连续冲四（≥2 步，且该方最佳胜率 ≤ 0.10）。2 段即满值。',
        usage: '0.4.7 引入，比「将败冲四」更严格：不仅败势，还要连着冲。单次可能是诚实的挣扎，连着冲才是无谓。',
        impact: '权重 {w}，行为信号之一。无此形态时为 0。',
      },
      en: {
        meaning: 'A run of 2+ consecutive four-chases played from a lost position (that side\'s best win rate ≤ 0.10). Two such runs saturate it.',
        usage: 'Added in 0.4.7 and stricter than 将败冲四: not just lost, but chasing repeatedly. A single one can be an honest attempt; a run cannot.',
        impact: 'Weight {w}, one of the behaviour signals. Zero when the pattern is absent.',
      },
    },
    {
      id: 'signal-sharp-streak', cat: 'signal', nameNs: 'learn.weight', nameVal: 'sharpStreak',
      applied: true, weightKey: 'sharpStreak',
      zh: {
        meaning: '唯一手连中：连续命中唯一手的最长段。0.5.2 起改为指数曲线——连得越长，增量越大（3 段约 0.14，十段封顶）。',
        usage: '人类偶尔猜中唯一手是常事，连着猜中不是。指数曲线的意义在于「第 6 次」比「第 2 次」更可疑。',
        impact: '权重 {w}，行为信号之一。无唯一手连中时为 0。',
      },
      en: {
        meaning: 'The longest run of consecutive unique-move hits. Exponential since 0.5.2 — the longer the run, the bigger the increment (a 3-run is worth about 0.14, ten saturates).',
        usage: 'A human guessing a unique move once is ordinary; guessing it repeatedly is not. The exponential curve is what makes the 6th hit more suspicious than the 2nd.',
        impact: 'Weight {w}, one of the behaviour signals. Zero with no streak.',
      },
    },
    {
      id: 'signal-sharp-total', cat: 'signal', nameNs: 'learn.weight', nameVal: 'sharpTotal',
      applied: true, weightKey: 'sharpTotal',
      zh: {
        meaning: '唯一手累计：命中唯一手的总次数，同样是指数曲线。',
        usage: '补「连中」的漏洞——一个从不断长段、但反复命中唯一手的一方，靠这一项被抓出来。',
        impact: '权重 {w}，行为信号之一。无唯一手命中时为 0。',
      },
      en: {
        meaning: 'The total number of unique-move hits, also exponential.',
        usage: 'Covers the gap left by the streak term — a side that never runs long but keeps finding the only move is caught here.',
        impact: 'Weight {w}, one of the behaviour signals. Zero with no hits.',
      },
    },
    {
      id: 'signal-good-pool', cat: 'signal', nameNs: 'learn.weight', nameVal: 'goodPool',
      applied: true, weightKey: 'goodPool',
      zh: {
        meaning: '好点池：好点占比（占七成）与最长连续好点（占三成）的组合。'
               + '好点 = 这一步落在引擎前 5 候选以内；记录到的思考时间超过 6 秒的手上，前 8 候选也算。',
        usage: '0.5.2 引入、0.5.5 重定义：看的是「一直保持在好点上」这件事本身，而不是某一步'
             + '是否命中首选。占比 55% 以下不计分，连续度不足 3 不扣分 —— 短连击只是不加分，'
             + '不会把占比挣来的分吃掉。',
        impact: '权重 {w}，是整张权重表里最大的一项。没有好点时占比项为 0。',
      },
      en: {
        meaning: 'A good-point pool: 70% the share of hands inside the engine\'s top-5 candidates, '
               + '30% the longest run of them. A good point is a hand inside the top five; on a hand '
               + 'whose recorded thinking time exceeded 6s, the top eight count as well.',
        usage: 'Added in 0.5.2 and redefined in 0.5.5. It reads the sustained fact of staying on '
             + 'good points rather than whether any single hand hit the top choice. Nothing scores '
             + 'below a 55% share, and a run shorter than three costs nothing — a short run fails to '
             + 'add, it does not eat the share\'s contribution.',
        impact: 'Weight {w}, the largest single term in the table. Zero with no good points at all.',
      },
    },
    {
      id: 'signal-live-three', cat: 'signal', nameNs: 'learn.weight', nameVal: 'liveThree',
      applied: true, weightKey: 'liveThree',
      zh: {
        meaning: '活三好手：活三防点连续走成引擎首选的最长段（≥2 段起算），指数曲线。',
        usage: '0.5.2 引入。单次把活三防点走成首选是正常水平——活三往往只有一两个可选点；'
             + '连续两次在两个方向里都选对，才不是运气。',
        impact: '权重 {w}，行为信号之一。无此池时为 0。',
      },
      en: {
        meaning: 'Live-three defence played as the engine\'s first choice, longest run (counted from 2), on an exponential curve.',
        usage: 'Added in 0.5.2. Blocking a live three with the top choice once is ordinary — there are usually only one or two candidate points. Doing it twice in a row, with two directions to choose from, is not luck.',
        impact: 'Weight {w}, one of the behaviour signals. Zero with no such pool.',
      },
    },
  ];

  // ---------------------------------------------------------------------------------------
  // Language resolution. §1.4.3 ships 中文 + 英文 and says the rest fall back, so the rule is
  // exactly two-way: either Chinese (simplified or traditional) or English. There is no
  // zh-TW body — traditional readers get simplified prose, which is legible, whereas falling
  // back to English would not be.
  // ---------------------------------------------------------------------------------------
  function bodyLang(lang) {
    var l = String(lang == null ? '' : lang);
    return (l === 'zh-CN' || l === 'zh-TW') ? 'zh' : 'en';
  }

  // The live weight table, if it is reachable.
  //
  // `app.js` publishes through `module.exports` (see its own note at app.js:2310) and so has no
  // global of its own — but `BASE_WEIGHTS` is a top-level `const` in a classic script, which
  // puts it in the shared global lexical environment, so a later script can read it as a bare
  // identifier. It is loaded before this file in both hosts. `typeof` on an undeclared name is
  // safe and returns 'undefined' rather than throwing, which is what makes this probe cheap.
  //
  // Returning null (rather than a default) when the table is unreachable is deliberate: see the
  // header. The caller renders an em dash.
  // 0.5.6 补增 §三 — a weight the OPERATOR overrode cannot be read from BASE_WEIGHTS, because the
  // override lives in `settings.signalWeights` and folding it in belongs to app.js. The viewer
  // therefore hands this file the RESOLVED table (`setWeightTable`) before it paints, and every
  // `{w}` below follows it.
  //
  // This carries NUMBERS, which is the one thing the entries above are forbidden to carry: they
  // still store a `weightKey` and nothing else, and this override is a rendering-time input
  // exactly like the locale — set from outside, read here, never stored. `null` means "no override
  // was handed over", which is every surface that never opened the settings page.
  var weightTable = null;
  function setWeightTable(map) {
    weightTable = (map && typeof map === 'object') ? map : null;
  }

  function weight(key) {
    if (!key) return null;
    try {
      if (weightTable && typeof weightTable[key] === 'number') return weightTable[key];
    } catch (e) { /* replaced by something hostile — fall through to the table below */ }
    try {
      /* global BASE_WEIGHTS */
      if (typeof BASE_WEIGHTS !== 'undefined' && BASE_WEIGHTS && typeof BASE_WEIGHTS[key] === 'number') {
        return BASE_WEIGHTS[key];
      }
    } catch (e) { /* TDZ or absent — treat as unreachable */ }
    return null;
  }

  function band(key) {
    if (!key) return null;
    try {
      /* global BASE_THRESHOLDS */
      if (typeof BASE_THRESHOLDS !== 'undefined' && BASE_THRESHOLDS
          && typeof BASE_THRESHOLDS[key] === 'number') {
        return BASE_THRESHOLDS[key];
      }
    } catch (e) { /* same */ }
    return null;
  }

  // ---------------------------------------------------------------------------------------
  // Placeholder filling. `{w}` is a weight and gets the raw table value; `{lo}`/`{hi}` are band
  // cuts and get rounded, because a cut is a whole number by intent and `BASE_THRESHOLDS` is
  // free to hold a float. A missing figure becomes an em dash, never a zero: "≥ —" is a visible
  // failure, "≥ 0" is a silent lie.
  // ---------------------------------------------------------------------------------------
  var DASH = '\u2014';

  function fill(text, entry) {
    if (!text) return '';
    var out = String(text);
    if (out.indexOf('{w}') >= 0) {
      var w = weight(entry && entry.weightKey);
      out = out.split('{w}').join(w == null ? DASH : String(w));
    }
    if (out.indexOf('{lo}') >= 0 || out.indexOf('{hi}') >= 0) {
      var lo = band(entry && entry.bandLo);
      var hi = band(entry && entry.bandHi);
      out = out.split('{lo}').join(lo == null ? '0' : String(Math.round(lo)));
      out = out.split('{hi}').join(hi == null ? '100' : String(Math.round(hi)));
    }
    return out;
  }

  // Resolve one entry for a language. `name` is intentionally NOT resolved here — it is a
  // dictionary key and needs GMI18n, which this file does not depend on. The caller does
  // `TO(entry.nameNs, entry.nameVal)`.
  function resolve(entry, lang) {
    if (!entry) return null;
    var body = entry[bodyLang(lang)] || entry.en || entry.zh || {};
    return {
      id: entry.id,
      cat: entry.cat,
      applied: entry.applied !== false,
      meaning: fill(body.meaning, entry),
      usage: fill(body.usage, entry),
      impact: fill(body.impact, entry),
    };
  }

  // Case-insensitive substring match over everything the operator can see: the id, the slug, the
  // two bodies, and — when the caller supplies one — the TRANSLATED display name.
  //
  // `nameOf` is a function rather than a pre-built map because the display name needs GMI18n,
  // which this file deliberately does not depend on (see the header). It matters that it is
  // searched: a signal's `nameVal` is the slug `top1`, while what the modal PRINTS is
  // 「Top1 吻合」 from the `learn.weight.top1` row, so an operator typing 吻合 would otherwise
  // get nothing back from a list that visibly contains it.
  function matches(entry, q, nameOf) {
    if (!q) return true;
    var needle = String(q).trim().toLowerCase();
    if (!needle) return true;
    var shown = '';
    if (typeof nameOf === 'function') {
      try { shown = nameOf(entry) || ''; } catch (e) { shown = ''; }
    }
    // Search the FILLED bodies, not the templates: an operator who types `75` is looking for
    // the AI cut, and `{lo}` is not what they are looking at.
    //
    // Both languages are searched regardless of the reader's language, so a Chinese operator can
    // still find an entry by an English word they saw in the docs, and vice versa.
    var zh = resolve(entry, 'zh-CN') || {};
    var en = resolve(entry, 'en') || {};
    var hay = [entry.id, entry.nameVal, shown,
               zh.meaning, zh.usage, zh.impact,
               en.meaning, en.usage, en.impact]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(needle) >= 0;
  }

  function filter(opts) {
    var o = opts || {};
    var cat = o.cat && o.cat !== 'all' ? o.cat : null;
    return ENTRIES.filter(function (e) {
      if (cat && e.cat !== cat) return false;
      return matches(e, o.q, o.nameOf);
    });
  }

  return {
    CATS: CATS,
    ENTRIES: ENTRIES,
    bodyLang: bodyLang,
    weight: weight,
    // 0.5.6 补增 §三 — the operator's resolved table, handed in by the viewer before a paint.
    setWeightTable: setWeightTable,
    band: band,
    fill: fill,
    resolve: resolve,
    matches: matches,
    filter: filter,
    DASH: DASH,
    byId: function (id) {
      for (var i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].id === id) return ENTRIES[i];
      return null;
    },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GM_TAG_WIKI: GM_TAG_WIKI };
}
