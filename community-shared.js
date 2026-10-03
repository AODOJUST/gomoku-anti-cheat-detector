/* extension/community-shared.js — the CLIENT half of §2.3.5's limits and word filter.
 *
 * ⚠ GENERATED FILE — DO NOT EDIT. Written by `_tools/gen-community-shared.cjs` from the SHARED
 * block of `supabase/functions/_shared/community.ts`, which is the single definition of every
 * limit below, of the word list, and of the matching algorithm. An edit here is lost the next
 * time the generator runs, and — worse — makes the client disagree with the server about what is
 * acceptable, silently.
 *
 * Run: node _tools/gen-community-shared.cjs   (then reload the extension)
 *
 * Loaded by viewer.html before community.js. Exposes `GMCommunityShared` on the global, with the
 * same dual export every other module here uses so a Node suite can require it.
 *
 * ⚠ These are DEFAULTS for failing fast, not the authority: every one is re-checked in the Edge
 * Function that acts on it, and `chat_messages` / `feedback` / `news` have no client INSERT
 * policy at all (005_community.sql), so a client that edits this object in a console gets
 * nothing. See the header of _shared/community.ts.
 */
(function (g) {
  'use strict';

// ⚠ Plain JavaScript only, and no occurrence of the END marker text. `gen-community-shared.cjs`
// slices between the markers by string, so a malformed block fails loudly rather than silently
// shipping half a limit set.

// ---- §2.3.5 「消息长度 ≤ 500 字符」 ---------------------------------------------------------
// Counted in UTF-16 code units, i.e. `String.length`, which is the same thing `maxlength` on an
// <input> counts. That agreement is the point: a limit measured two ways is a control that lets
// through text it then refuses.
var CHAT_MAX_LEN = 500;
/** How many messages the room loads at once. Not in the spec; §2.3.6's sketch is a scrollback. */
var CHAT_PAGE_SIZE = 50;
/** §2.3.5 「历史保留 最近 7 天（定时清理）」. Used for the read window; the cron deletes for real. */
var CHAT_RETENTION_DAYS = 7;

// ---- §2.3.5 「频率限制 每分钟最多 10 条」 -----------------------------------------------------
var CHAT_RATE_MAX = 10;
var CHAT_RATE_WINDOW_MS = 60 * 1000;

// ---- §2.5 Bug 与建议. The spec gives no limits, so these are choices, and they are stated as
// choices rather than left implicit: an unbounded `content` is an unbounded row in the operator's
// inbox, and §2.5.6's recommended admin surface is a Studio table where one 200 KB row ruins the
// page for every other report.
var FEEDBACK_TITLE_MAX = 120;
var FEEDBACK_CONTENT_MAX = 4000;
var FEEDBACK_CONTACT_MAX = 120;
/** §2.5 has no anti-abuse rule; this is the minimum that keeps a stuck retry loop from filling the
 *  inbox. Five reports per ten minutes is far above any honest use of the form. */
var FEEDBACK_RATE_MAX = 5;
var FEEDBACK_RATE_WINDOW_MS = 10 * 60 * 1000;
/** §2.5.4's 「类型：[Bug ▼] [建议] [其他]」 — the wire values, in the order the form shows them.
 *  Stored in `feedback.category` and compared by literal in the admin filter, so the set is an
 *  identity value: change it and old rows stop matching. */
var FEEDBACK_CATEGORIES = ['bug', 'suggestion', 'other'];
/** §2.5.2's `status` values, verbatim: 「'open' | 'in_progress' | 'resolved' | 'closed'」. */
var FEEDBACK_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

// ---- §2.4 新闻. §2.4.2 gives no limits either; same reasoning as above, sized for a changelog
// entry (which is prose) rather than for a chat line.
var NEWS_TITLE_MAX = 120;
var NEWS_CONTENT_MAX = 20000;
/** §2.4.2's `category`: 「'changelog' | 'announcement'」. §2.4.1 calls the second one 管理员发布;
 *  the wire value stays the spec's. */
var NEWS_CATEGORIES = ['changelog', 'announcement'];
/** §2.4.1 「更新日志 | 管理员 | 每个版本发布时自动/手动填写」 — the language a news row is written
 *  in when the publisher does not say. §2.4.4 keys `translations` by the same codes. */
var NEWS_DEFAULT_LANG = 'zh-CN';

/**
 * §2.3.5's 「简单词表」. Lower-case, and no entry may contain whitespace (whitespace is stripped
 * before matching, so such an entry could never match — a property of the algorithm, not a style
 * rule).
 *
 * WHAT THIS LIST IS AND IS NOT:
 *   * A FIRST-PASS nuisance filter for a public room, not a security boundary. The server's copy is
 *     authoritative because `chat-send` is the only writer of `chat_messages`.
 *   * Deliberately SHORT. §2.3.5 says 「简单词表」, and a long list in a shipped product is a
 *     maintenance bill plus a false-positive generator: 「外挂」 is a legitimate gomoku topic
 *     (「对面像开外挂」), and blocking it would silence the room's actual subject. The entries below
 *     are the ones with no innocent reading. Operators extend this array and re-run the generator;
 *     nobody has to touch the algorithm.
 */
var CENSOR_WORDS = [
  // ---- 广告与引流. A free tool's public room is a magnet for these, and every one of them is a
  // stranger trying to move a conversation somewhere the room cannot see.
  '加微信', '加qq', '加vx', '微信号', '扫码加', '私聊我', '代练', '陪玩', '刷分', '卖号',
  '免费领取', '日赚', '月入过万', '兼职赚钱', '稳赚不赔', '包赢', '必胜法', '破解版', '外挂下载',
  '博彩', '赌球', '棋牌室', '真人荷官', '私服', '点卡回收',
  // ---- 脏话. Kept to the ones that carry no other meaning; see above for why 外挂 is absent on
  // purpose even though it reads like spam.
  '傻逼', '煞笔', '沙比', '脑残', '智障', '废物东西', '狗东西', '杂种', '操你', '草你妈',
  '滚你妈', '去死吧', '死全家', '你妈死了',
  // ---- English. Matching is substring, so 'fuck' also covers 'fucking' and 'fucker'.
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'whore', 'retard',
  // ---- Link shorteners. NOT a bare 'http': a gomoku room legitimately shares replay links, and
  // blocking those would make the filter useless by making it wrong. These are the hosts whose only
  // purpose in a chat line is to hide where it goes.
  'bit.ly/', 't.cn/', 'tinyurl.com/', 'dwz.cn/', 'url.cn/',
];

/**
 * Fold a string into the form `censorHit` matches against.
 *
 * Three folds, each defeating one way of typing around a filter:
 *   * `toLowerCase()` — the list is lower-case, and `FUCK` is not a different word.
 *   * zero-width characters removed — `f<U+200B>uck` renders as `fuck` and matched nothing before.
 *     The range covers ZWSP / ZWNJ / ZWJ / LRM / RLM, the word-joiner, and the BOM.
 *   * ALL whitespace removed, including the ideographic space — `f u c k` and `加 微 信` are the
 *     same words to a reader. This is also why no list entry may contain a space.
 *
 * ⚠ Order matters: zero-width first, then whitespace, because a zero-width character is not `\s`
 * and would otherwise survive as part of a word and split the match.
 *
 * It does NOT fold homoglyphs or full-width latin (`ｆｕｃｋ`). That is a deliberate stop: the next
 * step after NFKC folding is a real Unicode skeleton, and §2.3.5 asked for a 简单词表.
 */
function censorNormalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\s\u3000]+/g, '');
}

