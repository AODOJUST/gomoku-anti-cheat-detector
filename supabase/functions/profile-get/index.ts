// profile-get -- the caller's own profile plus a small dashboard payload.
//
// GET or POST   Authorization: Bearer <jwt>
//   -> 200 { user, sampleCount, badges, achievements, accuracy, friends }
//
// Reads only the caller's own data: sampleCount is a count over their non-deleted
// samples, and RLS would enforce the same scope even if this ran with the user's token
// instead of the service role.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { internal, json, methodNotAllowed, unauthorized } from "../_shared/errors.ts";
import { requireUser, serviceClient, toPublicUser } from "../_shared/client.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST" && req.method !== "GET") {
    // Both verbs are allowed here; anything else is a client bug.
    return methodNotAllowed();
  }

  try {
    const sb = serviceClient();

    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    if (!caller.row) return unauthorized("Account not found");
    if (caller.deletedAt) return unauthorized("Account has been deleted");

    const { count, error: countError } = await sb
      .from("samples")
      .select("id", { count: "exact", head: true })
      .eq("user_id", caller.id)
      .is("deleted_at", null);
    if (countError) throw countError;

    // §5.2 of the product spec reserves badges / achievements / accuracy / friends for a
    // later release. They are returned as empty placeholders -- NOT omitted -- because the
    // client renders each one greyed out with a "coming soon" label and distinguishes
    // "reserved, empty" from "field missing". Keep them as [] / null until the features
    // actually ship; the badges table already exists for the admin grant path.
    return json({
      user: toPublicUser(caller.row),
      sampleCount: count ?? 0,
      badges: [],
      achievements: [],
      accuracy: null,
      friends: [],
    });
  } catch (err) {
    console.error("profile-get failed:", err);
    return internal("Could not load profile");
  }
});
