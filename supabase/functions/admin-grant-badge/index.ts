// admin-grant-badge -- attach a badge to a user.
//
// POST { user_id, badge_type }   Authorization: Bearer <jwt>
//   -> 200 { ok: true }
//
// Admin only. Idempotent: the badges table is unique on (user_id, badge_type), and the
// upsert is told to ignore duplicates, so granting the same badge twice is a no-op that
// still returns ok. The catalog of valid badge_type values lives in the client (it is a
// presentation concern); the server enforces only that the value is a sane identifier.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";

const BADGE_TYPE_MAX = 64;
const BADGE_TYPE_RE = /^[a-z0-9][a-z0-9._-]*$/;

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();

    const auth = await requireAdmin(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const userId = body.user_id;
    if (typeof userId !== "string" || userId.trim() === "") {
      return badRequest("Missing user_id");
    }

    const badgeType = typeof body.badge_type === "string" ? body.badge_type.trim().toLowerCase() : "";
    if (badgeType === "" || badgeType.length > BADGE_TYPE_MAX || !BADGE_TYPE_RE.test(badgeType)) {
      return badRequest("Invalid badge_type");
    }

    // Surface a clean NOT_FOUND instead of a foreign-key violation.
    const { data: user, error: userError } = await sb
      .from("users")
      .select("id")
      .eq("id", userId)
      .maybeSingle();
    if (userError) throw userError;
    if (!user) return fail("NOT_FOUND", 404, "User not found");

    const { error: upsertError } = await sb
      .from("badges")
      .upsert(
        { user_id: userId, badge_type: badgeType, granted_by: caller.id },
        { onConflict: "user_id,badge_type", ignoreDuplicates: true },
      );
    if (upsertError) throw upsertError;

    return json({ ok: true });
  } catch (err) {
    console.error("admin-grant-badge failed:", err);
    return internal("Could not grant badge");
  }
});
