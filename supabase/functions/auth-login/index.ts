// auth-login -- §2.6 已有账户的登录.
//
// POST { email, password, deviceId, userAgent? }
//   -> 200 { jwt, expiresAt, user }
//
// Reached from 「已有账户？点此登录」 on the activation screen, and from 忘记密码's 「重置后请重新登录」.
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

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  accountRefusal,
  anonClient,
  EMAIL_RE,
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
