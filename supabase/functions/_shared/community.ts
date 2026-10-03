// _shared/community.ts — §二 社区互动: everything the two realms must agree about, plus the
// server-only helpers the four community Edge Functions share.
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
// ==== SHARED COMMUNITY END ====

// -------------------------------------------------------------------------------------------
// Below the marker: TypeScript, and things only the server needs.
// -------------------------------------------------------------------------------------------

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** The shared block's surface, re-exported so a Function imports from one module. */
export {
  CENSOR_WORDS,
  CHAT_MAX_LEN,
  CHAT_PAGE_SIZE,
  CHAT_RATE_MAX,
  CHAT_RATE_WINDOW_MS,
  CHAT_RETENTION_DAYS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_RATE_MAX,
  FEEDBACK_RATE_WINDOW_MS,
  FEEDBACK_STATUSES,
  FEEDBACK_TITLE_MAX,
  NEWS_CATEGORIES,
  NEWS_CONTENT_MAX,
  NEWS_DEFAULT_LANG,
  NEWS_TITLE_MAX,
  censorHit,
  censorNormalize,
  chatClock,
  chatRetentionCutoff,
  newsText,
  previewLine,
};

/**
 * How many rows `table` holds for `userId` in the last `windowMs`.
 *
 * ONE implementation for both rate limits, because 「数最近一分钟的条数」 and 「数最近十分钟的条数」
 * are one query with two numbers, and the day one of them forgets the `user_id` filter is the day
 * one user's posting rate throttles everybody.
 *
 * `head: true` + `count: 'exact'` asks PostgREST for the count without the rows: the 10th message
 * does not need to be fetched to know it is the 11th.
 */
export async function recentCount(
  sb: SupabaseClient,
  table: string,
  userId: string,
  windowMs: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { count, error } = await sb
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) throw error;
  return count ?? 0;
}

/** A row of public.chat_messages (005_community.sql). */
export interface ChatMessageRow {
  id: string;
  user_id: string;
  username: string | null;
  avatar_url: string | null;
  content: string;
  created_at: string;
}

/**
 * The projection the client receives for a chat message.
 *
 * Written out rather than `select('*')` so a column added later cannot leak by default — the same
 * rule `admin-list-users` states for its user rows. `user_id` IS included: §2.3.1 needs it to tell
 * 「自己的消息在右侧」, and it is not a secret (every reader is inside the same room).
 */
export function publicChatMessage(row: ChatMessageRow): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    avatar_url: row.avatar_url,
    content: row.content,
    created_at: row.created_at,
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
