// admin-reply-feedback — §2.5.6: answer a Bug / 建议, and tell the submitter.
//
// POST { feedback_id, reply }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, mailed: <bool> }
//   -> 400 { error: 'BAD_REQUEST' }         missing reply / unknown id
//   -> 400 { error: 'CONTENT_TOO_LONG' }
//   -> 403 { error: 'FORBIDDEN' }           not an admin
//   -> 404 { error: 'NOT_FOUND' }           no such feedback row
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// THE REPLY IS WRITTEN FIRST AND MAILED SECOND, AND A MAIL FAILURE IS NOT AN ERROR
// ---------------------------------------------------------------------------------------------
// §2.5.7 makes the notification 「可选」 and this function treats it that way in the strong sense:
// `admin_reply` / `replied_at` / `status` are committed BEFORE `sendFeedbackReply` is called, and
// its result only ever changes the `mailed` flag in the response.
//
// The alternative — mail first, store on success — has two failures that are both worse than a
// missing notification. Resend refusing (an unverified domain on a fresh deployment; see the ⚠ in
// _shared/email.ts) would throw away a reply the admin has already typed and has no copy of. And a
// mail that goes out while the store fails leaves the user holding an answer the operator's own
// inbox does not contain. So the durable half goes first, and `mailed: false` tells the admin to
// relay it by hand — which is a recoverable situation, unlike either of the above.
//
// ⚠ MAIL GOES TO THE ACCOUNT'S OWN ADDRESS, NOT TO `feedback.email`. §2.5.2 stores the submitter's
// optional 联系方式 in that column and §2.5.7's sample mails `userEmail` — spelled as if it were the
// account address. It is not: the column holds whatever was typed into an optional field (a phone
// number, a QQ), and using it as a recipient would make this function send operator-authored mail to
// an arbitrary address a stranger supplied. The account's own `email` is the one address in the
// system that was PROVEN (§2.4's whole design) to belong to its owner.
//
// ⚠ AND `mailed` IS A FACT ABOUT THIS CALL, NOT ABOUT THE USER. It says the provider accepted the
// message, not that anybody read it — the same distinction `auth-send-code` draws.

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
import { sendFeedbackReply } from "../_shared/email.ts";
import { FEEDBACK_CONTENT_MAX, type FeedbackRow } from "../_shared/community.ts";

/** A uuid, loosely — enough to refuse a hand-typed id before it reaches Postgres and 22P02s. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const id = typeof body.feedback_id === "string" ? body.feedback_id.trim() : "";
    if (!UUID_RE.test(id)) return badRequest("Missing or malformed feedback_id");

    const rawReply = body.reply;
    if (typeof rawReply !== "string" || rawReply.trim() === "") return badRequest("Missing reply");
    const reply = rawReply.trim();
    if (reply.length > FEEDBACK_CONTENT_MAX) {
      return fail("CONTENT_TOO_LONG", HttpStatus.BAD_REQUEST,
        `reply may be at most ${FEEDBACK_CONTENT_MAX} characters`);
    }

    const { data: row, error: readError } = await sb
      .from("feedback")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw readError;
    // 404 rather than 403: the caller IS an admin (checked above), so the only thing left to explain
    // is that the row they named is not there.
    if (!row) return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such feedback");

    const feedback = row as FeedbackRow;
    const nowIso = new Date().toISOString();

    // `status: 'resolved'` is §2.5.6's step 3 verbatim. `updated_at` is set here because §2.5.2
    // declares the column with a DEFAULT and no trigger — a default only fires on INSERT, so without
    // this line 「最后更新」 would report the moment the report was FILED for every row forever.
    const { error: writeError } = await sb
      .from("feedback")
      .update({ admin_reply: reply, replied_at: nowIso, status: "resolved", updated_at: nowIso })
      .eq("id", id);
    if (writeError) throw writeError;

    // Best-effort, exactly as documented in the header. `feedback.email` is deliberately NOT the
    // recipient — see the ⚠ above.
    let mailed = false;
    const to = (auth.caller.email ?? "").trim();
    if (to) {
      const sent = await sendFeedbackReply(to, feedback.title, reply);
      mailed = sent.ok;
      if (!sent.ok) {
        console.error(`admin-reply-feedback: reply stored but not mailed for ${id}: ${sent.message}`);
      }
    }

    return json({ ok: true, mailed });
  } catch (err) {
    console.error("admin-reply-feedback failed:", err);
    return internal("Could not record the reply");
  }
});
