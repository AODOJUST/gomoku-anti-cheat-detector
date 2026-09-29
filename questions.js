/* 0.4.4 §十一 — the pre-made question bank (F&Q).
 *
 * Transcribed from the operator's 题库.txt. That file describes the bank as a DIALOGUE TREE
 * rather than the flat keyword array §11 sketched as a placeholder, and the operator confirmed
 * the tree is the real specification (2026-09-29). So the DATA shape below carries both:
 *
 *   - the §11 fields that still mean something (id / category / difficulty / weight / text /
 *     notes / reject), so a future flat question can be added without touching the engine;
 *   - `branches`, which is what actually drives these two questions.
 *
 * `text` holds all 8 languages inline instead of a `lang` + `translations` pair: these are
 * runtime CONTENT, not UI chrome, so they deliberately do NOT go through the i18n UI dictionary
 * (whose keys are Chinese UI strings). `GMChat.text(q, lang)` picks the entry.
 *
 * DELTA ARITHMETIC — §13.2's table is `correct = -10 × weight/3`, `wrong = +8 × weight/3`.
 * 题库.txt gives no weights, so both questions use weight 3 and the deltas land exactly on the
 * table's -10 / +8. A weight other than 3 would produce a fractional adjustment, which the
 * ±20 accumulator would then have to round; keeping 3 avoids that entirely.
 *
 * `delta.low` / `delta.high` are selected by the opponent's CURRENT risk score against the
 * 疑似AI line (55, i.e. `DEFAULT_THRESHOLDS.typeSuspectMin`). 题库.txt only says 「AI率低/高」
 * without naming a cut, and 55 is the same line §12 uses for 「AI 率超过 55 时才可提问」.
 */
(function (g) {
  'use strict';

  // The 疑似AI line: below it the opponent is "低", at or above it "高".
  var RATE_LINE = 55;

  var GM_QUESTIONS = [
    {
      id: 'q001',
      category: 'culture',
      difficulty: 1,
      weight: 3,
      // 「随时可提问」— no gate at all.
      askWhen: { always: true },
      cooldownMs: 10000,
      timeoutMs: 60000,
      text: {
        'zh-CN': '你学习过五子棋吗？',
        'zh-TW': '你學過五子棋嗎？',
        ja: '五目並べを勉強したことはありますか？',
        ko: '오목을 공부해 본 적이 있나요?',
        en: 'Have you studied gomoku before?',
        ru: 'Вы изучали гомоку?',
        fr: 'Avez-vous déjà étudié le gomoku ?',
        de: 'Haben Sie sich schon mit Gomoku beschäftigt?',
      },
      // 题库.txt:
      //   yes类 → 对方AI率低/高 → 均降低AI率
      //   No类  → 对方AI率低/高 → 降低/提高AI率
      branches: {
        yes: { delta: { low: -10, high: -10 } },
        no: { delta: { low: -10, high: +8 } },
      },
      notes: '入门常识题。答「学过」只是兴趣声明，两档都降；答「没学过」在已被怀疑时是反向证据。',
    },

    {
      id: 'q002',
      category: 'opening',
      difficulty: 2,
      weight: 3,
      // 「AI率超过55时才可提问」
      askWhen: { aiAbove: RATE_LINE },
      cooldownMs: 10000,
      timeoutMs: 60000,
      text: {
        'zh-CN': '你知道我们这局的开局叫什么名字吗？',
        'zh-TW': '你知道我們這局的開局叫什麼名字嗎？',
        ja: 'この対局の定石（開局）の名前を知っていますか？',
        ko: '이 대국의 포석 이름을 알고 있나요?',
        en: 'Do you know the name of the opening we played in this game?',
        ru: 'Знаете ли вы название дебюта в этой партии?',
        fr: 'Connaissez-vous le nom de l’ouverture de cette partie ?',
        de: 'Kennen Sie den Namen der Eröffnung in dieser Partie?',
      },
      // 题库.txt:
      //   yes类 → 追问「我是初学者，要补齐基础知识，你可以帮我看看这个开局叫什么名字吗？」
      //         → 回答正确/错误 → 降低/提高AI率 → 谢谢前辈
      //   NO类  → 直接增加AI率
      //   （第三条）直接回答出含有开局名称的答案 → 回答正确/错误 → 降低/提高AI率
      branches: {
        yes: {
          followUp: {
            'zh-CN': '我是初学者，要补齐基础知识，你可以帮我看看这个开局叫什么名字吗？',
            'zh-TW': '我是初學者，要補齊基礎知識，你可以幫我看看這個開局叫什麼名字嗎？',
            ja: '私は初心者で、基礎から学び直したいのです。この開局の名前を教えていただけますか？',
            ko: '저는 초보라서 기초부터 배우고 싶습니다. 이 포석의 이름을 알려주실 수 있나요?',
            en: 'I am a beginner trying to learn the basics — could you tell me what this opening is called?',
            ru: 'Я новичок и хочу разобраться в основах — не подскажете, как называется этот дебют?',
            fr: 'Je suis débutant et je cherche à apprendre les bases — pourriez-vous me dire comment s’appelle cette ouverture ?',
            de: 'Ich bin Anfänger und möchte die Grundlagen lernen — könnten Sie mir sagen, wie diese Eröffnung heißt?',
          },
          // 回答正确 → 降低 / 回答错误 → 提高；随后发一句「谢谢前辈」。
          then: 'gradeOpening',
          thanksAfter: true,
        },
        no: { delta: { low: +8, high: +8 } },
        // 直接报出开局名：不必追问，直接判对错。
        direct: { then: 'gradeOpening' },
      },
      notes: '开局名题。人类高手对 RIF 开局名有直觉，AI 作弊者通常没有 —— 这是本扩展独有的判定依据，因为本局真实开局名由 GMOpening 从棋谱反推，不依赖对手的答案。',
    },
  ];

  g.GM_QUESTIONS = GM_QUESTIONS;
  g.GM_RATE_LINE = RATE_LINE;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GM_QUESTIONS;
    module.exports.RATE_LINE = RATE_LINE;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
