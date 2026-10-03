// _shared/client.ts -- service-role client, caller verification, and JWT minting.
//
// Secrets policy: SUPABASE_SERVICE_ROLE_KEY is read ONLY from Deno.env here (and only
// ever used to build a server-side client). It is never returned in a response, never
// hardcoded, and the anon key is never used server-side.
//
// JWT design decision (the spec asked us to pick exactly one approach and document it):
// Supabase's JS client does not expose a "mint an HS256 JWT for an arbitrary user" API
// on `auth.admin` (it can create users / generate links, not sign session tokens), and
// we deliberately avoid pulling in an extra dependency such as `jose`. So we sign the
// token ourselves with the project JWT secret (`SUPABASE_JWT_SECRET`) using WebCrypto
// HMAC-SHA256 (HS256). The claim set is written out explicitly below so PostgREST
// accepts the token: `sub`, `role: 'authenticated'`, `aud: 'authenticated'`, `exp`,
// `iat`, `email`, plus `iss` so anything that does re-validate it against GoTrue agrees
// that it is ours. Nothing here trusts a client-supplied identity.
//
// 1.0.1 adds `epoch` to that claim set (§3.7's 「撤销所有设备 JWT」) — see `requireUser`.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fail, HttpStatus, unauthorized } from "./errors.ts";

// ---------------------------------------------------------------------------
// The two product limits every session path shares (§0 #2 / #8 of the 1.0.0 定稿).
//
// They live here because 1.0.1 adds two more paths that hand out a session — `auth-register` and
// `auth-login` — on top of `auth-activate` / `auth-renew` / `admin-reissue-jwt`. Each of those used
// to carry its own `const MAX_DEVICES = 3; const JWT_DAYS = 30;`, i.e. five copies of two facts
// that must never disagree, and this project has paid five times for exactly that shape.
// ---------------------------------------------------------------------------

/** 「限制同时在线的设备数为 3 台」. */
export const MAX_DEVICES = 3;
/** §0 #8 「JWT 有效期 30 天」. The client mirrors it in `auth.js`; this is the authority. */
export const SESSION_DAYS = 30;

/** Shape of a row in public.users. */
export interface UserRow {
  id: string;
  email: string | null;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
  activated_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  is_admin: boolean | null;
  is_banned: boolean | null;
  deleted_at: string | null;
  /** 1.0.1 §3.7 — bumped to invalidate every token already issued to this account. */
  token_epoch: number | null;
}

/** The only user projection the client ever receives. */
export interface PublicUser {
  id: string;
  email: string | null;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
  is_admin: boolean;
  activated_at: string | null;
  created_at: string | null;
}

/** Build the public projection, coercing nullable booleans. */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatar_url: row.avatar_url,
    bio: row.bio,
    is_admin: row.is_admin === true,
    activated_at: row.activated_at,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// 1.0.1 §2.3 — the field rules, in ONE place on the server side.
//
// The client carries its own copy because §2.3's table asks for 前端校验 AND 后端校验; the server's
// copy is the authority, and the two are kept word-for-word identical so a value that passes one
// cannot fail the other. `extension/auth.js` is the client's copy (PASSWORD_MIN / USERNAME_RE /
// EMAIL_RE / EMAIL_CODE_RE) — change either and change both.
// ---------------------------------------------------------------------------

