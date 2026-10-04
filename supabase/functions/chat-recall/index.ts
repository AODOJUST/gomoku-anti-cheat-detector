// chat-recall — 1.0.6 §1.11 「消息撤回（2 分钟内）」.
//
// POST { id, reason? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, message: { …, recalled: true, recalled_at, recall_reason } }
//   -> 400 { error: 'BAD_REQUEST' }         `id` missing / not a string, or `reason` over the cap
//   -> 403 { error: 'NOT_ACTIVATED' }       §1.8.1's 「社区仅对已激活用户开放」
//   -> 404 { error: 'TARGET_NOT_FOUND' }    §1.11's message does not exist (or is past retention)
//   -> 409 { error: 'NOT_RECALLABLE' }      not yours, already withdrawn, or past the 2-minute window
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY A FUNCTION RATHER THAN THE UPDATE POLICY §1.11 SHOWS
// ---------------------------------------------------------------------------------------------
// The 定稿 proposes an RLS policy:
//
//   for update using (auth.uid() = user_id and created_at > now() - interval '2 minutes')
//              with check (recalled = true and auth.uid() = user_id)
//
// 005_community.sql and 011_rls_community.sql give `chat_messages` **no write policy at all** and
// say why: a predicate can see a row, not the reason the row is being written. `chat-send` exists
// because §2.3.5's rate limit and §1.6.4's resolved mentions cannot be expressed in RLS. Recall
// needs the same treatment for three reasons of its own:
//
//   * `with check (recalled = true)` does not stop the SAME statement from also rewriting `content`.
//     The author would be able to edit the text and mark it withdrawn, and only the second half is
//     what a reader sees recorded.
//   * it cannot write `recalled_at`, so 021's `recalled = false or recalled_at is not null`
//     constraint would be violated by the very policy the spec proposes — a half-state with no
//     timestamp is exactly what that constraint exists to make unreachable.
//   * it cannot refresh §1.11.4's `reply_preview` snapshots. See below; that is a WRITE to rows the
//     author does not own, which no policy on `auth.uid() = user_id` can authorise.
//
// ⇒ ONE write path, this one, exactly as `chat-send` is the one write path for a new message.
//
// ---------------------------------------------------------------------------------------------
// §1.11.3 「会留下撤回记录」 — THE ROW IS MARKED, NOT DELETED
// ---------------------------------------------------------------------------------------------
// The place in the conversation stays. `recalled = true` is the whole of the edit; `content` is
// kept, because deleting it would make 「被引用时引用卡片显示 [该消息已被撤回]」 (below) impossible to
// answer for a quote whose snapshot had already been built, and because §2.1's 举报 review needs to
// see what was actually said. A withdrawn message is not a deleted one, and this function has no
// DELETE in it.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  badRequest,
  fail,
  HttpStatus,
  json,
  methodNotAllowed,
} from "../_shared/errors.ts";
import { accountRefusal, requireUser, serviceClient } from "../_shared/client.ts";
import {
  type ChatMessageRow,
  canRecall,
  communityRefusal,
  publicChatMessage,
  RECALL_REASON_MAX,
  RECALL_WINDOW_MS,
  refusalMessage,
} from "../_shared/community.ts";

/** How many quoting rows one recall refreshes, in one pass. See the note at the patch site: this is
 *  a bound on `reply_to` fan-out, not a silent truncation — a recall that hit it would be a room
 *  where one message is quoted hundreds of times inside seven days. */
