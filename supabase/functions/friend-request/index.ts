// friend-request — §1.2.2: A asks B to be friends.
//
// POST { user_id }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, friendship: { id, status, requester, ... } }
//   -> 400 { error: 'BAD_REQUEST' }      missing/blank user_id, or asking yourself
//   -> 403 { error: 'NOT_ACTIVATED' }    §1.8.1 「添加好友 ❌ 未激活」
//   -> 403 { error: 'MUTED' }            §2.4 「不能发消息/投票/互动」 — a request is interaction
//   -> 403 { error: 'BANNED' }           §6.2, via accountRefusal
//   -> 404 { error: 'TARGET_NOT_FOUND' } the account is gone, soft-deleted or banned
//   -> 409 { error: 'FRIEND_EXISTS' }    already friends, or already waiting on an answer
//   -> 409 { error: 'BLOCKED_BY_USER' }  §1.5.2's 拉黑 — the row exists with status 'blocked'
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY THERE IS NO `notifications` ROW BEHIND §1.2.2'S 「B 收到通知（徽章 + 消息列表）」
// ---------------------------------------------------------------------------------------------
// The notification IS this row. §1.5.3's 消息 screen lists 「张三 请求添加你为好友 [接受][拒绝]」, and
// everything it needs — who, when, still unanswered — is `friendships` itself: `status = 'pending'`
// and `requester <> me`. A notification row would be a second copy of that state, and the two would
// disagree the first time a request was accepted from another device: the friendship would move to
// 'accepted' and the badge would keep counting a request that no longer exists. The badge is
// `count(*) where status='pending' and requester <> auth.uid()` — derived, so it cannot drift.
//
// ⚠ NOT EVERY SECTION OF §1.5.3 WORKS THIS WAY. The rule (written out in full in 009_reports.sql) is
// that a section whose source row DIES when the event is dealt with is derived, and one that needs
// an unread marker gets a row in `notifications`. 分享 (`friend_shares`) is derived for the same
// reason this is; @提及 is a notification row, because §1.6.3 asks for 「头像上小红点」 and a mention
// is one name inside `chat_messages.mentioned_users` rather than a row anything can be marked read
// against. ⇒ three derivations and two tables, each chosen for a reason, not for uniformity.

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
  communityRefusal,
  orderPair,
  type FriendshipRow,
  refusalMessage,
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

    // §6.2's 封禁 + §4.2's soft delete.
    const refusal = accountRefusal(caller.row);
    if (refusal) return refusal;

    // §1.8.1 / §2.4: an unactivated account may LOOK (§1.8.1's four ✅ rows) but not act. Adding a
    // friend is one of the six ❌ rows, and a muted account is excluded by §2.4's 「互动」.
    const community = communityRefusal(caller.row);
    if (community) {
      return fail(community, HttpStatus.FORBIDDEN, refusalMessage(community));
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const target = typeof body.user_id === "string" ? body.user_id.trim() : "";
    if (!target) return badRequest("Missing user_id");
    // §1.1.1's quick menu offers 「添加好友（已是好友则隐藏）」 on ANY avatar, so 「和自己加好友」 is
    // one tap away — and `friendships_distinct` would answer it as a 500 rather than as a sentence.
    if (target === caller.id) return badRequest("Cannot add yourself");

    // §1.3's profile is public to members, but a request is not: the target has to be a real,
    // live, unbanned account. `TARGET_NOT_FOUND` rather than a 403 so the client can say
    // 「该用户不存在」 instead of implying the caller lacked permission.
    const { data: targetRow, error: targetError } = await sb
      .from("users")
      .select("id, deleted_at, is_banned")
      .eq("id", target)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!targetRow || targetRow.deleted_at || targetRow.is_banned === true) {
      return fail("TARGET_NOT_FOUND", HttpStatus.NOT_FOUND, "No such account");
    }

    // §1.2.1's 「user_a < user_b」, applied through the one helper both this and `friend-accept`
    // use — a lookup that ordered its pair differently would report 「没有请求」 about a row that
    // exists (see `orderPair`).
    const [userA, userB] = orderPair(caller.id, target);

    const { data: existing, error: existingError } = await sb
      .from("friendships")
      .select("*")
      .eq("user_a", userA)
      .eq("user_b", userB)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existing) {
      const row = existing as FriendshipRow;
      // §1.5.2's 拉黑: `status = 'blocked'` means one of the two has closed the door. ⚠ This does
      // tell the caller that the relationship is blocked rather than pending — but they can already
      // see that: the read policy in 011 admits BOTH parties to the row, so the status is on their
      // own screen. Refusing with a vaguer code would only make this endpoint's answer differ from
      // the one their friend list is already showing them.
      if (row.status === "blocked") {
        return fail("BLOCKED_BY_USER", HttpStatus.CONFLICT, "This relationship is blocked");
      }
      // Covers all three of §1.2.2's live states at once: already accepted, and already pending in
      // either direction. The client renders 「已发送请求」 vs 「已是好友」 from the row it gets
      // back, which is more honest than making the server guess which sentence the user needs.
      return fail("FRIEND_EXISTS", HttpStatus.CONFLICT, "A relationship already exists");
    }

    const { data, error } = await sb
      .from("friendships")
      .insert({
        user_a: userA,
        user_b: userB,
        status: "pending",
        // §1.2.2 「requester = A」. The pair is ordered, so this is the only record of direction —
        // and therefore the only thing that lets B's 消息 screen tell an incoming request from an
        // outgoing one.
        requester: caller.id,
      })
      .select("*")
      .single();
    if (error) throw error;

    return json({ ok: true, friendship: data });
  } catch (err) {
    console.error("friend-request failed:", err);
    return internal("Could not send the friend request");
  }
});