/**
 * The first list entry present in `text`, or `null` when the text is clean.
 *
 * Returns the ENTRY rather than a boolean so the caller can name the term it refused — the operator
 * reads which word tripped it, and a boolean would force a second scan just to say so.
 */
function censorHit(text) {
  var flat = censorNormalize(text);
  if (!flat) return null;
  for (var i = 0; i < CENSOR_WORDS.length; i++) {
    var word = CENSOR_WORDS[i];
    if (word && flat.indexOf(word) !== -1) return word;
  }
  return null;
}

/**
 * How long ago the retention window starts, as an ISO timestamp.
 *
 * Returned as a string because that is what PostgREST wants in `created_at=gte.<iso>` and what
 * `new Date(...)` prints — one function so the client never spells `Date.now() - 7 * 864e5` itself
 * (a second spelling of the window is a second window).
 */
function chatRetentionCutoff(nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  return new Date(now - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * §2.3.6's timestamp, from `created_at`. Local time, `HH:MM`, zero-padded.
 *
 * Shared because the same string appears twice on one screen — in the message row and in nothing
 * else, admittedly — and because `toLocaleTimeString` differs per browser locale, which would make
 * the room read differently for two people in the same conversation. This is deliberately blunt:
 * hours and minutes, 24-hour, no locale awareness. A chat line needs a clock, not a calendar.
 */
function chatClock(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var hh = String(d.getHours());
  var mm = String(d.getMinutes());
  return (hh.length < 2 ? '0' + hh : hh) + ':' + (mm.length < 2 ? '0' + mm : mm);
}

/**
 * The one-line preview §2.5.5's 「我的提交」 list shows for a report's body.
 *
 * Not `String.prototype.slice` alone: the room and the inbox both contain newlines, and a preview
 * with a newline in it silently grows the row it is drawn in. Collapses whitespace first, then
 * truncates, then marks the truncation — three steps in this order, because truncating before
 * collapsing can cut a run of spaces down to something that then collapses to nothing.
 */
function previewLine(text, max) {
  var flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  var limit = typeof max === 'number' && max > 0 ? max : 80;
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…';
}

/**
 * §2.4.4's fallback chain: 「客户端按 settings.lang 显示对应版本；无对应翻译时显示原文」.
 *
 * SHARED rather than server-only because the CLIENT is the one doing the choosing — `settings.lang`
 * lives in the extension, and §2.4.4's whole point is that a changelog entry is readable from the
 * moment it is published, translated later or never. A second copy of this chain on one side only
 * would mean the admin's preview and the reader's card disagree about which text is being shown.
 *
 * Returns the language actually used, not just the text: §2.4.4 wants the reader told when they are
 * looking at the original, and a card labelled with the language it asked for but did not get is
 * worse than one labelled plainly.
 */
function newsText(row, lang) {
  var t = (row && row.translations) || {};
  var entry = t[lang];
  if (entry && typeof entry === 'object' &&
      typeof entry.title === 'string' && typeof entry.content === 'string') {
    return { title: entry.title, content: entry.content, lang: lang, translated: true };
  }
  return {
    title: row ? row.title : '',
    content: row ? row.content : '',
    lang: row ? row.lang : '',
    translated: false,
  };
}

  g.GMCommunityShared = {
    CENSOR_WORDS: CENSOR_WORDS,
    CHAT_MAX_LEN: CHAT_MAX_LEN,
    CHAT_PAGE_SIZE: CHAT_PAGE_SIZE,
    CHAT_RETENTION_DAYS: CHAT_RETENTION_DAYS,
    CHAT_RATE_MAX: CHAT_RATE_MAX,
    CHAT_RATE_WINDOW_MS: CHAT_RATE_WINDOW_MS,
    FEEDBACK_CATEGORIES: FEEDBACK_CATEGORIES,
    FEEDBACK_CONTACT_MAX: FEEDBACK_CONTACT_MAX,
    FEEDBACK_CONTENT_MAX: FEEDBACK_CONTENT_MAX,
    FEEDBACK_RATE_MAX: FEEDBACK_RATE_MAX,
    FEEDBACK_RATE_WINDOW_MS: FEEDBACK_RATE_WINDOW_MS,
    FEEDBACK_STATUSES: FEEDBACK_STATUSES,
    FEEDBACK_TITLE_MAX: FEEDBACK_TITLE_MAX,
    NEWS_CATEGORIES: NEWS_CATEGORIES,
    NEWS_CONTENT_MAX: NEWS_CONTENT_MAX,
    NEWS_DEFAULT_LANG: NEWS_DEFAULT_LANG,
    NEWS_TITLE_MAX: NEWS_TITLE_MAX,
    censorHit: censorHit,
    censorNormalize: censorNormalize,
    chatClock: chatClock,
    chatRetentionCutoff: chatRetentionCutoff,
    newsText: newsText,
    previewLine: previewLine,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMCommunityShared;
})(typeof globalThis !== 'undefined' ? globalThis : this);
