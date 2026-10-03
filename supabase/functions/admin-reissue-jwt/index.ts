// admin-reissue-jwt -- mint a fresh session for another user, on an admin's authority.
//
// POST { user_id }   Authorization: Bearer <jwt>
//   -> 200 { jwt, expiresAt }
//
// This is the documented account-recovery path for the worst case: the user has lost
// their activation code AND cannot reach the mailbox on the account, so neither
// auth-activate (no code) nor a future email flow can help them. An administrator who
// has verified the person's identity out of band issues them a fresh 30-day session.
//
// It is deliberately admin-only, and it is the ONLY place in this codebase where a JWT
// is minted for somebody other than the caller. Every call re-verifies the admin's own
// JWT and database-side is_admin flag first.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, HttpStatus, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  accountRefusal,
  requireAdmin,
  serviceClient,
  SESSION_DAYS,
  signJwt,
  type UserRow,
} from "../_shared/client.ts";

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

    const { data: found, error } = await sb
      .from("users")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw error;
    const target = (found as UserRow | null) ?? null;

    // Handing a session to a banned or deleted account would defeat both features. The verdicts come
    // from `accountRefusal` — shared with the four session paths — with the 404 wording, because
    // here the account was NAMED by an operator rather than presented as a credential, so a miss is
    // a lookup that failed rather than an authentication that failed.
    const refusal = accountRefusal(target, HttpStatus.NOT_FOUND);
    if (refusal) return refusal;

    // Signed exactly like a normal session (HS256 with SUPABASE_JWT_SECRET, see
    // _shared/client.ts) -- there is no privileged "admin token" baked in here, so the
    // issued token grants the target user only their ordinary access.
    const { jwt, expiresAt } = await signJwt(
      { id: target.id, email: target.email, epoch: target.token_epoch },
      SESSION_DAYS,
    );

    console.log(`audit: admin ${caller.id} reissued a JWT for user ${target.id}`);

    return json({ jwt, expiresAt });
  } catch (err) {
    console.error("admin-reissue-jwt failed:", err);
    return internal("Could not reissue session");
  }
});
