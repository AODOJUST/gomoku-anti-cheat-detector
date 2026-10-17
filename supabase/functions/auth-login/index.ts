// auth-login -- §2.6 已有账户的登录.
//
// POST { email, password, deviceId, userAgent?, release? }
//   -> 200 { jwt, expiresAt, user }
//
// Reached from 「已有账户？点此登录」 on the activation screen, and from 忘记密码's 「重置后请重新登录」.
//
// `release` is optional and is §7.5 续's escape hatch: the row id of one of the caller's OWN devices,
// deleted before the device limit is consulted. See 「WHY THE RELEASE IS ISSUED FROM HERE」 below.
//
// ---------------------------------------------------------------------------------------------
// THE SPLIT THIS FUNCTION EXISTS TO KEEP
// ---------------------------------------------------------------------------------------------
// GoTrue owns the CREDENTIAL (this is the only place, with `auth-change-password`, that hands a
// password to it). This backend owns the SESSION (the JWT is minted by `signJwt`, carries the §3.7
// `epoch`, and is verified by `requireUser`). So the password check is GoTrue's answer, and
// everything after it — is the account banned? deleted? how many devices? — is ours.
//
// ---------------------------------------------------------------------------------------------
// WHY THE ROW IS FOUND BY EMAIL AND NOT BY GoTrue's USER ID
// ---------------------------------------------------------------------------------------------
// They are the same uuid for every account 1.0.1 creates (`auth-register` inserts the `createUser`
// id), but they are NOT the same in the two populations that predate it: an account created by
// 1.0.0's `auth-activate` has no `auth.users` row at all, and an account an administrator created
// by hand in the dashboard has one with an unrelated id. The email is the login identifier in all
// three cases and it is what the operator typed, so it is what we look the account up by — and the
// session we mint always carries `public.users.id`, which is what every other endpoint keys on.
//
// A wrong password and an unknown address both answer BAD_CREDENTIALS: telling them apart would let
// anyone enumerate which addresses have accounts here, one HTTP request at a time.
//
// ---------------------------------------------------------------------------------------------
// WHY THE RELEASE IS ISSUED FROM HERE (1.0.7 续)
// ---------------------------------------------------------------------------------------------
// §7.5's release path lives in 账号设置, which needs a SESSION — and the refusal it exists to resolve
// is hit HERE, at the login screen, by someone who has none. The door was on the wrong side of the
// wall: 「已达设备数上限」 was a dead end for the operator who reported 「只用了 iPad 和电脑两台设备」,
// because they could not sign in to reach the screen that would have freed a slot.
//
// So the same request that proves the password may also carry `release`. The flow is one round trip
// longer, not one credential more:
//   · the refusal from `touchDevice` answers the caller's device list (that is where the list comes
//     from — this function adds no endpoint and no query of its own);
//   · the operator picks a row they no longer use and the client resubmits the SAME email+password
//     with `release` attached;
//   · the row is deleted by the one shared `releaseDeviceRow`, and the login completes.
//
// ⚠ THE PASSWORD IS THE WHOLE AUTHORISATION for it. Nothing new is trusted here: GoTrue has already
// answered 「这个密码对吗」 two blocks above, and the delete is scoped to the account that password
// belongs to. A second password-consuming endpoint was the alternative and was rejected — two doors
// that accept credentials are two places to get the rate limiting, the logging and the wording wrong.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, HttpStatus, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  accountRefusal,
  anonClient,
  EMAIL_RE,
  releaseDeviceRow,
  serviceClient,
  SESSION_DAYS,
  signJwt,
  toPublicUser,
  touchDevice,
  type UserRow,
} from "../_shared/client.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim().toLowerCase())) {
      return fail("BAD_EMAIL", 400, "Invalid email address");
    }
    const email = body.email.trim().toLowerCase();

    if (typeof body.password !== "string" || body.password === "") {
      return fail("BAD_CREDENTIALS", 401, "Wrong email or password");
    }
    const password = body.password;

    if (typeof body.deviceId !== "string" || body.deviceId.trim() === "" || body.deviceId.length > 256) {
      return badRequest("Missing or invalid deviceId");
    }
    const deviceId = body.deviceId.trim();
    const userAgent = typeof body.userAgent === "string"
      ? body.userAgent.slice(0, 512)
      : (req.headers.get("user-agent") ?? "").slice(0, 512);

    // --- 1. the credential is GoTrue's to judge ----------------------------------------------
    const { data: signedIn, error: signInError } = await anonClient().auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signedIn?.user) {
      // The real reason goes to the log, never to the caller: 「Invalid login credentials」,
      // 「Email not confirmed」 and 「User not found」 are one answer from the outside.
      console.warn(`auth-login: refused ${email}: ${signInError?.message ?? "no user"}`);
      return fail("BAD_CREDENTIALS", 401, "Wrong email or password");
    }

    // --- 2. everything else is ours ----------------------------------------------------------
    const sb = serviceClient();
    const { data: found, error: lookupError } = await sb
      .from("users")
      .select("*")
      .eq("email", email)
      .maybeSingle();
    if (lookupError) throw lookupError;
    const userRow = (found as UserRow | null) ?? null;

    // A GoTrue identity with no detector account: an administrator made one by hand, or a
    // registration was rolled back after this half. Either way there is no account to sign into,
    // and the password has already been proven, so naming the problem leaks nothing.
    if (!userRow) {
      return fail("NOT_FOUND", 404, "This email address has no 白身 account");
    }

    const refusal = accountRefusal(userRow);
    if (refusal) return refusal;

    // --- 3. the device, then the session -----------------------------------------------------
    // ⚠⚠ 1.0.7 续 —— THE RELEASE IS CONSUMED HERE, BEFORE THE LIMIT IS CONSULTED. The password has
    // been proven; if the caller also named one of their own device rows, it is deleted first, so
    // the `touchDevice` below sees the freed slot. See 「WHY THE RELEASE IS ISSUED FROM HERE」.
    //
    // ⚠ A RELEASE THAT IS NOT THE CALLER'S IS REFUSED RATHER THAN IGNORED. `releaseDeviceRow` answers
    // `foreign` for a row that exists and belongs to somebody else, and silence would be the worst
    // reading of it: the caller would be told 「已达上限」 again with no idea that the id they sent was
    // not theirs. `invalid` is a client bug and is named as one.
    const release = typeof body.release === "string" ? body.release.trim() : "";
    if (release !== "") {
      const outcome = await releaseDeviceRow(sb, userRow.id, release);
      if (outcome === "invalid") return badRequest("Missing or invalid device id");
      if (outcome === "foreign") return fail("FORBIDDEN", HttpStatus.FORBIDDEN, "Not your device");
    }

    const limitHit = await touchDevice(sb, userRow.id, deviceId, userAgent);
    if (limitHit) return limitHit;

    const { jwt, expiresAt } = await signJwt(
      { id: userRow.id, email: userRow.email, epoch: userRow.token_epoch },
      SESSION_DAYS,
    );

    return json({ jwt, expiresAt, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("auth-login failed:", err);
    return internal("Could not sign in, please try again");
  }
});
