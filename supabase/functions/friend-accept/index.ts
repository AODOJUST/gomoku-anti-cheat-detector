// friend-accept — §1.2.2's accept/reject, and §1.5.2's 备注 / 删除 / 拉黑.
//
// POST { friendship_id, action, remark? }   Authorization: Bearer <jwt>
//   action = 'accept' | 'reject' | 'remove' | 'block' | 'unblock' | 'remark'
//   -> 200 { ok: true, friendship }        accept / block / unblock / remark
//   -> 200 { ok: true, removed: true }     reject / remove
//   -> 400 { error: 'BAD_REQUEST' }        unknown action, missing id, over-length remark,
//                                          or accepting/rejecting a request you sent yourself
//   -> 403 { error: 'NOT_ACTIVATED' | 'MUTED' }   §1.8.1 / §2.4
//   -> 404 { error: 'NOT_FOUND' }          no such row, OR it is not yours to act on
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY ONE FUNCTION CARRIES SIX VERBS, INCLUDING THREE §实现清单 DOES NOT MENTION
// ---------------------------------------------------------------------------------------------
// §实现清单 names `friend-request` and `friend-accept`. §1.5.2 then describes 备注 / 删除好友 / 拉黑
// with no function of their own — and they cannot be client-side writes, because `friendships` has
// no write policy at all (011). They belong here because they are the same operation on the same
// row with the same authorisation question: 「你是这一对的当事人吗」. A second Function would
// repeat that question, and §1.2.1's ordered pair means the question has exactly one right answer
// (`auth.uid() in (user_a, user_b)`) — the shape this project has paid six times for duplicating.
//
// ⚠ `NOT_FOUND` (404) RATHER THAN 403 FOR A ROW THAT IS NOT YOURS. Same reasoning as
// `auth-check-available`'s: answering 「存在，但你没权限」 turns this endpoint into an oracle for
// 「这两个人是好友吗」, which §1.2.1 keeps private (the read policy admits only the two parties).
// A row id the caller cannot see is, from where they stand, a row that does not exist.

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
  FRIEND_REMARK_MAX,
  type FriendshipRow,
  refusalMessage,
} from "../_shared/community.ts";

