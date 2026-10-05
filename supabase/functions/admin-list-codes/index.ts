// admin-list-codes -- 1.0.6 三号 §2.3: the 撤销激活码 panel becomes a LIST.
//
// POST { status?: 'all' | 'unused' | 'used' | 'revoked', page?, limit? }   Authorization: Bearer <jwt>
//   -> 200 { codes: [ … ], total: N }
//   -> 400 { error: 'BAD_REQUEST' }   a malformed status / page / limit
//   -> 401 { error: 'UNAUTHORIZED' }
//   -> 403 { error: 'FORBIDDEN' }
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY THIS IS AN ENDPOINT AND NOT A POSTGREST READ, WHICH IS THE OPPOSITE OF THE USUAL ANSWER
// ---------------------------------------------------------------------------------------------
// This project's rule since 1.0.3 is 「读走 PostgREST + RLS，写只走 Edge Function」 — the admin
// console reads `reports` / `feedback` / `news` / `global_settings` through the policies 011 wrote,
// precisely so each has ONE answer to 「谁看得见」. `activation_codes` is the one table where that
// rule produces the wrong result, and 002_rls.sql says so in as many words:
//
//   「activation_codes: NO client policy at all. … Do not add a policy here -- code lookup/validation
//     must stay server-side so codes can never be enumerated.」
//
// §2.3 asks the console to DRAW the codes, so the requirement and that comment are in direct
// tension, and the resolution is NOT to add the policy: an enumerable `activation_codes` is a table
// where anyone holding the shipped anon key plus any valid session can page through every unused
// code and spend them. The console list is therefore a service-role Function with an admin
// re-verification, i.e. the SAME door `admin-generate-code` and `admin-revoke-codes` already use,
// and 002's rule stands unchanged.
//
// ⚠ §2.3 ITSELF ACCEPTS THE CONSEQUENCE: 「显示所有未使用的码」 plus 批量复制 means the codes travel
// to an admin's screen in full. That is by design — an operator cannot hand out a code they cannot
// read — and the mitigation is the one already in place: the projection below is explicit, the
// caller is re-verified against `users.is_admin` on every call, and nothing is cached.
//
// ---------------------------------------------------------------------------------------------
// THE THREE STATES, AND WHY 已撤销 WINS
// ---------------------------------------------------------------------------------------------
// `revoked` and `redeemed` are two INDEPENDENT columns, so they describe four combinations rather
// than three states, and the console shows three labels. The precedence here is
// 已撤销 → 已使用 → 未使用, and the client's `adCodeStatus()` repeats it once:
//
//   · a code revoked by name (`admin-revoke-codes` `{codes:[…]}`) may already have been redeemed —
//     that path does not filter on `redeemed`, by design, because 「这个码泄露了，作废」 applies to a
//     spent code too (it is the historical proof of an activation, which is why revoking it does
//     not un-activate anything);
//   · so 已撤销 is asked FIRST. A row that is both would otherwise read 「已使用」 and the operator
//     would look for it under the wrong filter.
//
// The FILTERS follow the same precedence, which is what makes 「列表里看到什么」 and 「筛出来的条数」
// agree: `used` excludes revoked rows, exactly as the label does.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_PAGE = 1;

/** §2.3's 四个筛选按钮, as wire values. A closed set: an unknown value is refused rather than
 *  treated as 「全部」, so a typo in the console paints an error instead of every code. */
const STATUSES = ["all", "unused", "used", "revoked"] as const;
type Status = typeof STATUSES[number];

/** §2.3.3's 「展开显示生成时间/生成者/备注/状态」 — and nothing else. Explicit, like every other
 *  projection in this project: a column added to `activation_codes` later must not start travelling
 *  to the console by default. */
const COLS = "code,note,issued_by,issued_at,redeemed,redeemed_by,redeemed_at,revoked";

/** One page of rows, plus the 生成者's name resolved in a second read. */
async function withIssuers(
  sb: ReturnType<typeof serviceClient>,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  // One extra read for the WHOLE page rather than a join: 「生成者」 is a uuid in the table and a
  // name on screen, and printing the uuid would be a column the operator cannot use. A page holds
  // at most MAX_LIMIT ids, so the `in` list is bounded by something this file already enforces.
  const ids = Array.from(new Set(
    rows.map((r) => r.issued_by).filter((v): v is string => typeof v === "string" && v !== ""),
  ));
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data, error } = await sb.from("users").select("id,username").in("id", ids);
    // ⚠ A failed name lookup does NOT fail the list. The code, its state and its timestamps are the
    // page's job; a missing username leaves `issuer: null` and the view prints the id, which is
    // less pretty and still true. Throwing here would turn 「某个账号改名」 into 「激活码列表打不开」.
    if (!error) {
      for (const u of (data ?? []) as { id: string; username: string | null }[]) {
        if (u && u.id) names[u.id] = u.username ?? "";
      }
    }
  }
  return rows.map((r) => ({
    code: r.code,
    note: r.note ?? null,
    issued_by: r.issued_by ?? null,
    issued_at: r.issued_at ?? null,
    issuer: (typeof r.issued_by === "string" && names[r.issued_by]) || null,
    redeemed: r.redeemed === true,
    redeemed_at: r.redeemed_at ?? null,
    redeemed_by: r.redeemed_by ?? null,
    revoked: r.revoked === true,
  }));
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
    if (!body) return badRequest("Invalid JSON body");

    // `{}` is `{ status: 'all' }` — the panel's opening view is 全部, and requiring the field would
    // make 「刚打开这一页」 a special case in the client for no gain.
    let status: Status = "all";
    if (body.status !== undefined && body.status !== null) {
      if (typeof body.status !== "string" || !(STATUSES as readonly string[]).includes(body.status)) {
        return badRequest(`status must be one of: ${STATUSES.join(", ")}`);
      }
      status = body.status as Status;
    }

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

    let query = sb.from("activation_codes").select(COLS, { count: "exact" });

    // The precedence in one place — see the header. `unused` needs BOTH columns: `redeemed = false`
    // alone would list a revoked-but-never-spent code as still unused, which is the label 已撤销
    // exists to distinguish.
    if (status === "unused") query = query.eq("revoked", false).eq("redeemed", false);
    else if (status === "used") query = query.eq("revoked", false).eq("redeemed", true);
    else if (status === "revoked") query = query.eq("revoked", true);

    const from = (page - 1) * limit;
    const { data, count, error } = await query
      // Newest first, like every other console list. `code` breaks the tie: a batch generated in one
      // call shares a timestamp down to the microsecond, and without a second key the page boundary
      // is not stable between two requests.
      .order("issued_at", { ascending: false })
      .order("code", { ascending: true })
      .range(from, from + limit - 1);
    if (error) throw error;

    const rows = (data ?? []) as Record<string, unknown>[];
    return json({ codes: await withIssuers(sb, rows), total: count ?? 0 });
  } catch (err) {
    console.error("admin-list-codes failed:", err);
    return internal("Could not list activation codes");
  }
});
