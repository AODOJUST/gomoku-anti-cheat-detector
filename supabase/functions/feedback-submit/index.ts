// feedback-submit — §2.5.4: file a Bug / 建议 into the admin's inbox.
//
// POST { category, title, content, contact? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, feedback: { id, category, title, content, status, created_at } }
//   -> 400 { error: 'BAD_REQUEST' }         missing/blank field, or an unknown category
//   -> 400 { error: 'CONTENT_TOO_LONG' }    over one of the limits (see _shared/community.ts)
//   -> 400 { error: 'CONTENT_REJECTED' }    §2.3.5's word list, reused — see below
//   -> 403 { error: 'NOT_ACTIVATED' }       §2.1
//   -> 409 { error: 'RATE_LIMITED' }
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY THIS FUNCTION EXISTS, GIVEN §2.5.3 SHOWS AN INSERT POLICY
// ---------------------------------------------------------------------------------------------
// Same reasoning as `chat-send`: 005_community.sql does not create §2.5.3's `feedback_insert`. RLS
// can check 「is this your row」 and nothing else, and what this table needs checked is the SHAPE of
// the row — a category that exists, a title that is a title, a body inside its limit — because the
// other end of it is a human being reading a table in Studio. An unbounded `content` is not a
// theoretical problem when §2.5.6's recommended surface has no pagination for a single row.
//
// ⚠ §2.3.5's word list is applied here too, which the spec does not ask for. §2.3.5 scopes the
// filter to 聊天室 and §2.5 says nothing about it. The reason it is applied anyway: this is the ONE
// channel that reaches the operator's own inbox and sends mail to an address the submitter chooses
// (the optional 联系方式), so a word list that guards the public room but not the private one guards
// the wrong door. It costs one function call and it is the same list — no second vocabulary.
//
// ⚠ AND THE CONTACT FIELD IS NOT TRUSTED AS AN ADDRESS. §2.5.4 asks for 「联系方式（可选）」, which
// is whatever the submitter types: a phone number, a QQ, an email. It is stored in `feedback.email`
// because that is §2.5.2's column, but nothing sends mail to it automatically — the only mail this
// feature sends is `admin-reply-feedback`'s, and that one goes to the account's own address.

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
  censorHit,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_RATE_MAX,
  FEEDBACK_RATE_WINDOW_MS,
  FEEDBACK_TITLE_MAX,
  type FeedbackRow,
  recentCount,
} from "../_shared/community.ts";

/** The projection the submitter gets back. §2.5.5 renders it; `admin_reply` is not in it yet. */
function publicFeedback(row: FeedbackRow): Record<string, unknown> {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    status: row.status,
    admin_reply: row.admin_reply,
    replied_at: row.replied_at,
    created_at: row.created_at,
  };
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

    if (!caller.row?.activated_at) {
      return fail("NOT_ACTIVATED", HttpStatus.FORBIDDEN, "Activation required for the community");
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    // §2.5.4's 类型. Checked against the shared set rather than accepted as free text: the value is
    // stored and later compared by literal (the admin's filter, this panel's icons), so an invented
    // category is a row nothing can classify. The shared array is the same one the form builds its
    // buttons from, so the two cannot disagree about what is allowed.
    const category = typeof body.category === "string" ? body.category : "";
    if (FEEDBACK_CATEGORIES.indexOf(category) === -1) {
      return badRequest(`category must be one of: ${FEEDBACK_CATEGORIES.join(", ")}`);
    }

    const rawTitle = body.title;
    if (typeof rawTitle !== "string" || rawTitle.trim() === "") return badRequest("Missing title");
    const title = rawTitle.trim();

    const rawContent = body.content;
    if (typeof rawContent !== "string" || rawContent.trim() === "") {
      return badRequest("Missing content");
    }
    const content = rawContent.trim();

    // §2.5.4's 「联系方式（可选）」. Absent and empty are the same thing here, so the two shapes a
    // form can send for 「the operator left it blank」 do not produce two different rows.
    const rawContact = body.contact;
    if (rawContact !== undefined && rawContact !== null && typeof rawContact !== "string") {
      return badRequest("Invalid contact");
    }
    const contact = typeof rawContact === "string" ? rawContact.trim() : "";

    // One length check per field, each naming its own limit — a single 「内容过长」 for three
    // different fields leaves the submitter editing the wrong one.
    if (title.length > FEEDBACK_TITLE_MAX) {
      return fail("CONTENT_TOO_LONG", HttpStatus.BAD_REQUEST,
        `title may be at most ${FEEDBACK_TITLE_MAX} characters`);
    }
    if (content.length > FEEDBACK_CONTENT_MAX) {
      return fail("CONTENT_TOO_LONG", HttpStatus.BAD_REQUEST,
        `content may be at most ${FEEDBACK_CONTENT_MAX} characters`);
    }
    if (contact.length > FEEDBACK_CONTACT_MAX) {
      return fail("CONTENT_TOO_LONG", HttpStatus.BAD_REQUEST,
        `contact may be at most ${FEEDBACK_CONTACT_MAX} characters`);
    }

    // Both free-text fields, one hit test each. `title` is checked too because it is the field that
    // shows up in §2.5.5's list and in §2.5.7's mail subject line.
    const term = censorHit(title) ?? censorHit(content);
    if (term) {
      return fail("CONTENT_REJECTED", HttpStatus.BAD_REQUEST, `Blocked term: ${term}`);
    }

    const recent = await recentCount(sb, "feedback", caller.id, FEEDBACK_RATE_WINDOW_MS);
    if (recent >= FEEDBACK_RATE_MAX) {
      return fail("RATE_LIMITED", HttpStatus.CONFLICT,
        `At most ${FEEDBACK_RATE_MAX} reports per ${FEEDBACK_RATE_WINDOW_MS / 60000} minutes`);
    }

    // `username` from the account, `email` from the form: §2.5.2 stores both so §2.5.6's Studio view
    // and §2.5.7's reply have what they need without a join. Only `email` can be absent — a
    // registered account always has a username.
    const { data, error } = await sb
      .from("feedback")
      .insert({
        user_id: caller.id,
        username: caller.row?.username ?? null,
        email: contact || caller.email || null,
        category,
        title,
        content,
      })
      .select("*")
      .single();
    if (error) throw error;

    return json({ ok: true, feedback: publicFeedback(data as FeedbackRow) });
  } catch (err) {
    console.error("feedback-submit failed:", err);
    return internal("Could not submit the report");
  }
});
