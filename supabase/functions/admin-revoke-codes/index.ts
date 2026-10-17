// admin-revoke-codes -- revoke activation codes in bulk.
//
// POST { codes: [...] } or { all: true }   Authorization: Bearer <jwt>
//   -> 200 { revoked: N }
//
// Admin only. `revoked: N` is the number of codes this call actually flipped (already
// revoked codes are excluded), so the console can report "N codes revoked" honestly
// even if the same batch is submitted twice.
//
// Why `{ all: true }` skips redeemed codes: revoking a code that has already been used
// does not un-issue anything -- the account keeps working and the code remains the
// historical proof of that activation. Killing a *redeemed* credential is the job of a
// separate re-issue flow (see admin-reissue-jwt for the recovery half of it); this
// endpoint only retires codes that are still sitting unused.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";
import { normalizeCode } from "../_shared/codes.ts";

const MAX_CODES_PER_CALL = 1000;

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();

    const auth = await requireAdmin(req, sb);
    if (auth.response) return auth.response;

    // 1.0.6 四号 §2.4.3 — 「撤销时间 / 撤销者」 travel with the flip, in the SAME UPDATE that sets
    // `revoked = true`, so the three columns cannot disagree about who retired a code and when. ⚠ ONE
    // of the two UPDATEs below (the console's per-row 「撤销」) is why this exists at all: before 025 the
    // action recorded only that the code was dead, and an operator reading a revoked code could not
    // tell their own revocation from one somebody else did months ago.
    const revokedAt = new Date().toISOString();
    const revokedBy = auth.caller.id;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const wantsAll = body.all === true;
    const hasList = Array.isArray(body.codes);

    if (wantsAll && hasList) return badRequest("Pass either all or codes, not both");
    if (!wantsAll && !hasList) return badRequest("Pass either all: true or a codes array");

    if (wantsAll) {
      const { data: updated, error } = await sb
        .from("activation_codes")
        .update({ revoked: true, revoked_at: revokedAt, revoked_by: revokedBy })
        .eq("revoked", false)
        // ⚠ 1.0.5 审计 P2 — 「还没被用」 is `redeemed`, not `redeemed_by is null`. The two were one
        // column until 020, and they still agree for every code that has an owner; they stop agreeing
        // the moment a redeemer's account is purged, which nulls `redeemed_by` and would have made
        // 「撤销所有未使用的码」 also revoke codes that were already spent.
        .eq("redeemed", false) // redeemable, unused codes only
        .select("code");
      if (error) throw error;
      return json({ revoked: (updated ?? []).length });
    }

    const rawList = body.codes as unknown[];
    if (rawList.length === 0) return badRequest("codes array is empty");
    if (rawList.length > MAX_CODES_PER_CALL) {
      return badRequest(`at most ${MAX_CODES_PER_CALL} codes per call`);
    }
    const codes: string[] = [];
    for (const entry of rawList) {
      if (typeof entry !== "string" || entry.trim() === "") {
        return badRequest("codes must be non-empty strings");
      }
      codes.push(normalizeCode(entry));
    }

    const { data: updated, error } = await sb
      .from("activation_codes")
      .update({ revoked: true, revoked_at: revokedAt, revoked_by: revokedBy })
      .in("code", codes)
      .eq("revoked", false)
      .select("code");
    if (error) throw error;

    return json({ revoked: (updated ?? []).length });
  } catch (err) {
    console.error("admin-revoke-codes failed:", err);
    return internal("Could not revoke activation codes");
  }
});
