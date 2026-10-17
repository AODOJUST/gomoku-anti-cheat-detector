// admin-platform-stats — 1.0.6 四号 §一.5.3: the console's 平台统计 census.
//
// POST {}   Authorization: Bearer <jwt>
//   -> 200 { ok: true, stats: { users: {...}, logins7d: {...}, generated_at } }
//   -> 401 { error: 'UNAUTHORIZED' }
//   -> 403 { error: 'FORBIDDEN' }
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// ⚠ WHY THIS IS ITS OWN ENDPOINT RATHER THAN TWO FIELDS ON `admin-list-users`
// ---------------------------------------------------------------------------------------------
// §1.5.3's panel is a census of the WHOLE PRODUCT, and `admin-list-users` returns a PAGE of fifty —
// so the only thing a count assembled there could describe is 「这一页」. The 1.0.5 audit's finding
// 「计数必须在数据库」 is exactly this shape, and the counting cannot happen over PostgREST at all:
// PostgREST can count the rows a FILTER matches, but «仅扩展» is a property of a DERIVED tag
// (`platform_tag`) and 「近 7 天」 is a window over a second table, so the aggregate has to be SQL.
//
// ⇒ The counting lives in `public.platform_stats()` (023_platforms.sql) and this Function is the
// admin-gated door to it — the same arrangement `admin-list-codes` has with the code table's RLS:
// the data is service-role-only, and the door re-verifies the caller against `users.is_admin` on
// every call. Nothing is cached; a census that lags its own panel is worse than a slow one.
//
// ⚠ THE RESPONSE IS NESTED — `{ ok, stats }`, NOT `{ ok, …counts }` — AND THE CLIENT'S STUB MUST
// MATCH IT. That is 1.0.6 三号's own lesson, paid for once already: `admin-global-chat` answers
// `{ ok, settings }` and the client reads `res.data.settings`, so a FLAT stub in a test judged a
// working product red. Stating the shape here is what makes the harness's copy checkable rather than
// guessable.
//
// ⚠ WHAT THE FOUR USER BUCKETS MEAN, AND WHY 「未上报」 IS ONE OF THEM. §1.5.3 draws three lines
// (仅扩展 / 仅网页 / 两者); the SQL also returns `none` and `total`. `none` is every account whose
// client has not reported — which, on the day this ships, is every existing account — so without a
// fourth line the three numbers visibly do not add up to the account total, and the first person to
// notice will "fix" it by counting something other than accounts. The console renders it as 「未上报」
// rather than hiding it.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();

    const auth = await requireAdmin(req, sb);
    if (auth.response) return auth.response;

    // One aggregate, in the database, under `security definer` — see the header. `rpc` rather than
    // a table read because the answer is a computed object, not rows: there is nothing to select.
    const { data, error } = await sb.rpc("platform_stats");
    if (error) throw error;

    // ⚠ `data` IS THE jsonb OBJECT THE FUNCTION BUILT, and it is passed through rather than
    // re-assembled here. Rebuilding it field by field in Deno would be a second spelling of the
    // census — the exact shape this project has paid for six times — and the day a bucket is added
    // to the SQL, this Function would silently drop it.
    return json({ ok: true, stats: data ?? {} });
  } catch (err) {
    console.error("admin-platform-stats failed:", err);
    return internal("Could not read platform statistics");
  }
});
