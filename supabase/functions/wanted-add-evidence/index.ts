// wanted-add-evidence — 1.0.7 §2.1.7's 「补充证据」.
//
// POST { wanted_id, kind: 'archive' | 'sample' | 'comment', payload }
//   Authorization: Bearer <jwt>
//   -> 200 { ok: true, evidence, follower_count, notified }
//   -> 400 { error: 'BAD_REQUEST' }   missing id / unknown kind / malformed payload
//   -> 403 { error: 'NOT_ACTIVATED' | 'MUTED' }
//   -> 404 { error: 'NOT_FOUND' }     no such entry, or it is not public
//   -> 409 { error: 'RATE_LIMITED' }  ten pieces per ten minutes (§shared)
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// ⚠⚠ 「上传本地存档 / 样本」 PUBLISHES A LABEL, NOT THE FILE, AND THAT IS THE PRIVACY-CORRECT READING
// ---------------------------------------------------------------------------------------------
// §2.1.7 says 「用户可上传本地存档/样本作为证据」. Shipping an actual upload here would mean putting an
// archive on a PUBLIC wall — and an archive is somebody else's game: their moves, their name, their
// room id, the whole 定方. §2.1.9 is unambiguous about what the wall may publish (「公开的信息只有：用户
// 名、显示名、理由、证据摘要」), and a raw archive is on the wrong side of that sentence: it is not a
// summary, it is the evidence itself, and the person in it never agreed to anything.
//
// ⇒ The payload is `{ name, summary? }` — the label the wall's card draws (「3 个存档」) — and it is
// written by the person who has the file. The moderator, who has §2.1.6's queue, can ask for the file
// through the same channel every other kind of evidence travels (a friend share, §1.2.3). A real
// upload would need its own retention window, its own access rule and its own decision; it is
// deliberately NOT smuggled in under a comment box.
//
// ⚠ `kind: 'archive' | 'sample'` IS THEREFORE A LABEL TYPE, NOT A MIME TYPE, and the two are kept
// apart from `'comment'` because the card renders them differently (a chip versus a paragraph) and
// because the counts on the wall's 证据 line are per kind.
//
// ---------------------------------------------------------------------------------------------
// THE FOLLOWERS ARE NOTIFIED, WHICH IS §2.1.7's WHOLE POINT
// ---------------------------------------------------------------------------------------------
// 「被跟踪的嫌疑人若新增证据，跟踪者收到通知」. One `notifications` row per follower, kind `'wanted'`
// (the whitelist entry 026 adds) with `data.event = 'evidence'` — the same code the approval notice
// uses, worded differently by the client, because both are 「你关注的这条有新进展」.
//
// ⚠ THE ACTOR IS EXCLUDED. A reader who contributes to an entry they follow should not receive a
// notification about their own contribution — that is the 「自己给自己的消息」 shape which trains
// people to ignore the badge.
//
// ⚠ THE FAN-OUT IS CAPPED, AND THE CAP IS REPORTED. 500 rows in one insert is the whole of a busy
// wall's follower base; a cap that silently truncated would make 「notified」 a lie, so the number of
// rows actually written is returned and the client renders 「已通知 N 人」. A failure of the fan-out
// does NOT undo the evidence (the same rule `admin-handle-report` and `wanted-approve` state): the
// evidence is on the wall, and a courtesy note that could not be written is not a reason to delete it.
//
// ⚠ THE PARENT'S `updated_at` MOVES. §2.1.7 makes 「有新证据的排在前面」 a property of the wall, and that
// is the column 026 added for it.

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
  recentCount,
  refusalMessage,
  SHARE_NAME_MAX,
  WANTED_COMMENT_MAX,
  WANTED_EVIDENCE_KINDS,
  WANTED_EVIDENCE_RATE_MAX,
  WANTED_EVIDENCE_RATE_WINDOW_MS,
} from "../_shared/community.ts";

/** How many followers one contribution will notify. See the header for why it is reported, not
 *  silently applied. */
const NOTIFY_CAP = 500;
/** The longest 摘要 a label may carry — the wall's card prints it beside the name. */
const LABEL_SUMMARY_MAX = 200;

