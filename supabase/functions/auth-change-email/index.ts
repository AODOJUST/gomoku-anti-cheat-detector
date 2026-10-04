// auth-change-email -- §3.8 修改邮箱.
//
// POST { email, emailCode, password }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, user }
//
// Three proofs, and each one answers a different question:
//
//   * `password`   — 「你是这个账号本人吗」. Without it, a borrowed session (a shared laptop, a stolen
//                    token) could move the account's recovery address to an attacker's mailbox and
//                    then reset the password at leisure. This is the check that makes §3.8's
//                    「+ 当前密码」 row load-bearing rather than decorative.
//   * `emailCode`  — 「这个新地址确实归你」. Sent to the NEW address by `auth-send-code` (§2.4's shared
//                    mechanism), so it is read out of the mailbox that is about to become the
//                    account's.
//   * the session  — 「你是哪个账号」. Everything is scoped to `caller.id`; the body cannot name a
//                    user.
//
// ---------------------------------------------------------------------------------------------
// THE ORDER OF THE CHECKS IS THE DESIGN
// ---------------------------------------------------------------------------------------------
// The code is verified BEFORE availability is judged. Both orders exist in the wild; this one means
// the endpoint never answers 「这个邮箱已经有账号了」 to somebody who cannot read that mailbox — the
// proof of control comes first, and only then does the endpoint talk about the address at all. (In
// practice `auth-check-available` already answers that question for the signup form, so nothing is
// being protected by secrecy here; the point is that the *reset* path should not be a second,
// unauthenticated way to ask it.)
//
// The password is verified before the code, because a wrong password should not consume a
// single-use code — the rate limit means getting it back costs a minute.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  anonClient,
  emailTaken,
  EMAIL_CODE_RE,
  EMAIL_RE,
  requireUser,
  serviceClient,
  toPublicUser,
  type UserRow,
} from "../_shared/client.ts";
import { claimEmailCode, markEmailCodeUsed } from "../_shared/email.ts";

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
    const newEmail = body.email.trim().toLowerCase();

    if (typeof body.emailCode !== "string" || !EMAIL_CODE_RE.test(body.emailCode.trim())) {
      return fail("BAD_EMAIL_CODE", 400, "The verification code must be 6 digits");
    }
    const emailCode = body.emailCode.trim();

    if (typeof body.password !== "string" || body.password === "") {
      return fail("BAD_CREDENTIALS", 401, "Your current password is required");
    }
    const password = body.password;

    const sb = serviceClient();
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;
    const currentEmail = caller.email;

    if (currentEmail && currentEmail.toLowerCase() === newEmail) {
      return fail("BAD_EMAIL", 400, "That is already your email address");
    }
    if (!currentEmail) {
      // A 1.0.0 activation with no address on file. Proof-by-password needs an address to check the
      // password against, so an account with no login identity cannot use this path — but it also
      // has nothing to protect yet, and 1.0.1 gives it no way to acquire one. Named honestly rather
      // than reported as a wrong password.
      return fail("BAD_EMAIL", 400, "This account has no email address — contact an administrator");
    }

    // --- 1. is it you? ----------------------------------------------------------------------
    const { data: signedIn, error: signInError } = await anonClient().auth.signInWithPassword({
      email: currentEmail,
      password,
    });
    if (signInError || !signedIn?.user) {
      return fail("BAD_CREDENTIALS", 401, "The current password is wrong");
    }

    // --- 2. is that address yours? ----------------------------------------------------------
    // ⚠ 1.0.5 审计 P1 — this is the THIRD verification door, and it is the one that makes the limit a
    // funnel rather than three copies: it goes through the same `claimEmailCode` as §2.5's
    // registration and §2.6's reset, so 「改邮箱」 cannot be used as a cheaper place to guess.
    const claim = await claimEmailCode(sb, newEmail, emailCode);
    if (!claim.ok) {
      if (claim.reason === "TOO_MANY_ATTEMPTS") {
        return fail("TOO_MANY_ATTEMPTS", 429, "Too many wrong verification codes for the current code");
      }
      return fail("INVALID_EMAIL_CODE", 400, "The verification code is wrong or has expired");
    }
    const emailCodeRow = claim.row;

    // --- 3. can it be used? (now that control of it has been proven) -------------------------
    if (await emailTaken(sb, newEmail)) {
      return fail("EMAIL_TAKEN", 409, "That email address already has an account");
    }

    // --- 4. move the login identity, then the row ------------------------------------------
    // GoTrue first: it is what authenticates the next sign-in, and if it refuses (a hand-made
    // dashboard user already holds the address) nothing local has changed yet.
    const { error: authUpdateError } = await sb.auth.admin.updateUserById(signedIn.user.id, {
      email: newEmail,
      // The address was proven by the code in step 2, so GoTrue's own confirmation mail would be a
      // second, redundant loop.
      email_confirm: true,
    });
    if (authUpdateError) {
      if (/already|exists/i.test(authUpdateError.message ?? "")) {
        return fail("EMAIL_TAKEN", 409, "That email address already has an account");
      }
      throw authUpdateError;
    }

    const { data: updated, error: updateError } = await sb
      .from("users")
      .update({ email: newEmail })
      .eq("id", caller.id)
      .select("*")
      .single();
    if (updateError) {
      // The two stores must not disagree about a login identifier: if the row cannot move, move
      // GoTrue back. Best-effort and loud — a silent divergence here means 「登录用新邮箱、找回密码
      // 用旧邮箱」, which nobody could debug from a bug report.
      const { error: undoError } = await sb.auth.admin.updateUserById(signedIn.user.id, {
        email: currentEmail,
      });
      if (undoError) {
        console.error(`auth-change-email: ROLLBACK FAILED for user ${caller.id}:`, undoError);
      }
      if (updateError.code === "23505") {
        return fail("EMAIL_TAKEN", 409, "That email address already has an account");
      }
      throw updateError;
    }

    // --- 5. spend the code ------------------------------------------------------------------
    await markEmailCodeUsed(sb, emailCodeRow.id);

    return json({ ok: true, user: toPublicUser(updated as UserRow) });
  } catch (err) {
    console.error("auth-change-email failed:", err);
    return internal("Could not change the email address, please try again");
  }
});
