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
// 1.0.3 §3.2: the presence beat's interval. Imported rather than re-declared — see `touchLastSeen`.
// The dependency runs ONE WAY (client → community); community.ts imports nothing from here.
import { PRESENCE_BEAT_MS } from "./community.ts";

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

/**
 * 1.0.5 审计 P2 — how long a soft-deleted account is kept before the cron hard-deletes it.
 *
 * ⚠ IT MOVED HERE FROM `auth-delete-account`, WHICH WAS ITS ONLY COPY. The audit's finding was
 * 「账户删除后的云端数据清理没有闭环」: `auth-delete-account` stamps `deleted_at` and returns a
 * `purgeAt` computed from this number, while NOTHING anywhere actually deleted anything — and
 * `supabase/README.md` documented the cleanup as a `pg_cron` job that the operator had to write by
 * hand. The `purgeAt` the client shows and the deadline the cron enforces are the same fact, so
 * they are now the same constant, read by the door (`auth-delete-account`) and by the job
 * (`friend-share-purge`).
 */
export const PURGE_AFTER_DAYS = 30;

/**
 * §3.6's Storage bucket for profile pictures: `avatars/{user_id}.jpg`.
 *
 * ⚠ IT LIVES HERE BECAUSE 1.0.5 GAVE IT A SECOND READER. Until the audit's P2 was closed only
 * `profile-update` knew this name; the account purge (`friend-share-purge` §4) has to remove the
 * object too, and the audit's P2 fix is the last place that should invent a second copy of a bucket
 * name — a wrong name there fails silently as 「the picture was not deleted」. `verify-067 §10` asserts
 * the literal appears in exactly this one file.
 */
export const AVATAR_BUCKET = "avatars";

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
  // --- 1.0.3 (010_users_ext.sql) ---------------------------------------------------------------
  /** §2.4's mute deadline. ⚠ There is deliberately NO `is_muted` column: 「他现在被禁言了吗」 is
   *  `muted_until > now()`, derived rather than stored, so a served mute expires by itself. */
  muted_until: string | null;
  /** §3.1.2's ISO 3166-1 alpha-2, written only by `geo-update`. */
  country_code: string | null;
  country_updated_at: string | null;
  /** §3.1.6 — when true every reader renders 白旗 (`FLAG_FALLBACK`) instead of the flag. */
  hide_country: boolean | null;
  /** §3.2.3 — 'online' | 'busy' | 'hidden', or null for 「没选过」. */
  manual_status: string | null;
  /** Stamped by `touchLastSeen` on every authenticated call — see the note on `requireUser`. */
  last_seen_at: string | null;
  // --- 1.0.5 §二.2 (017_super_admin.sql) --------------------------------------------------------
  /** 'user' | 'admin' | 'super_admin'. THE AUTHORITY — `is_admin` above is trigger-derived from it
   *  (017 explains), so nothing here may decide admin-ness by writing `is_admin` directly. */
  role: string | null;
  // --- 1.0.6 四号 (023_platforms.sql) ------------------------------------------------------------
  /** §一.2's accumulated set, e.g. `['extension','web']`. ⚠ NEVER a stored `'both'` — that value is
   *  DERIVED by `platformTag()` / `public.platform_tag()`, and `users_platforms_known` refuses it.
   *  Written only by `platform-report`; absent (read as 「还没报过」) on a database without 023. */
  platforms: string[] | null;
  last_platform: string | null;
  last_platform_at: string | null;
  // --- 1.0.6 四号 (024_message_read.sql) ---------------------------------------------------------
  /** §2.1.1's five read watermarks — 「自上次进入该分区以来」, NOT 「这条处理完了吗」. Read by the
   *  client so it can count each partition's badge; written by the client (`grant update` on these
   *  five columns only). `null` means 「从未进入过这个分区」. See 024's header for the distinction
   *  from `notifications.read`. */
  friends_read_at: string | null;
  shares_read_at: string | null;
  mentions_read_at: string | null;
  system_read_at: string | null;
  reports_read_at: string | null;
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
  // --- 1.0.3 -----------------------------------------------------------------------------------
  // ⚠ THESE ARE ON THE **OWN-PROFILE** PROJECTION, which is the one `profile-get` builds for the
  // caller. Reading somebody ELSE's 国籍 / 状态 is a different path (011 §3's narrowed `select`
  // grant over PostgREST), and `email` is on this projection precisely because it never leaves
  // through the other one. Adding a field here is therefore safe for the caller's own screen and
  // says nothing about the 他人主页 — do not reuse this interface for it.
  country_code: string | null;
  hide_country: boolean;
  manual_status: string | null;
  last_seen_at: string | null;
  /** §2.4's 「你已被禁言至 YYYY-MM-DD HH:MM」 — null unless a mute is currently in force. The
   *  DURATION, not a boolean; the client derives 「还在禁言中」 the same way the server does. */
  muted_until: string | null;
  // --- 1.0.5 §二.2 ------------------------------------------------------------------------------
  /** ⚠ ONLY EVER THE CALLER'S OWN ROLE. §2.2.5 requires 超级管理员 to be visually identical to an
   *  ordinary admin, so this field exists for one job — letting the console render §2.2.3's
   *  super-only buttons without a second round trip — and `role` is NOT on the column-level SELECT
   *  grant over PostgREST (017 §4), so nobody can read anybody else's. */
  role: string;
  // --- 1.0.6 四号 §二.1.1 ------------------------------------------------------------------------
  /** The five read watermarks (024_message_read.sql). ⚠ ON THE OWN-PROFILE PROJECTION AND DELIBERATELY
   *  NOT ON `ForeignUser`: a watermark is the account's own business, and the whole reason the client
   *  receives them at all is that computing §2.1.2's five badges needs 「自上次进这个分区以来」 — which
   *  is a fact only the caller's own row carries. */
  friends_read_at: string | null;
  shares_read_at: string | null;
  mentions_read_at: string | null;
  system_read_at: string | null;
  reports_read_at: string | null;
}

