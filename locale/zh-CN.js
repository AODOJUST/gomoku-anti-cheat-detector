/* 简体中文 — 基准语言 (zh-CN).
 *
 * This file deliberately holds only the SEMANTIC keys. The bulk of the UI uses source-text
 * keys of the form `area|中文原文` (see i18n.js), and for zh-CN there is nothing to define:
 * `t('panel|查看器')` falls back to the text after the `|`, which is already correct. That is
 * why this table is short while the other seven are long.
 *
 * What MUST be listed here are the namespaces whose value is an IDENTITY, stored in
 * chrome.storage and compared by literal elsewhere in the code — tags, annotation labels,
 * risk levels, end reasons — plus the namespaces 0.3.6 §1.7/§2.6 names explicitly.
 */
GMI18n.register('zh-CN', {

  // ---- 风险等级 (§2.6). Stored in archives as blackLevel / whiteLevel and compared in
  // app.js (the cut lines) and content.js (riskColor), so the KEY is the stored value.
  'level.低风险': '低风险',
  'level.可疑': '可疑',
  'level.高风险': '高风险',

  // ---- 预设标签. Stored in samples/archives and matched by literal in learn.js.
  'tag.标准样本': '标准样本',
  'tag.存疑样本': '存疑样本',
  'tag.黑方打谱样本': '黑方打谱样本',
  'tag.白方打谱样本': '白方打谱样本',
  'tag.双方样本': '双方样本',
  'tag.AI 样本': 'AI 样本',
  'tag.人类样本': '人类样本',
  'tag.黑方AI': '黑方AI',
  'tag.白方AI': '白方AI',

  // ---- 人工标注. Stored in annotations[].labels and matched by literal in learn.js
  // ('AI步骤' gates the positive class, '人类样本' the negative).
  'ann.判断准确': '判断准确',
  'ann.判断错误': '判断错误',
  'ann.AI步骤': 'AI步骤',
  'ann.冲四': '冲四',
  'ann.无用冲四': '无用冲四',
  'ann.可疑': '可疑',
  'ann.豁免': '豁免',

  // ---- 对局结束原因. Persisted as record.meta.endedBy.
  'end.结算浮层': '结算浮层',
  'end.和棋浮层': '和棋浮层',
  'end.棋盘已满（和棋）': '棋盘已满（和棋）',
  'end.五连成立（无结算浮层）': '五连成立（无结算浮层）',

  // ---- 任务状态与任务名 (content.js panel). Both live on the in-memory job object rather
  // than in storage, but the panel compares `status` by literal in half a dozen places
  // (`status === '已完成'`, `status === '分析中'`), so they are identity values all the same
  // and only their display goes through tOr().
  'jobStatus.待分析': '待分析',
  'jobStatus.分析中': '分析中',
  'jobStatus.已完成': '已完成',
  'jobStatus.失败': '失败',
  'jobStatus.已中止': '已中止',
  'jobStatus.已暂停': '已暂停',

  'jobLabel.全局分析': '全局分析',
  'jobLabel.导入回放': '导入回放',
  'jobLabel.实时逐步': '实时逐步',

  // ---- 会话身份 (content.js meta.identity). ID_LABEL in viewer.js keeps these as canonical
  // keys and the detail row renders them through tOr(), for the same reason as the tags.
  'idLabel.registered': '注册账号',
  'idLabel.guest': '游客账号',
  'idLabel.spectator': '观战',

  // ---- 活四终止原因 (app.js applyTerminal). Written into the step record and the report, so
  // it is carried as an identity value like the levels. The engine's own prose is what
  // travels — these two are the only reasons the detector itself synthesises.
  'stopReason.活四': '活四',
  'stopReason.当前方形成活四，对手必败': '当前方形成活四，对手必败',
  'stopReason.对手形成活四，当前方必败': '对手形成活四，当前方必败',

  // ---- 开局筛选树。大类（直止 / 斜止）不翻译，见 §1.9 验收 4。
  'open.allDirect': '全部直止',
  'open.allIndirect': '全部斜止',

  // ---- 26 个 RIF 开局名. Kept as the published Chinese names in every language that uses
  // the RIF 汉字 (ja / ko); the other languages supply their own beside them.
  'opening.D1': '寒星', 'opening.D2': '溪月', 'opening.D3': '疏星',
  'opening.D4': '花月', 'opening.D5': '残月', 'opening.D6': '雨月',
  'opening.D7': '金星', 'opening.D8': '松月', 'opening.D9': '丘月',
  'opening.D10': '新月', 'opening.D11': '瑞星', 'opening.D12': '山月',
  'opening.D13': '游星',
  'opening.I1': '长星', 'opening.I2': '峡月', 'opening.I3': '恒星',
  'opening.I4': '水月', 'opening.I5': '流星', 'opening.I6': '云月',
  'opening.I7': '浦月', 'opening.I8': '岚月', 'opening.I9': '银月',
  'opening.I10': '明星', 'opening.I11': '斜月', 'opening.I12': '名月',
  'opening.I13': '彗星',

  // ---- 引擎错误与进度 (§1.7 决策 3). app.js runs offscreen, where the UI language is
  // irrelevant, so it throws `__i18n:` codes and the panel / viewer translates them with
  // GMI18n.trError(). These are the zh-CN renderings — the texts the pre-0.3.6 code threw
  // literally, recovered verbatim so nothing an operator reads changes.
  'engine.noSab': '当前环境不支持多线程 WASM（SharedArrayBuffer 不可用）',
  'engine.noResponse': '多线程搜索无响应',
  'engine.stalled': '搜索全程无进展',
  'engine.poolDown': '线程池未启动（{sec} 秒无输出）',

  'progress.loading': '加载引擎中...',
  'progress.ready': '引擎就绪，开始逐步分析...',
  'progress.risk': '计算风险分...',
  'progress.done': '完成',
  'progress.step.black': '分析第 {i}/{n} 手（黑方）',
  'progress.step.white': '分析第 {i}/{n} 手（白方）',

  'queue.busy': '引擎正忙，排队中…（前面还有 {ahead} 个任务）',
  'job.aborted': '任务已中止。',
  'job.abortedInQueue': '任务在排队时被中止。',
  'live.gone': '实时逐步会话不存在。',
  'live.goneMaybe': '实时逐步会话不存在（可能已切换模式或被中止）。',
  'live.ended': '实时逐步会话已结束。',

  // ---- 复制输出模板 (§2.6, verbatim).
  'copy.prefix': 'Gomoku反AI作弊检测器输出：',
  'copy.degraded': '（降级）',
  'copy.blackTag': '（黑）',
  'copy.whiteTag': '（白）',
  'copy.hands.simple': '{total}手',
  'copy.hands.withScored': '{total}手（有效{scored}手）',
  'copy.opening.unknown': '开局未识别',
  'copy.player.unknown': '未知',
  'copy.player.genericBlack': '黑方',
  'copy.player.genericWhite': '白方',
  'copy.rate.format': '（AI率：{rate}%，{level}）',
  'copy.rate.unanalyzed': '（未分析）',
  'copy.sides.sep': '，',
  'copy.done': '已复制到剪贴板',
  'copy.fail': '复制失败',
  'copy.noData': '尚无分析结果，无法复制',
  'copy.partial': '分析未完成，复制的是当前已完成部分',
  'copy.title': '复制当前结果',

  // ---- 学习参数标签与学习提示 (learn.js). The parameter labels are keyed by the parameter's
  // STABLE key (`top1`, `riskHigh`, …) rather than by their text, so the tables cannot share
  // them with the viewer's identical wording; `_tools/i18n-extra.js` maps the keys onto the
  // texts. `learn.noRoleTags` is the one learn result rendered through trError(), which has no
  // fallback guard — without an entry here zh-CN would print the slug.
  'learn.weight.top1': 'Top1 吻合',
  'learn.weight.acpl': 'ACPL 均损',
  'learn.weight.sharp': '唯一手',
  'learn.weight.out': 'Top5 之外',
  'learn.weight.desperate': '将败冲四',
  'learn.weight.time': '时间规律',

  'learn.threshold.top1Lo': 'Top1 下界',
  'learn.threshold.top1Hi': 'Top1 上界',
  'learn.threshold.acplLo': 'ACPL 优（低损）',
  'learn.threshold.acplHi': 'ACPL 差（高损）',
  'learn.threshold.sharpHitLo': '唯一手命中下界',
  'learn.threshold.sharpHitSpan': '唯一手跨度',
  'learn.threshold.outTop5Hi': 'Top5 之外 上界',
  'learn.threshold.riskHigh': '高风险线',
  'learn.threshold.riskMid': '可疑线',
  'learn.threshold.simWeight': '特征库权重',

  'learn.noRoleTags': '没有样本带「AI 样本」「人类样本」「黑方AI」或「白方AI」标签，权重无法调整（阈值与特征库仍已更新）。',

  // ---- 语言选择 (§1.2). Two entry points consume these: the toolbar right-click menu
  // (background.js) and the viewer's settings dropdown. The eight `lang.*` values are
  // ENDONYMS — every table carries the identical eight strings, because 「日本語」 reads
  // 「日本語」 no matter which language the rest of the UI is in.
  'menu.lang': '语言',
  'lang.zh-CN': '简体中文',
  'lang.zh-TW': '繁體中文',
  'lang.ja': '日本語',
  'lang.ko': '한국어',
  'lang.en': 'English',
  'lang.ru': 'Русский',
  'lang.fr': 'Français',
  'lang.de': 'Deutsch',

});
