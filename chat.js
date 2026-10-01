/* 0.4.4 §七~§十四 — the chat side: language, sender identity, the F&Q dialogue tree.
 *
 * Pure logic on purpose: no DOM, no chrome.*, no timers. content.js owns the DOM, the clocks
 * and the storage; everything in here is a function of its arguments, which is what makes the
 * whole feature testable under node without a browser (see _tools/verify-044.cjs).
 *
 * Depends on: GMI18n (locale list only), GMOpening (to grade the opening question), GM_QUESTIONS
 * (loaded before this file). All three are optional — every use is guarded, so a stripped build
 * still runs.
 */
(function (g) {
  'use strict';

  var LOCALES = ['zh-CN', 'zh-TW', 'ja', 'ko', 'en', 'ru', 'fr', 'de'];

  // ---------------------------------------------------------------- §8.1 language detection
  //
  // 题库.txt / §8.1 give a script-based cascade, and the ORDER is load-bearing: Japanese is
  // written with kanji, so the kana test has to run before the CJK-ratio test or every Japanese
  // sentence would be classified as Chinese. Same for Korean hanja.
  var RE_KANA = /[\u3040-\u30ff]/;          // hiragana + katakana
  var RE_HANGUL = /[\uac00-\ud7af]/;        // precomposed hangul syllables
  var RE_CYRILLIC = /[\u0400-\u04ff]/;
  // NOTE the /g. `String.match` without it returns the FIRST match plus its capture groups, so
  // `(s.match(RE_CJK) || []).length` is 1 for any CJK sentence — which made the ratio test
  // 1/8 = 0.125 and classified every Chinese message as null. Counting needs the global flag.
  var RE_CJK_G = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  var RE_LATIN = /[A-Za-z\u00c0-\u024f]/;

  // Traditional-only forms, and the simplified-only forms they contrast with. A message that
  // mixes both (very common — people type 简体 with a few 繁體 glyphs) is scored rather than
  // decided by a single hit.
  var TRAD = '們這學嗎開為與說個麼來時會對過現點樣國語體發經應該還進問間實覺讓聽寫讀幾內車馬鳥魚龍鳳樂愛戀';
  var SIMP = '们这学吗开为与说个么来时会对过现点样国语体发经应该还进问间实觉让听写读几内车马鸟鱼龙凤乐爱恋';

  function countChars(text, set) {
    var n = 0;
    for (var i = 0; i < text.length; i++) if (set.indexOf(text.charAt(i)) >= 0) n++;
    return n;
  }

  // 英/法/德 share the Latin script, so the script test cannot separate them and §8.1 falls back
  // to stopwords. The lists are deliberately small and made of the highest-frequency FUNCTION
  // words: content words would misfire across the three languages ("information" is a word in
  // both English and French).
  var STOP = {
    en: ['the', 'and', 'is', 'are', 'was', 'you', 'your', 'what', 'who', 'how', 'why', 'do',
      'does', 'did', 'of', 'to', 'in', 'on', 'at', 'it', 'its', 'that', 'this', 'have', 'has',
      'had', 'for', 'with', 'from', 'not', 'but', 'yes', 'no', 'hello', 'hi', 'know', 'think',
      'i', 'me', 'my', 'we', 'they', 'he', 'she', 'am', 'be', 'been', 'there', 'here', 'about'],
    fr: ['le', 'la', 'les', 'un', 'une', 'des', 'du', 'et', 'est', 'sont', 'vous', 'tu', 'je',
      'nous', 'ils', 'elle', 'ne', 'pas', 'que', 'qui', 'quoi', 'pour', 'avec', 'dans', 'sur',
      'ce', 'cette', 'ces', 'oui', 'non', 'bonjour', 'salut', 'comment', 'pourquoi', 'connais',
      'sais', 'merci', 'beaucoup', 'de', 'à', 'au', 'aux', 'mon', 'ma', 'mes', 'votre', 'votre'],
    de: ['der', 'die', 'das', 'den', 'dem', 'des', 'und', 'ist', 'sind', 'war', 'sie', 'er',
      'ich', 'wir', 'nicht', 'kein', 'keine', 'was', 'wer', 'wie', 'warum', 'ein', 'eine',
      'einen', 'einem', 'mit', 'für', 'auf', 'in', 'an', 'von', 'zu', 'ja', 'nein', 'hallo',
      'guten', 'tag', 'danke', 'vielen', 'kennen', 'weiß', 'weiss', 'bin', 'bist', 'mein',
      'meine', 'ihr', 'ihre', 'aber', 'auch', 'oder'],
  };
  var STOP_INDEX = null;
  function stopIndex() {
    if (STOP_INDEX) return STOP_INDEX;
    STOP_INDEX = {};
    for (var l in STOP) {
      if (!STOP.hasOwnProperty(l)) continue;
      for (var i = 0; i < STOP[l].length; i++) {
        var w = STOP[l][i];
        (STOP_INDEX[w] || (STOP_INDEX[w] = [])).push(l);
      }
    }
    return STOP_INDEX;
  }

  var HAS_VOWEL = /[aeiouyàâäéèêëîïôöùûüáíóúñãõç]/i;

  /**
   * §8.1. Returns one of the 8 locales, or null when the text carries no usable signal — the
   * null is what §8.3 routes to the 「where are you from?」 fallback, so it must stay reachable
   * for gibberish rather than being papered over with 'en'.
   */
  function detectLang(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return null;

    // Existence tests first, in this order — see the note above about kanji.
    if (RE_KANA.test(s)) return 'ja';
    if (RE_HANGUL.test(s)) return 'ko';
    if (RE_CYRILLIC.test(s)) return 'ru';

    var letters = s.replace(/[\s\p{P}\p{S}]/gu, '');
    if (!letters) {
      // §8.1 标点区分: a bare fullwidth ？ reads as Chinese, a bare ASCII ? as English. Only
      // reached when there is no letter at all, which is exactly when the rule was written.
      if (s.indexOf('\uff1f') >= 0) return 'zh-CN';
      if (s.indexOf('?') >= 0) return 'en';
      return null;
    }

    var cjk = (s.match(RE_CJK_G) || []).length;
    if (cjk / letters.length > 0.3) {
      var trad = countChars(s, TRAD);
      var simp = countChars(s, SIMP);
      return trad > simp ? 'zh-TW' : 'zh-CN';
    }

    if (!RE_LATIN.test(s)) return null;

    var words = s.toLowerCase().split(/[^a-z\u00c0-\u024f']+/).filter(Boolean);
    var score = { en: 0, fr: 0, de: 0 };
    var idx = stopIndex();
    for (var i = 0; i < words.length; i++) {
      var langs = idx[words[i]];
      if (langs) for (var j = 0; j < langs.length; j++) score[langs[j]]++;
    }
    var best = null, bestN = 0, tie = false;
    for (var l in score) {
      if (!score.hasOwnProperty(l)) continue;
      if (score[l] > bestN) { bestN = score[l]; best = l; tie = false; }
      else if (score[l] === bestN && bestN > 0) tie = true;
    }
    if (bestN > 0 && !tie) return best;
    if (bestN > 0 && tie) return 'en';   // 英/法/德 打平 → 英语是 §7.2 的中立默认

    // Latin letters but not one function word. A real sentence in any of the three languages
    // contains several, so this is either a name/fragment or gibberish — and a fragment that
    // carries no vowel at all ("shkdjf") is definitely gibberish (§8.3's 乱码 case).
    if (!HAS_VOWEL.test(s)) return null;
    return null;
  }

  // ---------------------------------------------------------------- §8.4 reply templates
  //
  // 8 languages × a few variants each, rotated at random with a 10s floor (§8.4). These are
  // CHAT CONTENT, so like the question texts they live here rather than in the i18n UI tables.
  var TEMPLATES = {
    'zh-CN': {
      greet: ['你好，一起下盘好棋。', '很高兴和你对局。', '这一局下得不错。'],
      thanks: ['谢谢前辈。', '多谢指点。'],
      whereFrom: ['你是哪里的？'],
    },
    'zh-TW': {
      greet: ['你好，一起下盤好棋。', '很高興和你對局。', '這一局下得不錯。'],
      thanks: ['謝謝前輩。', '多謝指點。'],
      whereFrom: ['你是哪裡的？'],
    },
    ja: {
      greet: ['こんにちは、良い対局を。', '対局ありがとうございます。', 'いい勝負でした。'],
      thanks: ['ありがとうございます、勉強になりました。', 'ご指導ありがとうございます。'],
      whereFrom: ['どちらのご出身ですか？'],
    },
    ko: {
      greet: ['안녕하세요, 좋은 대국 되길 바랍니다.', '대국해 주셔서 감사합니다.', '좋은 승부였습니다.'],
      thanks: ['감사합니다, 많이 배웠습니다.', '가르침 감사합니다.'],
      whereFrom: ['어디서 오셨어요?'],
    },
    en: {
      greet: ['Good luck, have fun.', 'Thanks for the game.', 'That was a close one.'],
      thanks: ['Thank you, that helps a lot.', 'Much appreciated.'],
      whereFrom: ['Where are you from?'],
    },
    ru: {
      greet: ['Хорошей партии!', 'Спасибо за игру.', 'Хорошая была партия.'],
      thanks: ['Спасибо, это очень помогло.', 'Благодарю за пояснение.'],
      whereFrom: ['Откуда вы?'],
    },
    fr: {
      greet: ['Bonne partie !', 'Merci pour la partie.', 'C’était serré.'],
      thanks: ['Merci, cela m’aide beaucoup.', 'Merci pour l’explication.'],
      whereFrom: ['D’où venez-vous ?'],
    },
    de: {
      greet: ['Gutes Spiel!', 'Danke für die Partie.', 'Das war knapp.'],
      thanks: ['Danke, das hilft mir sehr.', 'Vielen Dank für die Erklärung.'],
      whereFrom: ['Woher kommen Sie?'],
    },
  };

  /**
   * 0.5.0 §3.2 — the §7.2 announcement now lives in the question bank as `q-announce`, where it
   * carries all eight languages, instead of being a second copy of the English sentence here.
   *
   * The AUTOMATIC sender still passes 'en' (0.4.4 §7.2: 「固定英文，不随设置语言变化」, pinned by
   * verify-044); the manual entry in the 提问 picker sends the operator's chosen language. One
   * text, two entry points — a second copy of the sentence is the "two spellings of one answer"
   * shape this project has shipped wrong three times.
   *
   * Read from the global rather than captured at load time: a module-level `var` would freeze
   * whichever bank happened to exist at this file's evaluation, and the value would then be
   * invisible to any test that swaps the bank first. Returns null when the bank is absent — the
   * caller then simply does not send, which the old constant could never express.
   */
  function announceQuestion() {
    var bank = (typeof GM_QUESTIONS !== 'undefined' && GM_QUESTIONS) || [];
    for (var i = 0; i < bank.length; i++) {
      if (bank[i] && bank[i].category === 'announce') return bank[i];
    }
    return null;
  }

  function announceText(lang) {
    var q = announceQuestion();
    return q ? textOf(q.text, lang) : null;
  }

  /**
   * Every wording of the statement. Used to recognise our OWN message when the chat observer
   * echoes it back — comparing against the English string alone (as 0.4.4 did) stops working the
   * moment the operator sends the statement by hand in another language, and the failure is
   * silent: `chat.announced` simply never becomes true.
   */
  function announceTexts() {
    var q = announceQuestion(), out = [];
    if (!q || !q.text) return out;
    for (var k in q.text) {
      if (Object.prototype.hasOwnProperty.call(q.text, k)) out.push(q.text[k]);
    }
    return out;
  }

  function textOf(map, lang) {
    if (!map) return null;
    if (map[lang]) return map[lang];
    var base = String(lang || '').split('-')[0];
    for (var k in map) if (map.hasOwnProperty(k) && k.split('-')[0] === base) return map[k];
    return map.en || map['zh-CN'] || null;
  }

  /**
   * §8.4 — random rotation with a 10s floor. `last` is `{text, at}` from the caller's clock, so
   * this stays pure; the caller passes `now`.
   */
  function pickReply(lang, kind, last, now) {
    var pool = (TEMPLATES[lang] || TEMPLATES.en)[kind] || (TEMPLATES[lang] || TEMPLATES.en).greet;
    if (last && now - (last.at || 0) < 10000) return null;
    if (pool.length === 1) return pool[0];
    // Never repeat the immediately preceding line — the operator reads the chat too, and a
    // verbatim echo of our own last message looks like a bug.
    var out = pool[Math.floor(Math.random() * pool.length)];
    if (last && last.text === out) out = pool[(pool.indexOf(out) + 1) % pool.length];
    return out;
  }

  // ---------------------------------------------------------------- §9 sender identification
  //
  // Three levels, each of which may abstain (null). Abstaining is a first-class outcome: §9 says
  // 「始终无法确定时，不调整任何一方 AI 率」, so the caller must be able to tell "not the
  // opponent" from "don't know".
  //
  // Level 1 — socket. `game-start` ships `data.players = [{id, name, color}]`. hook.js collapses
  // that to `{black, white}` NAMES, so the players this is called with usually have `id: null`
  // while `selfId` is a real value. An id miss must therefore FALL THROUGH to the name match —
  // returning null there (as this did) made level 1 fail in exactly the case it exists for, and
  // the caller then saw "colour unknown", which blocks the question outright.
  // Order matters: an id hit is authoritative; the name is the fallback, never the reverse.
  function senderFromPlayers(players, selfId, selfName) {
    if (!Array.isArray(players) || !players.length) return null;
    var i, p;
    if (selfId != null) {
      for (i = 0; i < players.length; i++) {
        p = players[i];
        if (p && p.id != null && String(p.id) === String(selfId)) {
          var byId = colorIsBlack(p.color);
          if (byId != null) return byId;
        }
      }
    }
    if (!selfName) return null;
    for (i = 0; i < players.length; i++) {
      p = players[i];
      if (p && p.name === selfName) {
        var byName = colorIsBlack(p.color);
        if (byName != null) return byName;
      }
    }
    return null;
  }

  function colorIsBlack(c) {
    if (c === 'black' || c === 1 || c === '1' || c === 'B') return true;
    if (c === 'white' || c === 2 || c === '2' || c === 'W') return false;
    return null;
  }

  // Level 2 — DOM. We know our own displayed name and the two seat names; whichever seat name
  // matches ours is our colour. Exact match only: a fuzzy match here would silently invert the
  // adjustment and blame the wrong player.
  function senderFromNames(selfName, blackName, whiteName) {
    if (!selfName) return null;
    if (blackName && selfName === blackName) return true;
    if (whiteName && selfName === whiteName) return false;
    return null;
  }

  // ---------------------------------------------------------------- §13 grading + the tree
  //
  // YES / NO word lists. The NO list MUST be tested first: 「不知道」 contains 「知道」, and
  // 「没学过」 contains 「学过」, so a yes-first scan reads both negations as affirmatives.
  var NO_WORDS = [
    '不知道', '不清楚', '不明白', '不了解', '不认识', '没学过', '没学', '没有', '没',
    '不会', '不懂', '不是', '不', '否',
    'no', 'nope', 'never', 'not', 'dont', "don't", 'didnt', "didn't", 'havent', "haven't",
    'не знаю', 'не', 'нет',
    'non', 'ne', 'pas', 'aucun', 'jamais',
    'nein', 'nicht', 'kein', 'keine', 'nie',
    '아니', '모르', '몰라', '없',
    'いいえ', 'ない', 'ません', '知らない', 'わからない', '分からない',
  ];
  var YES_WORDS = [
    '学过', '学過', '知道', '了解', '认识', '会', '懂', '是', '有', '嗯', '对', '是的',
    'yes', 'yeah', 'yep', 'sure', 'of course', 'i know', 'i have', 'kind of',
    'да', 'конечно', 'знаю',
    'oui', 'bien sûr', 'je sais', 'je connais',
    'ja', 'jawohl', 'klar', 'sicher', 'ich weiß', 'ich weiss',
    '네', '예', '알', '있',
    'はい', 'そう', 'ええ', '知ってる', 'あります', 'わかる',
  ];

  function hitAny(text, words) {
    var low = ' ' + String(text).toLowerCase() + ' ';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      // Latin/Cyrillic entries are matched as words so that 「no」 does not fire inside
      // 「nothing」 — but 「不知道」 and 「ない」 are substrings by nature, so the boundary is
      // only applied to entries that are pure ASCII/Latin.
      if (/^[a-z' ]+$/i.test(w)) {
        if (new RegExp('[^a-z]' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^a-z]', 'i').test(low)) return true;
      } else if (low.indexOf(w) >= 0) return true;
    }
    return false;
  }

  /** §13.1's explicit-refusal test. Long sentence + a refusal phrase = a deliberate dodge. */
  var RE_REFUSE = /不(知道|清楚|明白|了解)|don'?t know|no idea|не знаю|keine ahnung|je ne sais pas|모르겠|わかりません|知りません/i;

  /**
   * Which branch of the question the reply lands on. `direct` is only meaningful for the
   * opening question and only when we can resolve the real opening — it means the opponent named
   * the opening without being asked twice.
   */
  function classifyReply(question, text, ctx) {
    ctx = ctx || {};
    var s = String(text == null ? '' : text).trim();
    if (!s) return 'empty';

    if (question && question.branches && question.branches.direct && hitAny(s, allOpeningNames())) {
      return 'direct';
    }
    if (hitAny(s, NO_WORDS)) return 'no';
    if (hitAny(s, YES_WORDS)) return 'yes';
    return 'other';
  }

  /**
   * §13.2's magnitude table, applied to the tree.
   *
   * Returns `{ branch, verdict, delta, followUp, thanks, question }`:
   *   verdict — §13.4's vocabulary (empty / unknown / wrong / correct / vague) plus the tree's
   *             own `no` / `other`;
   *   delta   — the signed adjustment to apply to the OPPONENT's risk score;
   *   followUp— a second message to send (the opening question's 「我是初学者…」);
   *   thanks  — send 「谢谢前辈」 after this exchange.
   */
  function grade(question, answer, ctx) {
    ctx = ctx || {};
    // 0.5.0 §三 — `weight != null`, NOT `weight ?`. A weight of 0 means "this is a message, not a
    // test", and the falsy ternary silently promoted it to the DEFAULT weight of 3, so the two
    // ungraded questions in the bank would have moved the opponent's risk by ±8 like any other.
    // Nothing about the old expression looks wrong, which is exactly why it survived.
    var w = (question && question.weight != null) ? question.weight : 3;
    var text = String(answer == null ? '' : answer).trim();

    if (!text) return { branch: 'empty', verdict: 'empty', delta: 0 };

    // A weight-0 question is never graded and never moves the risk score, whatever comes back.
    // Returned BEFORE the §13.1 dodge and the §13.4 tails below on purpose: those add +2 by
    // design, and 「不参与答案判定与 AI 率调整」 (§3.3 #3) would be false if they could fire.
    if (w === 0) return { branch: classifyReply(question, text, ctx), verdict: 'none', delta: 0 };

    // §13.1 runs BEFORE the branch test: a long dodge is milder evidence (+2) than a confident
    // 「没学过」, which is why it must not be swallowed by the NO branch.
    if (text.length > 30 && RE_REFUSE.test(text)) {
      return { branch: 'other', verdict: 'unknown', delta: +2 };
    }

    var branch = classifyReply(question, text, ctx);
    var b = (question && question.branches && question.branches[branch]) || null;

    // §11's keyword lists, honoured when a future question supplies them.
    if (question && question.reject && question.reject.length) {
      for (var i = 0; i < question.reject.length; i++) {
        var r = question.reject[i];
        if (r && r.type === 'keyword' && r.value && hitAny(text, r.value)) {
          return { branch: branch, verdict: 'wrong', delta: +8 * w / 3 };
        }
      }
    }

    if (!b) {
      // No branch claims this reply: §13.4's 答非所问 tail.
      return { branch: branch, verdict: 'vague', delta: +2 };
    }

    if (b.delta) {
      var rate = ctx.rate == null ? 0 : ctx.rate;
      var line = ctx.rateLine == null ? 55 : ctx.rateLine;
      var high = rate >= line;
      var d = high ? b.delta.high : b.delta.low;
      return {
        branch: branch,
        verdict: branch === 'yes' ? 'correct' : (branch === 'no' ? 'no' : 'wrong'),
        delta: d == null ? 0 : d,
      };
    }

    if (b.then === 'gradeOpening') {
      // The yes-branch asks a SECOND question (题库.txt: yes类 → 追问「我是初学者…」). Until the
      // opponent answers that, there is nothing to grade — 「yes」 only earns the follow-up.
      // Grading it here scored the bare word 「yes」 as a wrong opening name (+8) against a
      // question that had not been asked yet.
      if (b.followUp && !ctx.answeredFollowUp) {
        return { branch: branch, verdict: 'followup', delta: 0, followUp: b.followUp };
      }
      var opening = gradeOpening(text, ctx);
      var out = {
        branch: branch,
        verdict: opening.verdict,
        delta: opening.verdict === 'correct' ? (-10 * w / 3)
          : (opening.verdict === 'wrong' ? (+8 * w / 3) : 0),
      };
      if (b.thanksAfter) out.thanks = true;
      return out;
    }

    return { branch: branch, verdict: 'vague', delta: +2 };
  }

  /**
   * Is the reply naming this game's real opening? The answer set is built from GMOpening, so the
   * check covers the Chinese name, the local name in every one of the 8 languages, and the full
   * 「直止·寒星」 label — an opponent who says "Cold Star" or "寒星" or "Kalter Stern" all count.
   */
  function uniqByLength(list) {
    // Longest first, so a short name that happens to be a substring of a longer one is never
    // the one that matches first.
    list.sort(function (a, b) { return b.length - a.length; });
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    return out;
  }

  function openingAnswerNames(code) {
    var out = [];
    if (!g.GMOpening || !code) return out;
    var o = g.GMOpening.byCode ? g.GMOpening.byCode(code) : null;
    if (!o) return out;
    if (o.name) out.push(o.name);
    for (var i = 0; i < LOCALES.length; i++) {
      var l = LOCALES[i];
      // The name is resolved per-locale explicitly (`tIn`), never via the current locale — that
      // was the 0.4.4 bug fixed in openings.js:label(), and relying on the current locale here
      // would silently produce 8 copies of the Chinese name.
      var bare = (g.GMI18n && g.GMI18n.tIn) ? g.GMI18n.tIn(l, 'opening.' + code) : null;
      if (bare && bare.indexOf('opening.') !== 0) out.push(bare);
      var full = null;
      try { full = g.GMOpening.label(code, l); } catch (e) { full = null; }
      if (full) {
        out.push(full);
        var m = full.match(/\uff08([^\uff09]+)\uff09/);   // 「直止·寒星（Cold Star）」 → Cold Star
        if (m) out.push(m[1]);
      }
    }
    return uniqByLength(out);
  }

  // 题库.txt's third branch is 「直接回答出含有开局名称的答案」 — an answer that contains AN
  // opening name, not necessarily the right one. 花月 must therefore read as a direct answer
  // just as 寒星 does; whether it is CORRECT is `gradeOpening()`'s job, not this one's.
  var ALL_NAMES = null;
  function allOpeningNames() {
    if (ALL_NAMES) return ALL_NAMES;
    var out = [];
    var groups = (g.GMOpening && [g.GMOpening.DIRECT, g.GMOpening.INDIRECT]) || [];
    for (var gi = 0; gi < groups.length; gi++) {
      var map = groups[gi] || {};
      for (var k in map) {
        if (!map.hasOwnProperty(k)) continue;
        var o = map[k];
        if (o && o.code) out = out.concat(openingAnswerNames(o.code));
      }
    }
    ALL_NAMES = uniqByLength(out);
    return ALL_NAMES;
  }

  function gradeOpening(answer, ctx) {
    var names = (ctx && ctx.openingNames) || [];
    if (!names.length) return { verdict: 'vague' };     // no opening was recognised → nothing to grade
    return { verdict: hitAny(answer, names) ? 'correct' : 'wrong' };
  }

  // ---------------------------------------------------------------- §13.3 protections
  var MAX_ADJUSTS = 3;
  var MAX_SWING = 20;

  /**
   * §13.3. Returns `{ok, delta, reason}` — the delta may have been clipped by the ±20 budget,
   * which is why the caller must apply what comes back rather than what it asked for.
   */
  function applyBudget(history, delta) {
    var h = history || [];
    var used = 0, count = 0, i;
    for (i = 0; i < h.length; i++) {
      used += h[i].delta || 0;
      if (h[i].delta) count++;
    }
    if (count >= MAX_ADJUSTS) return { ok: false, delta: 0, reason: 'maxAdjusts' };
    var want = delta;
    var next = used + want;
    if (next > MAX_SWING) want = MAX_SWING - used;
    if (next < -MAX_SWING) want = -MAX_SWING - used;
    if (want === 0) return { ok: false, delta: 0, reason: 'budgetExhausted' };
    return { ok: true, delta: want, reason: want === delta ? 'ok' : 'clipped' };
  }

  // ---------------------------------------------------------------- §12 gating
  /**
   * May this question be asked right now? §12's 禁用 list plus the per-question gate.
   * Returns null when allowed, else a reason string the caller turns into a note.
   */
  function askBlocked(question, ctx) {
    ctx = ctx || {};
    if (ctx.spectating) return 'spectating';
    if (!ctx.chatAvailable) return 'noChat';
    if (ctx.senderIsBlack == null) return 'senderUnknown';
    if (ctx.lastSentAt && ctx.now - ctx.lastSentAt < (question.cooldownMs || 10000)) return 'cooldown';
    if (ctx.askedIds && ctx.askedIds.indexOf(question.id) >= 0) return 'alreadyAsked';
    // 0.5.0 §3.2 — the statement has a SECOND entry point: the automatic sender (§7.1), which has
    // its own idempotence record (`chatAnnounced`) and never touches `chat.history`. Without this
    // the operator could repeat by hand a statement the extension had already sent this game.
    if (question.category === 'announce' && ctx.announced) return 'alreadyAnnounced';
    var w = question.askWhen || {};
    if (w.aiAbove != null && !(ctx.rate > w.aiAbove)) return 'rateTooLow';
    if (w.always) return null;
    return null;
  }

  /** §12 自动提示: 被怀疑方 AI 率 > 65 时提示「是否发送验证题？」 */
  var AUTO_PROMPT_RATE = 65;
  function shouldPrompt(rate) { return rate != null && rate > AUTO_PROMPT_RATE; }

  g.GMChat = {
    LOCALES: LOCALES,
    RATE_LINE: 55,
    AUTO_PROMPT_RATE: AUTO_PROMPT_RATE,
    MAX_ADJUSTS: MAX_ADJUSTS,
    MAX_SWING: MAX_SWING,
    announceQuestion: announceQuestion,
    announceText: announceText,
    announceTexts: announceTexts,
    TEMPLATES: TEMPLATES,

    detectLang: detectLang,
    textOf: textOf,
    pickReply: pickReply,

    senderFromPlayers: senderFromPlayers,
    senderFromNames: senderFromNames,
    colorIsBlack: colorIsBlack,

    classifyReply: classifyReply,
    grade: grade,
    gradeOpening: gradeOpening,
    openingAnswerNames: openingAnswerNames,
    allOpeningNames: allOpeningNames,
    applyBudget: applyBudget,
    askBlocked: askBlocked,
    shouldPrompt: shouldPrompt,
    hitAny: hitAny,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMChat;
})(typeof globalThis !== 'undefined' ? globalThis : self);
