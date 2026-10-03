// chat-send — §2.3.1 / §2.3.5: post one message to the public room.
//
// POST { content }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, message: { id, user_id, username, avatar_url, content, created_at } }
//   -> 400 { error: 'BAD_REQUEST' }         missing/blank content
//   -> 400 { error: 'CONTENT_TOO_LONG' }    over CHAT_MAX_LEN (§2.3.5 「≤ 500 字符」)
//   -> 400 { error: 'CONTENT_REJECTED' }    §2.3.5 敏感词过滤; `message` names the term
//   -> 403 { error: 'NOT_ACTIVATED' }       §2.1 「社区仅对已激活用户开放」
//   -> 403 { error: 'BANNED' }              §6.2
//   -> 409 { error: 'RATE_LIMITED' }        §2.3.5 「每分钟最多 10 条」
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY THIS FUNCTION EXISTS AT ALL, GIVEN §2.3.3 SHOWS AN INSERT POLICY
// ---------------------------------------------------------------------------------------------
// §2.3.3 gives `chat_messages` a `chat_insert` policy that lets an activated client write its own
// row through PostgREST. 005_community.sql deliberately does NOT create it, and the reason is
// §2.3.5's own two safeguards one section below: RLS can check WHO is writing, but it cannot count
// a user's last minute of history nor read a word list. A client able to INSERT directly can post
// an 11th message, or a filtered one, simply by not calling this function — both limits would be
// decoration. So the table has no client INSERT policy and this is the only writer of the room.
//
// The read half stays on PostgREST under RLS, and that is what keeps the room realtime: Realtime
// authorises a subscription with the same policies a SELECT uses, so the INSERT push §2.3.4 listens
// for arrives only if the client may read the row it carries.
//
// ⚠ THE RESPONSE CARRIES THE STORED ROW. The sender renders its own message from this answer rather
// than waiting for its own Realtime echo: the echo is what everybody ELSE gets, and a client that
// depended on it would show its own message a round trip late (and never, if the socket is down).
// Because the row is echoed, the client must not also append the echo — §2.3.1's 「自己的消息在右侧」
// is decided by `user_id`, so a duplicate would be one message drawn twice.

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
  publicChatMessage,
  recentCount,
} from "../_shared/community.ts";

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

    // §2.1 「未激活用户不显示「社区」按钮（社区仅对已激活用户开放）」. The button is the courtesy;
    // this is the rule. 403 rather than 401: the caller IS who they say they are, they are simply
    // not allowed in the room — a 401 would tell the client to re-authenticate, which cannot help.
    if (!caller.row?.activated_at) {
      return fail("NOT_ACTIVATED", HttpStatus.FORBIDDEN, "Activation required for the community");
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const raw = body.content;
    if (typeof raw !== "string" || raw.trim() === "") return badRequest("Missing content");
    // `.trim()` BEFORE the length test, so trailing whitespace cannot push a legal message over the
    // limit — and before the store, so the room never holds a message whose rendered length differs
    // from the length the limit was measured against.
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
      })
      .select("*")
      .single();
    if (error) throw error;

    return json({ ok: true, message: publicChatMessage(data as ChatMessageRow) });
  } catch (err) {
    console.error("chat-send failed:", err);
    return internal("Could not send the message");
  }
});
