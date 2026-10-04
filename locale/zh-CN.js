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
  'jobLabel.重新分析': '重新分析',
  'jobLabel.导入至回放': '导入至回放',
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

  // ---- AI 分类 (0.4.3 §1.5) ----
  // app.js's classifySide() runs in the offscreen document, where there is no UI dictionary
  // at all, so it can only produce a CODE — and that code is what gets persisted in
  // report.types / entry.types / manualType. Nothing compares it by literal (the panel and the
  // viewer render it through TO('type', code)), but it is a stored identity value all the same,
  // which is what puts it here rather than in the text-keyed table. The five bands of §1.6 are
  // NOT listed: only the AI classes and the four non-AI classes are ever stored, and the
  // band names (疑似AI / 职业选手 / …) survive as the type names themselves.
  'type.lowAi': '低级AI',
  'type.evasiveAi': '规避型AI',
  'type.strongEvasiveAi': '强规避AI',
  // 0.5.7 §1.5 — the fourth AI class, and the only one that is not a band of the score at all:
  // `classifySide` reaches it by DOWNGRADING a 职业选手 / 高手玩家 verdict whose two low-end
  // signals give it away. It is stored like any other code, so it needs its row here as well as
  // in _tools/i18n-extra.js.
  'type.lowEndAi': '低端AI',
  'type.suspectAi': '疑似AI',
  'type.pro': '职业选手',
  'type.expert': '高手玩家',
  'type.normal': '普通玩家',

  // 0.4.4 — the runtime codes the chat side emits. Listed here so the BASELINE table can resolve
  // them; the twelve generated tables get them from _tools/i18n-extra.js (same arrangement as the
  // `type.*` block above). Both halves are load-bearing: `tOr()` returns the raw code when
  // neither table has the key, so a missing row here shows the operator the word `none`.
  'verdict.correct': '答对', 'verdict.wrong': '答错', 'verdict.unknown': '明确拒答',
  'verdict.vague': '答非所问', 'verdict.empty': '未作答', 'verdict.no': '否',
  'verdict.followup': '追问中',
  // 0.5.0 §三 — a `weight: 0` question is a message, not a test.
  'verdict.none': '已发送',
  // 0.5.2 §4.1.4 — the five levels the operator grades a custom question's answer with. Reached as
  // `TO('customLevel', lv)`, so a missing row prints the raw code (`high`) on the button, which is
  // also why the numeric delta is printed beside it: the words alone are not guessable arithmetic.
  // `none` and `low` deliberately do NOT reuse `level.低风险` / `level.高风险` — those name a
  // verdict the detector reached, these name what the operator just decided.
  'customLevel.none': '无风险', 'customLevel.low': '低风险', 'customLevel.unclear': '难以判断',
  'customLevel.risky': '有风险', 'customLevel.high': '高风险',
  'senderHow.socket': 'socket 事件', 'senderHow.dom': '页面 DOM',
  'senderHow.anchor-unresolved': '声明锚点（未定）', 'senderHow.unknown': '未确定',
  'llm.notConfigured': '未配置 LLM API', 'llm.quotaExceeded': '本月额度已用尽',
  'llm.httpError': 'HTTP 错误（{code}）', 'llm.timeout': '请求超时',
  'llm.autoDisabled': '连续失败已自动禁用', 'llm.bridgeFailed': '调用通道失败',
  // §7.3 — why a chat send did not go through (see i18n-extra.js for the same three codes).
  'sendWhy.noInput': '找不到聊天输入框', 'sendWhy.stuck': '聊天输入框未被清空',
  'sendWhy.throw': '发送脚本报错',

  // ---- 0.5.1 §2.1/§2.2: the engine and the custom weight-package store (see i18n-extra.js —
  // the same codes have to live in both places, or zh-CN resolves them and nothing else does).
  'engine.badCoord': '坐标无法转换（第 {i} 手）',
  'engine.noBuilds': '没有可用的引擎构建',
  'engine.noUrl': '未配置服务地址',
  'engine.noAnswer': '引擎没有给出任何着法',
  'engine.badResponse': '引擎返回了无法解析的应答',
  'engine.gtpFailed': 'GTP 引擎拒绝了该指令',
  'engine.httpTimeout': 'HTTP 引擎请求超时（{sec} 秒）',
  'engine.httpFailed': 'HTTP 引擎返回错误',
  'engine.noBridge': '无法与后台引擎通信',
  'engine.allFailed': '所有候选引擎均加载失败',
  'custom.missing': '自定义模型的权重包不存在',
  'custom.noFile': '未选择任何文件',
  'custom.tooBig': '单个权重包不能超过 {mb} MB',
  'custom.tooMany': '最多只能保存 {max} 个自定义模型',

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
  'copy.prefix': '白身（Baishen）输出：',
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
  'copy.codeOnly': '仅可复制棋谱代码（尚无分析结果）',
  'copy.partial': '分析未完成，复制的是当前已完成部分',
  'copy.title': '复制当前结果',

  // ---- 学习参数标签与学习提示 (learn.js). The parameter labels are keyed by the parameter's
  // STABLE key (`top1`, `riskHigh`, …) rather than by their text, so the tables cannot share
  // them with the viewer's identical wording; `_tools/i18n-extra.js` maps the keys onto the
  // texts. Every key of that file must ALSO be listed here: zh-CN is the baseline table and
  // `t()` cannot resolve a runtime key from anywhere else, so a missing row prints the SLUG
  // (`learn.weight.evasion`) in the panel. verify-053 asserts the two sets, because nothing in
  // the toolchain did — 0.4.7 shipped two weight rows and eleven threshold rows that were in
  // `i18n-extra.js` only, and the contribution breakdown rendered them as raw slugs in Chinese.
  'learn.weight.top1': 'Top1 吻合',
  'learn.weight.acpl': 'ACPL 均损',
  'learn.weight.sharp': '唯一手',
  'learn.weight.out': 'Top5 之外',
  'learn.weight.desperate': '将败冲四',
  'learn.weight.time': '时间规律',
  // 0.4.2 §2.3 — the two surcharges learned in their own budget. Reached RAW (no fallback) by
  // the viewer's contribution breakdown, so their absence here was visible, not latent.
  'learn.weight.evasion': '回避手',
  'learn.weight.winBlunder': '将胜乱下',
  // 0.4.7 §1.1 — the third per-item surcharge.
  'learn.weight.uselessFour': '无用冲四',
  // 0.4.8 §1.2 — the streak pair, also a surcharge.
  'learn.weight.sharpStreak': '唯一手连续',
  'learn.weight.sharpTotal': '唯一手累计',
  // 0.5.2 §1.1.4 / §1.2.4 — the two new surcharges, and the last two rows this block will get
  // before the base six are joined by a fifth and sixth surcharge (see app.js's WEIGHTS comment
  // for why the six keep summing to 1.00 and every addition lands outside).
  'learn.weight.goodPool': '好点池',
  'learn.weight.liveThree': '活三好手',
  // 0.5.7 §1.3 — the three low-end-AI signals. They are the first weight rows whose raw counts
  // do NOT come from the engine's candidate list at all: 不漏防 / 败势不崩 read the board and the
  // stored win rates, 探针匹配 reads the board against probes.js. Same arrangement as every other
  // runtime-key row — listed here so the BASELINE resolves them, emitted into the twelve
  // generated tables from _tools/i18n-extra.js.
  'learn.weight.noBlunder': '不漏防',
  'learn.weight.steadyLost': '败势不崩',
  'learn.weight.probeMatch': '探针匹配',

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
  // 0.4.2 §4.3 — the six evasion cuts and the winning-position win-rate line.
  'learn.threshold.evasionLoss': '回避手损失阈值',
  'learn.threshold.goodLoss': '好棋损失上限',
  'learn.threshold.evasionMin': '规律性最小回避数',
  'learn.threshold.evasionReg': '规律性标准差上限',
  'learn.threshold.winningWR': '将胜胜率阈值',
  // 0.4.3 §1.1/§1.6 — two re-anchored ramp cuts and the four AI-class band lines.
  'learn.threshold.topProxLo': '接近度下界',
  'learn.threshold.topProxHi': '接近度上界',
  'learn.threshold.typeAiMin': 'AI 档线',
  'learn.threshold.typeSuspectMin': '疑似AI 档线',
  'learn.threshold.typeProMin': '职业选手 档线',
  'learn.threshold.typeExpertMin': '高手玩家 档线',
  // 0.4.7 §1.1 — the two cuts that split a four-run into VCF / 防御性 / 无用.
  'learn.threshold.fourVcfWR': '冲四 VCF 胜率线',
  'learn.threshold.fourLostWR': '冲四 必败胜率线',

  'learn.noRoleTags': '没有样本带「AI 样本」「人类样本」「黑方AI」或「白方AI」标签，权重无法调整（阈值与特征库仍已更新）。',

  // ---- 语言选择 (§1.2). Two entry points consume these: the toolbar right-click menu
  // (background.js) and the viewer's settings dropdown. The thirteen `lang.*` values are
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
  'lang.vi': 'Tiếng Việt',
  'lang.es': 'Español',
  'lang.ms': 'Bahasa Melayu',
  'lang.ar': 'العربية',
  'lang.mn': 'Монгол',

  // ---- 网络自主更新 (0.4.0 §一). 更新横幅、设置页的「检测更新」按钮与它的三种结果。
  // 版本号走 {v}；releaseNotes 直接显示 version.json 的原文，故意不翻译（它随每次发布变）。
  'update.available': '发现新版本 v{v}',
  'update.view': '查看详情',
  'update.dismiss': '暂不更新',
  'update.check': '检测更新',
  'update.checking': '检测中…',
  'update.upToDate': '已是最新版本（v{v}）',
  'update.found': '发现新版本 v{v}，可前往下载',
  'update.failed': '检测失败（网络不可用或仓库不可达）',
  'update.current': '当前版本 v{v}',
  'update.oneClick': '一键更新',
  'update.downloading': '正在下载更新包…',
  'update.downloaded': '更新包已下载，可打开扩展页安装',
  'update.dlFailed': '下载失败（网络不可用或被浏览器拒绝）',
  'update.readyTitle': '更新包已下载',
  'update.readyBody': '白身检测器更新包「{file}」已下载。点此打开扩展管理页，解压后重新加载即可完成更新。',
  'update.openExtensions': '打开扩展管理页',

  // ---- 1.0.2 §1.4: the ONE source-text key whose zh-CN value is NOT the text after the `|`.
  //
  // Every other `area|中文原文` key is defined by zh-CN's absence: `fallback()` slices past the `|`
  // and the remaining text is already correct. §1.4 breaks that — the panel is called 语言与显示 but
  // displays 语言与显示（language）, because the suffix tells a reader who cannot yet read the UI
  // which control changes that. English omits it («language» is already English), which is why the
  // suffix lives in the twelve tables of `_tools/i18n-ui.js` rather than in the markup.
  //
  // ⚠ The key must be spelled with the area prefix here, and the markup must stay BARE: the bare
  // text is what `keys.cjs` turns into `html|语言与显示`, and that key is what all thirteen tables
  // are indexed by. Rewriting the <h2> to carry the suffix would change the key everywhere.
  // ⚠ This is the only `|`-bearing line in the file, and `keys.cjs` classifies `|` keys as
  // source-text rather than semantic for exactly this reason — see the ⚠ there. Writing the key
  // as a literal is safe BECAUSE of that rule; before 1.0.2 it was not.
  'html|语言与显示': '语言与显示（language）',

  // ---- 1.0.2 二 — 社区的 category / status 值 ----
  //
  // §2.4.2's `news.category`, §2.5.2's `feedback.category` and `feedback.status` are stored as
  // VALUES, so the label cannot be a source-text key (`area|中文原文`): `T('community|bug')` would
  // be a key whose text is the word 「bug」, and every table would need a row keyed by a code. They
  // are dotted runtime keys instead, the same shape as `learn.weight.top1`.
  //
  // ⚠ These nine MUST be listed here as well as in `_tools/i18n-extra.js`. `keys.cjs` learns the
  // KEY from this file and the Chinese text it translates FROM from that one; listing only the
  // latter builds the tables but leaves zh-CN itself without a row, and `t()` answers an unknown
  // key with the KEY — so the Chinese UI would print 「cm.cat.bug」 on every card.
  'cm.cat.bug': 'Bug',
  'cm.cat.suggestion': '建议',
  'cm.cat.other': '其他',
  'cm.st.open': '待处理',
  'cm.st.in_progress': '处理中',
  'cm.st.resolved': '已解决',
  'cm.st.closed': '已关闭',
  'cm.newscat.changelog': '更新日志',
  'cm.newscat.announcement': '公告',

  // ---- 1.0.3 §一/§二/§三 — 分享种类 / 投票选项 / 举报类型 / 状态 ----
  //
  // Same reason as the nine above: §1.2.3's `kind`, §1.4.2's `choice`, §2.1's `category` and
  // §3.2.1's resolved state are all stored as VALUES, so each label is a dotted runtime key
  // reached through `cmNamed()` rather than a source-text key. `cm.presence.*` is a THIRD family
  // again — those three are the strings `presenceState()` returns, and `cm.manual.*` are the
  // three §3.2.3 radios the operator picks from; they are the same three words today and must
  // still be two key families, because 「我声明我在线」 and 「系统测得他在线」 are different claims
  // and one of them will get a fourth value before the other does.
  //
  // ⚠ Registered in `_tools/i18n-extra.js` TOO — that file supplies the text to translate FROM
  // and this one is what makes zh-CN itself resolve the key instead of printing `cm.vote.both-ai`.
  'cm.share.archive': '存档',
  'cm.share.sample': '样本',
  'cm.share.config': '配置',
  'cm.vote.black-ai': '黑方 AI',
  'cm.vote.white-ai': '白方 AI',
  'cm.vote.both-ai': '双方 AI',
  'cm.vote.both-human': '双方人类',
  'cm.report.cheat': '作弊',
  'cm.report.abuse': '辱骂/骚扰',
  'cm.report.spam': '广告/刷屏',
  'cm.report.other': '其他',
  'cm.manual.online': '在线',
  'cm.manual.busy': '忙碌中',
  'cm.manual.hidden': '隐身',
  'cm.presence.online': '在线',
  'cm.presence.busy': '忙碌中',
  'cm.presence.offline': '离线',

});
