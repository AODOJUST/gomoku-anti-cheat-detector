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

    // ---------- 0.5.0 §三：两条不判对错的消息 ----------
    // Both carry `weight: 0`, which `GMChat.grade()` now reads as "this is a message, not a
    // test": no branch is graded and the adjustment is exactly 0 whatever the opponent replies.
    // Before 0.5.0 a weight of 0 fell through `question.weight ? … : 3` to the DEFAULT weight of
    // 3, so the two would have moved the opponent's risk score by ±8 like any other question —
    // silently, because 0 is falsy and nothing about the value looks wrong.
    {
      id: 'q-ask-origin',
      category: 'social',
      difficulty: 1,
      weight: 0,
      // 随时可提问. It asks nothing the extension can grade, so there is no reason to gate it on
      // the opponent's rate the way q002 is gated.
      askWhen: { always: true },
      cooldownMs: 10000,
      timeoutMs: 60000,
      // ENGLISH ONLY, on purpose (§3.1). The question exists to make the opponent REVEAL their
      // language, and `GMChat.detectLang()` reads the reply: sending it in a language the
      // operator guessed would prime the answer and destroy the evidence. English is the least
      // priming choice available, because it is the most likely second language for anyone who
      // would answer at all.
      //
      // A one-language entry needs no special handling anywhere: `GM_QUESTION_LANGS` is the
      // union over the bank, so English was already in it, and `GMChat.textOf` falls back to
      // English for every other locale — which is the same string, so the picker cannot send
      // this question in a language it does not have.
      text: { en: 'where are you from?' },
      accepted: [],
      reject: [],
      notes: '引导对手自报母语，回答交给 GMChat.detectLang() 更新 chatState.lang。weight 0：不判对错、不动 AI 率。',
    },

    {
      id: 'q-announce',
      category: 'announce',
      difficulty: 1,
      weight: 0,
      askWhen: { always: true },
      cooldownMs: 10000,
      timeoutMs: 60000,
      // The anti-cheat statement. 0.4.4 §7.2 fixed the AUTOMATIC statement to the English text
      // and said it must not be translated; §3.2 keeps that and adds a manual entry that sends
      // the operator's chosen language. The two entry points therefore share this one map — the
      // automatic sender passes 'en' explicitly — instead of keeping a second copy of the
      // sentence in chat.js, which is the "two spellings of one answer" shape this project has
      // shipped wrong three times.
      text: {
        'zh-CN': '反作弊程序已接入对局，请诚信对弈。',
        'zh-TW': '反作弊程式已接入對局，請誠信對弈。',
        ja: '不正行為対策プログラムが対局に導入されました。公正にプレイしてください。',
        ko: '반부정행위 프로그램이 대국에 적용되었습니다. 정정당당하게 대국해 주세요.',
        en: 'The Gomoku anti-cheat program has been integrated into matches. Please play with integrity.',
        ru: 'Программа по борьбе с читерством подключена к матчам. Играйте честно.',
        fr: 'Le programme anti-triche de Gomoku a été intégré aux parties. Jouez avec intégrité.',
        de: 'Das Gomoku-Anti-Cheat-Programm wurde in Spiele integriert. Bitte spielen Sie fair.',
      },
      accepted: [],
      reject: [],
      notes: '开局声明。自动发送固定英文（0.4.4 §7.2），手动入口按提问语言发送。weight 0：不判对错、不动 AI 率。',
    },
  ];

  // 0.4.11 §一.6 — the languages the BANK can actually send, COMPUTED from the data rather than
  // typed out a second time.
  //
  // The 提问 picker used to list `GMI18n.LOCALES` (13). Choosing 越南语 or 阿拉伯语 made
  // `GMChat.textOf()` fall back to English in silence — and the footer only apologised AFTER the
  // question had already gone out, in a language the operator had not picked. That is precisely
  // what §2.3 promises never happens. Restricting the picker to this list removes the path
  // entirely, so the apology can no longer be printed at all.
  //
  // A hand-written copy would drift the first time a question gains a language, so the union is
  // derived here, in each question's own key order.
  var GM_QUESTION_LANGS = (function () {
    var order = [], seen = {};
    for (var i = 0; i < GM_QUESTIONS.length; i++) {
      var t = GM_QUESTIONS[i].text || {};
      for (var l in t) {
        if (!Object.prototype.hasOwnProperty.call(t, l)) continue;
        if (!t[l] || seen[l]) continue;
        seen[l] = true;
        order.push(l);
      }
    }
    return order;
  })();

  g.GM_QUESTIONS = GM_QUESTIONS;
  g.GM_QUESTION_LANGS = GM_QUESTION_LANGS;
  g.GM_RATE_LINE = RATE_LINE;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GM_QUESTIONS;
    module.exports.QUESTION_LANGS = GM_QUESTION_LANGS;
    module.exports.RATE_LINE = RATE_LINE;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
