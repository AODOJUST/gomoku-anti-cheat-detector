// _shared/community.ts — 1.0.2 §二 社区互动 + 1.0.3 §一/§二/§三: everything the two realms must
// agree about, plus the server-only helpers the community Edge Functions share.
//
// ⚠ THE SHARED BLOCK GREW A LOT IN 1.0.3 (好友 / 投票 / 举报 / 国旗 / 在线状态), and it grew for the
// SAME reason each time: a number or a derivation that both realms need, where a second copy would
// stay self-consistent and quietly stop agreeing. The rule for deciding whether something belongs in
// the block is in the block's own header, below the markers.
//
// ---------------------------------------------------------------------------------------------
// WHY THERE IS A SHARED BLOCK IN A TYPESCRIPT FILE
// ---------------------------------------------------------------------------------------------
// §2.3.5 asks for three limits (≤500 字符 / 每分钟 10 条 / 敏感词过滤) and §2.3.5 asks for the word
// filter on BOTH sides (「客户端 + 服务端双重」). The client cannot import this file: `extension/` is
// a set of plain browser scripts loaded by `<script src>`, this is a Deno TypeScript module. Writing
// each limit twice by hand is the shape this project has paid for five times — the copies stay
// self-consistent and simply stop agreeing, so nothing goes red.
//
// ⇒ The block between the two markers below is PLAIN JAVASCRIPT and is the single definition of
// every number and of the matching algorithm. `_tools/gen-community-shared.cjs` copies it VERBATIM
// into `extension/community-shared.js`, and the release sweep runs that generator with `--check`, so
// an edit to either side that is not accompanied by a regeneration goes red. This is the same
// arrangement `_tools/gen-locale.cjs` has with the twelve locale tables, and it exists for the same
// reason: one answer, one place, with a gate that notices drift.
//
// ⚠ PLAIN JAVASCRIPT, so: no type annotations, no `export`, no `import`, and nothing that needs
// TypeScript to be stripped. Anything typed belongs BELOW the END marker.
//
// ---------------------------------------------------------------------------------------------
// WHAT IS SHARED, AND WHY EACH THING IS
// ---------------------------------------------------------------------------------------------
//   * The lengths — the client puts `CHAT_MAX_LEN` on the input and refuses a paste over it; the
//     server refuses it too. If they disagreed, one of them would be decorative: a longer client cap
//     means every over-length message is a wasted round trip, a shorter one means the server's
//     answer is unreachable.
//   * The rate limits — the client can count its own sends and say 「发得太快了」 without a network
//     round trip; the server counts the DATABASE's rows, which is the one that binds.
//   * The retention window — §2.3.5 「历史保留 最近 7 天」. The cron job that deletes is shipped
//     commented (005_community.sql), so the window is applied on READ as well: the room looks
//     trimmed from the day it ships rather than from the day the operator enables pg_cron.
//   * The word list and `censorHit` — see there.
//
// ⚠ WHAT IS **NOT** SHARED: the authority. Every value below is a DEFAULT the client uses to fail
// fast; each is re-checked in the Edge Function that matters, and the server's copy is what binds.
// A client that edits `GMCommunityShared` in a console gets exactly nothing — the table it wants to
// write has no INSERT policy at all (see 005_community.sql).

// ==== SHARED COMMUNITY BEGIN ====
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

// =============================================================================================
// 1.0.3 — the numbers and derivations §一/§二/§三 need on BOTH sides.
// =============================================================================================
// Same arrangement, same reason as everything above: each item below is a fact the client and an
// Edge Function must agree about, and a second copy would be self-consistent and stop agreeing.

// ---- §1.2.3 / §1.2.4 好友间发送与「15 分钟云端删除」 ------------------------------------------
/** §1.2.4 「created_at + 15 分钟」. Also the DEFAULT on `friend_shares.expires_at` (006) — the two
 *  are the same window spelled twice on purpose, and this is the one the client counts down from. */
var SHARE_TTL_MS = 15 * 60 * 1000;
/** §1.2.3's three kinds verbatim: 「'archive' | 'sample' | 'config'」. */
var SHARE_KINDS = ['archive', 'sample', 'config'];
/** §1.2.3 「payload（< 500KB 时）；超出则用 storage_url」. The client needs this to decide whether to
 *  hand `friend-share` a body or an upload; the Function re-measures what it receives. */
var SHARE_INLINE_MAX_BYTES = 500 * 1024;
/** §1.1.3's `name` (「张三 VS 李四 黑72/白85」) and §1.2.3's. Capped because it is a CARD TITLE: a
 *  name long enough to wrap the message row three times breaks the room's layout for everyone, and
 *  the cap is shared so the picker can refuse a paste before the round trip. */
