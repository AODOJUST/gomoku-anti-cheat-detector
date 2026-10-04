// vote-create — §1.4.1 「发布者在发送存档或样本时可勾选「启用投票」」.
//
// POST { target_kind, target_cloud_id }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, vote, created }     `created: false` when one already existed
//   -> 400 { error: 'BAD_REQUEST' }        bad/absent target_kind
//   -> 403 { error: 'NOT_ACTIVATED' | 'MUTED' }   §1.8.1 「投票 ❌ 未激活」
//   -> 403 { error: 'FORBIDDEN' }          not the account that shared the target
//   -> 404 { error: 'TARGET_NOT_FOUND' }   the cloud copy is gone or expired
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// §1.4 / §七.5 「仅对云端分享的存档/样本生效，本地存档不参与」
// ---------------------------------------------------------------------------------------------
// The target is therefore a row of `cloud_shares` (008_community_ext.sql) — the cloud copy a member
// put in the room — and NOT an id from `public.archives` / `public.samples`. That is not a
// technicality: those two tables are per-user under `archives_select_self` / `samples_select_self`,
// so a poll attached to one of their ids would be a poll every voter can see and nobody can open,
// and the id would mean a different row on every machine.
//
// ⚠ THE TARGET IS CHECKED FOR LIVENESS, not just for existence. §1.1.2 gives a room share 7 days;
// a poll on an expired one would still render (the `votes` row is independent) and every 「查看」
// would fail — a broken card that looks like a rendering bug.
//
// ⚠ OWNERSHIP IS `cloud_shares.owner_id = auth.uid()`, and it is the only thing standing between
// 「发布者发起投票」 and 「任何人都能对别人的存档发起投票」 (§1.4.1's alternative path — 「其他用户提醒
// 请求发布者发起（通过社区消息）」 — is exactly a REQUEST, i.e. a message, not this endpoint).

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
  isShareLive,
  refusalMessage,
  VOTE_TARGET_KINDS,
  type VoteRow,
} from "../_shared/community.ts";

/**
 * §1.4.3's `target_kind` — and it is DELIBERATELY NARROWER than `SHARE_KINDS`.
 *
 * ⚠ 1.0.2's comment here said 「Mirrors `cloud_shares_kind_known` (008)」, which stopped being true
 * the moment 015 let that constraint take 配置. A poll asks the community to judge a REPLAY or a
 * SAMPLE; a 配置包 is a settings bundle with nothing to vote on, and the client disables the 投票
 * checkbox for it.
 *
 * ⚠ 1.0.4 — THE LIST MOVED INTO THE SHARED BLOCK (`VOTE_TARGET_KINDS`, with `isVotableKind()`), so
 * the picker, the room's per-card vote slot and this Function answer 「这个附件能投票吗」 the same
 * way. It is not a copy of the share vocabulary, and it is not a second opinion either.
 */
const TARGET_KINDS = VOTE_TARGET_KINDS;

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

    const community = communityRefusal(caller.row);
    if (community) return fail(community, HttpStatus.FORBIDDEN, refusalMessage(community));

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const kind = typeof body.target_kind === "string" ? body.target_kind : "";
    if (TARGET_KINDS.indexOf(kind) === -1) {
      return badRequest(`target_kind must be one of: ${TARGET_KINDS.join(", ")}`);
    }
    const cloudId = typeof body.target_cloud_id === "string" ? body.target_cloud_id.trim() : "";
    if (!cloudId) return badRequest("Missing target_cloud_id");

    const { data: target, error: targetError } = await sb
      .from("cloud_shares")
      .select("id, owner_id, kind, expires_at")
      .eq("id", cloudId)
      .maybeSingle();
    if (targetError) throw targetError;

    // Gone, expired, or a kind that does not match what the caller claims it is. The last one is
    // checked because `votes.target_kind` is denormalised (007): a poll that says 'archive' about a
    // sample would pick the wrong label on the card.
    // ⚠ `isShareLive` rather than an inline `Date.parse`: `cloud_shares` and `friend_shares` carry
    // the same `expires_at`-in-the-future rule, only with different windows (7 days vs 15 minutes),
    // and the predicate itself is one answer.
    if (!target || target.kind !== kind || !isShareLive(target)) {
      return fail("TARGET_NOT_FOUND", HttpStatus.NOT_FOUND, "No such shared item");
    }
    if (target.owner_id !== caller.id) {
      return forbidden("Only the account that shared this item may open a poll");
    }

    // Idempotent rather than 409. §1.4.1 puts 「启用投票」 on the send flow, and a client that
    // retried after a timeout has no way to know whether the first call landed — answering 「已存在」
    // as an error would leave the poll on screen with no id to cast against. Returning the existing
    // row with `created: false` lets the caller carry on either way. 007's
    // `idx_votes_target` unique index is the backstop for the race this probe misses.
    const { data: existing, error: existingError } = await sb
      .from("votes")
      .select("*")
      .eq("target_kind", kind)
      .eq("target_cloud_id", cloudId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      return json({ ok: true, vote: existing, created: false });
    }

    const { data, error } = await sb
      .from("votes")
      .insert({
        target_kind: kind,
        target_cloud_id: cloudId,
        creator_id: caller.id,
      })
      .select("*")
      .single();
    if (error) throw error;

    return json({ ok: true, vote: data as VoteRow, created: true });
  } catch (err) {
    console.error("vote-create failed:", err);
    return internal("Could not open the poll");
  }
});
