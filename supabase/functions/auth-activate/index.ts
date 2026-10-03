// auth-activate -- redeem an activation code, bind a device, and mint a session JWT.
//
// POST { code, deviceId, userAgent?, email? }
//   -> 200 { jwt, expiresAt, user }
//
// This function is the only way a normal user obtains a token, and it runs with the
// service role. It performs its own checks in a deliberate order so the client never
// learns more than it needs to (an unknown code and a malformed one both look "not
// found").

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  serviceClient,
  signJwt,
  toPublicUser,
  type UserRow,
} from "../_shared/client.ts";
import { isValidCodeShape, normalizeCode } from "../_shared/codes.ts";

/** Product rule: at most three active devices per account. */
const MAX_DEVICES = 3;
/** Session lifetime; the client renews every 7 days, so 30 days is generous. */
const JWT_DAYS = 30;

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

    // --- 5. banned? ----------------------------------------------------------
    if (userRow.is_banned === true) {
      return fail("BANNED", 403, "Account is banned");
    }

    // --- 6. device plan (checked *before* redeeming so a limit hit cannot burn
    //        an otherwise valid code) ---------------------------------------
    const { data: existingDevice, error: deviceLookupError } = await sb
      .from("devices")
      .select("id")
      .eq("user_id", userRow.id)
      .eq("device_id", deviceId)
      .maybeSingle();
    if (deviceLookupError) throw deviceLookupError;

    const isNewDevice = !existingDevice;
    if (isNewDevice) {
      const { count, error: countError } = await sb
        .from("devices")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userRow.id);
      if (countError) throw countError;
      if ((count ?? 0) >= MAX_DEVICES) {
        return fail("DEVICE_LIMIT", 409, `At most ${MAX_DEVICES} devices may be active`);
      }
    }

    // --- 7. bind the code with an optimistic lock ----------------------------
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

    // --- 8. register / touch the device --------------------------------------
    const nowIso = new Date().toISOString();
    if (isNewDevice) {
      const { error: insertDeviceError } = await sb
        .from("devices")
        .insert({ user_id: userRow.id, device_id: deviceId, user_agent: userAgent, last_seen: nowIso });
      if (insertDeviceError) throw insertDeviceError;
    } else {
      const { error: touchError } = await sb
        .from("devices")
        .update({ last_seen: nowIso, user_agent: userAgent })
        .eq("user_id", userRow.id)
        .eq("device_id", deviceId);
      if (touchError) throw touchError;
    }

    // --- 9. mint the session -------------------------------------------------
    // Signed with the project JWT secret via WebCrypto HMAC-SHA256 (see _shared/client.ts).
    const { jwt, expiresAt } = await signJwt({ id: userRow.id, email: userRow.email }, JWT_DAYS);

    return json({ jwt, expiresAt, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("auth-activate failed:", err);
    return internal("Activation failed, please try again");
  }
});
