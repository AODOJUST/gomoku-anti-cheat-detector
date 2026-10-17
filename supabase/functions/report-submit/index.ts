// report-submit — §2.1's form → §2.3.4's 管理员信箱.
//
// POST { reported_id, category, detail?, evidence? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, report }
//   -> 400 { error: 'BAD_REQUEST' }   bad category / missing target / over-length detail
//   -> 403 { error: 'NOT_ACTIVATED' | 'MUTED' }   §1.8.1 「举报 ❌ 未激活」
//   -> 404 { error: 'TARGET_NOT_FOUND' }
//   -> 409 { error: 'RATE_LIMITED' }  §2.2 gives no anti-abuse rule; this is the minimum (§shared)
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY A RATE LIMIT THE SPEC DOES NOT ASK FOR
// ---------------------------------------------------------------------------------------------
// §2.2 defines the table and no anti-abuse rule at all, and `reports` is the one table in this
// schema whose every row costs a HUMAN BEING their morning (§2.3.4's 信箱 is worked by hand). 005's
// header made the same call for `feedback` — 「five reports per ten minutes is far above any honest
// use of the form and far below what it takes to bury a 信箱」. Same number, same reasoning, and it
// is `REPORT_RATE_MAX` in the shared block so the client can say 「提交太频繁」 without a round trip.
//
// ⚠ IT COUNTS BOTH DIRECTIONS. The limit is 「how many reports did this account FILE recently」, but
// the abuse it prevents is not only flooding: §2.3.1 lets a report mute or ban its subject, so a
// coordinated set of accounts filing one report each against the same person is the attack. Two
// counts — per reporter and per reported — because the second is the one that makes brigading cost
// something. `reports_not_self` (009) already stops the degenerate case.
//
// ---------------------------------------------------------------------------------------------
// THE EVIDENCE OBJECT
// ---------------------------------------------------------------------------------------------
// §2.2's `evidence` is 「{ message_ids: [], screenshot_urls: [] }」. ⚠ `message_ids` is accepted and
// `screenshot_urls` is accepted but NOT fetched: §2.1's 「[截图]」 control uploads nowhere yet, and a
// Function that took a URL and stored it unvalidated would turn the admin's 信箱 into a place where
// an attacker chooses what the admin's browser loads. The array is stored for the shape's sake and
// rendered as plain text; a real screenshot path needs a bucket and a size limit, which is its own
// change.
//
// ⚠ `message_ids` are NOT verified to belong to the reported user. That is deliberate: §2.1's
// 「选择消息引用」 lets the reporter point at context, and the admin reads the quoted message in the
// 信箱. Verifying ownership would refuse the honest case (a message the reporter saw in the room
// but that has since been deleted) to make a display-only field trustworthy.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  badRequest,
  fail,
  HttpStatus,
  internal,
  json,
  methodNotAllowed,
} from "../_shared/errors.ts";
import { accountRefusal, requireUser, serviceClient } from "../_shared/client.ts";
import {
  communityRefusal,
  refusalMessage,
  REPORT_CATEGORIES,
  REPORT_DETAIL_MAX,
  REPORT_RATE_MAX,
  REPORT_RATE_WINDOW_MS,
  recentCount,
} from "../_shared/community.ts";

/** §2.2's evidence arrays. The set of keys is closed so a client cannot paste arbitrary jsonb into
 *  the admin's inbox — the 信箱 renders this object's keys by name. */
const EVIDENCE_KEYS = ["message_ids", "screenshot_urls"];

/** Normalise the evidence object: only the two known keys, only arrays of strings, capped. */
function cleanEvidence(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  let any = false;
  for (const key of EVIDENCE_KEYS) {
    const raw = src[key];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw)) return null;
    const items = raw
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      // §2.2 says 「相关证据（可选）」 and gives no cap. Twenty is far above 一份举报 and far below
      // what it takes to make one row unrenderable.
      .slice(0, 20)
      .map((v) => v.trim().slice(0, 200));
    if (items.length > 0) {
      out[key] = items;
      any = true;
    }
  }
  return any ? out : null;
}

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const { caller } = auth;

    const refusal = accountRefusal(caller.row);
    if (refusal) return refusal;

    const community = communityRefusal(caller.row);
    if (community) return fail(community, HttpStatus.FORBIDDEN, refusalMessage(community));

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const reportedId = typeof body.reported_id === "string" ? body.reported_id.trim() : "";
    if (!reportedId) return badRequest("Missing reported_id");
    // `reports_not_self` would answer this as a 23514; a sentence is better than a constraint name.
    if (reportedId === caller.id) return badRequest("Cannot report yourself");

    const category = typeof body.category === "string" ? body.category : "";
    if (REPORT_CATEGORIES.indexOf(category) === -1) {
      return badRequest(`category must be one of: ${REPORT_CATEGORIES.join(", ")}`);
    }

    const rawDetail = body.detail;
    if (rawDetail !== undefined && rawDetail !== null && typeof rawDetail !== "string") {
      return badRequest("detail must be a string");
    }
    const detail = typeof rawDetail === "string" ? rawDetail.trim() : "";
    if (detail.length > REPORT_DETAIL_MAX) {
      return badRequest(`detail must be at most ${REPORT_DETAIL_MAX} characters`);
    }
    // §2.1's form has a 详细说明 box that can be left empty; the category alone is a complete
    // report. Unlike `chat-send`, a blank body is not an error here.

    const evidence = cleanEvidence(body.evidence);
    if (body.evidence !== undefined && body.evidence !== null && evidence === null) {
      return badRequest("evidence must be { message_ids?: string[], screenshot_urls?: string[] }");
    }

    // §2.3.1's ladder acts on a PERSON, so the target has to be a live account. `TARGET_NOT_FOUND`
    // rather than 403 for the same reason `friend-request` uses it: 「该用户不存在」 is actionable,
    // 「没有权限」 is not.
    const { data: target, error: targetError } = await sb
      .from("users")
      .select("id, deleted_at, is_banned")
      .eq("id", reportedId)
      .maybeSingle();
    if (targetError) throw targetError;
    if (!target || target.deleted_at) {
      return fail("TARGET_NOT_FOUND", HttpStatus.NOT_FOUND, "No such account");
    }

    // ---- the two counts (§see header) --------------------------------------------------------
    const byReporter = await recentCount(sb, "reports", caller.id, REPORT_RATE_WINDOW_MS, "reporter_id");
    const byTarget = await recentCount(sb, "reports", reportedId, REPORT_RATE_WINDOW_MS, "reported_id");
    if (byReporter >= REPORT_RATE_MAX || byTarget >= REPORT_RATE_MAX) {
      return fail("RATE_LIMITED", HttpStatus.CONFLICT,
        `At most ${REPORT_RATE_MAX} reports per ten minutes`);
    }

    const { data, error } = await sb
      .from("reports")
      .insert({
        reporter_id: caller.id,
        reported_id: reportedId,
        category,
        detail: detail === "" ? null : detail,
        evidence,
      })
      .select("*")
      .single();
    if (error) throw error;

    return json({ ok: true, report: data });
  } catch (err) {
    console.error("report-submit failed:", err);
    return internal("Could not submit the report");
  }
});
