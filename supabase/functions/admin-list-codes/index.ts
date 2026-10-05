// admin-list-codes -- 1.0.6 三号 §2.3: the 撤销激活码 panel becomes a LIST.
//                    1.0.6 四号 §2.4: …and every row can name the account it belongs to.
//
// POST { status?: 'all' | 'unused' | 'used' | 'revoked', filter?: { query? }, page?, limit? }
//   Authorization: Bearer <jwt>
//   -> 200 { codes: [ … ], total: N }
//   -> 400 { error: 'BAD_REQUEST' }   a malformed status / page / limit / filter
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
//
// ---------------------------------------------------------------------------------------------
// 1.0.6 四号 §2.4 — THREE PEOPLE PER ROW, AND WHY THE SEARCH IS NOT A JOIN
// ---------------------------------------------------------------------------------------------
// §2.4.2 asks a 已使用 row to name 使用者（用户名 + 邮箱）; §2.4.3 asks a 已撤销 row to name 撤销者 and
// 撤销时间. All three actors are uuids in this table (`issued_by` / `redeemed_by` / `revoked_by`), so
// ONE `users` read covers the whole page — the same shape `withIssuers` already had, widened from one
// role to three rather than looped three times.
//
// ⚠ AND `email` TRAVELS HERE, WHICH IS THE ONE PLACE IT DOES. 011 §3 deliberately withheld `email`
// from the PostgREST projection of `users`; this endpoint is service-role and admin-gated on every
// call, and §2.4.2 names the email explicitly — 「使用者：张三（zhang@example.com）」 — because two
// accounts can share a username-shaped display name while the email is what identifies one.
//
// ⚠ §2.4.4's 「搜索使用者」 RESOLVES TO IDS FIRST, DELIBERATELY, RATHER THAN EMBEDDING A JOIN. The
// obvious PostgREST spelling is an embedded resource with a filter on it
// (`select=…,users!activation_codes_redeemed_by_fkey(username)`), which requires naming a constraint
// the database generated — 020 replaces that constraint by hand, so the name is a fact about
// migration history rather than about this query. Resolving the term to a set of ids is two reads
// instead of one, needs no knowledge of constraint names, and — the part that matters — cannot
// silently degrade into 「no filter」 if the embed comes back empty.
//
// ⚠ AN EMPTY MATCH IS AN EMPTY PAGE, NOT "NO FILTER". `redeemerIds.length === 0` returns
// `{ codes: [], total: 0 }` rather than falling through to the unfiltered query; the failure that
// hides there is a search box that shows every code whenever it finds nothing.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, sanitizeSearchQuery, serviceClient } from "../_shared/client.ts";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const DEFAULT_PAGE = 1;
const MAX_QUERY_LENGTH = 100;
/**
 * How many accounts a 「搜索使用者」 term may resolve to before the code list it produces stops being
 * the whole answer. The bound exists because the matched ids travel in the `in.(…)` filter, i.e. in
 * the query string — a term matching thousands of accounts would build a URL no proxy will carry and
 * fail with a 414 instead of an answer.
 *
 * ⚠ 100 IS A 「narrow it down」 BOX, NOT A DIRECTORY. The operator has the user list for browsing and
 * the email in hand when they are hunting a specific code holder; typing three characters of a name
 * is how the term gets under this cap.
 */
const MAX_SEARCH_USERS = 100;

/** §2.3's 四个筛选按钮, as wire values. A closed set: an unknown value is refused rather than
 *  treated as 「全部」, so a typo in the console paints an error instead of every code. */
const STATUSES = ["all", "unused", "used", "revoked"] as const;
type Status = typeof STATUSES[number];

/** §2.3.3's 「展开显示生成时间/生成者/备注/状态」 plus §2.4's actors — and nothing else. Explicit, like
 *  every other projection in this project: a column added to `activation_codes` later must not start
 *  travelling to the console by default. `revoked_at` / `revoked_by` arrive with 025. */
const COLS = "code,note,issued_by,issued_at,redeemed,redeemed_by,redeemed_at,revoked,revoked_at,revoked_by";

/** The three columns a row can name a person through. ⚠ ONE LIST, USED FOR BOTH the lookup and the
 *  projection, so adding a fourth actor is one edit rather than four. */
const ACTOR_COLS = ["issued_by", "redeemed_by", "revoked_by"] as const;

interface Person {
  username: string | null;
  email: string | null;
}

