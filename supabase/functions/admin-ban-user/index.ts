// admin-ban-user -- block an account from activating / renewing.
//
// POST { user_id, reason? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true }
//
// Admin only, and an admin may not ban themselves -- that is the single most likely way
// to lock every operator out of the console. `reason` is recorded as an audit log line:
// the schema specified for this product has no ban_reason column, and adding one is out
// of scope, so the Edge Function log (visible in the Supabase dashboard) is the audit
// trail rather than a silent drop.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";

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
    if (userId === caller.id) {
      return badRequest("You cannot ban your own account");
    }

    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;

    const { data: updated, error } = await sb
      .from("users")
      .update({ is_banned: true })
      .eq("id", userId)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length !== 1) {
      return fail("NOT_FOUND", 404, "User not found");
    }

    console.log(
      `audit: admin ${caller.id} banned user ${userId}` +
        (reason ? ` reason=${JSON.stringify(reason)}` : ""),
    );

    return json({ ok: true });
  } catch (err) {
    console.error("admin-ban-user failed:", err);
    return internal("Could not ban user");
  }
});