/**
 * §1.3's 他人主页 projection — the same row MINUS everything that is the account's own business.
 *
 * ⚠ IT IS A SEPARATE FUNCTION FROM `toPublicUser`, NOT A FLAG ON IT. `toPublicUser` deliberately
 * carries `email` (it is what `profile-get` hands the caller about THEMSELVES), so 「拿掉一个字段」
 * is not something a parameter can express safely: the day somebody adds a private column to the
 * own-profile shape, a flag-based version would publish it to every 他人主页 by default. Two named
 * functions mean the dangerous direction is the one that has to be written out.
 *
 * ⚠ `muted_until` IS DROPPED HERE. §2.4's client half prints 「你已被禁言至 …」 to the muted account;
 * telling everyone else that somebody is muted is a moderation record, and §2.3.4 keeps those in the
 * 信箱. `is_banned` is dropped for the same reason and a stronger one — 011 §3 does not grant it, so
 * a banned account is simply ABSENT from a 他人主页 (`users_select_public` requires
 * `is_banned = false`).
 */
export interface ForeignUser {
  id: string;
  username: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: string | null;
  country_code: string | null;
  hide_country: boolean;
  manual_status: string | null;
  last_seen_at: string | null;
}

/**
 * The TypeScript twin of `018_user_directory.sql`, and the only place the two per-reader rules are
 * written on this side of the wire.
 *
 * `opts.self` / `opts.friend` are passed in rather than derived here because this function has no
 * database handle: the caller already knows 「我在看谁」 (`profile-get` compares the target id with
 * `caller.id`) and asks the pair question once. Deriving it here would mean a query inside a pure
 * projection.
 *
 * 1.0.5 审计 P0-2 — **`country_code` is withheld, not merely unrendered.** Before this, 隐藏国籍
 * controlled nothing but which glyph the client drew; `get /rest/v1/users?select=country_code` still
 * answered, so the PRIVACY.md promise was a rendering convention. The account itself always sees its
 * own code (its own settings screen shows what it hid), a friend does too — 「隐藏国籍」 is §3.1.6's
 * 「给陌生人看的旗子」 switch, not a secrecy pact with one's friends — and everyone else gets `null`
 * plus `hide_country: true`, which is what makes the client draw 白旗.
 *
 * 1.0.5 审计 P0-3 — **`last_seen_at` travels only to self and accepted friends.** `presenceState`
 * already refused to report a 隐身 account as 在线, but the raw timestamp was readable by any
 * authenticated caller, and it is stamped every `PRESENCE_BEAT_MS` (60 s) — finer than the dot it
 * feeds. `null` here is indistinguishable from 「好久没上线」 to the client, which is the point.
 */
