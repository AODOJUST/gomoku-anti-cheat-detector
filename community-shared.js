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

// ---- §2.3.5 「频率限制 每分钟最多 20 条」 -----------------------------------------------------
// ⚠ 1.0.6 §1.10.1 RAISED THIS FROM 10. The number lives HERE and nowhere else: `chat-send` reads it
// and so does the client, the latter through the mirrored `community-shared.js`. §2.3.5 asks for
// 「客户端 + 服务端双重」检查, and two halves of one rule that can disagree is the shape this
// project has shipped by accident five times — so raising the cap is this line plus a regeneration,
// never an edit in the caller.
var CHAT_RATE_MAX = 20;
var CHAT_RATE_WINDOW_MS = 60 * 1000;

// ---- §1.11 「消息撤回（2 分钟内）」 ---------------------------------------------------------------
/** §1.11.2's window: 「仅 2 分钟内可撤回」. ⚠ IT LIVES HERE BECAUSE TWO REALMS ASK THE SAME
 *  QUESTION and they must answer it the same way: `chat-recall` asks it about a stored row (the
 *  answer that holds), and the room asks it about a drawn row to decide whether the 撤回 row belongs
 *  in the right-click menu at all (the answer that keeps a button from offering something the server
 *  will refuse). Two literals would drift the moment one of them was touched. */
var RECALL_WINDOW_MS = 2 * 60 * 1000;
/** §1.11.1's `recall_reason` — 「可选」 in the 定稿, and nothing fills it today: a recall is a
 *  WITHDRAWAL the author performs on themselves, and asking them why would be a form in the way of
 *  an undo. It is capped and accepted anyway so the column has a writer the day §2.6's admin needs to
 *  withdraw someone else's message and say why. */
var RECALL_REASON_MAX = 200;

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
/**
 * §1.4.3's `target_kind` — the kinds a POLL may attach to.
 *
 * ⚠ DELIBERATELY NARROWER THAN `SHARE_KINDS`, AND IT LIVES HERE SO IT CANNOT DRIFT. A poll asks the
 * community to judge a REPLAY or a SAMPLE; a 配置包 is a settings bundle with nothing to vote on.
 * 1.0.2 kept this list inside `vote-create` with a comment claiming it mirrored
 * `cloud_shares_kind_known` — which stopped being true as soon as 015 let that constraint take the
 * third kind, and 1.0.4 also wants the same answer on the client (the 投票 checkbox is disabled
 * for 配置, and `cmPaintVotesForRows` must not spend three queries per config card).
 */
var VOTE_TARGET_KINDS = ['archive', 'sample'];
/** One spelling of 「这个附件能投票吗」 for the picker, the room and the Function. */
function isVotableKind(kind) {
  return VOTE_TARGET_KINDS.indexOf(kind) >= 0;
}
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
 *
 * ⚠ 1.0.4 — `config` IS A CARD TOO, AND IT USED TO FALL THROUGH TO `'text'`. 1.0.2 drew only two
 * of `SHARE_KINDS`'s three, so a 配置包 sent to the room arrived as a message with an attachment
 * and NO card: the reader saw a name and a timestamp and nothing to press. The derivation is over
 * `SHARE_KINDS` — the same three the picker offers, the same three `friend_shares` accepts, the
 * same three `cloud_shares` accepts since 015 — rather than a second list that can drift from it.
 */
function messageType(row) {
  var a = row && row.attachment;
  if (!a || typeof a !== 'object') return 'text';
  for (var i = 0; i < SHARE_KINDS.length; i++) {
    if (a.kind === SHARE_KINDS[i]) return SHARE_KINDS[i] + '-share';
  }
  return 'text';
}

/**
 * §1.11.2 「仅 2 分钟内可撤回」 — the ONE predicate behind it, asked by both realms.
 *
 * `chat-recall` asks it about the row it just read (this is the answer that HOLDS, together with the
 * `recalled = false` and the cutoff baked into the UPDATE it then issues), and the room asks it about
 * a drawn row to decide whether 「撤回」 belongs in the right-click menu at all — a button that
 * offers something the server will refuse is one of the shapes §1.11 would otherwise ship.
 *
 * ⚠ THE ANSWER IS THREE FACTS, NOT ONE, and that is why it is not just a clock comparison. 「是
 * 我发的」 excludes everyone else's message (the confirm dialog would be a lie), 「还没撤回过」
 * excludes a second recall, and the window excludes the rest. A caller that asked only about time
 * would offer 撤回 on a stranger's message and on one already withdrawn.
 *
 * ⚠ `String(row.user_id) !== String(meId)` RATHER THAN `!==`: the two realms hand this in different
 * types on purpose — the server gets a `uuid` column and the client gets a JSON string — and 1.0.x
 * has already paid once for an id compared across those two shapes.
 *
 * An unparsable `created_at` is `false`, never `true`: a row whose age cannot be established is not
 * one to offer an undo on, and the server's own UPDATE would refuse it anyway.
 */
