// auth-change-password -- §3.7 修改密码.
//
// POST { currentPassword, newPassword }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, revoked: true }
//
// The current password is verified SERVER-SIDE, by GoTrue, because a client-side check would be
// theatre: the old password is precisely what an attacker who holds a stolen session does not
// have. `anonClient().auth.signInWithPassword` is that verification — and it hands back the GoTrue
// user id in the same round trip, which is what `admin.updateUserById` needs (see below).
//
// ---------------------------------------------------------------------------------------------
// 「撤销所有设备 JWT」 — §3.7 suggests it, and this implements it
// ---------------------------------------------------------------------------------------------
// §3.7: 「建议撤销——密码修改通常是安全事件，应让所有设备重新登录」. The tokens here are stateless
// HS256 with no denylist, so the revocation is a counter: `users.token_epoch` is bumped, every
// token minted at the old epoch stops passing `requireUser`, and the client that made this call
// logs out locally to match (its own token just died — see `GMProfile.changePassword`).
//
// `revoked: true` is in the response so the client does not have to assume it. §3.7 floats
// 「或提供『仅本设备保持登录』的选项」; a deployment that later offers that option changes this one
// field, and the client's message follows from it rather than from a hardcoded sentence.
//
// WHY THE GoTrue ID COMES FROM THE SIGN-IN AND NOT FROM THE ROW: for every account 1.0.1 creates
// they are the same uuid, but a 1.0.0 activation account has no `auth.users` row at all, and an
// account an admin created by hand has one with an unrelated id. Asking GoTrue who it just
// authenticated is correct in all three cases; asking our row would be a guess that happens to be
// right most of the time.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { anonClient, passwordOk, requireUser, serviceClient } from "../_shared/client.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    if (typeof body.currentPassword !== "string" || body.currentPassword === "") {
      return fail("BAD_CREDENTIALS", 401, "Current password is required");
    }
    if (typeof body.newPassword !== "string" || !passwordOk(body.newPassword)) {
      return fail("WEAK_PASSWORD", 400, "Password must be at least 8 characters with letters and digits");
    }

    const sb = serviceClient();
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    // `requireUser` refuses a token whose `public.users` row is gone, so `caller.row` is set here.
    const email = caller.email;
    if (!email) {
      // Reachable: 1.0.0's `auth-activate` accepts an activation with no email address. There is no
      // credential to change and no address to verify one against — 更换邮箱 is the door that gives
      // this account a login identity.
      return fail("BAD_EMAIL", 400, "This account has no email address yet — set one first");
    }

    const { data: signedIn, error: signInError } = await anonClient().auth.signInWithPassword({
      email,
      password: body.currentPassword,
    });
    if (signInError || !signedIn?.user) {
      return fail("BAD_CREDENTIALS", 401, "The current password is wrong");
    }

    const { error: updateError } = await sb.auth.admin.updateUserById(signedIn.user.id, {
      password: body.newPassword,
    });
    if (updateError) throw updateError;

    // The counter that makes a stateless token revocable. Read-modify-write on the value
    // `requireUser` just handed us, so there is no extra query to disagree with.
    const nextEpoch = Number(caller.row?.token_epoch ?? 0) + 1;
    const { error: epochError } = await sb
      .from("users")
      .update({ token_epoch: nextEpoch })
      .eq("id", caller.id);
    if (epochError) throw epochError;

    console.log(`audit: user ${caller.id} changed their password; epoch -> ${nextEpoch}`);

    return json({ ok: true, revoked: true });
  } catch (err) {
    console.error("auth-change-password failed:", err);
    return internal("Could not change the password, please try again");
  }
});