export function toForeignUser(
  row: UserRow,
  opts?: { self?: boolean; friend?: boolean },
): ForeignUser {
  const self = !!(opts && opts.self);
  const friend = !!(opts && opts.friend);
  return {
    id: row.id,
    username: row.username,
    avatar_url: row.avatar_url,
    bio: row.bio,
    created_at: row.created_at,
    country_code: (row.hide_country === true && !self) ? null : (row.country_code ?? null),
    hide_country: row.hide_country === true,
    manual_status: row.manual_status ?? null,
    last_seen_at: (self || friend) ? (row.last_seen_at ?? null) : null,
  };
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
    country_code: row.country_code ?? null,
    hide_country: row.hide_country === true,
    manual_status: row.manual_status ?? null,
    last_seen_at: row.last_seen_at ?? null,
    // ⚠ A MUTE THAT HAS ALREADY LAPSED IS REPORTED AS NULL, not as its old timestamp. The column
    // keeps the date and `isMuted` is the predicate, but this projection is what the account
    // settings screen renders — handing it a deadline in the past would print 「你已被禁言至
    // (昨天)」 on an account that can post. The rule is one predicate (`isMuted` in the shared
    // block), applied here to a presentation field.
    muted_until: row.muted_until && Date.parse(row.muted_until) > Date.now() ? row.muted_until : null,
    // 1.0.5 §二.2 — the caller's OWN role. Normalised to the three known values so a null from a
    // pre-017 row (or a hand-edited one) reads as `'user'` rather than as `undefined` — the client
    // branches on this string, and an unexpected fourth value would take the 「not a super admin」
    // arm by falling through, which is the safe direction but should be the EXPLICIT one.
    role: toRole(row.role),
    // 1.0.6 四号 §二.1.1 — the five partition watermarks, passed through unchanged. ⚠ `null` IS THE
    // VALUE, not a missing field: 「从未进入过这个分区」 is what makes the client draw 「全部算新的」
    // (`unreadSince`'s epoch fallback) and the 「还没有…」 empty state. Coercing a null to an epoch
    // here would erase the distinction between 「没进过」 and 「1970 年进过」 for the empty state.
    friends_read_at: row.friends_read_at ?? null,
    shares_read_at: row.shares_read_at ?? null,
    mentions_read_at: row.mentions_read_at ?? null,
    system_read_at: row.system_read_at ?? null,
    reports_read_at: row.reports_read_at ?? null,
  };
}

/** §2.2.2's three values, in ONE place. Anything unrecognised is `'user'`. */
export const ROLES = ["user", "admin", "super_admin"] as const;
export type Role = typeof ROLES[number];
export function toRole(value: unknown): Role {
  return (ROLES as readonly string[]).indexOf(String(value)) >= 0 ? (String(value) as Role) : "user";
}
export function isSuperAdminRole(value: unknown): boolean {
  return toRole(value) === "super_admin";
}

/**
 * §2.2.5 「视觉上超级管理员和普通管理员完全相同」 — enforced on the WIRE, not in the renderer.
 *
 * Everywhere a caller can see somebody else's role (`admin-list-users`) the value is flattened to
 * `'admin'`, so 「谁是超级管理员」 is not a fact the API hands out at all. A rendering convention
 * would leave the truth one 「View source / Network」 away, and §2.2.1 is explicit that the elevation
 * is 「获取方式隐藏」 rather than merely undecorated.
 *
 * `self` is the caller's OWN row: an account is always told what it really is, because that is what
 * §2.2.5's conditional button needs and it is the only role fact the client is entitled to.
 *
 * ⚠ THE COARSE HALF IS DELIBERATELY PRESERVED: an ordinary admin still sees 「this account is an
 * admin」, which is what §2.2.3's 「罢免普通管理员」 button has to know. Flattening to `'user'` would
 * hide the super admin by making the console unable to list administrators — and demoting a super
 * admin is refused by the Function anyway, so the client does not need the finer value to be safe.
 */