var SHARE_NAME_MAX = 120;
/** §1.7.4's `reply_preview.content`. Not in the spec; a quote is a PREVIEW, and storing the whole
 *  quoted message would make a 500-character message appear twice in the same room's payload. */
var REPLY_PREVIEW_MAX = 120;
/** §1.2.5 「回放 20 个 / 天」 and 「配置 10 个 / 天」. ⚠ 样本 has no row of its own in §1.2.5's table —
 *  the prose says 「按「回放」类处理」 — so a sample spends the SAME 20 as a replay. See
 *  006_friends.sql for why that is implemented as one counter rather than two. */
var SHARE_DAILY_ARCHIVE_MAX = 20;
var SHARE_DAILY_CONFIG_MAX = 10;

// ---- §1.2.1 好友关系 -------------------------------------------------------------------------
/** §1.2.1's three values verbatim: 「'pending' | 'accepted' | 'blocked'」. */
var FRIEND_STATUSES = ['pending', 'accepted', 'blocked'];
/** §1.5.2's 「备注：修改备注名」. Capped for the same reason every other free-text field here is: an
 *  unbounded remark is an unbounded row in a list that renders many of them. */
var FRIEND_REMARK_MAX = 40;

// ---- §1.4.2 投票 -----------------------------------------------------------------------------
/** §1.4.2's four options verbatim: 黑方 AI / 白方 AI / 双方 AI / 双方人类. Order is the order
 *  §1.4.4 draws them in, and it is the order the bars are rendered in — so it is a display fact as
 *  well as a wire enum. */
var VOTE_CHOICES = ['black-ai', 'white-ai', 'both-ai', 'both-human'];
/** §1.4.2 「持续时间：24 小时」. */
var VOTE_TTL_MS = 24 * 60 * 60 * 1000;

// ---- §2.1 / §2.2 / §2.3.1 举报与落实 ----------------------------------------------------------
/** §2.1's four radio buttons, as wire values: 作弊 / 辱骂骚扰 / 广告刷屏 / 其他. */
var REPORT_CATEGORIES = ['cheat', 'abuse', 'spam', 'other'];
/** §2.2's four states verbatim: 「'open' | 'reviewing' | 'resolved' | 'dismissed'」. */
var REPORT_STATUSES = ['open', 'reviewing', 'resolved', 'dismissed'];
/** §2.3.1's five actions verbatim: 「'none' | 'warn' | 'mute-24h' | 'mute-7d' | 'ban'」. */
var ADMIN_ACTIONS = ['none', 'warn', 'mute-24h', 'mute-7d', 'ban'];
/** §2.3.1's two durations, keyed by the action that applies them. The client reads this to render
 *  「禁言至 YYYY-MM-DD HH:MM」 without re-deriving 24h/7d from the action's NAME — a derivation
 *  that would silently disagree the day a third duration is added. */
var MUTE_DURATIONS_MS = { 'mute-24h': 24 * 60 * 60 * 1000, 'mute-7d': 7 * 24 * 60 * 60 * 1000 };
/** §2.1's 「详细说明」 and §2.3.1's `admin_note`. Not in the spec; an unbounded report body is an
 *  unbounded row in the one table where 「垃圾进垃圾出」 costs a human their morning. */
var REPORT_DETAIL_MAX = 2000;
var REPORT_NOTE_MAX = 2000;
/** §2.2 has no anti-abuse rule, same reasoning as §2.5's. Five reports per ten minutes is far above
 *  any honest use and far below what it takes to bury a 信箱. */
var REPORT_RATE_MAX = 5;
var REPORT_RATE_WINDOW_MS = 10 * 60 * 1000;

// ---- §3.1 国旗 -------------------------------------------------------------------------------
/** §3.1.5 「港澳台均使用五星红旗」. STORAGE keeps the real code (HK / MO / TW); only the DISPLAY
 *  maps it, so a policy change is one array. ⚠ The display helper is below and is the only place
 *  this list is applied — never rename the code on the way INTO the database. */
var CHINA_REGIONS = ['CN', 'HK', 'MO', 'TW'];
/** §3.1.4's 「if (!code) return '🏳️'」 — also the rendering of §3.1.6's hidden country. */
var FLAG_FALLBACK = '🏳️';
/** §3.1.2's 「ISO 3166-1 alpha-2」. `users.country_code` carries the same shape as a CHECK
 *  constraint (010); this is the client-side test so a bad value is dropped rather than rendered as
 *  garbage glyphs. */
