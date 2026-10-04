// chat-send — §2.3.1 发一条消息, and 1.0.3's §1.1.2 附件 / §1.6.4 提及 / §1.7 引用.
//
// POST { content, attachment?, reply_to? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, message: { …, attachment, mentioned_users, reply_to, reply_preview } }
//   -> 400 { error: 'BAD_REQUEST' }         missing/blank content, or a malformed attachment
//   -> 400 { error: 'CONTENT_TOO_LONG' }    over CHAT_MAX_LEN (§2.3.5 「≤ 500 字符」)
//   -> 400 { error: 'CONTENT_REJECTED' }    §2.3.5 敏感词过滤; `message` names the term
//   -> 403 { error: 'NOT_ACTIVATED' }       §1.8.1 「发送消息 ❌ 未激活」
//   -> 403 { error: 'MUTED' }               §2.4 「你已被禁言至 …」
//   -> 403 { error: 'BANNED' }              §6.2
//   -> 404 { error: 'TARGET_NOT_FOUND' }    §1.7.4's `reply_to` names no message in the window
//   -> 409 { error: 'CHAT_DISABLED' }       §2.3.2 「关闭聊天室 / 全体禁言」
//   -> 409 { error: 'RATE_LIMITED' }        §2.3.5 「每分钟最多 10 条」
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY THIS FUNCTION EXISTS AT ALL, GIVEN §2.3.3 SHOWS AN INSERT POLICY
// ---------------------------------------------------------------------------------------------
// §2.3.3 gives `chat_messages` a `chat_insert` policy that lets an activated client write its own
// row through PostgREST. 005_community.sql deliberately does NOT create it, and 1.0.3 sharpens the
// reason: §2.3.5's two safeguards one section below (「每分钟最多 10 条」 / 「敏感词过滤」) cannot be
// evaluated by RLS, which sees a row and not a history and not a word list — AND the three columns
// §1.6/§1.7 add are resolved data. A client able to INSERT directly can post an 11th message, or a
// filtered one, or a `mentioned_users` array nobody resolved, by simply not calling this function.
//
// The read half stays on PostgREST under RLS, and that is what keeps the room realtime: Realtime
// authorises a subscription with the same policies a SELECT uses, so the INSERT push §2.3.4 listens
// for arrives only if the client may read the row it carries.
//
// ⚠ THE RESPONSE CARRIES THE STORED ROW. The sender renders its own message from this answer rather
// than waiting for its own Realtime echo — see 1.0.2's note, unchanged.
//
// ---------------------------------------------------------------------------------------------
// 1.0.3: THE ORDER OF THE GATES, WHICH IS NOW FIVE DEEP
// ---------------------------------------------------------------------------------------------
//   requireUser → accountRefusal(BANNED/deleted) → communityRefusal(NOT_ACTIVATED, MUTED)
//   → CHAT_DISABLED → content(BAD_REQUEST, TOO_LONG, REJECTED) → RATE_LIMITED → the row
//
// ⚠ CHAT_DISABLED SITS ABOVE THE CONTENT CHECKS, and that is a decision rather than an accident.
// §2.3.2's 关闭聊天室 is a statement about the ROOM, not about the message — when the room is shut,
// 「你的消息太长」 is not true in any useful sense, and answering it would send the user off to edit a
// message that will still be refused. A closed room says so first.
//
// ⚠ THE MUTE SITS ABOVE THE LENGTH CHECK TOO, for the same reason and one more: §2.4's client half
// renders 「你已被禁言至 YYYY-MM-DD HH:MM」, which needs the MUTED answer and not a length complaint.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  badRequest,
  fail,
  HttpStatus,
  internal,
  json,
  methodNotAllowed,
} from "../_shared/errors.ts";
import { accountRefusal, requireUser, serviceClient } from "../_shared/client.ts";
import {
  CHAT_MAX_LEN,
  CHAT_RATE_MAX,
  CHAT_RATE_WINDOW_MS,
  censorHit,
  type ChatMessageRow,
  communityRefusal,
  MENTION_MAX,
  parseMentions,
  publicChatMessage,
  recentCount,
  refusalMessage,
  REPLY_PREVIEW_MAX,
  SHARE_INLINE_MAX_BYTES,
  SHARE_NAME_MAX,
} from "../_shared/community.ts";

const BUCKET = "temp-shares";
/** §1.1.2 「保留时间与普通消息一致（7 天）」 — the same window as `CHAT_RETENTION_DAYS`. */
const SHARE_LIFETIME_DAYS = 7;