export function roleAsSeenBy(value: unknown, self: boolean): Role {
  const role = toRole(value);
  if (self) return role;
  return role === "user" ? "user" : "admin";
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
  /** 1.0.5 §二.2 — 'user' | 'admin' | 'super_admin', read from the database row on every call.
   *  `isAdmin` above stays the coarse gate the eight admin-* functions already ask; this is the
   *  finer one, and only §2.2.3's three super-only operations consult it. */
  role: Role;
  isSuperAdmin: boolean;
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
/**
 * Stamp `users.last_seen_at`, at most once per `PRESENCE_BEAT_MS`, and never fatally.
 *
 * See the call site in `requireUser` for why the beat lives on the auth path and why 011 does not
 * grant the column to the client. This function owns the two things that make it safe to call on
 * every request:
 *
 *   * THE THROTTLE IS A READ, NOT A TIMER. `userRow` was already loaded, so a fresh row costs one
 *     comparison and no round trip; only a stale one writes. `<=` rather than `<` so a row stamped
 *     exactly one beat ago is refreshed, which keeps the beat from drifting out of phase with
 *     §3.2.1's 2-minute 在线 window on a slow cadence.
 *   * A FAILURE IS LOGGED AND SWALLOWED. Presence is decoration on a profile and this is on the
 *     critical path of every Function in the product — a valid request must never be refused
 *     because a cosmetic timestamp could not be written.
 *
 * ⚠ An UNPARSEABLE `last_seen_at` (a value from before the column existed, a hand-edited row) reads
 * as stale, so it heals itself on the next call rather than sitting wrong forever.
 */
async function touchLastSeen(sb: SupabaseClient, userRow: UserRow): Promise<void> {
  const now = Date.now();
  const seen = userRow.last_seen_at ? Date.parse(userRow.last_seen_at) : NaN;
  if (!isNaN(seen) && now - seen < PRESENCE_BEAT_MS) return;
  try {
    const { error } = await sb
      .from("users")
      .update({ last_seen_at: new Date(now).toISOString() })
      .eq("id", userRow.id);
    if (error) console.error("client: last_seen beat failed:", error);
  } catch (err) {
    console.error("client: last_seen beat threw:", err);
  }
}

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

  // -------------------------------------------------------------------------------------------
  // 1.0.3 §3.2 — the presence beat
  // -------------------------------------------------------------------------------------------
  // §3.2.1 defines 在线 as 「最近 2 分钟内有活动」, so SOMETHING has to record activity. §3.2.2 uses
  // Supabase Realtime Presence for the live half, and this is the other half: the stored timestamp
  // that answers 「他在线吗」 for an account that is not standing in the room (a 他人主页 opened from
  // the room, a friend list). Without it, every such answer is 离线 and §3.2.4's three display
  // locations show one state.
  //
  // ⚠ IT LIVES HERE BECAUSE THIS IS THE ONE PLACE EVERY AUTHENTICATED CALL PASSES THROUGH, AND
  // BECAUSE 011 DELIBERATELY DOES NOT GRANT `users.last_seen_at` TO THE CLIENT. The alternative — a
  // `presence-beat` Edge Function on a timer, or a client UPDATE — buys nothing and costs either an
  // eleventh Function or a column a client could pin to 「刚刚」 forever, which is a capability
  // `manual_status` does not give it (011 §4 explains why 隐身/忙碌 may be chosen but 在线 is not a
  // claim: 在线 means 「按活跃度来」).
  //
  // ⚠ THROTTLED BY THE READ, NOT BY A TIMER. The row is already in hand, so the common case is one
  // comparison and no write; the update happens at most once per PRESENCE_BEAT_MS per account, no
  // matter how many Functions it calls. `PRESENCE_BEAT_MS` comes from the shared block so the beat
  // and §3.2.1's two thresholds stay one arithmetic — it is imported rather than re-declared here,
  // and community.ts does not import this file, so the edge runs one way.
  //
  // ⚠ A FAILED BEAT DOES NOT FAIL THE CALL. This is decoration on a profile; a Function that
  // refused a valid request because a timestamp could not be stamped would trade a working feature
  // for a cosmetic one. Logged, and the row is left as it was.
  await touchLastSeen(sb, userRow);

  return {
    caller: {
      id: claims.sub,
      email: (userRow.email ?? claims.email ?? null),
      token,
      isAdmin: userRow.is_admin === true,
      isBanned: userRow.is_banned === true,
      deletedAt: userRow.deleted_at ?? null,
      // 1.0.5 §二.2 — read from the ROW, never from a claim: a token is minted once and lives 30
      // days, and a role decided at mint time would leave a demoted admin privileged until expiry.
      // (`is_admin` is trigger-derived from `role` in 017, so the two can never disagree.)
      role: toRole(userRow.role),
      isSuperAdmin: isSuperAdminRole(userRow.role),
      row: userRow,
    },
    response: null,
  };
}

