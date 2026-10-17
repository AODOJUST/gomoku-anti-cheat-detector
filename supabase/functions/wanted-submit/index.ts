// wanted-submit — 1.0.7 §2.1.3's form → §2.1.6's 待审队列.
//
// POST { suspect_profile_url, suspect_username, suspect_display_name?, reason?, evidence? }
//   Authorization: Bearer <jwt>
//   -> 200 { ok: true, wanted, merged }      `merged` true ⇒ it landed on an existing entry
//   -> 400 { error: 'BAD_REQUEST' }          bad URL / mismatched username / over-length / no reason
//                                            and no evidence / malformed evidence
//   -> 403 { error: 'NOT_ACTIVATED' | 'MUTED' }   §2.1.1 「已激活用户可提交」
//   -> 409 { error: 'RATE_LIMITED' }         §五.2's per-day cap (answered — see the shared block)
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// ⚠⚠ §2.1.9's THIRD CONSTRAINT IS ENFORCED BY *REQUIRING SOMETHING TO READ*, AND THE SPEC CONTRADICTS
// ITSELF ABOUT WHICH THING
// ---------------------------------------------------------------------------------------------
// §2.1.9 lists 「提交必须附证据（防止恶意诬陷）」 as a key constraint. §2.1.3's form draws 附加证据 as
// 「（可选）」 and 提交理由 with no 必填 marker at all — so the spec's own screen would let a submission
// through with neither, while its own constraint says one is mandatory.
//
// ⇒ RESOLVED AS: **at least one of {reason, evidence} must be present**, and the refusal names both
// halves. This is the only reading that satisfies the constraint without contradicting the form: the
// form's two fields stay optional INDIVIDUALLY (which is what its markers say), and the pair is what
// §2.1.9 requires. A submission with neither is an accusation a moderator cannot judge and a wall
// reader cannot assess — the exact thing 「防止恶意诬陷」 is about.
//
// ⚠ THE DATABASE COLUMNS STAY NULLABLE. 026_wanted.sql does not encode this rule as a CHECK, and that
// is deliberate: a constraint would be a SECOND answer to 「什么算一条合格的提交」, and the moment
// §2.1.9's wording is revisited the migration would have to change with the function. The server is
// the gate; the table records what was accepted.
//
// ---------------------------------------------------------------------------------------------
// THE DUPLICATE MERGE (§2.1.6), AND WHAT "ALREADY SUBMITTED" MEANS
// ---------------------------------------------------------------------------------------------
// 「同一 suspect_username 只允许一条 approved 记录，重复提交合并到已有条目（补充证据）」.
//
// The merge target is an entry in `pending` OR `approved`, compared case-insensitively (the unique
// index in 026 is `lower(suspect_username) where status = 'approved'`, so this is the same
// normalisation, not a second one). A `rejected` or `resolved` entry is NOT a merge target, and that
// is the load-bearing half of the rule: a rejection was a judgement about THAT entry, and letting it
// absorb the next person's evidence would mean one moderator's 「不通过」 silently silences every
// later report of the same account. The unique index agrees — it is partial on `'approved'` for
// exactly this reason.
//
// ⚠ WHAT THE MERGE ACTUALLY WRITES, because 「合并」 could mean several things and only one of them
// preserves evidence: the incoming `evidence` arrays are APPENDED to the entry's jsonb (deduped,
// capped), and the incoming `reason`, if there is one, becomes a `wanted_evidence` row of kind
// `'comment'`. A merge that overwrote the entry's evidence would let a later submitter erase the
// first one's work, and a merge that dropped the newcomer's reason would lose the only new
// information they brought.
//
// ⚠ THE ENTRY'S `updated_at` MOVES on a merge. §2.1.7 makes 「有新证据的在前面」 the wall's ordering,
// and a merged submission IS new evidence.
//
// ---------------------------------------------------------------------------------------------
// WHY NOBODY IS NOTIFIED (§2.1.6 step 4 「通知管理员」)
// ---------------------------------------------------------------------------------------------
// §2.1.6's step 4 is 「通知管理员（管理员信箱新增「缉捕墙审核」分区）」 — and the parenthesis defines the
// mechanism: a new SECTION of the 管理员 page, which this release draws. A notifications fan-out to
// every admin would be a second answer to the same requirement, and the worse one (it would need a
// per-admin inbox row per submission, and it would go stale the moment a submission is handled while
// the admin is away). The queue panel reads `wanted_players where status = 'pending'`, which cannot
// disagree with the table.

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
  extractUsernameFromProfileUrl,
  isValidProfileUrl,
  normalizeWantedUsername,
  refusalMessage,
  recentCount,
  WANTED_DISPLAY_MAX,
  WANTED_EVIDENCE_KEYS,
  WANTED_EVIDENCE_MAX,
  WANTED_RATE_MAX,
  WANTED_RATE_WINDOW_MS,
  WANTED_REASON_MAX,
  wantedUrlMatches,
  type WantedRow,
} from "../_shared/community.ts";

