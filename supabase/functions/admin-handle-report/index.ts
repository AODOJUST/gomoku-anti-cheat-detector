// admin-handle-report — §2.3.1's 警告 / 禁言 24 小时 / 禁言 7 天 / 封禁, and §2.2's `status`.
//
// POST { report_id, action, note? }   Authorization: Bearer <admin jwt>
//   -> 200 { ok: true, report, user }        `user` is the target's row after the action
//   -> 400 { error: 'BAD_REQUEST' }          unknown action / missing id / over-length note
//   -> 401 { error: 'UNAUTHORIZED' }         no/invalid token
//   -> 403 { error: 'FORBIDDEN' }            not an administrator
//   -> 404 { error: 'NOT_FOUND' }            no such report
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHERE EACH ACTION'S EFFECT IS WRITTEN (the split 009_reports.sql explains in full)
// ---------------------------------------------------------------------------------------------
// 警告     -> `users` unchanged; a `notifications` row of kind 'warn' is the whole effect (§2.3.1)
// 禁言 24h -> `users.muted_until = now() + 24h`   — the DURATION, never a boolean
// 禁言 7d  -> `users.muted_until = now() + 7d`
// 封禁     -> `users.is_banned = true`            — a DIFFERENT column, and not a long mute
// none     -> recorded as the decision, changes nothing
//
// ⇒ A mute and a ban are not the same mechanism at different lengths, and this file must not
// conflate them: §2.4's mute leaves the community readable (「可查看社区，只是不能发言」) while §6.2's
// ban closes every cloud feature. `muteUntil('ban')` therefore returns null on purpose — see
// `_shared/community.ts`.
//
// ⚠ THE REPORT'S OUTCOME IS RECORDED IN `admin_action`, AND THE STATE IS IN `users`. Two writes,
// one transaction's worth of intent, and no attempt to make them atomic beyond ordering them so the
// state lands first: an action that took effect but was not recorded is recoverable (the user
// notices the mute), whereas a report marked 「已禁言」 with nobody muted is a lie the 信箱 repeats
// forever. `handled_at` is stamped on every path, including 'none' — §2.3.4's 「已处理」 filter reads
// it, and a dismissed report is handled.
//
// ⚠ BOTH PARTIES ARE NOTIFIED. §2.3.1 only describes 警告's notification, and §七.2 asks
// 「是否需要自动通知举报人」 as an open question. This release answers it YES and records the choice:
// a reporter who never hears back files the next one by hand, or stops filing. The reporter's row is
// kind 'report_result' and carries the UPDATED status, not the action — they are told their report
// was dealt with, not what was done to somebody else.

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
import { requireAdmin, serviceClient } from "../_shared/client.ts";
import {
  ADMIN_ACTIONS,
  muteUntil,
  REPORT_NOTE_MAX,
  type ReportRow,
} from "../_shared/community.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    const auth = await requireAdmin(req, sb);
    if (auth.response) return auth.response;
    // Note: the ADMIN's identity is not recorded on the report. §2.2's table has no `handled_by`
    // column, and adding one would mean the 信箱 could attribute a sanction to a named human —
    // which is a policy decision about the moderation team rather than a gap in this function.

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const reportId = typeof body.report_id === "string" ? body.report_id.trim() : "";
    if (!reportId) return badRequest("Missing report_id");

    const action = typeof body.action === "string" ? body.action : "";
    if (ADMIN_ACTIONS.indexOf(action) === -1) {
      return badRequest(`action must be one of: ${ADMIN_ACTIONS.join(", ")}`);
    }

    const rawNote = body.note;
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
      return badRequest("note must be a string");
    }
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (note.length > REPORT_NOTE_MAX) {
      return badRequest(`note must be at most ${REPORT_NOTE_MAX} characters`);
    }

    const { data: found, error: findError } = await sb
      .from("reports")
      .select("*")
      .eq("id", reportId)
      .maybeSingle();
    if (findError) throw findError;
    if (!found) return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such report");
    const report = found as ReportRow;

    // =========================================================================================
    // 1. the effect on the account (before the bookkeeping — see the header)
    // =========================================================================================
    let userPatch: Record<string, unknown> | null = null;
    let notificationKind: string | null = null;

    if (action === "ban") {
      // §2.3.1 「封禁 | 不能使用任何云功能 | users.is_banned = true」. The existing token keeps
      // working until it expires, which is why `is_member()` (011) and `accountRefusal` both read
      // the column on EVERY call rather than trusting a claim.
      userPatch = { is_banned: true };
      notificationKind = "ban";
    } else if (action === "mute-24h" || action === "mute-7d") {
      const until = muteUntil(action);
      // ⚠ THROWN RATHER THAN TOLERATED. `muteUntil` reads `MUTE_DURATIONS_MS`, which is the same
      // table `ADMIN_ACTIONS` is derived from, so a null here means the two have drifted apart. The
      // tolerant version — `if (until) userPatch = …` with `notificationKind` set regardless — would
      // notify 「你被禁言了」 while nothing was written, which is exactly the lie this file's header
      // refuses to tell in the other direction. A 500 says the truth: the action did not happen.
      if (!until) throw new Error(`No mute duration for action "${action}"`);
      userPatch = { muted_until: until };
      notificationKind = "mute";
    } else if (action === "warn") {
      notificationKind = "warn";
    }
    // `none` deliberately sets neither: §2.3.1's 「'none'」 is 「查过了，不处理」, which is a
    // decision worth recording and nothing else.

    let updatedUser: Record<string, unknown> | null = null;
    if (userPatch) {
      const { data, error } = await sb
        .from("users")
        .update(userPatch)
        .eq("id", report.reported_id)
        .select("*")
        .single();
      if (error) throw error;
      updatedUser = data as Record<string, unknown>;
    }

    // =========================================================================================
    // 2. the report's record
    // =========================================================================================
    // §2.2's `status`: every action but 'none' resolves the report; 'none' closes it as dismissed,
    // because §2.3.4's filter list has 「已处理」 and a report that stays 'open' after an admin has
    // read it is a queue that never empties.
    const status = action === "none" ? "dismissed" : "resolved";
    const { data: updatedReport, error: updateError } = await sb
      .from("reports")
      .update({
        status,
        admin_action: action,
        admin_note: note === "" ? null : note,
        handled_at: new Date().toISOString(),
      })
      .eq("id", report.id)
      .select("*")
      .single();
    if (updateError) throw updateError;

    // =========================================================================================
    // 3. the two notifications
    // =========================================================================================
    const rows: Record<string, unknown>[] = [];

    if (notificationKind) {
      rows.push({
        user_id: report.reported_id,
        kind: notificationKind,
        // ⚠ `title`/`body` carry the ADMIN's wording where there is any, and nothing where there
        // is not — the client substitutes its own translated sentence keyed on `kind`. See
        // 009_reports.sql's note on why this is data rather than a translation key.
        title: null,
        body: note === "" ? null : note,
        data: { report_id: report.id, action },
      });
    }

    // The reporter's acknowledgement (§七.2, answered yes — see the header). ⚠ No `action` in
    // `data`: what happened to the reported account is between the admin and that account, and a
    // reporter who learns 「他因为你的举报被封了」 has been handed a lever.
    rows.push({
      user_id: report.reporter_id,
      kind: "report_result",
      title: null,
      body: null,
      data: { report_id: report.id, status },
    });

    const { error: notifyError } = await sb.from("notifications").insert(rows);
    // ⚠ A failed notification does not undo the action. The mute/ban is already in force and the
    // report is already recorded; rolling back a sanction because a courtesy note could not be
    // written would be the wrong trade. Logged, not thrown — same rule as `friend-share`'s counter.
    if (notifyError) console.error("admin-handle-report notify failed:", notifyError);

    return json({ ok: true, report: updatedReport, user: updatedUser });
  } catch (err) {
    console.error("admin-handle-report failed:", err);
    return internal("Could not handle the report");
  }
});
