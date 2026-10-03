// admin-list-users -- paged, filterable user directory for the admin console.
//
// POST { page?, limit?, filter? }   Authorization: Bearer <jwt>
//   -> 200 { users: [...], total }
//
// requiresAdmin: JWT is re-verified and users.is_admin is read from the database on
// every call. Rows are returned through an explicit projection so a schema change can
// never accidentally leak a new sensitive column to the console.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, serviceClient, toPublicUser, type UserRow } from "../_shared/client.ts";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_PAGE = 1;
const MAX_QUERY_LENGTH = 100;

/** Admin console needs the ban/deletion state on top of the public projection. */
function toAdminUser(row: UserRow): Record<string, unknown> {
  return {
    ...toPublicUser(row),
    is_banned: row.is_banned === true,
    deleted_at: row.deleted_at,
  };
}

/**
 * PostgREST filter values are a mini-grammar: commas separate terms, parentheses group,
 * `*` is the like/ilike wildcard. Strip those (plus backslash and quotes) so an
 * operator cannot inject extra filter terms, then cap the length.
 */
function sanitizeQuery(raw: string): string {
  return raw.replace(/[%*,()\\_"']/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
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
        const q = sanitizeQuery(filter.query);
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
    return json({ users: rows.map(toAdminUser), total: count ?? 0 });
  } catch (err) {
    console.error("admin-list-users failed:", err);
    return internal("Could not list users");
  }
});