/** §2.3: 「2–20 字符，无空格」. */
export const USERNAME_RE = /^\S{2,20}$/;
/** The same shape `auth-activate` has always used. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** §2.4: 「6 位数字」. */
export const EMAIL_CODE_RE = /^\d{6}$/;
/** §2.3: 「≥ 8 位，含字母 + 数字」. 「强」 is a UI encouragement and is NOT enforced (§2.3 says so). */
export const PASSWORD_MIN = 8;
export function passwordOk(pw: string): boolean {
  return pw.length >= PASSWORD_MIN && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

/**
 * Public (anon) client — for the credential operations GoTrue owns.
 *
 * Separate from `serviceClient()` on purpose: `signInWithPassword` / `admin.*` are two different
 * grants, and handing the service key to a password check would work by accident today and be a
 * privilege escalation the day Supabase tightens it.
 */
export function anonClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  return createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** True when this row came from a real Postgres insert/select (guards against nulls). */
export function isUserRow(value: unknown): value is UserRow {
  return !!value && typeof value === "object" && typeof (value as UserRow).id === "string";
}

/**
 * Service-role client. Bypasses RLS, which is why it must only ever be constructed
 * inside an Edge Function and never handed to the client.
 */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The verified caller, resolved to their public.users row. */
export interface Caller {
  id: string;
  email: string | null;
  token: string;
  isAdmin: boolean;
  isBanned: boolean;
  deletedAt: string | null;
  row: UserRow | null;
}

export type RequireUserResult =
  | { caller: Caller; response: null }
  | { caller: null; response: Response };

/** Pull the raw bearer token out of the Authorization header. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Verify the caller: check the bearer token's signature, then load the matching public.users row so
 * callers can check is_admin / is_banned. Returns `{ caller, response: null }` on success, or
 * `{ caller: null, response }` with a ready 401 envelope on failure. Never throws for an auth
 * problem -- the caller just forwards the response.
 *
 * ---------------------------------------------------------------------------------------------
 * ⚠ WHY THIS VERIFIES THE TOKEN ITSELF INSTEAD OF ASKING GOTRUE
 * ---------------------------------------------------------------------------------------------
 * 1.0.0 verified here with `sb.auth.getUser(token)`. That call does two things: validate the
 * signature, and then look the subject up in `auth.users`. The second half is the problem, and it
 * is not a corner case:
 *
 *   * `auth-activate` (1.0.0's only door, still shipped) inserts into **public.users** and mints a
 *     token whose `sub` is that row's freshly generated uuid. No `auth.users` row is ever created —
 *     there is no password to store, the activation code was the credential.
 *   * GoTrue answers 「User from sub claim in JWT does not exist」 (403) for such a token, so
 *     `requireUser` would 401 **every 1.0.1-relevant user** on `profile-*`, `auth-change-password`,
 *     `auth-change-email` and the seven `admin-*` functions — the exact population 1.0.1's §1.2
 *     promises not to lock out.
 *
 * Verifying the signature ourselves (`verifyJwtAllowExpired` with a zero-day grace, i.e. strictly
 * `exp`-enforced) removes that dependency, and it is the SAME check the renewal path already
 * performs — one implementation of 「这个 token 是我们签的并且还没过期」 rather than one per caller.
 * The `public.users` row remains the source of truth for identity, ban state and the epoch below,
 * and GoTrue remains the credential authority (it is what `auth-login` and `auth-change-password`
 * hand the password to) — which is the split the two roles should have had all along.
 */
export async function requireUser(req: Request, sb: SupabaseClient): Promise<RequireUserResult> {
  const token = bearerToken(req);
  if (!token) {
    return { caller: null, response: unauthorized("Missing bearer token") };
  }

  // graceDays = 0 ⇒ an expired token is refused outright. See `verifyJwtAllowExpired`.
  const verified = await verifyJwtAllowExpired(token, 0);
  if (!verified) {
    return { caller: null, response: unauthorized("Invalid or expired token") };
  }
  const claims = verified.token;

  const { data: row } = await sb
    .from("users")
    .select("*")
    .eq("id", claims.sub)
    .maybeSingle();

  const userRow = isUserRow(row) ? row : null;
  if (!userRow) {
    return { caller: null, response: unauthorized("Account not found") };
  }

  // -------------------------------------------------------------------------------------------
  // 1.0.1 §3.7 — 「撤销所有设备 JWT」, implemented as a per-user epoch rather than a denylist.
  //
  // The tokens this backend mints are stateless HS256, so there is nothing to delete when a
  // password changes — which is exactly the case §3.7 「建议撤销」 wants covered, because a password
  // change is the moment an attacker's stolen token must stop working. A counter on the row is the
  // smallest thing that makes a stateless token revocable: every minted token carries the epoch it
  // was issued under, and a token from an older epoch is refused here — the single place every
  // function already passes through.
  //
  // A token with NO `epoch` claim reads as 0, which is what every pre-1.0.1 token is, so the
  // upgrade does not sign anybody out until an epoch is actually bumped.
  // -------------------------------------------------------------------------------------------
  if (Number(claims.epoch ?? 0) !== Number(userRow.token_epoch ?? 0)) {
    return { caller: null, response: unauthorized("Token has been revoked") };
  }

  return {
    caller: {
      id: claims.sub,
      email: (userRow.email ?? claims.email ?? null),
      token,
      isAdmin: userRow.is_admin === true,
      isBanned: userRow.is_banned === true,
      deletedAt: userRow.deleted_at ?? null,
      row: userRow,
    },
    response: null,
  };
}

/**
 * requireUser + the admin gate in one call, for the seven admin-* functions.
 * The is_admin check always reads the database row via requireUser -- a client-supplied
 * is_admin is never consulted. Non-admin => 403.
 */
export async function requireAdmin(req: Request, sb: SupabaseClient): Promise<RequireUserResult> {
  const result = await requireUser(req, sb);
  if (result.response) return result;
  if (!result.caller.isAdmin) {
    return {
      caller: null,
      response: fail("FORBIDDEN", HttpStatus.FORBIDDEN, "Administrator privileges required"),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// The account-state gate, and the device rule.
//
// Both are answers that FIVE functions now need (auth-activate / auth-register / auth-login /
// auth-renew / admin-reissue-jwt) and neither was shared in 1.0.0 — each file wrote its own `if`s.
// That is the shape of duplicate this project has paid for five times: the day one of them starts
// refusing a banned account with a different status, one door is open and four are shut.
// ---------------------------------------------------------------------------

/**
 * May this account hold a session? `null` means yes; otherwise a ready refusal response.
 *
 * `missingStatus` is the one thing the callers legitimately disagree about, and it is about who is
 * asking rather than about the account:
 *
 *   * a SESSION path (activate / register / login / renew) was handed a credential naming an
 *     account that is gone — that is an authentication failure, so 401 UNAUTHORIZED;
 *   * an ADMIN path (admin-reissue-jwt) was handed a `user_id` by an operator — that is a lookup
 *     that missed, so 404 NOT_FOUND.
 *
 * A soft-deleted row (deleted_at set, §4.2's 30-day retention) counts as gone in both: it is on its
 * way to being purged and must not be handed a new 30-day session — nor re-activated with a spare
 * code, which is why `auth-activate` calls this too.
 */
export function accountRefusal(
  row: UserRow | null,
  missingStatus: number = HttpStatus.UNAUTHORIZED,
): Response | null {
  const lookupMiss = missingStatus === HttpStatus.NOT_FOUND;
  if (!row) {
    return lookupMiss
      ? fail("NOT_FOUND", HttpStatus.NOT_FOUND, "User not found")
      : unauthorized("Account not found");
  }
  if (row.deleted_at) {
    return lookupMiss
      ? fail("NOT_FOUND", HttpStatus.NOT_FOUND, "Account has been deleted")
      : unauthorized("Account has been deleted");
  }
  if (row.is_banned === true) {
    return fail("BANNED", HttpStatus.FORBIDDEN, "Account is banned");
  }
  return null;
}

/**
 * Register (or touch) `deviceId` for `userId`, enforcing 「限制同时在线的设备数为 3 台」.
 *
 * Returns `null` when the session may continue, or a ready `DEVICE_LIMIT` response when this would
 * be a fourth device. Note what the ORDER buys: the limit is checked BEFORE anything is inserted,
 * so a refused attempt cannot leave a half-bound device behind, and — in `auth-activate` — the
 * caller checks it before redeeming the code, so hitting the limit never burns a valid code.
 */
export async function touchDevice(
  sb: SupabaseClient,
  userId: string,
  deviceId: string,
  userAgent: string,
): Promise<Response | null> {
  const { data: existing, error: lookupError } = await sb
    .from("devices")
    .select("id")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (lookupError) throw lookupError;

  const nowIso = new Date().toISOString();

  if (existing) {
    const { error } = await sb
      .from("devices")
      .update({ last_seen: nowIso, user_agent: userAgent })
      .eq("id", existing.id);
    if (error) throw error;
    return null;
  }

  const { count, error: countError } = await sb
    .from("devices")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_DEVICES) {
    return fail("DEVICE_LIMIT", HttpStatus.CONFLICT, `At most ${MAX_DEVICES} devices may be active`);
  }

  const { error: insertError } = await sb
    .from("devices")
    .insert({ user_id: userId, device_id: deviceId, user_agent: userAgent, last_seen: nowIso });
  if (insertError) throw insertError;
  return null;
}

// ---------------------------------------------------------------------------
// §2.3's 「实时检查唯一」, asked in two places with one answer.
//
// `auth-check-available` answers the question for the registration form's ✓/✕, and `auth-register`
// asks it again before creating anything. If the two used different predicates, the form would say
// 「可用」 and the submit would say 「已被占用」 — the specific contradiction §2.3's table creates by
// listing 唯一检查 twice (前端 and 后端).
//
// ⚠ WHAT THESE MIRROR IS THE CONSTRAINT, NOT A HOUSE STYLE:
//   * username — `idx_users_username_lower` (004_email_codes.sql) is case-insensitive AND scoped to
//     `deleted_at is null`, so a cancelled account does not hold its name hostage for the 30 days
//     §4.2 keeps the row. Both halves are mirrored below.
//   * email — `users.email` carries a plain `unique` (001_init.sql), which does NOT skip deleted
//     rows, so a soft-deleted account still owns its address until the purge. Mirrored below.
//
// Being courtesies, they are allowed to be beaten by a race: the 23505 handlers in `auth-register`
// are what actually decide, and they report the same two codes.
// ---------------------------------------------------------------------------

/** Is `username` free? Case-insensitive, ignoring soft-deleted accounts. */
export async function usernameTaken(sb: SupabaseClient, username: string): Promise<boolean> {
  // `.eq`, not `.ilike`: a LIKE pattern would read `_` and `%` in the typed username as wildcards,
  // so `a_b` would be reported taken because somebody holds `axb`. A case-variant collision
  // (`Alice` vs `alice`) therefore slips past this probe — and is caught by the unique index at
  // insert time, which reports USERNAME_TAKEN exactly as this does. Same code, either way.
  const { data, error } = await sb
    .from("users")
    .select("id")
    .eq("username", username)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Is `email` free? Exact, and deleted rows still count — see the block comment above. */
export async function emailTaken(sb: SupabaseClient, email: string): Promise<boolean> {
  const { data, error } = await sb
    .from("users")
    .select("id")
    .eq("email", email)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// ---------------------------------------------------------------------------
// JWT minting (HS256, signed with SUPABASE_JWT_SECRET).
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Minimal identity needed to mint a token. */
export interface JwtSubject {
  id: string;
  email?: string | null;
  /** 1.0.1 §3.7 — the row's `token_epoch` at issue time; see `requireUser`. */
  epoch?: number | null;
}

/**
 * Sign a Supabase-compatible session JWT.
 *
 * Claims (explicit, so PostgREST's role check passes):
 *   sub  = user id, role = 'authenticated', aud = 'authenticated', exp, iat, email, iss.
 * `iss` is `<SUPABASE_URL>/auth/v1`, which is what GoTrue (and therefore
 * `sb.auth.getUser`) expects when it re-validates the token on later calls.
 *
 * 1.0.1 adds `epoch` — the `users.token_epoch` this token was issued under. It is ignored by
 * PostgREST and GoTrue and read only by `requireUser`; see there for why a stateless token
 * needs one.
 */
export async function signJwt(
  user: JwtSubject,
  days: number = SESSION_DAYS,
): Promise<{ jwt: string; expiresAt: string }> {
  const secret = Deno.env.get("JWT_SECRET") ?? Deno.env.get("SUPABASE_JWT_SECRET");
  const url = Deno.env.get("SUPABASE_URL");
  if (!secret) throw new Error("JWT_SECRET must be set");
  if (!url) throw new Error("SUPABASE_URL must be set");

  const now = Math.floor(Date.now() / 1000);
  const exp = now + days * 24 * 60 * 60;

  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    sub: user.id,
    role: "authenticated",
    aud: "authenticated",
    exp,
    iat: now,
    iss: `${url}/auth/v1`,
    epoch: Number(user.epoch ?? 0),
  };
  if (user.email) payload.email = user.email;

  const signingInput = `${base64UrlEncodeText(JSON.stringify(header))}.${
    base64UrlEncodeText(JSON.stringify(payload))
  }`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(signingInput),
  );

  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  return { jwt, expiresAt: new Date(exp * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// Signature-only verification, for the renewal path.
// ---------------------------------------------------------------------------

/** The claims we care about after verifying a token ourselves. */
export interface VerifiedToken {
  sub: string;
  email: string | null;
  exp: number;
  /** 1.0.1 §3.7 — the `users.token_epoch` this token was minted under; absent reads as 0. */
  epoch: number;
}

function base64UrlDecodeBytes(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeText(segment: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(segment));
}

/**
 * Verify an HS256 token's signature and decode it, tolerating a token that has recently
 * expired (up to `graceDays` past `exp`). Returns null when the token is malformed,
 * mis-signed, or older than the grace window.
 *
 * Why not `sb.auth.getUser(token)`: GoTrue rejects an expired token outright, but the
 * renewal endpoint exists precisely to exchange a just-expired token for a fresh one,
 * so it has to accept a signature-valid token that is past `exp` within the grace window.
 *
 * `graceDays = 0` is the STRICT setting (an expired token is refused), which is what `requireUser`
 * passes: there is no grace on an ordinary authenticated call. It is the same function for both so
 * that 「这个 token 是本服务签的」 has one implementation — see the note on `requireUser`.
 */
export async function verifyJwtAllowExpired(
  token: string,
  graceDays: number = SESSION_DAYS,
): Promise<{ token: VerifiedToken; expired: boolean } | null> {
  const secret = Deno.env.get("JWT_SECRET") ?? Deno.env.get("SUPABASE_JWT_SECRET");
  if (!secret) throw new Error("JWT_SECRET must be set");

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header: { alg?: string; typ?: string };
  let payload: { sub?: unknown; email?: unknown; exp?: unknown; epoch?: unknown };
  try {
    header = JSON.parse(base64UrlDecodeText(headerSegment));
    payload = JSON.parse(base64UrlDecodeText(payloadSegment));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;

  let signatureValid = false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    signatureValid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecodeBytes(signatureSegment),
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    );
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  const now = Math.floor(Date.now() / 1000);
  const expired = payload.exp <= now;
  if (expired && payload.exp + graceDays * 24 * 60 * 60 < now) return null;

  return {
    token: {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      exp: payload.exp,
      epoch: Number(payload.epoch ?? 0),
    },
    expired,
  };
}