/**
 * requireUser + the SUPER-admin gate, for §2.2.3's three operations nobody but the original
 * developer may perform (罢免管理员 / 任命管理员 / 修改全局设置 / 删除用户数据).
 *
 * ⚠ IT IS A SEPARATE FUNCTION FROM `requireAdmin` RATHER THAN A FLAG, for the same reason
 * `toForeignUser` is separate from `toPublicUser`: the dangerous direction (letting an ordinary
 * admin through) must be the one somebody has to type out. A `requireAdmin(req, sb, {super: true})`
 * reads almost identically at the call site to the plain one, and this repo has paid for
 * near-identical call sites before.
 */
export async function requireSuperAdmin(req: Request, sb: SupabaseClient): Promise<RequireUserResult> {
  const result = await requireUser(req, sb);
  if (result.response) return result;
  if (!result.caller.isSuperAdmin) {
    // 403 FORBIDDEN, same code `requireAdmin` uses for the coarse gate: to the caller the two are
    // one fact (「你不够格」), and §2.2.5 requires that nothing about the response distinguishes a
    // super admin from an ordinary one.
    return {
      caller: null,
      response: fail("FORBIDDEN", HttpStatus.FORBIDDEN, "Super administrator privileges required"),
    };
  }
  return result;
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

/**
 * Make a free-text search term safe to drop into a PostgREST filter.
 *
 * PostgREST's filter values are a mini-grammar rather than a string: `,` separates terms, `()` groups,
 * `*` is the like/ilike wildcard, and `\` / `"` escape. A term interpolated raw into
 * `email.ilike.*<term>*` can therefore close the expression and add terms of its own — which on an
 * admin endpoint means an operator (or anyone who can reach one) can turn 「搜索这个用户名」 into
 * 「给我看这个表的所有行」. Stripping the metacharacters is the whole defence: the value that survives
 * can only ever be a substring match.
 *
 * ⚠ IN `_shared` RATHER THAN IN EITHER CALLER. It was private to `admin-list-users` until §2.4.4 gave
 * `admin-list-codes` a 「搜索使用者」 box, and a security predicate with two copies is this project's
 * most expensive shape — the copies stay self-consistent and simply stop agreeing, so no test goes red
 * when one of them forgets a character. (Compare `quotaColumnFor`, which moved into the shared block
 * for the same reason.)
 *
 * ⚠ AN EMPTY RESULT IS MEANINGFUL, NOT AN ERROR: a term made entirely of punctuation sanitises to `""`,
 * and the caller must treat that as 「搜不到」 rather than as 「没有筛选」 — otherwise `*%*` becomes a
 * request for every row.
 */
export function sanitizeSearchQuery(raw: string, maxLen: number = 100): string {
  return String(raw == null ? "" : raw).replace(/[%*,()\\_"']/g, " ").trim().slice(0, maxLen);
}
