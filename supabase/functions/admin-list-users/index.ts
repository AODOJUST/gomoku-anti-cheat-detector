// admin-list-users -- paged, filterable user directory for the admin console.
//
// POST { page?, limit?, filter? }   Authorization: Bearer <jwt>
//   -> 200 { users: [...], total }
//
// requiresAdmin: JWT is re-verified and users.is_admin is read from the database on
// every call. Rows are returned through an explicit projection so a schema change can
// never accidentally leak a new sensitive column to the console.
//
// ---------------------------------------------------------------------------------------------
// 1.0.6 四号 §一.5 / §二.3 — the platform tag, and where the HISTORY comes from
// ---------------------------------------------------------------------------------------------
// §1.5.1 puts a tag on every row (扩展 / 网页 / 两者) and §1.5.2 / §2.3.2 draw 平台历史 一 「扩展：首次
// 2026-10-01，最近 2026-10-03」 — inside the row that is expanded. Both come from this one call:
//
//   THE TAG is `platformTag(row.platforms)` — the shared derivation, NOT a lookup in the log. ⚠ That
//   distinction is the whole design (023_platforms.sql's header): `users.platforms` is the STATE and
//   `platform_logins` is the HISTORY, and deriving the tag from the log would make a pruned log or a
//   failed log INSERT change what platform an account is shown as using.
//
//   THE HISTORY is ONE `platform_history(uuids)` call for the whole page, because it is an aggregate
//   (`min` / `max` / `count` grouped by user and platform) and PostgREST cannot GROUP — fetching the
//   page's log rows and reducing them in Deno would ship every login of fifty accounts to compute
//   four values per platform. ⚠ IT IS BUILT FOR THE PAGE, NOT PER ROW: the expanded row already has
//   its history in hand, so opening it costs no round trip, and a page of fifty is one extra query
//   rather than fifty.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, roleAsSeenBy, sanitizeSearchQuery, serviceClient, toPublicUser, type UserRow } from "../_shared/client.ts";
import { platformTag } from "../_shared/community.ts";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_PAGE = 1;
const MAX_QUERY_LENGTH = 100;

/** One row of `platform_history()`'s result. */
interface PlatformHistoryRow {
  user_id: string;
  platform: string;
  first_at: string | null;
  last_at: string | null;
  logins: number | null;
}

/**
 * §1.5.2's 平台历史, per user, as `{ <userId>: [ … ] }`.
 *
 * ⚠ A MISSING ENTRY AND AN EMPTY ARRAY ARE THE SAME THING TO THE VIEW and that is deliberate: an
 * account that has never reported has no rows here, and the expanded row draws 「—」 rather than an
 * empty 「平台历史：」 heading. So there is nothing to fill in for the absent case.
 *
 * ⚠ A FAILED AGGREGATE DOES NOT FAIL THE PAGE, the same rule `admin-list-codes` states for its
 * issuer lookup: the tag, the name and the ban state are the list's job, the history is a detail
 * inside an expanded row, and throwing here would turn one slow aggregate into 「用户列表打不开」.
 */
async function withPlatformHistory(
  sb: ReturnType<typeof serviceClient>,
  rows: UserRow[],
): Promise<Record<string, PlatformHistoryRow[]>> {
  const ids = rows.map((r) => r.id).filter((v): v is string => typeof v === "string" && v !== "");
  const out: Record<string, PlatformHistoryRow[]> = {};
  if (!ids.length) return out;
  const { data, error } = await sb.rpc("platform_history", { uuids: ids });
  if (error) {
    console.error("platform_history failed:", error);
    return out;
  }
  for (const h of (data ?? []) as PlatformHistoryRow[]) {
    if (!h || typeof h.user_id !== "string") continue;
    (out[h.user_id] = out[h.user_id] || []).push(h);
  }
  return out;
}

/**
 * Admin console needs the ban/deletion state on top of the public projection.
 *
 * 1.0.5 §二.2 adds `role`, run through `roleAsSeenBy` — see that function: the console is told
 * 「user」 or 「admin」 and NEVER 「super_admin」, so the elevation §2.2.1 calls 「获取方式隐藏」 is not
 * a fact the API emits. `self` is passed so the caller's own row (which `toPublicUser` already
 * carries truthfully) is not the one inconsistent entry in the list.
 *
 * 1.0.6 四号 adds 平台痕迹: the RAW array (so the console can decide its own rendering), the DERIVED
 * tag (from the shared `platformTag`, so the console does not re-derive it and the panel filters do
 * not invent a second rule), the last-seen pair, and `platform_history` (filled in by the caller, one
 * aggregate for the whole page).
 */
function toAdminUser(
  row: UserRow,
  viewerId: string,
  history: Record<string, PlatformHistoryRow[]>,
): Record<string, unknown> {
  return {
    ...toPublicUser(row),
    role: roleAsSeenBy(row.role, row.id === viewerId),
    is_banned: row.is_banned === true,
    deleted_at: row.deleted_at,
    // ⚠ `Array.isArray` rather than `row.platforms ?? []`: on a database where 023 has not run the
    // field is absent, and an absent field must read as 「还没报过」 rather than reach the console as
    // `undefined` (which would render as the string "undefined" in a `<span>`).
    platforms: Array.isArray(row.platforms) ? row.platforms : [],
    platform_tag: platformTag(row.platforms),
    last_platform: row.last_platform ?? null,
    last_platform_at: row.last_platform_at ?? null,
    platform_history: history[row.id] ?? [],
  };
}

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();

    const auth = await requireAdmin(req, sb);
    if (auth.response) return auth.response;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    let limit = DEFAULT_LIMIT;
    if (body.limit !== undefined) {
      if (typeof body.limit !== "number" || !Number.isInteger(body.limit)) {
        return badRequest("limit must be an integer");
      }
      limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, body.limit));
    }

    let page = DEFAULT_PAGE;
    if (body.page !== undefined) {
      if (typeof body.page !== "number" || !Number.isInteger(body.page) || body.page < 1) {
        return badRequest("page must be a positive integer");
      }
      page = body.page;
    }

    let query = sb.from("users").select("*", { count: "exact" });

    if (body.filter !== undefined && body.filter !== null) {
      if (typeof body.filter !== "object") return badRequest("Invalid filter");
      const filter = body.filter as Record<string, unknown>;

      if (filter.query !== undefined && filter.query !== null) {
        if (typeof filter.query !== "string") return badRequest("Invalid filter.query");
        const q = sanitizeSearchQuery(filter.query, MAX_QUERY_LENGTH);
        if (q !== "") {
          // `*` is PostgREST's like/ilike wildcard.
          query = query.or(`email.ilike.*${q}*,username.ilike.*${q}*`);
        }
      }
      if (typeof filter.banned === "boolean") {
        query = query.eq("is_banned", filter.banned);
      }
      if (typeof filter.admin === "boolean") {
        query = query.eq("is_admin", filter.admin);
      }
    }

    const from = (page - 1) * limit;
    const { data, count, error } = await query
      .order("created_at", { ascending: false })
      .range(from, from + limit - 1);
    if (error) throw error;

    const rows = (data ?? []) as UserRow[];
    const history = await withPlatformHistory(sb, rows);
    return json({
      users: rows.map((row) => toAdminUser(row, auth.caller.id, history)),
      total: count ?? 0,
    });
  } catch (err) {
    console.error("admin-list-users failed:", err);
    return internal("Could not list users");
  }
});