var COUNTRY_CODE_RE = /^[A-Z]{2}$/;

// ---- §3.2 状态 -------------------------------------------------------------------------------
/** §3.2.3's three settings verbatim: 在线 / 忙碌中 / 隐身（显示为离线）. */
var MANUAL_STATUSES = ['online', 'busy', 'hidden'];
/** §3.2.1 「在线 🟢 最近 2 分钟内有活动」. */
var PRESENCE_ONLINE_MS = 2 * 60 * 1000;
/** §3.2.1 「离线 ⚪ 超过 5 分钟无活动」. */
var PRESENCE_OFFLINE_MS = 5 * 60 * 1000;
/** How often an open community view re-stamps `last_seen_at`. Comfortably inside
 *  PRESENCE_ONLINE_MS, so a client whose socket is healthy never flickers offline between beats,
 *  and short enough that a closed tab reads offline within one OFFline window. */
var PRESENCE_BEAT_MS = 60 * 1000;

// ---- §1.6 提及 -------------------------------------------------------------------------------
/** §1.6.2's 「用户名」 follows a typed `@`, and `users.username` is 「2–20 字符，无空格」
 *  (`USERNAME_RE`). This is the same shape as a loose regex over free text.
 *
 *  ⚠⚠ IT CARRIES THE `g` FLAG, SO IT HAS MUTABLE STATE (`lastIndex`). A `g` regex reused across
 *  calls with `.test()` / `.exec()` resumes from wherever the previous call stopped: the second
 *  scan of the same text returns a DIFFERENT answer, and it looks like a parsing bug rather than a
 *  shared-object bug. This constant is the DEFINITION of 「什么是一个提及」; anything that iterates
 *  with it must clone it first — see `parseMentions`, which does. */
var MENTION_RE = /@([^\s@]{2,20})/g;
/** Not in the spec. §1.6.3 turns a mention into a NOTIFICATION, so an uncapped array is a way to
 *  push a badge onto fifty strangers from one message. Ten is far above any honest use. */
var MENTION_MAX = 10;

/**
 * §3.1.4's ISO 3166-1 alpha-2 → emoji.
 *
 * Each letter of the code becomes a REGIONAL INDICATOR SYMBOL: 'A' is U+1F1E6, and U+1F1E6 is
 * 127462 = 127397 + 65 = 127397 + 'A'. Two of them in sequence render as the flag.
 *
 * ⚠ A code that is not exactly two upper-case ASCII letters does NOT render "wrong" — it renders
 * as unrelated pictographs or as nothing, because the arithmetic is applied to whatever the
 * characters are. Hence the shape test rather than an optimistic attempt.
 */
function countryFlag(code) {
  if (typeof code !== 'string' || !COUNTRY_CODE_RE.test(code)) return FLAG_FALLBACK;
  return code.replace(/./g, function (c) {
    return String.fromCodePoint(127397 + c.charCodeAt(0));
  });
}

/**
 * §3.1.5's display rule: 港澳台 all render as 五星红旗, everything else as its own flag.
 *
 * Reads the STORED code, which is the real one — `HK` / `MO` / `TW` are never rewritten to `CN` on
 * the way into `users.country_code`. That is the whole point of §3.1.5 「存储仍保留真实 code… 仅在
 * 显示时映射」: the mapping is a presentation rule, so the day it changes, only this function does.
 */
function countryFlagChinaUnified(code) {
  if (CHINA_REGIONS.indexOf(code) >= 0) return countryFlag('CN');
  return countryFlag(code);
}

/**
 * §2.4's 「他现在被禁言了吗」 — derived from the DURATION, never stored as a flag.
 *
 * `users.muted_until` is the only column (010_users_ext.sql explains why there is no `is_muted`).
 * The comparison is against `now` rather than against 「是否设置过」, so a served mute expires by
 * itself and nothing has to remember to clear it.
 */
function isMuted(row, nowMs) {
  var until = row && row.muted_until;
  if (!until) return false;
  var t = typeof until === 'number' ? until : Date.parse(until);
  if (isNaN(t)) return false;
  return t > (typeof nowMs === 'number' ? nowMs : Date.now());
}

/** §1.2.4's deadline, as an ISO string, from the moment a share was created. */
function shareExpiresAt(createdAtMs) {
  var base = typeof createdAtMs === 'number' ? createdAtMs : Date.now();
  return new Date(base + SHARE_TTL_MS).toISOString();
}

