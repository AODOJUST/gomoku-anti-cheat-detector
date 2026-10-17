// auth-renew -- exchange a still-valid (or just-expired) session for a fresh 30-day one.
//
// POST { deviceId, userAgent? }   Authorization: Bearer <jwt>
//   -> 200 { jwt, expiresAt, user }
//
// Renewal cadence: the extension calls this every 7 days. A 30-day token therefore
// comfortably outlives the interval, and even a client that has been offline for a
// while can still renew, because we accept a signature-valid token whose `exp` has
// passed within the grace window (see verifyJwtAllowExpired in _shared/client.ts).
// That is also why this function is deployed with --no-verify-jwt: the platform's own
// gate would reject an expired token before our code ever runs.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  accountRefusal,
  bearerToken,
  serviceClient,
  SESSION_DAYS,
  signJwt,
  toPublicUser,
  touchDevice,
  verifyJwtAllowExpired,
  type UserRow,
} from "../_shared/client.ts";

/** How far past `exp` a token may be and still be exchanged. */
const RENEW_GRACE_DAYS = 30;

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const token = bearerToken(req);
    if (!token) return fail("UNAUTHORIZED", 401, "Missing bearer token");

    // Signature-valid + within the grace window, even if already expired.
    const verified = await verifyJwtAllowExpired(token, RENEW_GRACE_DAYS);
    if (!verified) return fail("UNAUTHORIZED", 401, "Invalid or expired token");

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const rawDeviceId = body.deviceId;
    if (typeof rawDeviceId !== "string" || rawDeviceId.trim() === "" || rawDeviceId.length > 256) {
      return badRequest("Missing or invalid deviceId");
    }
    const deviceId = rawDeviceId.trim();

    const userAgent = typeof body.userAgent === "string"
      ? body.userAgent.slice(0, 512)
      : (req.headers.get("user-agent") ?? "").slice(0, 512);

    const sb = serviceClient();

    const { data: found, error: userError } = await sb
      .from("users")
      .select("*")
      .eq("id", verified.token.sub)
      .maybeSingle();
    if (userError) throw userError;
    const userRow = (found as UserRow | null) ?? null;

    // A token for a row that no longer exists is worthless; a deleted account is on its way to
    // purging and must not be resurrected; a banned one is §6.2's reversible kill switch, which the
    // client keeps the session for so it can say so. All three verdicts come from `accountRefusal`,
    // shared with the four other doors that hand out a session.
    const refusal = accountRefusal(userRow);
    if (refusal) return refusal;

    // Keep the device binding honest: register if new (respecting the limit), touch if
    // known. Deleting the device rows (as auth-delete-account does) is what forces a
    // user off every device.
    const limitHit = await touchDevice(sb, userRow.id, deviceId, userAgent);
    if (limitHit) return limitHit;

    // Fresh full-length token, signed the same way as in auth-activate.
    const { jwt, expiresAt } = await signJwt(
      { id: userRow.id, email: userRow.email, epoch: userRow.token_epoch },
      SESSION_DAYS,
    );
    // ⚠⚠ 1.0.6 二号 §1.7.1 — THE USER PROJECTION GOES BACK WITH THE TOKEN, AND THIS IS THE FIX.
    //
    // 切换账号 rebuilds the live session from the remembered credential row, because there is no
    // refresh token in this product (see `auth.js`'s header) — and that row only ever held the five
    // fields the drawer draws. So a switched-to session was missing every other column, `activated_at`
    // among them, and `cmReadOnly()` (viewer.js) read the missing field as 「未激活」: the operator
    // switched to an ACTIVATED account and the room locked itself with 「激活后参与讨论」.
    //
    // The row is already loaded right above (`userRow`), so this costs nothing — and it is the
    // version that cannot drift: `toPublicUser` is the ONE projection, so a column added to it
    // arrives at every session-adopting door at once (activate / login / register / renew / switch)
    // instead of having to be remembered in each.
    return json({ jwt, expiresAt, user: toPublicUser(userRow) });
  } catch (err) {
    console.error("auth-renew failed:", err);
    return internal("Renewal failed, please try again");
  }
});