/** One `users` read for the whole page, covering every actor column. */
async function loadPeople(
  sb: ReturnType<typeof serviceClient>,
  rows: Record<string, unknown>[],
): Promise<Record<string, Person>> {
  const ids = new Set<string>();
  for (const r of rows) {
    for (const col of ACTOR_COLS) {
      const v = r[col];
      if (typeof v === "string" && v !== "") ids.add(v);
    }
  }
  const people: Record<string, Person> = {};
  if (!ids.size) return people;

  const { data, error } = await sb.from("users").select("id,username,email").in("id", Array.from(ids));
  // ⚠ A failed name lookup does NOT fail the list. The code, its state and its timestamps are the
  // page's job; a missing person leaves the field `null` and the view prints the uuid, which is less
  // pretty and still true. Throwing here would turn 「某个账号改名」 into 「激活码列表打不开」.
  if (!error) {
    for (const u of (data ?? []) as { id: string; username: string | null; email: string | null }[]) {
      if (u && u.id) people[u.id] = { username: u.username ?? null, email: u.email ?? null };
    }
  }
  return people;
}

/** A row of the page, with the three people resolved and `redeemed_*` named as §2.4.2 spells them. */
function project(
  r: Record<string, unknown>,
  people: Record<string, Person>,
): Record<string, unknown> {
  const at = (col: string): Person | null => {
    const id = r[col];
    return typeof id === "string" && id !== "" ? people[id] ?? null : null;
  };
  const redeemer = at("redeemed_by");
  const revoker = at("revoked_by");
  const issuer = at("issued_by");
  return {
    code: r.code,
    note: r.note ?? null,
    issued_by: r.issued_by ?? null,
    issued_at: r.issued_at ?? null,
    issuer: issuer ? issuer.username : null,
    redeemed: r.redeemed === true,
    redeemed_at: r.redeemed_at ?? null,
    redeemed_by: r.redeemed_by ?? null,
    // §2.4.2's two fields, verbatim. ⚠ `null` WHEN THE ACCOUNT WAS PURGED: `redeemed_by` is
    // `on delete set null` (020), so a redeemed code can outlive its holder with `redeemed = true`
    // and no name to show. The view draws 「账号已注销」 for exactly that row rather than treating a
    // null as 「未使用」 — `redeemed` is the flag that decides which state the row is in.
    redeemed_username: redeemer ? redeemer.username : null,
    redeemed_email: redeemer ? redeemer.email : null,
    revoked: r.revoked === true,
    revoked_at: r.revoked_at ?? null,
    revoked_by: r.revoked_by ?? null,
    revoker: revoker ? revoker.username : null,
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

    // §2.4.4's 「搜索使用者」, resolved to a candidate set BEFORE the paged query — see the header.
    let redeemerIds: string[] | null = null;
    if (body.filter !== undefined && body.filter !== null) {
      if (typeof body.filter !== "object") return badRequest("Invalid filter");
      const filter = body.filter as Record<string, unknown>;
      if (filter.query !== undefined && filter.query !== null) {
        if (typeof filter.query !== "string") return badRequest("Invalid filter.query");
        const q = sanitizeSearchQuery(filter.query, MAX_QUERY_LENGTH);
        // A term made entirely of PostgREST metacharacters sanitises to "". Treating that as 「没有
        // 筛选」 is how a search box becomes a way to ask for every row — see the header.
        if (q === "") return json({ codes: [], total: 0 });
        const { data: matched, error: matchErr } = await sb
          .from("users")
          .select("id")
          .or(`username.ilike.*${q}*,email.ilike.*${q}*`)
          .limit(MAX_SEARCH_USERS);
        if (matchErr) throw matchErr;
        redeemerIds = (matched ?? [])
          .map((u) => (u as { id?: unknown }).id)
          .filter((v): v is string => typeof v === "string" && v !== "");
        if (!redeemerIds.length) return json({ codes: [], total: 0 });
      }
    }

    let query = sb.from("activation_codes").select(COLS, { count: "exact" });

    // The precedence in one place — see the header. `unused` needs BOTH columns: `redeemed = false`
    // alone would list a revoked-but-never-spent code as still unused, which is the label 已撤销
    // exists to distinguish.
    if (status === "unused") query = query.eq("revoked", false).eq("redeemed", false);
    else if (status === "used") query = query.eq("revoked", false).eq("redeemed", true);
    else if (status === "revoked") query = query.eq("revoked", true);

    // ⚠ THE SEARCH IS ON `redeemed_by`, NOT ON `revoked_by`: §2.4.4's box is 「搜索使用者」 — the person
    // who SPENT the code. An operator hunting a revoked code searches it by the code itself.
    if (redeemerIds) query = query.in("redeemed_by", redeemerIds);

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
    const people = await loadPeople(sb, rows);
    return json({ codes: rows.map((r) => project(r, people)), total: count ?? 0 });
  } catch (err) {
    console.error("admin-list-codes failed:", err);
    return internal("Could not list activation codes");
  }
});