/**
 * Is this share still receivable?
 *
 * §1.2.4 makes the 15-minute window absolute: the row is gone after that whether or not anybody
 * looked, and `consumed` records 「已接收」 rather than ending the window. Both halves are tested
 * here so the client and the RLS policy (011 §6) ask one question.
 *
 * ⚠ IT SERVES TWO TABLES WITH TWO WINDOWS. `friend_shares.expires_at` is created_at + 15 minutes
 * (§1.2.4) and `cloud_shares.expires_at` is created_at + 7 days (§1.1.3's 「保留时间与普通消息一致」
 * — a room share does NOT expire in 15 minutes). The PREDICATE is the same: 「expires_at is in the
 * future」. `vote-create` checks a cloud share's liveness with this function, and writing
 * `Date.parse(row.expires_at) > Date.now()` there instead is how two spellings of one rule begin.
 *
 * ⚠ An unparseable `expires_at` reads as EXPIRED, not as live: a share whose deadline cannot be
 * established must not be the one that leaks.
 */
function isShareLive(row, nowMs) {
  var exp = row && row.expires_at;
  if (!exp) return false;
  var t = typeof exp === 'number' ? exp : Date.parse(exp);
  if (isNaN(t)) return false;
  return t > (typeof nowMs === 'number' ? nowMs : Date.now());
}

/**
 * §1.2.5's counter column for a share kind.
 *
 * ⚠ 样本 maps to `shares_archive` on purpose: §1.2.5's prose says 「按「回放」类处理」 and
 * 006_friends.sql explains why that is one counter rather than two. A `default:` arm that fell back
 * to the config counter would let a sample spend a budget the acceptance list never mentions.
 *
 * ⚠ INSIDE THE SHARED BLOCK, unlike most of §1.2.5. The view has to render 「今日还可发送 N 个」
 * for the kind the operator is about to pick, so it needs the same mapping — and a second copy of
 * `kind === 'config' ? … : …` in viewer.js is exactly the shape that has cost this project six times
 * (`shareQuota()` returns the two COUNTERS; which counter a kind spends is this function's answer).
 */
function quotaColumnFor(kind) {
  return kind === 'config' ? 'shares_config' : 'shares_archive';
}

/** §1.2.5's ceiling for a share kind — the same mapping, read as a number. */
function quotaMaxFor(kind) {
  return kind === 'config' ? SHARE_DAILY_CONFIG_MAX : SHARE_DAILY_ARCHIVE_MAX;
}

/**
 * §1.4.2's window: 「24 小时 或 发布者手动关闭」 — open while NEITHER has happened.
 *
 * ⚠ The two halves are one predicate, not two. `vote-cast` refuses a ballot on it, `vote-create`
 * answers 「已经有一个投票了」 on it, the poll's own UI draws 「[关闭投票]」 from it, and §1.4.2's
 * countdown reads the same `closes_at`. Written inline in each place, the day one of them forgot
 * `closed_manually` is the day a closed poll still accepts votes — and every file would be
 * internally consistent, which is how this project has paid for duplicated answers six times.
 *
 * ⚠ An unparseable `closes_at` reads as CLOSED rather than open, the same direction `isShareLive`
 * fails in: a poll whose deadline cannot be established must not be the one that keeps counting.
 */
function isVoteOpen(row, nowMs) {
  if (!row) return false;
  if (row.closed_manually === true) return false;
  var raw = row.closes_at;
  if (!raw) return false;
  var t = typeof raw === 'number' ? raw : Date.parse(raw);
  if (isNaN(t)) return false;
  return t > (typeof nowMs === 'number' ? nowMs : Date.now());
}

/**
 * §3.2.1's three states, from the account's `last_seen_at` and its `manual_status`.
 *
 * ⚠ §3.2.1 defines 在线 as 「最近 2 分钟」 and 离线 as 「超过 5 分钟」, which leaves 2–5 minutes
 * UNSPECIFIED. The resolution here is that 在线 HOLDS until the offline threshold — i.e. the gap
 * reads 在线. The alternative (offline from 2 minutes) would make the dot flicker for anyone whose
 * heartbeat is slightly late, and would make PRESENCE_ONLINE_MS and PRESENCE_OFFLINE_MS describe
 * the same boundary, at which point there would be no reason to have two constants.
 *
 * ⚠ ONLY TWO OF THE THREE SETTINGS FORCE AN ANSWER. 隐身 「显示为离线」 and 忙碌中 are claims the
 * user makes about themselves, so they beat recency in both directions — a hidden user with a live
 * socket still reads 离线. 在线 is the NEUTRAL value, not a third forcing: it means 「别改我的显示，
 * 按活跃度来」, so a user who chose 在线 and then closed the tab reads 离线. Treating 在线 as a force
 * would pin every such account to 🟢 forever, which is the one thing a presence dot must not do.
 */
