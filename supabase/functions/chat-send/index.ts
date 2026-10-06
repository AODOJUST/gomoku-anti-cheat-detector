// chat-send — §2.3.1 发一条消息, and 1.0.3's §1.1.2 附件 / §1.6.4 提及 / §1.7 引用.
//
// POST { content, attachment?, reply_to? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, message: { …, attachment, mentioned_users, reply_to, reply_preview } }
//   -> 400 { error: 'BAD_REQUEST' }         blank content with NO attachment, or a malformed attachment
//   -> 400 { error: 'CONTENT_TOO_LONG' }    over CHAT_MAX_LEN (§2.3.5 「≤ 500 字符」)
//   -> 400 { error: 'CONTENT_REJECTED' }    §2.3.5 敏感词过滤; `message` names the term
//   -> 403 { error: 'NOT_ACTIVATED' }       §1.8.1 「发送消息 ❌ 未激活」
//   -> 403 { error: 'MUTED' }               §2.4 「你已被禁言至 …」
//   -> 403 { error: 'BANNED' }              §6.2
//   -> 404 { error: 'TARGET_NOT_FOUND' }    §1.7.4's `reply_to` names no message in the window,
//                                            or §2.1.5's `attachment.wanted_id` names no PUBLIC entry
//   -> 409 { error: 'CHAT_DISABLED' }       §2.3.2 「关闭聊天室 / 全体禁言」
//   -> 409 { error: 'RATE_LIMITED' }        §2.3.5 「每分钟最多 20 条」
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY THIS FUNCTION EXISTS AT ALL, GIVEN §2.3.3 SHOWS AN INSERT POLICY
// ---------------------------------------------------------------------------------------------
// §2.3.3 gives `chat_messages` a `chat_insert` policy that lets an activated client write its own
// row through PostgREST. 005_community.sql deliberately does NOT create it, and 1.0.3 sharpens the
// reason: §2.3.5's two safeguards one section below (「每分钟最多 20 条」 / 「敏感词过滤」) cannot be
// evaluated by RLS, which sees a row and not a history and not a word list — AND the three columns
// §1.6/§1.7 add are resolved data. A client able to INSERT directly can post a 21st message, or a
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
  SHARE_KINDS,
  SHARE_NAME_MAX,
  WANTED_ATTACHMENT_KIND,
} from "../_shared/community.ts";

const BUCKET = "temp-shares";
/** §1.1.2 「保留时间与普通消息一致（7 天）」 — the same window as `CHAT_RETENTION_DAYS`. */
const SHARE_LIFETIME_DAYS = 7;

/**
 * The kinds a room 附件 may be. ⚠ 1.0.4 — THIS IS `SHARE_KINDS`, NOT A COPY OF IT.
 *
 * 1.0.2 had `["archive", "sample"]` here, mirroring 008's `cloud_shares_kind_known`, while the
 * picker in `viewer.js` has always drawn `SHARE_KINDS` — three buttons, including 配置. So 配置 +
 * 聊天室 reached this file and came back 400 for choosing something the UI offered. 015 relaxes the
 * table's constraint to the same three, and this import removes the second list entirely: the
 * picker, `friend_shares`, `cloud_shares`, `messageType()` and this check are one vocabulary.
 */
