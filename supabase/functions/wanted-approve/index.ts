// wanted-approve — 1.0.7 §2.1.6's 审核, and §2.1.3's third filter state.
//
// POST { wanted_id, action: 'approve' | 'reject' | 'resolve', note? }   Authorization: Bearer <admin jwt>
//   -> 200 { ok: true, wanted }
//   -> 400 { error: 'BAD_REQUEST' }   missing id / unknown action / over-length note
//   -> 401 { error: 'UNAUTHORIZED' }  no/invalid token
//   -> 403 { error: 'FORBIDDEN' }     not an administrator
//   -> 404 { error: 'NOT_FOUND' }     no such entry
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHERE EACH ACTION'S EFFECT LANDS
// ---------------------------------------------------------------------------------------------
// approve -> `status = 'approved'`, `approved_at = now()`, `approved_by = <the admin>`
// reject  -> `status = 'rejected'`
// resolve -> `status = 'resolved'`
//
// ⚠ `approved_at` / `approved_by` ARE WRITTEN ONLY ON `approve`, and that is not an oversight about
// the other two: the columns say WHO VOUCHED FOR THIS ENTRY, and a rejection is not a vouch. Stamping
// them on every decision would make 「谁批的」 unanswerable — the question a future appeal asks first
// (§2.1.9's 「被举报玩家可申诉（未来接口）」).
//
// ⚠ `resolve` IS NOT `approve` AND NOT A DELETE. §2.1.3 draws 已解决 as its own filter, and 026's read
// predicate tests ONLY `status = 'approved'` — so a resolved entry STAYS ON THE WALL. That is §2.1.9
// taken seriously: 「公开的信息只有：用户名、显示名、理由、证据摘要」 is what an approval published, and
// 「这一条办完了」 is not a reason to un-publish an accusation that other people contributed evidence
// to. (If a moderator ever needs to take an entry DOWN, that is a different action with a different
// name, and it does not exist yet — `reject` is for entries that were never public.)
//
// ⚠ THE MODERATOR'S IDENTITY GOES IN `approved_by` AND THE NOTE STAYS OFF THE WALL. 026 grants
// `authenticated` every column EXCEPT `admin_note` and `approved_by`, because §2.1.9 lists what is
// public and a moderator's free-text note is not on the list. The note reaches exactly one reader: the
// submitter, as the notification body below.
//
// ---------------------------------------------------------------------------------------------
// THE SUBMITTER IS NOTIFIED; THE FOLLOWERS ARE NOT (YET)
// ---------------------------------------------------------------------------------------------
// §2.1.6's 「驳回 → 通知提交者」 is implemented for all three actions rather than for the rejection
// alone: a submitter whose entry was approved has to learn that too, or the wall's first public
// accusation against a named person would appear without its author knowing. ⚠ The APPROVAL notice
// names no follower, and cannot: `wanted_followers` rows only exist after the entry is public.
//
// ⚠ The notification's `kind` is `'wanted'` (added to the whitelist by 026) and `data.event` carries
// WHICH of the three happened, because the client words the sentence per event — `kind` answers 「这是
// 关于哪一类事的」 and only the event answers 「发生了什么」. Same split 009 made for `report_result`.
//
// ⚠ A FAILED NOTIFICATION DOES NOT UNDO THE DECISION. The status is already written and it is what the
// wall reads; rolling a moderation decision back because a courtesy note could not be delivered would
// be the wrong trade — the same rule `admin-handle-report` states for its two notifications.

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
  WANTED_ACTIONS,
  WANTED_NOTE_MAX,
  WANTED_STATUS_FOR_ACTION,
  type WantedRow,
} from "../_shared/community.ts";

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

    const wantedId = typeof body.wanted_id === "string" ? body.wanted_id.trim() : "";
    if (!wantedId) return badRequest("Missing wanted_id");

    const action = typeof body.action === "string" ? body.action : "";
    if (WANTED_ACTIONS.indexOf(action) === -1) {
      return badRequest(`action must be one of: ${WANTED_ACTIONS.join(", ")}`);
    }
    const status = WANTED_STATUS_FOR_ACTION[action];

    const rawNote = body.note;
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
      return badRequest("note must be a string");
    }
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (note.length > WANTED_NOTE_MAX) {
      return badRequest(`note must be at most ${WANTED_NOTE_MAX} characters`);
    }

    const { data: found, error: findError } = await sb
      .from("wanted_players")
      .select("*")
      .eq("id", wantedId)
      .maybeSingle();
    if (findError) throw findError;
    if (!found) return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such entry");
    const entry = found as WantedRow;

    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = {
      status,
      admin_note: note === "" ? null : note,
      updated_at: nowIso,
    };
    // See the header — only an approval is a vouch.
    if (action === "approve") {
      patch.approved_at = nowIso;
      patch.approved_by = auth.caller.id;
    }

    const { data: updated, error: updateError } = await sb
      .from("wanted_players")
      .update(patch)
      .eq("id", entry.id)
      .select("*")
      .single();
    if (updateError) throw updateError;

    // ---- the submitter's notice ---------------------------------------------------------------
    // NULL submitter ⇒ the account was purged (026's `on delete set null`). There is nobody to tell,
    // and that is not an error: the entry outlives its author by design.
    if (entry.submitter_id) {
      const { error: notifyError } = await sb.from("notifications").insert({
        user_id: entry.submitter_id,
        kind: "wanted",
        // ⚠ The client substitutes its own translated sentence keyed on `data.event`; `body` carries
        // the moderator's own words where there are any. Exactly the split 009 describes for
        // `warn`'s `admin_note`.
        title: null,
        body: note === "" ? null : note,
        data: { wanted_id: entry.id, event: action, username: entry.suspect_username },
      });
      // Logged, not thrown — see the header.
      if (notifyError) console.error("wanted-approve notify failed:", notifyError);
    }

    return json({ ok: true, wanted: updated });
  } catch (err) {
    console.error("wanted-approve failed:", err);
    return internal("Could not handle the entry");
  }
});