function presenceState(lastSeenAt, manualStatus, nowMs) {
  if (manualStatus === 'hidden') return 'offline';
  if (manualStatus === 'busy') return 'busy';
  var seen = typeof lastSeenAt === 'number' ? lastSeenAt : Date.parse(lastSeenAt);
  if (isNaN(seen)) return 'offline';
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  return (now - seen) <= PRESENCE_OFFLINE_MS ? 'online' : 'offline';
}

/**
 * §1.1.3's `type`, DERIVED from `attachment` rather than stored.
 *
 * The spec's sample object carries both `type: 'archive-share'` and `attachment.kind: 'archive'`,
 * which are one fact twice (`type` is 'text' exactly when there is no attachment). One column is
 * stored — 008_community_ext.sql has the reasoning — and this is the single derivation both realms
 * use, so `undefined` / `null` / a malformed attachment all read as a plain message rather than as
 * a card with an empty title.
 */
function messageType(row) {
  var a = row && row.attachment;
  if (!a || typeof a !== 'object') return 'text';
  if (a.kind === 'archive') return 'archive-share';
  if (a.kind === 'sample') return 'sample-share';
  return 'text';
}

/**
 * §1.6.4 「发送时解析 `@用户名`」 — the NAMES a message mentions, in order, deduplicated.
 *
 * It deliberately returns NAMES and not ids: resolving a name to an account is the SERVER's job
 * (`chat-send` does the lookup against `users`), because only the server knows which names exist
 * and only the server may write `mentioned_users`. A client that resolved them itself could
 * mention anybody, including accounts it cannot see.
 *
 * ⚠ The regex is global and `lastIndex`-bearing, so it is re-created per call rather than held in a
 * variable — `RegExp.prototype.exec` in a loop over a shared literal starts from wherever the last
 * call stopped, which is the classic way this function returns a different answer the second time.
 */
function parseMentions(text) {
  var out = [];
  var s = String(text == null ? '' : text);
  var re = new RegExp(MENTION_RE.source, 'g');
  var m;
  while ((m = re.exec(s)) !== null) {
    var name = m[1];
    if (out.indexOf(name) === -1) out.push(name);
    if (out.length >= MENTION_MAX) break;
  }
  return out;
}

/** §1.6.1 / §1.6.2 — the token both the right-click menu and the autocomplete insert. One spelling
 *  of 「@ followed by the name followed by a space」, because the space is what stops the next
 *  character the user types from becoming part of the name.
 *
 *  ⚠ ONE WRITER, ONE READER, AND THEY AGREE. The writer is `cmInsertMention` in viewer.js; the
 *  reader is `parseMentions` above, through `MENTION_RE`. This function was exported and mirrored
 *  for the whole of the 1.0.3 cycle with no caller at all — the view inlined `'@' + name + ' '`
 *  instead — so the two formats were held together by nothing but the fact that nobody had tried a
 *  name containing a space or a leading `@`. `verify-065` §6 now calls this and asserts the view
 *  has no literal of its own. */
function mentionToken(name) {
  return '@' + String(name == null ? '' : name) + ' ';
}

/**
 * §1.4.4's four counts, from the rows `public.vote_tally` returns.
 *
 * Returns an object keyed by EVERY choice in VOTE_CHOICES, with 0 for the ones nobody picked: the
 * view only emits rows for choices that have votes, so a renderer iterating the view's rows would
 * draw two buttons on a poll where nobody has voted at all. Zero-filling here means the UI always
 * shows the same four options, which is what §1.4.4's sketch draws.
 */
function voteTally(rows) {
  var out = {};
  for (var i = 0; i < VOTE_CHOICES.length; i++) out[VOTE_CHOICES[i]] = 0;
  var list = rows || [];
  for (var j = 0; j < list.length; j++) {
    var row = list[j];
    if (row && Object.prototype.hasOwnProperty.call(out, row.choice)) {
      var n = typeof row.n === 'number' ? row.n : parseInt(row.n, 10);
      if (!isNaN(n) && n > 0) out[row.choice] = n;
    }
  }
  return out;
}

