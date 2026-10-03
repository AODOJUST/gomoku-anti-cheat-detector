// auth-activate -- redeem an activation code, bind a device, and mint a session JWT.
//
// POST { code, deviceId, userAgent?, email? }
//   -> 200 { jwt, expiresAt, user }
//
// This was 1.0.0's ONLY door: 「输码即建号」, one step, no password. 1.0.1 put the two-step flow
// (`auth-validate-code` → `auth-register`) in front of the UI, but this endpoint stays exactly as
// it was — a deployed 1.0.0 client still calls it, and an operator who needs to re-activate an
// account whose row predates 1.0.1 still has to come through here (see `auth-reset-password`).
// It runs with the service role and performs its own checks in a deliberate order so the client
// never learns more than it needs to (an unknown code and a malformed one both look "not found").

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  accountRefusal,
  serviceClient,
  SESSION_DAYS,
  signJwt,
  toPublicUser,
  touchDevice,
  type UserRow,
} from "../_shared/client.ts";
import { isValidCodeShape, normalizeCode } from "../_shared/codes.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const rawCode = body.code;
    if (typeof rawCode !== "string" || rawCode.trim() === "") {
      return badRequest("Missing activation code");
    }
    const code = normalizeCode(rawCode);
    // A malformed code can never exist, so report it as INVALID_CODE rather than
    // BAD_REQUEST -- this avoids turning the endpoint into a shape oracle.
    if (!isValidCodeShape(code)) {
      return fail("INVALID_CODE", 404, "Activation code not found");
    }

    const rawDeviceId = body.deviceId;
    if (typeof rawDeviceId !== "string" || rawDeviceId.trim() === "" || rawDeviceId.length > 256) {
      return badRequest("Missing or invalid deviceId");
    }
    const deviceId = rawDeviceId.trim();

    const userAgent = typeof body.userAgent === "string"
      ? body.userAgent.slice(0, 512)
      : (req.headers.get("user-agent") ?? "").slice(0, 512);

    let email: string | null = null;
    if (body.email !== undefined && body.email !== null) {
      if (typeof body.email !== "string") return badRequest("Invalid email");
      email = body.email.trim().toLowerCase();
      if (email !== "" && !EMAIL_RE.test(email)) return badRequest("Invalid email");
      if (email === "") email = null;
    }

    const sb = serviceClient();

    // --- 1. look up the code -------------------------------------------------
    const { data: codeRow, error: codeError } = await sb
      .from("activation_codes")
      .select("*")
      .eq("code", code)
      .maybeSingle();
    if (codeError) throw codeError;
    if (!codeRow) return fail("INVALID_CODE", 404, "Activation code not found");

    // --- 2. revoked? ---------------------------------------------------------
    if (codeRow.revoked === true) {
      return fail("CODE_REVOKED", 403, "Activation code has been revoked");
    }

    // --- 3. already redeemed by somebody else? --------------------------------
    // Resolve the caller's existing account *without creating one* first, so a code
    // that belongs to another account never results in a junk user being inserted.
    let userRow: UserRow | null = null;
    if (email) {
      const { data: found, error } = await sb
        .from("users")
        .select("*")
        .eq("email", email)
        .maybeSingle();
      if (error) throw error;
      userRow = (found as UserRow | null) ?? null;
    }

    if (codeRow.redeemed_by) {
      // Re-activating the very same code with the very same account is idempotent;
      // anything else means the code is spent.
      if (!userRow || userRow.id !== codeRow.redeemed_by) {
        return fail("CODE_ALREADY_USED", 409, "Activation code has already been used");
      }
    } else if (!userRow) {
      // --- 4. find-or-create the account ------------------------------------
      const { data: created, error: createError } = await sb
        .from("users")
        .insert({ email })
        .select("*")
        .single();
      if (createError) {
        // 23505 = unique_violation: a concurrent activation with the same email won
        // the race, so re-read that row instead of failing.
        if (createError.code === "23505" && email) {
          const { data: raced, error: raceError } = await sb
            .from("users")
            .select("*")
            .eq("email", email)
            .maybeSingle();
          if (raceError) throw raceError;
          if (!raced) throw createError;
          userRow = raced as UserRow;
        } else {
          throw createError;
        }
      } else {
        userRow = created as UserRow;
      }
    }

    if (!userRow) throw new Error("Failed to resolve user during activation");

    // --- 5. may this account hold a session? -------------------------------------------------
    // Banned, or soft-deleted and therefore on its way to the purge (§4.2's 30-day retention).
    // ⚠ 1.0.0 checked only `is_banned` here, so a cancelled account could be brought back to life
    // with a spare code and would keep its `deleted_at` while holding a fresh 30-day token. The
    // `deleted_at` half is 1.0.1's fix, and it lives in `accountRefusal` so this door and the four
    // other doors that hand out a session cannot disagree about what 「不得再登录」 means.
    const refusal = accountRefusal(userRow);
    if (refusal) return refusal;

    // --- 6. the device (§0 #2, 「3 台」) ------------------------------------------------------
    // Checked *before* the code is redeemed so a limit hit cannot burn an otherwise valid code:
    // `touchDevice` refuses before it inserts, so a fourth device leaves nothing behind either.
    const limitHit = await touchDevice(sb, userRow.id, deviceId, userAgent);
    if (limitHit) return limitHit;

    // --- 7. bind the code with an optimistic lock --------------------------------------------
    const alreadyBoundToSelf = codeRow.redeemed_by === userRow.id;
    if (!alreadyBoundToSelf) {
      const { data: bound, error: bindError } = await sb
        .from("activation_codes")
        .update({ redeemed_by: userRow.id, redeemed_at: new Date().toISOString() })
        .eq("code", code)
        .is("redeemed_by", null) // optimistic lock: only succeeds if still unredeemed
        .select("code");
      if (bindError) throw bindError;
      if (!bound || bound.length !== 1) {
        // Somebody else redeemed it between our read and our write.
        return fail("CODE_ALREADY_USED", 409, "Activation code has already been used");
      }

      // Stamp activated_at on first successful redemption (leave it alone afterwards).
      if (!userRow.activated_at) {
        const { data: stamped, error: stampError } = await sb
          .from("users")
          .update({ activated_at: new Date().toISOString() })
          .eq("id", userRow.id)
          .select("*")
          .single();
        if (stampError) throw stampError;
        userRow = stamped as UserRow;
      }
    }

    // --- 8. mint the session ----------------------------------------------------------------
    // Signed with the project JWT secret via WebCrypto HMAC-SHA256 (see _shared/client.ts).
    const { jwt, expiresAt } = await signJwt(
      { id: userRow.id, email: userRow.email, epoch: userRow.token_epoch },
      SESSION_DAYS,
    );

    return json({ jwt, expiresAt, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("auth-activate failed:", err);
    return internal("Activation failed, please try again");
  }
});