/**
 * The payload, per kind. Returns `null` for anything that is not the shape its kind declares, and the
 * caller turns that into a 400 — a client that sends `{ name }` with `kind: 'comment'` believes it has
 * contributed something, and silently storing `{}` would make it right about that.
 */
function cleanPayload(kind: string, value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;

  if (kind === "comment") {
    const raw = src.text;
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    if (text === "" || text.length > WANTED_COMMENT_MAX) return null;
    return { text };
  }

  // 'archive' | 'sample' — a label. See the header.
  const rawName = src.name;
  if (typeof rawName !== "string") return null;
  const name = rawName.trim();
  if (name === "" || name.length > SHARE_NAME_MAX) return null;
  const out: Record<string, string> = { name };
  const rawSummary = src.summary;
  if (rawSummary !== undefined && rawSummary !== null) {
    if (typeof rawSummary !== "string") return null;
    const summary = rawSummary.trim();
    if (summary.length > LABEL_SUMMARY_MAX) return null;
    if (summary !== "") out.summary = summary;
  }
  return out;
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

    const wantedId = typeof body.wanted_id === "string" ? body.wanted_id.trim() : "";
    if (!wantedId) return badRequest("Missing wanted_id");

    const kind = typeof body.kind === "string" ? body.kind : "";
    if (WANTED_EVIDENCE_KINDS.indexOf(kind) === -1) {
      return badRequest(`kind must be one of: ${WANTED_EVIDENCE_KINDS.join(", ")}`);
    }
    const payload = cleanPayload(kind, body.payload);
    if (payload === null) {
      return badRequest(kind === "comment"
        ? `payload must be { text } of at most ${WANTED_COMMENT_MAX} characters`
        : `payload must be { name, summary? } of at most ${SHARE_NAME_MAX} / ${LABEL_SUMMARY_MAX} characters`);
    }

    // Only a public entry takes contributions — the write side of 「通过后公开，其他用户可…补充证据」.
    // Same reasoning as `wanted-follow` for 404-over-403.
    const { data: entry, error: findError } = await sb
      .from("wanted_players")
      .select("id, status, suspect_username")
      .eq("id", wantedId)
      .maybeSingle();
    if (findError) throw findError;
    if (!entry || entry.status !== "approved") {
      return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such entry");
    }

    const recent = await recentCount(
      sb, "wanted_evidence", caller.id, WANTED_EVIDENCE_RATE_WINDOW_MS,
    );
    if (recent >= WANTED_EVIDENCE_RATE_MAX) {
      return fail("RATE_LIMITED", HttpStatus.CONFLICT,
        `At most ${WANTED_EVIDENCE_RATE_MAX} contributions per ten minutes`);
    }

    const nowIso = new Date().toISOString();
    const { data: row, error: insertError } = await sb
      .from("wanted_evidence")
      .insert({ wanted_id: entry.id, user_id: caller.id, kind, payload })
      .select("*")
      .single();
    if (insertError) throw insertError;

    // §2.1.7's ordering — see the header.
    const { error: touchError } = await sb
      .from("wanted_players")
      .update({ updated_at: nowIso })
      .eq("id", entry.id);
    if (touchError) throw touchError;

    // ---- the followers' notices ---------------------------------------------------------------
    const { data: followers, error: followerError } = await sb
      .from("wanted_followers")
      .select("user_id")
      .eq("wanted_id", entry.id)
      .neq("user_id", caller.id)
      .limit(NOTIFY_CAP);
    if (followerError) throw followerError;

    const ids = (followers ?? [])
      .map((f) => (f as { user_id: string }).user_id)
      .filter((id): id is string => typeof id === "string" && id !== "");
    let notified = 0;
    if (ids.length > 0) {
      const { error: notifyError } = await sb.from("notifications").insert(
        ids.map((userId) => ({
          user_id: userId,
          kind: "wanted",
          title: null,
          body: null,
          data: { wanted_id: entry.id, event: "evidence", username: entry.suspect_username, kind },
        })),
      );
      if (notifyError) console.error("wanted-add-evidence notify failed:", notifyError);
      else notified = ids.length;
    }

    return json({ ok: true, evidence: row, notified });
  } catch (err) {
    console.error("wanted-add-evidence failed:", err);
    return internal("Could not add the evidence");
  }
});