/** The two kinds §1.1.2's picker offers. Mirrors `cloud_shares_kind_known` (008). */
const ATTACHMENT_KINDS = ["archive", "sample"];

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const { caller } = auth;

    // §6.2's 封禁 and §4.2's soft delete, through the one predicate five other functions use.
    const refusal = accountRefusal(caller.row);
    if (refusal) return refusal;

    // §1.8.1 「发送消息 ❌ 未激活」 + §2.4's mute. 403 rather than 401: the caller IS who they say
    // they are, they are simply not allowed to post — a 401 would tell the client to re-authenticate,
    // which cannot help.
    const community = communityRefusal(caller.row);
    if (community) return fail(community, HttpStatus.FORBIDDEN, refusalMessage(community));

    // §2.3.2 「关闭聊天室 / 全体禁言」. TWO keys, ONE effect — see `admin-global-mute` for why the
    // spec's two names are both honoured rather than collapsed into one flag.
    //
    // ⚠ IT APPLIES TO EVERYONE, INCLUDING AN ADMIN. There is no bypass, on purpose: an admin who
    // needs to speak can reopen the room, and a bypass would be a second answer to 「聊天室开着吗」
    // that the client's disabled-input state does not know about.
    const { data: flagRows, error: flagError } = await sb
      .from("global_settings")
      .select("key, value")
      .in("key", ["chat_enabled", "global_mute"]);
    if (flagError) throw flagError;
    let chatEnabled = true;
    let globalMute = false;
    for (const row of (flagRows ?? []) as { key: string; value: unknown }[]) {
      if (row.key === "chat_enabled") chatEnabled = row.value !== false;
      if (row.key === "global_mute") globalMute = row.value === true;
    }
    if (!chatEnabled || globalMute) {
      return fail("CHAT_DISABLED", HttpStatus.CONFLICT, "The room is closed");
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const raw = body.content;
    if (typeof raw !== "string" || raw.trim() === "") return badRequest("Missing content");
    // `.trim()` BEFORE the length test, so trailing whitespace cannot push a legal message over the
    // limit — and before the store, so the room never holds a message whose rendered length differs
    // from the length the limit was measured against.
    //
    // ⚠ A SHARE MESSAGE'S content IS STILL CHECKED. §1.1.3 gives it 「分享了一个存档」, which is well
    // under the limit — but it is TEXT, and the censor reads it like any other text. Skipping the
    // checks for an attachment would make the attachment a way to post anything.
    const content = raw.trim();

    if (content.length > CHAT_MAX_LEN) {
      return fail("CONTENT_TOO_LONG", HttpStatus.BAD_REQUEST,
        `At most ${CHAT_MAX_LEN} characters`);
    }

    // §2.3.5 敏感词过滤. AFTER the length check and BEFORE the rate-limit query: it is the cheapest
    // test here (no I/O) and it is local, so a refused message costs no database round trip.
    //
    // ⚠ The refused TERM travels in `message`. It is the sender's own text, so nothing is disclosed
    // that they did not type, and without it the answer is 「有敏感词」 with no way to find it —
    // which for a 500-character message is a guessing game.
    const term = censorHit(content);
    if (term) {
      return fail("CONTENT_REJECTED", HttpStatus.BAD_REQUEST, `Blocked term: ${term}`);
    }

    // §2.3.5 「频率限制 每分钟最多 10 条」. Counted from the TABLE, not from a client-supplied
    // counter, and it only counts messages that were actually stored — a refused or censored message
    // is not one of the ten. `>=` rather than `>`: the 10th message inside the window is allowed and
    // the 11th is the one refused, which is what 「每分钟最多 10 条」 says.
    const recent = await recentCount(sb, "chat_messages", caller.id, CHAT_RATE_WINDOW_MS);
    if (recent >= CHAT_RATE_MAX) {
      return fail("RATE_LIMITED", HttpStatus.CONFLICT,
        `At most ${CHAT_RATE_MAX} messages per minute`);
    }

    // =========================================================================================
    // §1.1.2 / §1.1.3 — the attachment
    // =========================================================================================
    // ⚠ THE UPLOAD HAPPENS INSIDE THIS CALL, which is why §实现清单's nine functions do not include
    // a `share-create`. A separate upload endpoint would make 「上传成功，发消息失败」 a reachable
    // state, and the artefact would be orphaned — a bucket object nothing points at, that the purge
    // job cannot find because nothing records it. One call means the message and its copy are
    // created together or not at all.
    let attachment: Record<string, unknown> | null = null;
    const rawAttachment = body.attachment;

    if (rawAttachment !== undefined && rawAttachment !== null) {
      if (typeof rawAttachment !== "object" || Array.isArray(rawAttachment)) {
        return badRequest("attachment must be an object");
      }
      const att = rawAttachment as Record<string, unknown>;

      const kind = typeof att.kind === "string" ? att.kind : "";
      if (ATTACHMENT_KINDS.indexOf(kind) === -1) {
        return badRequest(`attachment.kind must be one of: ${ATTACHMENT_KINDS.join(", ")}`);
      }
      const rawName = att.name;
      if (typeof rawName !== "string" || rawName.trim() === "") {
        return badRequest("attachment.name is required");
      }
      const name = rawName.trim();
      if (name.length > SHARE_NAME_MAX) {
        return badRequest(`attachment.name must be at most ${SHARE_NAME_MAX} characters`);
      }
      if (att.payload === undefined || att.payload === null) {
        return badRequest("attachment.payload is required");
      }

      const size = byteLength(att.payload);
      let storagePath: string | null = null;
      if (size > SHARE_INLINE_MAX_BYTES) {
        const path = `public/${caller.id}/${crypto.randomUUID()}.json`;
        const upload = await sb.storage.from(BUCKET).upload(
          path,
          new Blob([JSON.stringify(att.payload)], { type: "application/json" }),
          { contentType: "application/json", upsert: false },
        );
        if (upload.error) throw upload.error;
        storagePath = path;
      }

      const expiresAt = new Date(Date.now() + SHARE_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
        .toISOString();

      const { data: cloudRow, error: cloudError } = await sb
        .from("cloud_shares")
        .insert({
          owner_id: caller.id,
          kind,
          name,
          summary: att.summary ?? null,
          payload: storagePath === null ? att.payload : null,
          storage_url: storagePath,
          size_bytes: size,
          expires_at: expiresAt,
        })
        .select("id")
        .single();
      if (cloudError) throw cloudError;

      // §1.1.3's literal shape. `name` / `summary` / `expires_at` are a SNAPSHOT of the
      // `cloud_shares` row, not a cache of something mutable — that row is write-once, exactly like
      // the `username` / `avatar_url` snapshot 005_community.sql explains for this table. Including
      // them is what lets the room render the card for 500 messages without joining.
      //
      // ⚠ NO `type` FIELD. §1.1.3 carries both `type` and `attachment.kind`, which are one fact
      // twice; 008_community_ext.sql drops the redundant one and `messageType()` in the shared block
      // derives it, so both realms spell it the same way.
      attachment = {
        kind,
        cloud_id: (cloudRow as { id: string }).id,
        name,
        summary: att.summary ?? null,
        expires_at: expiresAt,
      };
    }

    // =========================================================================================
    // §1.7.4 — the quote
    // =========================================================================================
    // ⚠ `reply_to` IS RESOLVED HERE AND SNAPSHOTTED, NOT JOINED AT RENDER TIME. §1.7.4 says so
    // (「冗余存储，避免每次 join」), and it is also what makes §1.7.3 work after the original is gone:
    // 008 keeps `reply_to` with `on delete set null` and the card keeps rendering from
    // `reply_preview`. A broken quote is worse than a dangling one.
    let replyTo: string | null = null;
    let replyPreview: Record<string, unknown> | null = null;
    const rawReply = body.reply_to;

    if (rawReply !== undefined && rawReply !== null) {
      if (typeof rawReply !== "string" || rawReply.trim() === "") {
        return badRequest("reply_to must be a message id");
      }
      const { data: quoted, error: quoteError } = await sb
        .from("chat_messages")
        .select("id, user_id, username, content, created_at")
        .eq("id", rawReply.trim())
        .maybeSingle();
      if (quoteError) throw quoteError;
      // Out of the retention window, deleted, or never existed — all three are 「引用不了」, and the
      // client's next step is the same. ⚠ Answered as TARGET_NOT_FOUND rather than silently
      // dropping the quote: a message posted without the reference the user asked for looks like
      // the quote button did nothing.
      if (!quoted) {
        return fail("TARGET_NOT_FOUND", HttpStatus.NOT_FOUND, "The quoted message is gone");
      }
      const q = quoted as { id: string; user_id: string; username: string | null; content: string; created_at: string };
      replyTo = q.id;
      replyPreview = {
        user_id: q.user_id,
        username: q.username,
        // `previewLine` collapses whitespace then truncates then marks the cut — shared with §2.5.5's
        // 我的提交 list, so 「一行预览」 means the same thing in both places.
        content: previewContent(q.content),
        created_at: q.created_at,
      };
    }

    // =========================================================================================
    // §1.6.4 — 「发送时解析 `@用户名`，查表获得 user_id，写入数组」
    // =========================================================================================
    // ⚠ THE RESOLUTION IS SERVER-SIDE, and that is a security property rather than tidiness: a
    // client-supplied array would let a message notify any account it liked, and §1.6.3 turns a
    // mention into a badge. Only names that resolve to a REAL, live account are stored.
    //
    // ⚠ A NAME THAT DOES NOT RESOLVE IS SILENTLY IGNORED. §1.6.2's autocomplete only offers names
    // that exist, so an unresolvable one means either a typo or a hand-crafted request; answering
    // 「张三 不存在」 would turn this into a username oracle for anyone with an account.
    const mentionNames = parseMentions(content).slice(0, MENTION_MAX);
    let mentionedUsers: string[] = [];
    if (mentionNames.length > 0) {
      const { data: found, error: mentionError } = await sb
        .from("users")
        .select("id, username")
        .in("username", mentionNames)
        .is("deleted_at", null);
      if (mentionError) throw mentionError;
      // ⚠ 「@自己」 IS DROPPED. It is not an error — §1.6.1's right-click menu is on every avatar
      // including your own, and §1.7.2's auto-@ explicitly skips the author — but notifying yourself
      // about your own message would put a red dot on your own avatar, which §1.6.3 asks for only
      // as a signal about OTHER people's messages.
      mentionedUsers = ((found ?? []) as { id: string }[])
        .map((u) => u.id)
        .filter((id) => id !== caller.id);
    }

    // =========================================================================================
    // the row
    // =========================================================================================
    // `username` / `avatar_url` are copied from the caller's row, never taken from the request: they
    // are the SNAPSHOT §2.3.2 stores (see 005_community.sql), and letting the client name itself
    // would make the room's one identity guarantee — the name beside a message is the name of the
    // account that sent it — a client-side claim.
    const { data, error } = await sb
      .from("chat_messages")
      .insert({
        user_id: caller.id,
        username: caller.row?.username ?? null,
        avatar_url: caller.row?.avatar_url ?? null,
        content,
        attachment,
        mentioned_users: mentionedUsers.length > 0 ? mentionedUsers : null,
        reply_to: replyTo,
        reply_preview: replyPreview,
      })
      .select("*")
      .single();
    if (error) throw error;

    const message = publicChatMessage(data as ChatMessageRow);

    // =========================================================================================
    // §1.6.3 — 「被 @ 的用户收到通知：消息列表中的「@提及」分类；头像上小红点」
    // =========================================================================================
    // ⚠ AFTER THE MESSAGE, NEVER BEFORE. `data.message_id` is the destination of §1.5.3's 「[查看]」,
    // and this row's `id` does not exist until the insert above commits. A notification written
    // first would have to name the message some other way, or be updated afterwards — both are a
    // second source for one fact.
    //
    // ⚠ THE PREVIEW IS COPIED INTO `data`, not joined at render time. Chat is purged after
    // `CHAT_RETENTION_DAYS` and notifications are not, so a mention whose message is gone must still
    // render 「王五 在聊天室 @了你」 with the sentence that mentioned you. Same snapshot reasoning as
    // §1.7.4's `reply_preview` — 009_reports.sql states the rule.
    if (mentionedUsers.length > 0) {
      const { error: notifyError } = await sb.from("notifications").insert(
        mentionedUsers.map((userId) => ({
          user_id: userId,
          kind: "mention",
          title: null,
          body: null,
          data: {
            message_id: (data as { id: string }).id,
            from_user: caller.id,
            username: caller.row?.username ?? null,
            content: previewContent(content),
          },
        })),
      );
      // ⚠ A failed notification does NOT fail the message. The message is stored and readable, and
      // the mention still resolves for anyone who scrolls the room; tearing the message down because
      // a badge could not be written would lose the thing the badge was about. Same trade as
      // `friend-share`'s quota counter — logged, not thrown.
      if (notifyError) console.error("chat-send mention notify failed:", notifyError);
    }

    return json({ ok: true, message });
  } catch (err) {
    console.error("chat-send failed:", err);
    return internal("Could not send the message");
  }
});

/**
 * §1.7.4's `reply_preview.content`: collapse whitespace, cut to REPLY_PREVIEW_MAX, mark the cut.
 *
 * ⚠ Its own function rather than `previewLine` (which lives in the shared block and is used by the
 * client for §2.5.5): the two want the same SHAPE but this one's limit is a shared constant for the
 * quote and `previewLine` defaults to 80. Kept local to the server because only the server writes
 * the preview — see the note on `reply_preview` above.
 */
function previewContent(text: string): string {
  const flat = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return flat.length <= REPLY_PREVIEW_MAX
    ? flat
    : flat.slice(0, REPLY_PREVIEW_MAX - 1) + "…";
}
