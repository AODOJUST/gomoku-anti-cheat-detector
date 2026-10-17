// cloud-share — §1.1.2 / §1.1.3 打开 a ROOM 附件.
//
// POST { cloud_id }   Authorization: Bearer <jwt>
//
//   -> 200 { ok: true, payload, kind }        small share, the body rode in the row
//   -> 200 { ok: true, url, expires_in, kind } large share, a short-lived signed URL
//   -> 400 BAD_REQUEST                        missing cloud_id
//   -> 404 NOT_FOUND                          no such row
//   -> 409 SHARE_EXPIRED                      §1.1.2's 7-day window has passed
//
// ---------------------------------------------------------------------------------------------
// WHY THIS IS A FUNCTION AND NOT A POSTGREST READ
// ---------------------------------------------------------------------------------------------
// 011 §4 already lets any member SELECT a live `cloud_shares` row, and the card renders entirely
// from the message's own SNAPSHOT of `name` / `summary` / `expires_at` — so nothing here is about
// the card. It is about the BYTES: when the payload is over 500 KB the body is an object in the
// private `temp-shares` bucket, and getting to it means SIGNING, which is a service-role operation
// (`cloud.js` says so at length — the client has no signing API on purpose). One route for both
// sizes, the same shape `friend-share`'s `fetch` returns, so the client has one downloader rather
// than a branch per table: 「payload 在行里就直接用，在 Storage 就先签」 is decided HERE.
//
// ⚠ §1.1.2's EXPIRY IS CHECKED AGAIN, HERE, even though 011's policy has `expires_at > now()`.
// The policy answers for the ROW; this answers for the OBJECT, which RLS cannot reach. Same split
// `friend-share` documents — the policy is about the table and this is about the file.
//
// ⚠ NO `consume`. A room share is not addressed to anybody — it is published to the community, and
// 「已接收」 would be a per-recipient fact with nowhere to live (one row, many readers). §1.2.4's
// 15-minute inbox是 the friend path's, and it already has `friend-share`.
//
// ⚠ NO MEMBERSHIP BEYOND 「not banned, not deleted」. Reads are open to the community by design
// (§1.8.3's 未激活只读), so this asks exactly what 011's policy asks — `accountRefusal`, not
// `communityRefusal`. A function that refused an unactivated member here would answer 403 for a row
// the same account can read over PostgREST, which is two answers to one question.

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
import { type CloudShareRow } from "../_shared/community.ts";

/** The bucket 011_rls_community.sql creates, shared with §1.2.3's friend shares. */
const BUCKET = "temp-shares";
/** How long a signed URL lives — the same 60 seconds `friend-share` uses, and for the same reason:
 *  long enough for the download to start, short enough that a copied link is useless. A 403 means
 *  the signature expired, NOT that the share is broken; the client re-calls this. */
const SIGNED_URL_SECONDS = 60;

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

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const cloudId = typeof body.cloud_id === "string" ? body.cloud_id.trim() : "";
    if (!cloudId) return badRequest("Missing cloud_id");

    const { data, error } = await sb
      .from("cloud_shares")
      .select("*")
      .eq("id", cloudId)
      .maybeSingle();
    if (error) throw error;

    // 404 rather than 403 for a row that is gone: the id is a capability the room handed out, and
    // 「存在，但过期了」 vs 「不存在」 are different sentences for the reader, so the expiry gets its
    // own code below rather than being folded into this one.
    const row = data as CloudShareRow | null;
    if (!row) return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such share");

    const expires = row.expires_at ? Date.parse(String(row.expires_at)) : NaN;
    if (!isNaN(expires) && expires <= Date.now()) {
      return fail("SHARE_EXPIRED", HttpStatus.CONFLICT, "This share has expired");
    }

    if (row.payload !== null && row.payload !== undefined) {
      return json({ ok: true, payload: row.payload, kind: row.kind });
    }
    if (!row.storage_url) {
      // `cloud_shares_has_body` (008) makes this unreachable for a real row; answering it anyway
      // means a corrupt row reads as 「找不到」 rather than as a crash with no code to branch on.
      return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such share");
    }

    const { data: signed, error: signError } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(row.storage_url, SIGNED_URL_SECONDS);
    if (signError) throw signError;
    return json({
      ok: true,
      url: signed?.signedUrl ?? null,
      expires_in: SIGNED_URL_SECONDS,
      kind: row.kind,
    });
  } catch (err) {
    console.error("cloud-share failed:", err);
    return internal("Could not open the share");
  }
});
