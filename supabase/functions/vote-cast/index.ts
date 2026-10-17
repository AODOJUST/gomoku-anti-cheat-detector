// vote-cast — §1.4.5 「已激活且未禁言的用户可投票」, plus §1.4.4's 「[关闭投票]」.
//
// POST { vote_id, choice }               Authorization: Bearer <jwt>
// POST { action: 'close', vote_id }      the poll's creator only
//   -> 200 { ok: true, tally: { 'black-ai': 3, ... }, total }
//   -> 400 { error: 'BAD_REQUEST' }      bad/absent choice (not one of §1.4.2's four)
//   -> 403 { error: 'NOT_ACTIVATED' | 'MUTED' }
//   -> 403 { error: 'FORBIDDEN' }        close, by someone other than the creator
//   -> 404 { error: 'NOT_FOUND' }        no such poll
//   -> 409 { error: 'VOTE_CLOSED' }      §1.4.2 「24 小时 或 发布者手动关闭」
//   -> 409 { error: 'VOTE_ALREADY_CAST' }§1.4.3 「一人一票」
//
// ---------------------------------------------------------------------------------------------
// WHY THE TALLY COMES BACK FROM THE VIEW, AND NOT FROM A COUNT OF BALLOTS
// ---------------------------------------------------------------------------------------------
// `public.vote_tally` (007_votes.sql) is a `security_invoker = false` view: it aggregates as its
// owner, so it can count rows that `vote_ballots`' RLS hides, and it exposes only
// `(vote_id, choice, n)`. That is what makes §七.3's 「匿名投票，仅显示票数」 structural rather than
// a promise — there is no code path, here or in the client, that can read a ballot other than its
// own.
//
// ⇒ The response carries the FRESH tally so the caster sees their own vote land without a second
// round trip, exactly as `chat-send` echoes the stored row. The client must not also apply its own
// optimistic +1: it would be added to the server's number and count that vote twice.
//
// ⚠ §1.4.5's sample policy ALSO tested `votes.closed_manually = false and votes.closes_at >
// now()`. Those two checks are here instead, because this release ships no INSERT policy at all
// (011's header). Both are still made — a closed poll is refused with `VOTE_CLOSED` — they are just
// made where the rest of the write path is.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  badRequest,
  fail,
  forbidden,
  HttpStatus,
  internal,
  json,
  methodNotAllowed,
} from "../_shared/errors.ts";
import { accountRefusal, requireUser, serviceClient } from "../_shared/client.ts";
import {
  communityRefusal,
  isVoteOpen,
  refusalMessage,
  type VoteRow,
  VOTE_CHOICES,
  voteTally,
} from "../_shared/community.ts";

/** Read the four counts for one poll. One helper, because both verbs answer with a tally. */
async function tallyFor(
  sb: ReturnType<typeof serviceClient>,
  voteId: string,
): Promise<{ tally: Record<string, number>; total: number }> {
  const { data, error } = await sb
    .from("vote_tally")
    .select("choice, n")
    .eq("vote_id", voteId);
  if (error) throw error;
  const tally = voteTally(data ?? []);
  let total = 0;
  for (const key of Object.keys(tally)) total += tally[key];
  return { tally, total };
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

    const refusal = accountRefusal(caller.row);
    if (refusal) return refusal;

    // §1.8.1 「投票 ❌ 未激活」 and §1.4.5's 「未禁言」 — the same predicate as every other write.
    const community = communityRefusal(caller.row);
    if (community) return fail(community, HttpStatus.FORBIDDEN, refusalMessage(community));

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const voteId = typeof body.vote_id === "string" ? body.vote_id.trim() : "";
    if (!voteId) return badRequest("Missing vote_id");

    const { data: found, error: findError } = await sb
      .from("votes")
      .select("*")
      .eq("id", voteId)
      .maybeSingle();
    if (findError) throw findError;
    if (!found) return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such poll");
    const vote = found as VoteRow;

    // §1.4.2's window, in one predicate: a poll is open while it has neither been closed by hand
    // nor run past its 24 hours. Checked for BOTH verbs — closing an expired poll is harmless but
    // pointless, and answering it the same way keeps the client's branch table smaller.
    // ⚠ Through `isVoteOpen`, not inline: §1.4.2 also governs `vote-create`'s 「已经有一个投票」 and
    // the client's countdown, and three spellings of one rule is how they drift apart.
    const open = isVoteOpen(vote);

    // =========================================================================================
    // close — §1.4.4 「[关闭投票]（发布者可见）」
    // =========================================================================================
    if (body.action === "close") {
      if (vote.creator_id !== caller.id) {
        // 403 rather than 404 here, unlike the friendship endpoints: a poll is PUBLIC (eleven
        // members can read the row), so 「这个投票存在」 is not a secret and answering 「不存在」
        // would contradict what the caller is looking at.
        return forbidden("Only the poll's creator may close it");
      }
      // Idempotent: closing a closed poll reports the state it is in.
      if (!open) {
        const current = await tallyFor(sb, vote.id);
        return json({ ok: true, vote, ...current });
      }
      const { data: closed, error: closeError } = await sb
        .from("votes")
        .update({ closed_manually: true })
        .eq("id", vote.id)
        .select("*")
        .single();
      if (closeError) throw closeError;
      const closedTally = await tallyFor(sb, vote.id);
      return json({ ok: true, vote: closed, ...closedTally });
    }

    // =========================================================================================
    // cast
    // =========================================================================================
    const choice = typeof body.choice === "string" ? body.choice : "";
    if (VOTE_CHOICES.indexOf(choice) === -1) {
      return badRequest(`choice must be one of: ${VOTE_CHOICES.join(", ")}`);
    }

    if (!open) {
      return fail("VOTE_CLOSED", HttpStatus.CONFLICT, "This poll is closed");
    }

    // §1.4.3 「一人一票」. Probed before the insert so the caller gets a sentence instead of a 23505
    // — and the unique constraint is kept as the backstop for the race this probe cannot see. ⚠ A
    // ballot is never UPDATED (that would be the third answer to 「他投了什么」): changing your mind
    // is not in §1.4.
    const { data: mine, error: mineError } = await sb
      .from("vote_ballots")
      .select("id")
      .eq("vote_id", vote.id)
      .eq("user_id", caller.id)
      .maybeSingle();
    if (mineError) throw mineError;
    if (mine) {
      return fail("VOTE_ALREADY_CAST", HttpStatus.CONFLICT, "You have already voted");
    }

    const { error: insertError } = await sb
      .from("vote_ballots")
      .insert({ vote_id: vote.id, user_id: caller.id, choice });
    if (insertError) throw insertError;

    const { tally, total } = await tallyFor(sb, vote.id);
    return json({ ok: true, tally, total });
  } catch (err) {
    console.error("vote-cast failed:", err);
    return internal("Could not record the vote");
  }
});