/**
 * §1.2.5's day key for `daily_quotas`, in the SAME timezone the column default uses.
 *
 * ⚠ THIS LIVES IN THE SHARED BLOCK, and it did not always. It used to be exported BELOW the marker
 * — server only — while `shareQuota()` in community.js spelled the expression out inline behind a
 * `S.serverDate ? S.serverDate() : …` guard whose first branch could never be taken. Two spellings
 * of 「今天」, one of them dead. The failure that hides there is quiet: 006 defaults the column to
 * `(now() at time zone 'utc')::date` and quotes are read-then-written, so if the two ever drifted a
 * share sent at 23:59 UTC would be CHECKED against one day and STORED under another, and the
 * counter would sit one row out of step for as long as the row lived. Same reasoning that moved
 * `quotaColumnFor` / `quotaMaxFor` in here.
 */
function serverDate(nowMs) {
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  return new Date(now).toISOString().slice(0, 10);
}
// ==== SHARED COMMUNITY END ====

// -------------------------------------------------------------------------------------------
// Below the marker: TypeScript, and things only the server needs.
// -------------------------------------------------------------------------------------------

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** The shared block's surface, re-exported so a Function imports from one module. */
export {
  ADMIN_ACTIONS,
  CENSOR_WORDS,
  CHAT_MAX_LEN,
  CHAT_PAGE_SIZE,
  CHAT_RATE_MAX,
  CHAT_RATE_WINDOW_MS,
  CHAT_RETENTION_DAYS,
  CHINA_REGIONS,
  COUNTRY_CODE_RE,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_RATE_MAX,
  FEEDBACK_RATE_WINDOW_MS,
  FEEDBACK_STATUSES,
  FEEDBACK_TITLE_MAX,
  FLAG_FALLBACK,
  FRIEND_REMARK_MAX,
  FRIEND_STATUSES,
  MANUAL_STATUSES,
  MENTION_MAX,
  MENTION_RE,
  MUTE_DURATIONS_MS,
  NEWS_CATEGORIES,
  NEWS_CONTENT_MAX,
  NEWS_DEFAULT_LANG,
  NEWS_TITLE_MAX,
  PRESENCE_BEAT_MS,
  PRESENCE_OFFLINE_MS,
  PRESENCE_ONLINE_MS,
  REPORT_CATEGORIES,
  REPORT_DETAIL_MAX,
  REPORT_NOTE_MAX,
  REPORT_RATE_MAX,
  REPORT_RATE_WINDOW_MS,
  REPLY_PREVIEW_MAX,
  REPORT_STATUSES,
  SHARE_DAILY_ARCHIVE_MAX,
  SHARE_DAILY_CONFIG_MAX,
  SHARE_INLINE_MAX_BYTES,
  SHARE_NAME_MAX,
  SHARE_KINDS,
  SHARE_TTL_MS,
  VOTE_CHOICES,
  VOTE_TTL_MS,
  censorHit,
  censorNormalize,
  chatClock,
  chatRetentionCutoff,
  countryFlag,
  countryFlagChinaUnified,
  isMuted,
  isShareLive,
  isVoteOpen,
  mentionToken,
  messageType,
  newsText,
  parseMentions,
  presenceState,
  previewLine,
  quotaColumnFor,
  quotaMaxFor,
  serverDate,
  shareExpiresAt,
  voteTally,
};

/**
 * How many rows `table` holds for `userId` in the last `windowMs`.
 *
 * ONE implementation for every rate limit, because 「数最近一分钟的条数」 and 「数最近十分钟的条数」
 * are one query with two numbers, and the day one of them forgets the filter is the day one user's
 * posting rate throttles everybody.
 *
 * `head: true` + `count: 'exact'` asks PostgREST for the count without the rows: the 10th message
 * does not need to be fetched to know it is the 11th.
 *
 * ⚠ `column` defaults to `user_id` because that is what most of these tables call their subject —
 * but it is NOT universal: `reports` has no `user_id` at all, it has `reporter_id` AND `reported_id`,
 * and §2.2's anti-abuse rule needs to count BOTH directions (see `report-submit`). Passing the
 * column rather than adding a second function keeps 「怎么数一片时间窗里的行数」 to one answer — the
 * alternative is two counters that silently disagree about whether the window is inclusive.
 */
export async function recentCount(
  sb: SupabaseClient,
  table: string,
  userId: string,
  windowMs: number,
  column: string = "user_id",
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { count, error } = await sb
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, userId)
    .gte("created_at", since);
  if (error) throw error;
  return count ?? 0;
}

