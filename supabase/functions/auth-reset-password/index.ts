// auth-reset-password -- §2.6 忘记密码：用邮箱验证码重置.
//
// POST { email, emailCode, password }
//   -> 200 { ok: true }
//
// No session is minted. The operator has proven control of the mailbox, so the reset SUCCEEDS — but
// the whole point of a reset is that the old credential is suspect, so handing out a token in the
// same breath would skip the moment they should be re-authenticating deliberately. They log in
// through `auth-login` afterwards, which is one flow fewer than auto-login would be.
//
// ---------------------------------------------------------------------------------------------
// WHY THIS ONE DOES NOT HIDE WHETHER THE ADDRESS EXISTS
// ---------------------------------------------------------------------------------------------
// Every other endpoint answers 「邮箱不存在」 and 「密码错误」 identically (see `auth-login`). This one
// names the problem, because here it CANNOT be an enumeration: the caller must have read a code out
// of that mailbox seconds ago. An attacker who can read the mailbox already knows whether they have
// an account. Refusing to say 「这个邮箱没有白身账号」 would only make a typo look like a network fault.
//
// THE 404 FROM GoTrue IS ALSO MEANINGFUL, and is reported as such: see the comment on the update.
//
// §3.7's 「密码修改通常是安全事件」 applies double here, so `token_epoch` is bumped exactly as a
// password CHANGE bumps it — every device that was signed in with the old password is signed out.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, HttpStatus, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  accountRefusal,
  EMAIL_CODE_RE,
  EMAIL_RE,
  passwordOk,
  serviceClient,
  type UserRow,
} from "../_shared/client.ts";
import { markEmailCodeUsed, takeEmailCode } from "../_shared/email.ts";

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

    if (typeof body.emailCode !== "string" || !EMAIL_CODE_RE.test(body.emailCode.trim())) {
      return fail("BAD_EMAIL_CODE", 400, "The verification code must be 6 digits");
    }
    const emailCode = body.emailCode.trim();

    // §2.3's rule, applied to the replacement password — a reset that installs 「123456」 would be a
    // way around the rule the registration form enforces.
    if (typeof body.password !== "string" || !passwordOk(body.password)) {
      return fail("WEAK_PASSWORD", 400, "Password must be at least 8 characters with letters and digits");
    }
    const password = body.password;

    const sb = serviceClient();

    const { data: found, error: lookupError } = await sb
      .from("users")
      .select("*")
      .eq("email", email)
      .maybeSingle();
    if (lookupError) throw lookupError;
    const userRow = (found as UserRow | null) ?? null;
    if (!userRow) return fail("NOT_FOUND", 404, "This email address has no 白身 account");

    const refusal = accountRefusal(userRow, HttpStatus.NOT_FOUND);
    if (refusal) return refusal;

    // The code is checked before the password is touched, so a wrong code cannot leave an account
    // in a half-reset state.
    const emailCodeRow = await takeEmailCode(sb, email, emailCode);
    if (!emailCodeRow) {
      return fail("INVALID_EMAIL_CODE", 400, "The verification code is wrong or has expired");
    }

    // -------------------------------------------------------------------------------------------
    // WHY `userRow.id` IS THE RIGHT GoTrue ID — AND WHAT A 404 MEANS
    // -------------------------------------------------------------------------------------------
    // For every account this backend creates, `public.users.id` IS the GoTrue user id:
    // `auth-register` inserts the id `admin.createUser` returned. A 404 here therefore has exactly
    // one cause: the row predates 1.0.1, having been created by 1.0.0's `auth-activate`, which
    // inserted into `public.users` and never touched `auth.users` — because the activation code
    // WAS the credential and there was no password to store.
    //
    // So a 404 is not an internal error, it is the honest answer for that population: there is no
    // password on this account to reset. They are told to use an activation code instead, which is
    // the door `admin-generate-code` + `auth-activate` still provides.
    const { error: updateError } = await sb.auth.admin.updateUserById(userRow.id, { password });
    if (updateError) {
      if (/not found/i.test(updateError.message ?? "")) {
        console.warn(`auth-reset-password: ${email} has no auth.users row (pre-1.0.1 activation account)`);
        return fail(
          "NOT_FOUND",
          404,
          "This account has no password on file — activate it with an activation code instead",
        );
      }
      throw updateError;
    }

    // §3.7's revocation, for a reset: every device signed in with the OLD password must go.
    const nextEpoch = Number(userRow.token_epoch ?? 0) + 1;
    const { error: epochError } = await sb
      .from("users")
      .update({ token_epoch: nextEpoch })
      .eq("id", userRow.id);
    if (epochError) throw epochError;

    await markEmailCodeUsed(sb, emailCodeRow.id);

    // §2.6's promise: they now log in with the new password. Nothing is returned that could be
    // used as a session.
    return json({ ok: true });
  } catch (err) {
    console.error("auth-reset-password failed:", err);
    return internal("Could not reset the password, please try again");
  }
});
