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

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const wantsAll = body.all === true;
    const hasList = Array.isArray(body.codes);

    if (wantsAll && hasList) return badRequest("Pass either all or codes, not both");
    if (!wantsAll && !hasList) return badRequest("Pass either all: true or a codes array");

    if (wantsAll) {
      const { data: updated, error } = await sb
        .from("activation_codes")
        .update({ revoked: true })
        .eq("revoked", false)
        .is("redeemed_by", null) // redeemable, unused codes only
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
      .update({ revoked: true })
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