/** A row of public.chat_messages (005_community.sql + 008_community_ext.sql). */
export interface ChatMessageRow {
  id: string;
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  content: string;
  created_at: string;
  /** 1.0.3 §1.1.3 — `{ kind, cloud_id, name, summary, expires_at }`, or null for a plain message. */
  attachment?: unknown;
  /** 1.0.3 §1.6.4 — the accounts `@用户名` resolved to. */
  mentioned_users?: string[] | null;
  /** 1.0.3 §1.7.4 — the quoted message's id, or null. */
  reply_to?: string | null;
  /** 1.0.3 §1.7.4 — `{ user_id, username, content, created_at }`, snapshotted. */
  reply_preview?: unknown;
}

/**
 * The projection the client receives for a chat message.
 *
 * Written out rather than `select('*')` so a column added later cannot leak by default — the same
 * rule `admin-list-users` states for its user rows. `user_id` IS included: §2.3.1 needs it to tell
 * 「自己的消息在右侧」, and it is not a secret (every reader is inside the same room).
 *
 * ⚠ 1.0.3 adds four columns and ALL FOUR are in the projection, because each is rendered: the
 * attachment is §1.1.3's card, `mentioned_users` is what makes §1.6.3's highlight possible,
 * `reply_to` is §1.7.3's click target and `reply_preview` is the text of the quote. A `select('*')`
 * would have included them by accident; writing them out means the NEXT column starts excluded,
 * which is the direction the mistake should point.
 */
export function publicChatMessage(row: ChatMessageRow): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    avatar_url: row.avatar_url,
    content: row.content,
    created_at: row.created_at,
    attachment: row.attachment ?? null,
    mentioned_users: row.mentioned_users ?? null,
    reply_to: row.reply_to ?? null,
    reply_preview: row.reply_preview ?? null,
  };
}

/** A row of public.news. */
export interface NewsRow {
  id: string;
  author_id: string | null;
  category: string;
  title: string;
  content: string;
  lang: string;
  translations: Record<string, unknown> | null;
  published_at: string;
  is_pinned: boolean;
}