const ATTACHMENT_KINDS = SHARE_KINDS;

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

    // §2.3.2 「关闭聊天室」 — ONE switch, ONE effect (1.0.6 三号). This used to read `global_mute`
    // beside `chat_enabled`: two names for the same outcome, and the console offered both, so an
    // operator could tick 「允许发言」 and 「全体禁言」 together with no defined answer. The pair is
    // collapsed — `admin-global-chat` owns the single key, 022 deletes the other row, and this is
    // the only place the flag is enforced.
    //
    // ⚠ IT APPLIES TO EVERYONE, INCLUDING AN ADMIN. There is no bypass, on purpose: an admin who
    // needs to speak can reopen the room, and a bypass would be a second answer to 「聊天室开着吗」
    // that the client's disabled-input state does not know about.
    const { data: flagRows, error: flagError } = await sb
      .from("global_settings")
      .select("key, value")
      .eq("key", "chat_enabled");
    if (flagError) throw flagError;
    let chatEnabled = true;
    for (const row of (flagRows ?? []) as { key: string; value: unknown }[]) {
      if (row.key === "chat_enabled") chatEnabled = row.value !== false;
    }
    if (!chatEnabled) {
      return fail("CHAT_DISABLED", HttpStatus.CONFLICT, "The room is closed");
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const rawAttachment = body.attachment;
    const hasAttachment = rawAttachment !== undefined && rawAttachment !== null;

    // -----------------------------------------------------------------------------------------
    // ⚠⚠ 1.0.5 — A SHARE MESSAGE HAS NO TEXT OF ITS OWN, AND THIS LINE USED TO FORBID THAT.
    // -----------------------------------------------------------------------------------------
    // §1.1.2 makes 分享到聊天室 「一条带附件的消息」, and the room draws it from `attachment.kind`
    // alone (`cmMsgHtml` renders the card and skips the bubble when `content` is empty — the card
    // carries `name` / `summary`, the bubble would only repeat them). So `''` is the CORRECT store
    // for a message that is nothing but a card.
    //
    // 1.0.2 through 1.0.4 required a non-empty string HERE, while `cmShareGo` in `viewer.js` has
    // always called `chat.send('', { attachment })`. Every 发送到聊天室 therefore came back
    // BAD_REQUEST and reached the operator as 「发送失败（请求无效，请重试）」 — with the picker
    // offering no other route into the room. It survived three releases because the behaviour suites
    // stub `chat-send` and the static ones read this file's TEXT rather than its judgements.
    //
    // The requirement is kept for a message with NO attachment: an empty bubble is not a message,
    // it is a mis-click, and the client's own `cmSend` refuses it before the round trip for the same
    // reason. The length and censor checks below still run on whatever text IS present — §1.1.3's
    // text of a share is not a hole in §2.3.5, it is simply empty here.
    if (rawAttachment !== undefined && (typeof rawAttachment !== "object" || Array.isArray(rawAttachment))) {
      return badRequest("attachment must be an object");
    }
    const raw = body.content;
    if (raw !== undefined && typeof raw !== "string") return badRequest("Invalid content");
    // `.trim()` BEFORE the length test, so trailing whitespace cannot push a legal message over the
    // limit — and before the store, so the room never holds a message whose rendered length differs
    // from the length the limit was measured against.
    const content = typeof raw === "string" ? raw.trim() : "";
    if (content === "" && !hasAttachment) return badRequest("Missing content");

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

    // §2.3.5 「频率限制 每分钟最多 20 条」. Counted from the TABLE, not from a client-supplied
    // counter, and it only counts messages that were actually stored — a refused or censored message
    // is not one of the twenty. `>=` rather than `>`: the 20th message inside the window is allowed
    // and the 21st is the one refused, which is what 「每分钟最多 20 条」 says. (1.0.6 §1.10.1
    // raised the cap; the comparison shape did not need to change, because it never named the
    // number — it reads `CHAT_RATE_MAX`.)
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

    // ⚠ `hasAttachment` and the object-shape check were both taken ABOVE, next to the content test:
    // 「有附件吗」 decides whether empty content is legal, so it has to be answered before the
    // message can be judged at all. Two spellings of that one question (the earlier `hasAttachment`
    // and a later `rawAttachment !== null`) is exactly the second-copy shape this project has paid
    // for five times.
    if (hasAttachment) {
      const att = rawAttachment as Record<string, unknown>;

      const kind = typeof att.kind === "string" ? att.kind : "";
      // =========================================================================================
      // ⚠⚠ 1.0.7 §2.1.5 — THE FOURTH KIND, AND IT IS NOT A FILE
      // =========================================================================================
      // 「「文件」菜单扩展：发送回放 / 发送样本 / 发送嫌疑人」. The first three are `SHARE_KINDS`: each
      // becomes a `cloud_shares` row with a payload, an `expires_at` and a poll. A 嫌疑人 is a LABEL
      // POINTING AT A ROW THAT ALREADY EXISTS — there is nothing to upload, nothing to expire, and
      // the only thing the card needs is the entry's id.
      //
      // ⚠ SO IT DOES NOT JOIN `ATTACHMENT_KINDS`, and this branch is where it passes the check
      // instead. Adding it to the list would send it down the `cloud_shares` path thirty lines below
      // and fail on `cloud_shares_kind_known` (015 relaxed that CHECK to the same three) — a 500 for
      // choosing something the picker offers, which is precisely the defect 1.0.4 removed from the
      // picker/`SHARE_KINDS` pair. The shared block states the split; `WANTED_ATTACHMENT_KIND`'s own
      // note is the long form.
      const isWanted = kind === WANTED_ATTACHMENT_KIND;
      if (!isWanted && ATTACHMENT_KINDS.indexOf(kind) === -1) {
        return badRequest(`attachment.kind must be one of: ${
          ATTACHMENT_KINDS.concat([WANTED_ATTACHMENT_KIND]).join(", ")}`);
      }

      if (isWanted) {
        const wantedId = typeof att.wanted_id === "string" ? att.wanted_id.trim() : "";
        if (!wantedId) return badRequest("attachment.wanted_id is required");
        // ⚠ THE NAME AND THE SUBMITTER COME OUT OF THE ROW, NEVER OUT OF THE REQUEST. A card that
        // took its own title from the client would let any member post 「🚨 张三（@zhangsan）』 s
        // heading over an entry about somebody else — the wall's one job is that the name on a card
        // is the name in the row.
        const { data: entryRow, error: wantedError } = await sb
          .from("wanted_players")
          .select("id, status, suspect_username, suspect_display_name, submitter_name")
          .eq("id", wantedId)
          .maybeSingle();
        if (wantedError) throw wantedError;
        // ⚠ ONLY `approved` MAY BE POSTED, and the refusal is 404 rather than 403 for the same reason
        // `wanted-follow` gives: a pending entry is not 「something you may not have」, it is something
        // the room may not know EXISTS. A distinguishable answer would turn this into an oracle for
        // 「has anybody filed this account」.
        const entry = entryRow as {
          id: string; status: string; suspect_username: string;
          suspect_display_name: string | null; submitter_name: string | null;
        } | null;
        if (!entry || entry.status !== "approved") {
          return fail("TARGET_NOT_FOUND", HttpStatus.NOT_FOUND, "No such public entry");
        }
        const display = String(entry.suspect_display_name || "").trim();
        const handle = `@${entry.suspect_username}`;
        attachment = {
          kind,
          wanted_id: entry.id,
          name: display ? `${display}（${handle}）` : handle,
          // A SNAPSHOT, like the other three kinds' `name` / `summary`: `submitter_name` is written
          // once and §2.2's 注销 sets it null, and a card that went blank for that reason would be a
          // card whose 提交者 line changed under a reader who is not looking.
          submitter_name: entry.submitter_name ?? null,
        };
      } else {

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
      } // end §1.1.2's three file kinds
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
        .select("id, user_id, username, content, created_at, recalled")
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
      const q = quoted as { id: string; user_id: string; username: string | null; content: string; created_at: string; recalled: boolean };
      replyTo = q.id;
      replyPreview = {
        user_id: q.user_id,
        username: q.username,
        // `previewLine` collapses whitespace then truncates then marks the cut — shared with §2.5.5's
        // 我的提交 list, so 「一行预览」 means the same thing in both places.
        //
        // ⚠⚠ 1.0.6 §1.11 — A QUOTE OF A WITHDRAWN MESSAGE CARRIES NO TEXT. 021 KEEPS `content` on a
        // recalled row (the row is marked, not deleted — §1.11.3, and §2.1's 举报 review needs it),
        // so snapshotting it here would take the withdrawn words and put them back on screen inside
        // a NEW message — the quote card would render them under the quoting author's name. 「撤回」
        // that republishes the text one line later is not a recall.
        //
        // ⇒ The snapshot is built empty and marked, and `cmMsgHtml` draws 「[该消息已被撤回]」 for it,
        // which is the same card §1.11.4 asks for on a quote made BEFORE the recall. Deeper than the
        // UI hiding the menu row: this is the half that holds when someone calls the endpoint by hand.
        content: q.recalled ? "" : previewContent(q.content),
        created_at: q.created_at,
        // ⚠ 1.0.6 §1.11 — THE SNAPSHOT CARRIES THE RECALL FLAG, AND IT IS WRITTEN HERE SO IT ALWAYS
        // EXISTS. §1.11.4 asks the quote card to say 「[该消息已被撤回]」, and the card cannot ask the
        // original: `reply_preview` exists precisely because the original may be out of the loaded
        // page, or deleted (`on delete set null` leaves `reply_to` empty while this preview keeps the
        // text). So `chat-recall` patches every quoting row's preview when it withdraws one, and that
        // patch is a `jsonb_set` on `{recalled}` — which is only meaningful if the key is part of the
        // shape from the first write. A row that quotes something unrecallable is `false`, and only
        // `true` is ever drawn as withdrawn.
        recalled: q.recalled === true,
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
