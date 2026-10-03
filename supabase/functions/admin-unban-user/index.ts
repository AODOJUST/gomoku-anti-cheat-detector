// admin-unban-user -- lift a ban.
//
// POST { user_id }   Authorization: Bearer <jwt>
//   -> 200 { ok: true }
//
// Admin only. Deliberately has no "cannot unban yourself" guard: lifting a ban is the
// safe direction, and the guard on admin-ban-user already means an admin can never have
// banned themselves in the first place.

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

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const userId = body.user_id;
    if (typeof userId !== "string" || userId.trim() === "") {
      return badRequest("Missing user_id");
    }

    const { data: updated, error } = await sb
      .from("users")
      .update({ is_banned: false })
      .eq("id", userId)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length !== 1) {
      return fail("NOT_FOUND", 404, "User not found");
    }

    return json({ ok: true });
  } catch (err) {
    console.error("admin-unban-user failed:", err);
    return internal("Could not unban user");
  }
});