/** Every verb this endpoint answers, in one list so the message can name the alternatives. */
const ACTIONS = ["accept", "reject", "remove", "block", "unblock", "remark"];

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const { caller } = auth;

    const refusal = accountRefusal(caller.row);
    if (refusal) return refusal;

    // §1.8.1's 「添加好友 ❌」 covers the whole relationship lifecycle — accepting a request is the
    // second half of the same feature, and §2.4's 「互动」 covers it too. ⚠ Note what this does NOT
    // block: `reject` and `remove`. A user who has been muted part-way through a conversation must
    // still be able to leave it, or the mute becomes a trap. That asymmetry is deliberate and it is
    // the reason the check sits after the action is parsed rather than before it.
    const community = communityRefusal(caller.row);

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const id = typeof body.friendship_id === "string" ? body.friendship_id.trim() : "";
    if (!id) return badRequest("Missing friendship_id");

    const action = typeof body.action === "string" ? body.action : "";
    if (ACTIONS.indexOf(action) === -1) {
      return badRequest(`action must be one of: ${ACTIONS.join(", ")}`);
    }

    // `reject` / `remove` are allowed through a mute; the four that build or edit a relationship
    // are not.
    if (community && action !== "reject" && action !== "remove") {
      return fail(community, HttpStatus.FORBIDDEN, refusalMessage(community));
    }

    const { data: found, error: findError } = await sb
      .from("friendships")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (findError) throw findError;

    // The authorisation question, asked once, for all six verbs. See the header for why a miss and
    // a not-yours are the same answer.
    const row = found as FriendshipRow | null;
    if (!row || (row.user_a !== caller.id && row.user_b !== caller.id)) {
      return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such friendship");
    }

    const iAmRequester = row.requester === caller.id;

    // ----- ⚠ a blocked row is FROZEN for everyone but the blocker ----------------------------
    // One guard, before every verb, because there is more than one way out of a blocked row and
    // only one of them is allowed to work:
    //   * `unblock` by the other side would make 拉黑 a suggestion the blocked account can decline;
    //   * `remove` / `reject` DELETE the row — which erases the record of the block entirely and
    //     frees the blocked account to send a fresh 添加好友 request, i.e. it is a louder版 of the
    //     same escape;
    //   * `accept` / `remark` / `block` all rewrite a state the blocker already settled.
    // `blocked_by` is nullable and `on delete set null`, so an account that deleted itself leaves
    // the row 'blocked' with nobody to blame — which is why the test is `!== caller.id` rather than
    // `=== other`. With nobody named, neither party may lift it, and the purge/cleanup path is what
    // resolves it. Freezing is the safe direction: the cost is a stale row, not a lifted block.
    if (row.status === "blocked" && row.blocked_by !== caller.id) {
      // 403 rather than 404: the caller CAN see this row — it is on their own list — so pretending
      // it does not exist is a lie they can catch. What they may not do is overrule somebody else's
      // decision, and the answer says exactly that.
      return fail("FORBIDDEN", HttpStatus.FORBIDDEN,
        "This relationship was blocked; only the account that blocked may change it");
    }

    // ----- reject / remove: the row goes away ------------------------------------------------
    // §1.2.2 「B 点击「拒绝」 → 删除记录」, and §1.5.2's 删除好友. Both are a delete; they differ
    // only in which screen offered them, so they share one implementation and one answer shape.
    if (action === "reject" || action === "remove") {
      // ⚠ Accepting your own request is meaningless, and so is rejecting it — §1.2.2 makes B the
      // only one who answers. `remove` has no such rule: either side may leave.
      if (action === "reject" && iAmRequester) {
        return badRequest("A request cannot be answered by the account that sent it");
      }
      const { error } = await sb.from("friendships").delete().eq("id", row.id);
      if (error) throw error;
      return json({ ok: true, removed: true });
    }

    // ----- accept ----------------------------------------------------------------------------
    if (action === "accept") {
      if (iAmRequester) {
        return badRequest("A request cannot be answered by the account that sent it");
      }
      if (row.status !== "pending") {
        // Idempotence guarded on purpose: a second device pressing 接受 must not re-stamp
        // `updated_at` and re-order the friend list. Re-accepting an already-accepted row is a
        // no-op that reports success, because from the user's point of view it already happened.
        if (row.status === "accepted") return json({ ok: true, friendship: row });
        // A 'blocked' row can only be reached here by the BLOCKER — the guard above turned the
        // other side away — so answering 「对方拉黑了你」 would be a sentence that is false about the
        // account reading it. ▶ `unblock` is the verb for this caller, and the message says so.
        return badRequest("This relationship is blocked — unblock it first");
      }
      const { data, error } = await sb
        .from("friendships")
        .update({ status: "accepted", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .select("*")
        .single();
      if (error) throw error;
      return json({ ok: true, friendship: data });
    }

    // ----- block / unblock -------------------------------------------------------------------
    // §1.5.2 「拉黑（不再接收对方消息）」. The row is KEPT with `status = 'blocked'` rather than
    // deleted, because §1.2.1 makes that status part of the schema — a delete would lose the fact
    // that a block happened, and a re-request would then sail through.
    //
    // ⚠ WHO MAY LIFT A BLOCK is decided by the guard above — `blocked_by` records the blocker, and
    // only that account gets this far with `status = 'blocked'`. There is deliberately no second
    // check here: two tests of one fact is how the two answers drift apart.
    if (action === "block" || action === "unblock") {
      const patch: Record<string, unknown> = action === "block"
        // Both halves in one write — the biconditional CHECK in 006 rejects either one alone.
        ? { status: "blocked", blocked_by: caller.id, updated_at: new Date().toISOString() }
        // `blocked_by` goes back to NULL with the status, for the same reason.
        : { status: "accepted", blocked_by: null, updated_at: new Date().toISOString() };
      const { data, error } = await sb
        .from("friendships")
        .update(patch)
        .eq("id", row.id)
        .select("*")
        .single();
      if (error) throw error;
      return json({ ok: true, friendship: data });
    }

    // ----- remark (§1.5.2 「备注：修改备注名」) -------------------------------------------------
    // ⚠ WHICH COLUMN IS WHOSE. §1.2.1's `remark_a` is 「A 对 B 的备注」, and the pair is ORDERED,
    // so the column is decided by which side of `user_a`/`user_b` the caller is on — NOT by who
    // sent the request. Writing `remarkFor`'s answer back into the wrong column would show my
    // nickname for them on THEIR screen.
    const rawRemark = body.remark;
    if (rawRemark !== null && rawRemark !== undefined && typeof rawRemark !== "string") {
      return badRequest("remark must be a string or null");
    }
    const remark = typeof rawRemark === "string" ? rawRemark.trim() : "";
    if (remark.length > FRIEND_REMARK_MAX) {
      return badRequest(`remark must be at most ${FRIEND_REMARK_MAX} characters`);
    }
    // An empty remark clears it rather than storing ''. The friend list renders the username when
    // the remark is null, and a zero-length string is a second spelling of 「没有备注」 that every
    // reader would have to know about.
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      [caller.id === row.user_a ? "remark_a" : "remark_b"]: remark === "" ? null : remark,
    };
    const { data, error } = await sb
      .from("friendships")
      .update(patch)
      .eq("id", row.id)
      .select("*")
      .single();
    if (error) throw error;
    return json({ ok: true, friendship: data });
  } catch (err) {
    console.error("friend-accept failed:", err);
    return internal("Could not update the friendship");
  }
});