/** The statuses a duplicate submission may be merged INTO. See the header for why the other two are
 *  excluded; ⚠ it is the same pair the partial unique index is written against. */
const MERGE_STATUSES = ["pending", "approved"];

/**
 * §2.1.2's evidence object, cleaned to its three known keys.
 *
 * Returns `null` when nothing survived, and the caller treats that as 「no evidence」 rather than as an
 * error — §2.1.3's control is optional. A malformed SHAPE (an array where an object belongs, a
 * non-array under a known key) is refused by the caller, because a client sending `{notes: "x"}`
 * believes it has attached something.
 */
function cleanEvidence(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  let any = false;
  for (const key of WANTED_EVIDENCE_KEYS) {
    const raw = src[key];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw)) return null;
    const items = raw
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .slice(0, WANTED_EVIDENCE_MAX)
      .map((v) => v.trim().slice(0, 200));
    if (items.length > 0) {
      out[key] = items;
      any = true;
    }
  }
  return any ? out : null;
}

/** Append `add` onto `base` and dedupe by exact value, capped at `WANTED_EVIDENCE_MAX` per key. A
 *  merge must not be able to grow an entry's evidence beyond what one submission could have carried. */
function mergeEvidence(
  base: unknown,
  add: Record<string, string[]> | null,
): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  const src = (base && typeof base === "object" && !Array.isArray(base))
    ? base as Record<string, unknown>
    : {};
  for (const key of WANTED_EVIDENCE_KEYS) {
    const seen: string[] = [];
    for (const from of [src[key], add ? add[key] : null]) {
      if (!Array.isArray(from)) continue;
      for (const v of from) {
        if (typeof v !== "string") continue;
        const s = v.trim();
        if (s !== "" && seen.indexOf(s) === -1) seen.push(s);
      }
    }
    if (seen.length > 0) out[key] = seen.slice(0, WANTED_EVIDENCE_MAX);
  }
  return Object.keys(out).length > 0 ? out : null;
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

    // ---- §2.1.4's link, and its two helpers (§shared, so the client agrees) --------------------
    const rawUrl = typeof body.suspect_profile_url === "string" ? body.suspect_profile_url.trim() : "";
    if (!rawUrl) return badRequest("Missing suspect_profile_url");
    if (!isValidProfileUrl(rawUrl)) {
      return badRequest("suspect_profile_url must be a gomoku.com profile URL");
    }

    const rawName = body.suspect_username;
    if (typeof rawName !== "string" || normalizeWantedUsername(rawName) === "") {
      return badRequest("Missing suspect_username");
    }
    const username = normalizeWantedUsername(rawName);
    // §2.1.4's 「一致性检查」. `wantedUrlMatches` normalises the leading `@` the form draws, and the
    // extracted name is reported back so the refusal is actionable rather than 「不一致」.
    if (!wantedUrlMatches(rawUrl, username)) {
      return badRequest(`suspect_username must match the URL (which names ${extractUsernameFromProfileUrl(rawUrl)})`);
    }

    const rawDisplay = body.suspect_display_name;
    if (rawDisplay !== undefined && rawDisplay !== null && typeof rawDisplay !== "string") {
      return badRequest("suspect_display_name must be a string");
    }
    const displayName = typeof rawDisplay === "string" ? rawDisplay.trim() : "";
    if (displayName.length > WANTED_DISPLAY_MAX) {
      return badRequest(`suspect_display_name must be at most ${WANTED_DISPLAY_MAX} characters`);
    }

    const rawReason = body.reason;
    if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
      return badRequest("reason must be a string");
    }
    const reason = typeof rawReason === "string" ? rawReason.trim() : "";
    if (reason.length > WANTED_REASON_MAX) {
      return badRequest(`reason must be at most ${WANTED_REASON_MAX} characters`);
    }

    const evidence = cleanEvidence(body.evidence);
    if (body.evidence !== undefined && body.evidence !== null && evidence === null) {
      return badRequest(
        `evidence must be { ${WANTED_EVIDENCE_KEYS.join("?: string[], ")}?: string[] }`,
      );
    }

    // §2.1.9's third constraint — see the header for how the spec's two statements are reconciled.
    if (reason === "" && evidence === null) {
      return badRequest("A submission needs a reason or evidence");
    }

    // ---- §五.2's cap ---------------------------------------------------------------------------
    const recent = await recentCount(
      sb, "wanted_players", caller.id, WANTED_RATE_WINDOW_MS, "submitter_id",
    );
    if (recent >= WANTED_RATE_MAX) {
      return fail("RATE_LIMITED", HttpStatus.CONFLICT,
        `At most ${WANTED_RATE_MAX} submissions per day`);
    }

    // ---- §2.1.6's dedupe ----------------------------------------------------------------------
    // `ilike` rather than `eq`: the unique index in 026 is on `lower(suspect_username)`, so the lookup
    // has to compare the same way or a submission could pass the lookup and then collide with the
    // index — a 23505 the operator would read as 「服务器坏了」.
    const { data: existing, error: findError } = await sb
      .from("wanted_players")
      .select("*")
      .ilike("suspect_username", username)
      .in("status", MERGE_STATUSES)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (findError) throw findError;

    const submitterName = typeof caller.row.username === "string" ? caller.row.username : null;
    const nowIso = new Date().toISOString();

    if (existing) {
      const row = existing as WantedRow;
      const { error: mergeError } = await sb
        .from("wanted_players")
        .update({ evidence: mergeEvidence(row.evidence, evidence), updated_at: nowIso })
        .eq("id", row.id);
      if (mergeError) throw mergeError;

      // The newcomer's reason is EVIDENCE rather than a field overwrite — see the header. ⚠ Its
      // `user_id` is the caller, not the original submitter: 「谁补的这一条」 is what makes the
      // evidence list auditable.
      if (reason !== "") {
        const { error: noteError } = await sb.from("wanted_evidence").insert({
          wanted_id: row.id,
          user_id: caller.id,
          kind: "comment",
          payload: { text: reason, via: "submit" },
        });
        if (noteError) throw noteError;
      }

      const { data: after } = await sb
        .from("wanted_players")
        .select("id, status, follower_count, updated_at")
        .eq("id", row.id)
        .maybeSingle();

      return json({ ok: true, merged: true, wanted: after ?? { id: row.id, status: row.status } });
    }

    const { data, error } = await sb
      .from("wanted_players")
      .insert({
        submitter_id: caller.id,
        submitter_name: submitterName,
        suspect_username: username,
        suspect_profile_url: rawUrl,
        suspect_display_name: displayName === "" ? null : displayName,
        reason: reason === "" ? null : reason,
        evidence,
        status: "pending",
        updated_at: nowIso,
      })
      .select("*")
      .single();
    if (error) throw error;

    return json({ ok: true, merged: false, wanted: data });
  } catch (err) {
    console.error("wanted-submit failed:", err);
    return internal("Could not submit the entry");
  }
});
