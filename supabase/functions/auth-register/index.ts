// auth-register -- §2.5 第二步：建号 + 绑码 + 签发 JWT.
//
// POST { code, username, email, password, emailCode, deviceId, userAgent? }
//   -> 200 { jwt, expiresAt, user }
//
// Called by somebody who already passed `auth-validate-code` — but nothing here TRUSTS that, so the
// activation code is re-checked from scratch (§2.5 step 1). The client's step one is an
// affordance; this is the gate.
//
// ---------------------------------------------------------------------------------------------
// TWO PLACES WHERE THIS DELIBERATELY DIFFERS FROM §2.5's PSEUDOCODE
// ---------------------------------------------------------------------------------------------
// 1. §2.5 step 1 collapses 「不存在」/「已撤销」/「已被绑定」 into one `INVALID_CODE`. We keep them apart,
//    exactly as `auth-activate` and `auth-validate-code` already do. The reason is this project's
//    standing rule (同一答案只准有一份): the operator has just been told 「该激活码已被使用，请直接登录」
//    by step one, and if pressing 完成注册 then says 「激活码无效」 the two steps are contradicting each
//    other about the same code — while the remedy that sentence carries (go log in) is exactly the
//    one they now cannot see.
//
// 2. §2.5 step 7 mints the session with `auth.signInWithPassword`, i.e. a GoTrue access token. We
//    mint ours with `signJwt` instead, for two reasons: (a) a GoTrue token carries no `epoch` claim,
//    so it would be rejected by `requireUser`'s §3.7 revocation check the moment the password
//    changes — the client would hold a token that every authenticated endpoint refuses; and (b)
//    re-verifying the password we just stored adds a second authority for 「这个密码对吗」, which the
//    credentials endpoint (`auth-login`) already owns. The password IS checked — by the mail code
//    that was just consumed and by the strength rule below.
//
// ---------------------------------------------------------------------------------------------
// THE ONE NON-OBVIOUS ORDERING
// ---------------------------------------------------------------------------------------------
// The account is created before the code is bound, because a code is bound to a user id. That
// leaves a window where a GoTrue user exists with no `public.users` row, and a failure in that
// window (a username race, a code race, a dropped write) would make the address permanently
// unusable — the insert can never succeed again, and the retry would report EMAIL_TAKEN forever.
// Every failure after `createUser` therefore rolls the GoTrue user back out before answering. See
// `rollbackAuthUser`.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  emailTaken,
  EMAIL_CODE_RE,
  EMAIL_RE,
  passwordOk,
  serviceClient,
  SESSION_DAYS,
  signJwt,
  toPublicUser,
  touchDevice,
  USERNAME_RE,
  usernameTaken,
  type UserRow,
} from "../_shared/client.ts";
import { isValidCodeShape, normalizeCode } from "../_shared/codes.ts";
import { markEmailCodeUsed, takeEmailCode } from "../_shared/email.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Undo the half-created account. Best-effort and loud: if it fails, the operator still gets their
 * error and the log says exactly which address is now stuck, because that is the only way anyone
 * can clean it up.
 */
