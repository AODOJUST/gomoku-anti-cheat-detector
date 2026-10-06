// wanted-follow — 1.0.7 §2.1.7's 「跟踪」, and the only writer of `follower_count`.
//
// POST { wanted_id, follow: boolean }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, following, follower_count }
//   -> 400 { error: 'BAD_REQUEST' }   missing id / follow is not a boolean
//   -> 403 { error: 'NOT_ACTIVATED' | 'MUTED' }
//   -> 404 { error: 'NOT_FOUND' }     no such entry, or it is not public
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// ⚠⚠ `follower_count` IS DERIVED, AND THIS FUNCTION IS WHERE THAT RULE IS KEPT
// ---------------------------------------------------------------------------------------------
// §2.1.2's `follower_count` is a redundant column (§2.1.7: 「follower_count 冗余更新」) because the wall
// draws 「👥 12 人跟踪」 on every card and a count per card is a query per card. Redundant columns
// become two answers to one question, and this project has paid for that six times, so the rule is
// written into 026's header and obeyed here in the one writer:
//
//     `wanted_followers` is the AUTHORITY; `follower_count` is recomputed from it with count(*).
//
// ⚠ NOT `+= 1` / `-= 1`, AND NOT A TRIGGER. An arithmetic counter drifts the first time two requests
// interleave — the classic read-modify-write the chat counter already documents — and the drift is
// invisible until someone counts by hand. A trigger would fix the drift and would put this rule in a
// second place (26x plus a function), where `wanted-add-evidence`'s or a future admin tool's writes
// would have to remember it.
//
// ⚠ THE RECOMPUTE IS UNCONDITIONAL, EVEN WHEN NOTHING CHANGED. A second press on 跟踪 is a no-op
// against `unique (wanted_id, user_id)`, and the count is read anyway: repairing a count that drifted
// before this release, or that a manual SQL edit broke, is worth one `count(*)` on a button press.
//
// ---------------------------------------------------------------------------------------------
// ONLY AN APPROVED ENTRY CAN BE FOLLOWED
// ---------------------------------------------------------------------------------------------
// §2.1.7 is placed under §2.1.6's 「通过后公开，其他用户可跟踪 + 补充证据」, and the read predicate 026
// defines agrees: `wanted_visible()` is true for an approved entry, its submitter, or an admin.
// ⚠ THE FUNCTION TESTS `status = 'approved'` DIRECTLY AND DOES NOT CALL `wanted_visible()`, because
// `wanted_visible` is a READ predicate written for a row the caller can already see — it answers 「可以
// 读吗」 — while this is a WRITE gate answering 「可以跟踪吗」, and only one of the three arms of the
// read predicate should be able to follow. A submitter following their own pending entry would put a
// follower behind an entry that may never be approved; an admin following it would do the same.
//
// 404 rather than 403 for a non-public entry: whether a pending accusation exists is exactly what
// §2.1.6's moderation gate keeps out of circulation, and 「没有权限」 would confirm it.

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
import { communityRefusal, refusalMessage } from "../_shared/community.ts";

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

    const wantedId = typeof body.wanted_id === "string" ? body.wanted_id.trim() : "";
    if (!wantedId) return badRequest("Missing wanted_id");
    if (typeof body.follow !== "boolean") return badRequest("follow must be a boolean");
    const follow = body.follow;

    const { data: entry, error: findError } = await sb
      .from("wanted_players")
      .select("id, status, follower_count")
      .eq("id", wantedId)
      .maybeSingle();
    if (findError) throw findError;
    if (!entry || entry.status !== "approved") {
      return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such entry");
    }

    if (follow) {
      // `upsert` with `ignoreDuplicates` rather than an insert that may raise 23505: 「我已经关注了」
      // is not a failure, and the button is drawn from state the client may have fetched a minute ago.
      const { error } = await sb
        .from("wanted_followers")
        .upsert(
          { wanted_id: entry.id, user_id: caller.id },
          { onConflict: "wanted_id,user_id", ignoreDuplicates: true },
        );
      if (error) throw error;
    } else {
      const { error } = await sb
        .from("wanted_followers")
        .delete()
        .eq("wanted_id", entry.id)
        .eq("user_id", caller.id);
      if (error) throw error;
    }

    // ---- the derived count (see the header) ---------------------------------------------------
    const { count, error: countError } = await sb
      .from("wanted_followers")
      .select("id", { count: "exact", head: true })
      .eq("wanted_id", entry.id);
    if (countError) throw countError;
    const followerCount = count ?? 0;

    const { error: patchError } = await sb
      .from("wanted_players")
      .update({ follower_count: followerCount })
      .eq("id", entry.id);
    if (patchError) throw patchError;

    return json({ ok: true, following: follow, follower_count: followerCount });
  } catch (err) {
    console.error("wanted-follow failed:", err);
    return internal("Could not change the follow state");
  }
});
