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
// `iat`, `email`, plus `iss` so GoTrue's `getUser(token)` (used by requireUser) also
// accepts it. Nothing here trusts a client-supplied identity.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fail, HttpStatus, unauthorized } from "./errors.ts";

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
 * Verify the caller: extract the bearer token, ask GoTrue to validate it, then load the
 * matching public.users row so callers can check is_admin / is_banned. Returns
 * `{ caller, response: null }` on success, or `{ caller: null, response }` with a ready
 * 401 envelope on failure. Never throws for an auth problem -- the caller just forwards
 * the response.
 */
export async function requireUser(req: Request, sb: SupabaseClient): Promise<RequireUserResult> {
  const token = bearerToken(req);
  if (!token) {
    return { caller: null, response: unauthorized("Missing bearer token") };
  }

  const { data: authData, error: authError } = await sb.auth.getUser(token);
  if (authError || !authData?.user?.id) {
    return { caller: null, response: unauthorized("Invalid or expired token") };
  }

  const authUser = authData.user;
  const { data: row } = await sb
    .from("users")
    .select("*")
    .eq("id", authUser.id)
    .maybeSingle();

  const userRow = isUserRow(row) ? row : null;

  return {
    caller: {
      id: authUser.id,
      email: (userRow?.email ?? authUser.email ?? null),
      token,
      isAdmin: userRow?.is_admin === true,
      isBanned: userRow?.is_banned === true,
      deletedAt: userRow?.deleted_at ?? null,
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
}

/**
 * Sign a Supabase-compatible session JWT.
 *
 * Claims (explicit, so PostgREST's role check passes):
 *   sub  = user id, role = 'authenticated', aud = 'authenticated', exp, iat, email, iss.
 * `iss` is `<SUPABASE_URL>/auth/v1`, which is what GoTrue (and therefore
 * `sb.auth.getUser`) expects when it re-validates the token on later calls.
 */
export async function signJwt(
  user: JwtSubject,
  days: number = 30,
): Promise<{ jwt: string; expiresAt: string }> {
  const secret = Deno.env.get("SUPABASE_JWT_SECRET");
  const url = Deno.env.get("SUPABASE_URL");
  if (!secret) throw new Error("SUPABASE_JWT_SECRET must be set");
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
 */
export async function verifyJwtAllowExpired(
  token: string,
  graceDays: number = 30,
): Promise<{ token: VerifiedToken; expired: boolean } | null> {
  const secret = Deno.env.get("SUPABASE_JWT_SECRET");
  if (!secret) throw new Error("SUPABASE_JWT_SECRET must be set");

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header: { alg?: string; typ?: string };
  let payload: { sub?: unknown; email?: unknown; exp?: unknown };
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
    },
    expired,
  };
}