function canRecall(row, meId, nowMs) {
  if (!row || !meId) return false;
  if (String(row.user_id == null ? '' : row.user_id) !== String(meId)) return false;
  if (row.recalled) return false;
  var t = Date.parse(String(row.created_at == null ? '' : row.created_at));
  if (!isFinite(t)) return false;
  return (nowMs - t) < RECALL_WINDOW_MS;
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

/**
 * 1.0.4 §P1 — every table the community subscribes to, and the events it wants from each.
 *
 * ONE AUTHORITY, THREE CONSUMERS, and they are the reason this is in the block rather than inline in
 * `community.js`:
 *
 *   1. `joinFrame` builds the `postgres_changes` array from `realtimeChanges()` below — so the
 *      subscription cannot list a table the client does not also dispatch on.
 *   2. `rtFrame` dispatches by `table`, so the same list decides who hears what.
 *   3. `013_realtime.sql` publishes exactly these tables, in SQL, where it cannot import this file.
 *      ⚠ THAT THIRD ONE IS A SECOND SPELLING and it is pinned: `verify-066` parses the migration's
 *      array and asserts it equals this list. The failure mode without that test is the one this
 *      whole release opens with — a client that subscribes to a table the publication does not
 *      carry receives nothing, silently, forever, and the join still answers `ok`.
 *
 * ⚠ `vote_ballots` IS ABSENT AND MUST STAY ABSENT. §七.3 makes the poll anonymous and
 * 011_rls_community.sql gives ballots a self-only SELECT policy; Realtime applies the same policies
 * to what it delivers, so publishing them would deliver to each subscriber exactly the ballots they
 * could already read — their own. Counts are refreshed by a bounded poll while a poll is on screen
 * (`VOTE_TALLY_POLL_MS` in community.js). A trigger that BROADCAST each ballot's choice would be
 * real-time and is deliberately not done: it would publish 「有人刚投了 B」 to the room, which is
 * more than §七.3's 「仅显示票数」 promises.
 *
 * ⚠ `event` IS `'*'` FOR EVERYTHING EXCEPT THE ROOM, and that is not laziness. §1.2.1's 接受好友 is
 * an UPDATE on `friendships`, §1.2.3's 「已接收」 an UPDATE on `friend_shares`, §1.5.3's 「已读」 an
 * UPDATE on `notifications`, §1.4.2's 「已结束」 an UPDATE on `votes` — an INSERT-only subscription
 * would deliver the *arrival* of every one of those features and none of their outcomes. The room is
 * INSERT-only because a message is never edited: subscribing to updates there would ship the whole
 * old row over the wire for nothing, and `chat_messages` is the one table here that grows large.
 */
var REALTIME_TABLES = [
  // ⚠⚠ 1.0.6 §1.11 CHANGED THIS FROM 'INSERT' TO '*', AND THE REASON IT WAS 'INSERT' HAD TO STOP
  // BEING TRUE. 013_realtime.sql subscribed the room INSERT-only on an explicit premise: 「a message
  // is never edited」, which is why it also kept the default replica identity and paid no extra WAL
  // (it is the one table here that grows to millions of rows). §1.11 makes a message editable — a
  // recall is an UPDATE — and there is no fallback that could cover it: the room's poller asks for
  // `created_at > RT.since` (community.js `rtPollOnce`), so an updated row is never re-fetched, and
  // the other reader would keep drawing 「你好」 for a message its author had withdrawn until they
  // reloaded the page. A flag nobody can see is not a withdrawn message.
  { table: 'chat_messages', event: '*' },
  { table: 'friendships', event: '*' },
  { table: 'friend_shares', event: '*' },
  { table: 'notifications', event: '*' },
  { table: 'votes', event: '*' },
  { table: 'news', event: '*' },
  { table: 'feedback', event: '*' }
];

/**
 * `REALTIME_TABLES` shaped as Phoenix's `postgres_changes` config.
 *
 * A function rather than a constant so the frame builder cannot hold a reference the caller might
 * mutate — the join payload is assembled once per connect and a shared array edited by one caller
 * would be edited for every later one.
 */
function realtimeChanges() {
  var out = [];
  for (var i = 0; i < REALTIME_TABLES.length; i++) {
    out.push({ event: REALTIME_TABLES[i].event, schema: 'public', table: REALTIME_TABLES[i].table });
  }
  return out;
}

  g.GMCommunityShared = {
    ADMIN_ACTIONS: ADMIN_ACTIONS,
    CENSOR_WORDS: CENSOR_WORDS,
    CHAT_MAX_LEN: CHAT_MAX_LEN,
    CHAT_PAGE_SIZE: CHAT_PAGE_SIZE,
    CHAT_RETENTION_DAYS: CHAT_RETENTION_DAYS,
    CHAT_RATE_MAX: CHAT_RATE_MAX,
    CHAT_RATE_WINDOW_MS: CHAT_RATE_WINDOW_MS,
    CHINA_REGIONS: CHINA_REGIONS,
    COUNTRY_CODE_RE: COUNTRY_CODE_RE,
    FLAG_FALLBACK: FLAG_FALLBACK,
    FEEDBACK_CATEGORIES: FEEDBACK_CATEGORIES,
    FEEDBACK_CONTACT_MAX: FEEDBACK_CONTACT_MAX,
    FEEDBACK_CONTENT_MAX: FEEDBACK_CONTENT_MAX,
    FEEDBACK_RATE_MAX: FEEDBACK_RATE_MAX,
    FEEDBACK_RATE_WINDOW_MS: FEEDBACK_RATE_WINDOW_MS,
    FEEDBACK_STATUSES: FEEDBACK_STATUSES,
    FEEDBACK_TITLE_MAX: FEEDBACK_TITLE_MAX,
    FRIEND_REMARK_MAX: FRIEND_REMARK_MAX,
    FRIEND_STATUSES: FRIEND_STATUSES,
    MANUAL_STATUSES: MANUAL_STATUSES,
    MENTION_MAX: MENTION_MAX,
    MENTION_RE: MENTION_RE,
    MUTE_DURATIONS_MS: MUTE_DURATIONS_MS,
    NEWS_CATEGORIES: NEWS_CATEGORIES,
    NEWS_CONTENT_MAX: NEWS_CONTENT_MAX,
    NEWS_DEFAULT_LANG: NEWS_DEFAULT_LANG,
    NEWS_TITLE_MAX: NEWS_TITLE_MAX,
    PRESENCE_BEAT_MS: PRESENCE_BEAT_MS,
    PRESENCE_OFFLINE_MS: PRESENCE_OFFLINE_MS,
    PRESENCE_ONLINE_MS: PRESENCE_ONLINE_MS,
    REPLY_PREVIEW_MAX: REPLY_PREVIEW_MAX,
    REPORT_CATEGORIES: REPORT_CATEGORIES,
    REPORT_DETAIL_MAX: REPORT_DETAIL_MAX,
    REPORT_NOTE_MAX: REPORT_NOTE_MAX,
    REPORT_RATE_MAX: REPORT_RATE_MAX,
    REPORT_RATE_WINDOW_MS: REPORT_RATE_WINDOW_MS,
    REPORT_STATUSES: REPORT_STATUSES,
    REALTIME_TABLES: REALTIME_TABLES,
    RECALL_REASON_MAX: RECALL_REASON_MAX,
    RECALL_WINDOW_MS: RECALL_WINDOW_MS,
    SHARE_DAILY_ARCHIVE_MAX: SHARE_DAILY_ARCHIVE_MAX,
    SHARE_DAILY_CONFIG_MAX: SHARE_DAILY_CONFIG_MAX,
    SHARE_INLINE_MAX_BYTES: SHARE_INLINE_MAX_BYTES,
    SHARE_KINDS: SHARE_KINDS,
    SHARE_NAME_MAX: SHARE_NAME_MAX,
    SHARE_TTL_MS: SHARE_TTL_MS,
    VOTE_CHOICES: VOTE_CHOICES,
    VOTE_TARGET_KINDS: VOTE_TARGET_KINDS,
    VOTE_TTL_MS: VOTE_TTL_MS,
    censorHit: censorHit,
    censorNormalize: censorNormalize,
    chatClock: chatClock,
    chatRetentionCutoff: chatRetentionCutoff,
    canRecall: canRecall,
    countryFlag: countryFlag,
    countryFlagChinaUnified: countryFlagChinaUnified,
    isMuted: isMuted,
    isShareLive: isShareLive,
    isVotableKind: isVotableKind,
    isVoteOpen: isVoteOpen,
    mentionToken: mentionToken,
    messageType: messageType,
    newsText: newsText,
    parseMentions: parseMentions,
    presenceState: presenceState,
    previewLine: previewLine,
    quotaColumnFor: quotaColumnFor,
    quotaMaxFor: quotaMaxFor,
    realtimeChanges: realtimeChanges,
    serverDate: serverDate,
    shareExpiresAt: shareExpiresAt,
    voteTally: voteTally,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMCommunityShared;
})(typeof globalThis !== 'undefined' ? globalThis : this);