/** A row of public.feedback. */
export interface FeedbackRow {
  id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  category: string;
  title: string;
  content: string;
  status: string;
  admin_reply: string | null;
  replied_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * §2.4.4's 「客户端按 settings.lang 显示对应版本；无对应翻译时显示原文」.
 *
 * ⚠ DEFINED IN THE SHARED BLOCK ABOVE, not here. Both realms resolve a news row's text — the client
 * to render §2.4.4's card, the server if anything ever previews one — and the fallback chain is a
 * rule about which text a reader sees, so two copies would mean two answers. `newsText` is therefore
 * plain JS in the block and re-exported below; see the generated `extension/community-shared.js`.
 *
 * Input and output are structurally typed rather than declared, because a TypeScript interface
 * cannot appear inside the shared block. `NewsRow` above is the shape this expects.
 */

// -------------------------------------------------------------------------------------------
// 1.0.3 — the row shapes and the server-only helpers.
// -------------------------------------------------------------------------------------------

/** A row of public.friendships (006_friends.sql). The pair is ordered: `user_a < user_b`. */
export interface FriendshipRow {
  id: string;
  user_a: string;
  user_b: string;
  status: string;
  /** ⚠ Not in §1.2.1's sketch — 006_friends.sql explains why 「谁拉黑谁」 has to be recorded for
   *  §1.5.2's 拉黑 to mean anything. Non-null exactly when `status === 'blocked'`. */
  blocked_by: string | null;
  requester: string;
  remark_a: string | null;
  remark_b: string | null;
  created_at: string;
  updated_at: string;
}

/** A row of public.friend_shares (006_friends.sql). */
export interface FriendShareRow {
  id: string;
  from_user: string;
  to_user: string;
  kind: string;
  payload: unknown;
  storage_url: string | null;
  size_bytes: number | null;
  created_at: string;
  expires_at: string;
  consumed: boolean;
}

/** A row of public.votes (007_votes.sql). */
export interface VoteRow {
  id: string;
  target_kind: string;
  target_cloud_id: string;
  creator_id: string;
  created_at: string;
  closes_at: string;
  closed_manually: boolean;
}

/** A row of public.reports (009_reports.sql). */
export interface ReportRow {
  id: string;
  reporter_id: string;
  reported_id: string;
  category: string;
  detail: string | null;
  evidence: unknown;
  status: string;
  admin_action: string | null;
  admin_note: string | null;
  handled_at: string | null;
  created_at: string;
}

/**
 * §1.2.1's pair ordering, in ONE place.
 *
 * 「约定：user_a < user_b」 is a constraint on the table (`friendships_pair_ordered`), so every
 * writer must produce an ordered pair before it inserts. Two callers need it — `friend-request`
 * (which creates the row) and `friend-accept` (which looks one up) — and a lookup that ordered its
 * arguments differently from the insert would simply never find the row: not an error, an empty
 * result, i.e. 「没有这条好友请求」 about a request that exists.
 */
export function orderPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/**
 * The row's remark AS SEEN BY `viewer`: §1.2.1's `remark_a` belongs to `user_a`, so which column a
 * reader sees depends on which side of the ordered pair they are. Returns the OTHER side's remark
 * (the name I gave them), which is the only one §1.5.2's 「备注」 list renders.
 */
export function remarkFor(row: FriendshipRow, viewer: string): string | null {
  return viewer === row.user_a ? row.remark_b : row.remark_a;
}

/** §1.2.5's date key. See `serverDate` up in the shared block for why this is not `current_date`'s job. */
export type QuotaColumn = "shares_archive" | "shares_config";

// ⚠ `quotaColumnFor` / `quotaMaxFor` USED TO LIVE HERE, fully typed, and are now inside the shared
// block above (re-exported with the rest). They moved because the VIEW needs them too — the share
// picker prints 「今日还可发送 N 个」 for the kind being chosen — and `shareQuota()` deliberately
// returns the two counters rather than a per-kind answer, so the mapping has to be the same object
// on both sides. `QuotaColumn` stays here: it is a type, and the block is plain JavaScript.

/**
 * §1.2.5's day key — now IN the shared block above, because the client needs the same answer and
 * had been spelling it out inline. See `serverDate` beside the END marker; this space is left as
 * the pointer rather than as a second export, because two `serverDate`s in one module is a
 * redeclaration and the compiler would be the only thing that noticed.
 */

/**
 * §2.3.1's 禁言 duration, as an absolute deadline.
 *
 * `mute-24h` / `mute-7d` come straight out of `MUTE_DURATIONS_MS` (shared, because the client
 * renders 「禁言至 …」 from the same table). `warn` / `none` return `null` — they do not touch the
 * clock — and `ban` also returns `null` because 封禁 is `is_banned`, a different column: conflating
 * them would leave a banned account with a mute that expires and a ban that does not, i.e. two
 * answers to 「他现在能说话吗」.
 */
export function muteUntil(action: string, nowMs?: number): string | null {
  const span = (MUTE_DURATIONS_MS as Record<string, number | undefined>)[action];
  if (!span) return null;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  return new Date(now + span).toISOString();
}

/**
 * May this account WRITE to the community? `null` means yes; otherwise the `ErrorCode` to answer
 * with.
 *
 * ⚠ ONE IMPLEMENTATION, FIVE CALLERS. §1.8.1's matrix has six ❌ rows and §2.4 adds a seventh state,
 * and every one of them is enforced by a different Edge Function. Written inline in each, the day
 * one of them forgot the mute check is the day a muted user discovers which endpoint to use — and
 * nothing would go red, because each file would be internally consistent.
 *
 * ORDER: activation first, then the mute. A muted account is by definition activated, so the two
 * cannot both apply; fixing the order anyway means the message a user sees does not depend on which
 * Function they hit.
 *
 * ⚠ `accountRefusal` (client.ts) already answered the BANNED and soft-deleted questions before this
 * is called — these are the two states it deliberately does not know about, because they matter to
 * the community and to nothing else.
 */
export function communityRefusal(
  row: { activated_at?: string | null; muted_until?: string | null } | null,
  nowMs?: number,
): "NOT_ACTIVATED" | "MUTED" | null {
  if (!row) return null;
  if (!row.activated_at) return "NOT_ACTIVATED";
  if (isMuted(row, nowMs)) return "MUTED";
  return null;
}

/**
 * The wire `message` that goes with `communityRefusal`'s code.
 *
 * A map rather than six inline strings, for the same reason the code itself is shared: §1.8 and
 * §2.4 describe ONE behaviour and the operator should read the same sentence whichever endpoint
 * refused them. ⚠ The CODES are what the client branches on (`cloudErrText`); these sentences are
 * the human hint beside them.
 *
 * ⚠ This deliberately returns a string rather than a `Response`. Building the envelope here would
 * make `community.ts` a second place that knows about HTTP status and CORS, and `errors.ts` already
 * owns that.
 */
export function refusalMessage(code: "NOT_ACTIVATED" | "MUTED"): string {
  return code === "MUTED"
    ? "This account is muted and cannot post"
    : "Activation required to post in the community";
}