async function rollbackAuthUser(sb: SupabaseClient, authUserId: string): Promise<void> {
  const { error } = await sb.auth.admin.deleteUser(authUserId);
  if (error) {
    console.error(`auth-register: ROLLBACK FAILED for auth user ${authUserId}:`, error);
  }
}

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    // --- 1. fields, against the server's copy of §2.3's table --------------------------------
    if (typeof body.code !== "string") return badRequest("Missing activation code");
    const code = normalizeCode(body.code);
    // A malformed code cannot exist ⇒ INVALID_CODE, not BAD_REQUEST (same reasoning as
    // auth-activate: BAD_REQUEST here would make the endpoint a shape oracle).
    if (!isValidCodeShape(code)) return fail("INVALID_CODE", 404, "Activation code not found");

    if (typeof body.username !== "string" || !USERNAME_RE.test(body.username.trim())) {
      return fail("BAD_USERNAME", 400, "Username must be 2-20 characters with no spaces");
    }
    const username = body.username.trim();

    if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim().toLowerCase())) {
      return fail("BAD_EMAIL", 400, "Invalid email address");
    }
    const email = body.email.trim().toLowerCase();

    if (typeof body.password !== "string" || !passwordOk(body.password)) {
      return fail("WEAK_PASSWORD", 400, "Password must be at least 8 characters with letters and digits");
    }
    const password = body.password;

    if (typeof body.emailCode !== "string" || !EMAIL_CODE_RE.test(body.emailCode.trim())) {
      return fail("BAD_EMAIL_CODE", 400, "The verification code must be 6 digits");
    }
    const emailCode = body.emailCode.trim();

    if (typeof body.deviceId !== "string" || body.deviceId.trim() === "" || body.deviceId.length > 256) {
      return badRequest("Missing or invalid deviceId");
    }
    const deviceId = body.deviceId.trim();
    const userAgent = typeof body.userAgent === "string"
      ? body.userAgent.slice(0, 512)
      : (req.headers.get("user-agent") ?? "").slice(0, 512);

    const sb = serviceClient();

    // --- 2. the activation code (§2.5 step 1) ------------------------------------------------
    const { data: codeRow, error: codeError } = await sb
      .from("activation_codes")
      .select("code, revoked, redeemed_by")
      .eq("code", code)
      .maybeSingle();
    if (codeError) throw codeError;
    if (!codeRow) return fail("INVALID_CODE", 404, "Activation code not found");
    if (codeRow.revoked === true) return fail("CODE_REVOKED", 403, "Activation code has been revoked");
    if (codeRow.redeemed_by) {
      return fail("CODE_ALREADY_USED", 409, "Activation code has already been used");
    }

    // --- 3. the email verification code (§2.5 step 2) ----------------------------------------
    // Checked BEFORE anything is written. A wrong code must not cost the operator their address:
    // §2.4's rate limit means a retry has to wait, and having to wait while also being told the
    // account exists would be the worst version of this failure.
    const emailCodeRow = await takeEmailCode(sb, email, emailCode);
    if (!emailCodeRow) {
      return fail("INVALID_EMAIL_CODE", 400, "The verification code is wrong or has expired");
    }

    // --- 4. uniqueness, so the failure is legible (§2.3 「唯一约束」) --------------------------
    // These probes are courtesies, not the guarantee: the constraints are (they are what makes the
    // 23505 handlers below load-bearing). A probe costs one round trip and turns 「500」 into
    // 「用户名已被占用」, which is the difference between the operator picking another name and the
    // operator filing a bug. They are the SAME predicates `auth-check-available` answers with, so
    // the form's ✓ and this refusal can never disagree.
    if (await usernameTaken(sb, username)) {
      return fail("USERNAME_TAKEN", 409, "That username is already taken");
    }
    if (await emailTaken(sb, email)) {
      return fail("EMAIL_TAKEN", 409, "This email address already has an account");
    }

    // --- 5. create the mailbox identity (§2.5 step 3) ----------------------------------------
    const { data: created, error: createError } = await sb.auth.admin.createUser({
      email,
      password,
      // §2.5 step 3: 「已通过邮箱验证，直接确认」 — the code in `email_codes` is the proof, so GoTrue's
      // own confirmation mail would be a second, redundant loop.
      email_confirm: true,
    });
    if (createError || !created?.user) {
      // §2.5 maps every createUser error to EMAIL_TAKEN. We split the duplicate case out, because a
      // deployment that is missing a migration or a secret would otherwise be told 「邮箱已被使用」
      // about an address nobody has ever registered — a lie that costs an afternoon.
      if (createError && (/already|exists/i.test(createError.message ?? ""))) {
        return fail("EMAIL_TAKEN", 409, "This email address already has an account");
      }
      console.error("auth-register: createUser failed:", createError);
      return internal("Could not create the account, please try again");
    }
    const authUserId = created.user.id;

    // --- 6. bind the account, and take the code (§2.5 steps 4–6) -----------------------------
    // Every failure below has to undo step 5 first. See the note at the top of this file.
    let userRow: UserRow;
    try {
      const { data: inserted, error: insertError } = await sb
        .from("users")
        .insert({
          id: authUserId,
          email,
          username,
          activated_at: new Date().toISOString(),
        })
        .select("*")
        .single();

      if (insertError) {
        if (insertError.code === "23505") {
          await rollbackAuthUser(sb, authUserId);
          const detail = `${insertError.message ?? ""} ${insertError.details ?? ""}`;
          return /username/i.test(detail)
            ? fail("USERNAME_TAKEN", 409, "That username is already taken")
            : fail("EMAIL_TAKEN", 409, "This email address already has an account");
        }
        throw insertError;
      }
      userRow = inserted as UserRow;

      // §2.5 step 5 — the optimistic lock, verbatim: only the caller who finds `redeemed_by` null
      // gets the row, so two simultaneous registrations cannot both claim one code.
      const { data: bound, error: bindError } = await sb
        .from("activation_codes")
        .update({ redeemed_by: authUserId, redeemed_at: new Date().toISOString() })
        .eq("code", code)
        .is("redeemed_by", null)
        .select("code");
      if (bindError) throw bindError;
      if (!bound || bound.length !== 1) {
        await sb.from("users").delete().eq("id", authUserId);
        await rollbackAuthUser(sb, authUserId);
        return fail("CODE_ALREADY_USED", 409, "Activation code has already been used");
      }

      // §2.5 step 6 — a code is single-use.
      await markEmailCodeUsed(sb, emailCodeRow.id);
    } catch (err) {
      await sb.from("users").delete().eq("id", authUserId);
      await rollbackAuthUser(sb, authUserId);
      throw err;
    }

    // --- 7. the device (§0 #2, 「3 台」) ------------------------------------------------------
    // The device limit is checked here rather than before step 5: a fourth device is a
    // device problem, not a registration problem, and the operator's account is already valid — so
    // refusing must not roll the account back. They can free a slot and log in, which is exactly
    // what §7.5's 「已达设备数上限，请在其他设备登出」 tells them to do.
    const limitHit = await touchDevice(sb, authUserId, deviceId, userAgent);
    if (limitHit) return limitHit;

    // --- 8. the session (§2.5 step 7, our way — see the header) ------------------------------
    const { jwt, expiresAt } = await signJwt(
      { id: userRow.id, email: userRow.email, epoch: userRow.token_epoch },
      SESSION_DAYS,
    );

    return json({ jwt, expiresAt, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("auth-register failed:", err);
    return internal("Registration failed, please try again");
  }
});