const REPLY_PATCH_BATCH = 200;

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const { caller } = auth;

    // §6.2's 封禁 and §4.2's soft delete, through the one predicate every other function uses.
    const refusal = accountRefusal(caller.row);
    if (refusal) return refusal;

    // ⚠ `NOT_ACTIVATED` ONLY — A MUTE MUST NOT STOP A RECALL, and that is a decision rather than an
    // oversight. `communityRefusal` answers both (§1.8.1's 「社区仅对已激活用户开放」 and §2.4's
    // 禁言), and its two halves mean two different things here: 未激活 is true of the account before
    // anything was ever written, while §2.4 mutes an account that HAS posted. Refusing the withdraw
    // would extend the penalty past its own sentence — 「你不能再说话了」 is not 「你刚才说的那句也不许
    // 收回」 — and the client offers 撤回 because `cmReadOnly()` asks the same one question this line
    // does (`activated_at is null`). Two halves of one predicate, asked separately on purpose.
    const community = communityRefusal(caller.row);
    if (community === "NOT_ACTIVATED") {
      return fail(community, HttpStatus.FORBIDDEN, refusalMessage(community));
    }

    // ⚠ NO `CHAT_DISABLED` GATE, UNLIKE chat-send. §2.3.2's 关闭聊天室 stops posting; withdrawing
    // is the opposite of posting, and an operator who has just shut the room is more likely to want
    // a message gone than kept. Every other gate on this table is about what ARRIVES in it.

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const rawId = body.id;
    if (typeof rawId !== "string" || rawId.trim() === "") {
      return badRequest("`id` must be a chat message id");
    }
    const id = rawId.trim();

    // §1.11.1's `recall_reason`, 「可选」. Nothing in 1.0.6's UI sends one — the author is undoing
    // their own message, not justifying it — but the column is accepted from a caller that has one
    // (a future 管理员 action) rather than being a field with no writer at all.
    let reason: string | null = null;
    const rawReason = body.reason;
    if (rawReason !== undefined && rawReason !== null) {
      if (typeof rawReason !== "string") return badRequest("`reason` must be a string");
      const trimmed = rawReason.trim();
      if (trimmed.length > RECALL_REASON_MAX) {
        return badRequest(`\`reason\` must be at most ${RECALL_REASON_MAX} characters`);
      }
      reason = trimmed === "" ? null : trimmed;
    }

    // =========================================================================================
    // 1. the row, by id
    // =========================================================================================
    const { data: found, error: readError } = await sb
      .from("chat_messages")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw readError;
    // Out of the retention window, never existed — both are 「撤回不了」 and the operator's next
    // step is the same (reload the room). Same code `chat-send` answers for a quote it cannot
    // resolve: `TARGET_NOT_FOUND` means 「你指的那一行不在」 and nothing else, in both callers.
    if (!found) {
      return fail("TARGET_NOT_FOUND", HttpStatus.NOT_FOUND, "No such message");
    }
    const row = found as ChatMessageRow;

    // =========================================================================================
    // 2. the predicate — §1.11.2, from the one home both realms share
    // =========================================================================================
    const now = Date.now();
    // `canRecall` answers all three facts at once: 是我发的 / 还没撤回过 / 在 2 分钟窗口内. The client
    // asks the same function before it draws the menu row, so 「按钮在了但服务端拒绝」 is not reachable
    // except by a clock that moved between the paint and the click.
    if (!canRecall(row, caller.id, now)) {
      // 409 rather than 403: this is the STATE of the resource (withdrawn already, or too old), not
      // the caller's identity — and the two are one answer on purpose. The only way to reach this
      // line with a message that is not yours is to call the endpoint by hand, and 「只能撤回自己 2
      // 分钟内的消息」 is one sentence that covers both halves without naming which one failed,
      // because naming it would tell a stranger whether an id exists.
      return fail("NOT_RECALLABLE", HttpStatus.CONFLICT,
        "Only your own messages, within two minutes of sending");
    }

    // =========================================================================================
    // 3. the edit, with the predicate repeated as the ATOMIC guard
    // =========================================================================================
    // ⚠ THE CUTOFF IS COMPUTED FROM `RECALL_WINDOW_MS`, NOT SPELLED AS AN INTERVAL. `db push` will
    // happily accept `created_at > now() - interval '2 minutes'`, and then 「2 分钟」 would have two
    // homes — this one and the mirrored constant `canRecall` reads — and they would disagree the
    // first time one of them was tuned. Passing the boundary in as a value keeps the number in one
    // place while still making the UPDATE self-guarding.
    //
    // ⚠ AND THE GUARD IS NOT REDUNDANT WITH THE READ ABOVE. Between the `select` and the `update`
    // another request from the same author can land (two tabs, a retry). `eq('recalled', false)`
    // makes the second one a no-op rather than a second `recalled_at`; without it the loser of that
    // race would overwrite the winner's timestamp.
    const cutoff = new Date(now - RECALL_WINDOW_MS).toISOString();
    const { data: updated, error: updateError } = await sb
      .from("chat_messages")
      .update({
        recalled: true,
        recalled_at: new Date(now).toISOString(),
        recall_reason: reason,
      })
      .eq("id", row.id)
      .eq("user_id", caller.id)
      .eq("recalled", false)
      .gte("created_at", cutoff)
      .select("*");
    if (updateError) throw updateError;
    // Zero rows = it was withdrawn, or aged out, in the milliseconds between the two statements.
    // Answered as the same refusal rather than as a success, because the row did not change.
    if (!updated || updated.length === 0) {
      return fail("NOT_RECALLABLE", HttpStatus.CONFLICT,
        "Only your own messages, within two minutes of sending");
    }

    // =========================================================================================
    // 4. §1.11.4 — 「被引用时引用卡片显示 [该消息已被撤回]」
    // =========================================================================================
    // ⚠ THIS IS THE HALF THE 定稿 DOES NOT MENTION, AND WITHOUT IT §1.11.4 IS DEAD. A quote is drawn
    // from `reply_preview`, a SNAPSHOT taken when the quoting message was sent (008's header, and
    // §1.7.4's 「冗余存储，避免每次 join」). The snapshot is not a join, so the original being
    // withdrawn does not reach it — and the case where that matters is exactly the one the snapshot
    // exists for: the reader arrives mid-history, the original is outside the loaded page, and the
    // card keeps showing 「你好」 for a message its author has withdrawn.
    //
    // ⚠ EVERY PATCHED ROW IS ITSELF PUBLISHED TO REALTIME (021 sets `replica identity full` on this
    // table), so the readers holding one of these in view repaint from the same change they would
    // have got for the original. That is also why this is a per-row write rather than one statement:
    // PostgREST has no `jsonb_set`, and reading each preview back is the only way to keep every
    // other field of the snapshot (`username`, `content`, `created_at`) exactly as it was.
    const { data: quoting, error: quotingError } = await sb
      .from("chat_messages")
      .select("id, reply_preview")
      .eq("reply_to", row.id)
      .limit(REPLY_PATCH_BATCH);
    if (quotingError) throw quotingError;

    for (const q of (quoting ?? []) as { id: string; reply_preview: unknown }[]) {
      const preview = q.reply_preview;
      if (!preview || typeof preview !== "object") continue;
      const { error: patchError } = await sb
        .from("chat_messages")
        .update({ reply_preview: { ...(preview as Record<string, unknown>), recalled: true } })
        .eq("id", q.id);
      // A quote that could not be re-marked is not a failed recall: the message IS withdrawn, and
      // failing the whole call here would tell the author their recall did not happen when it did.
      // The stale card is a cosmetic leftover with a seven-day lifetime (`CHAT_RETENTION_DAYS`).
      if (patchError) continue;
    }

    // =========================================================================================
    // 5. the answer carries the stored row
    // =========================================================================================
    // Same contract as `chat-send`: the author's own view is rendered from this answer rather than
    // from a Realtime round trip, which may never arrive in the polling fallback. `recalled_at` is
    // the value the UPDATE wrote, read back rather than echoed, so what the client draws and what
    // the row says cannot differ.
    return json({ ok: true, message: publicChatMessage(updated[0] as ChatMessageRow) });
  } catch (_e) {
    return fail("INTERNAL", HttpStatus.INTERNAL_SERVER_ERROR, "Recall failed");
  }
});
