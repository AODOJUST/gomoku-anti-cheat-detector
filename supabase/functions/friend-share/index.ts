// friend-share — §1.2.3 send, §1.2.4 fetch/consume, §1.2.5 每日上限.
//
// POST { action, ... }   Authorization: Bearer <jwt>
//
//   action = 'send'    { to_user, kind, name, summary?, payload? }   (default)
//     -> 200 { ok: true, share }
//     -> 400 BAD_REQUEST        bad kind / missing name / over 每日上限 is 429-shaped but 409 here
//     -> 403 NOT_ACTIVATED | MUTED
//     -> 403 BLOCKED_BY_USER    §1.5.2 「对方发来的消息/分享自动拒绝」
//     -> 409 NOT_FRIENDS        not an accepted friendship
//     -> 409 QUOTA_EXCEEDED     §1.2.5 「回放 20 / 天，配置 10 / 天」
//
//   action = 'fetch'   { share_id }
//     -> 200 { ok: true, payload }            small share, body rode in the row
//     -> 200 { ok: true, url, expires_in }    large share, a short-lived signed URL
//     -> 409 SHARE_EXPIRED                    §1.2.4 「若 15 分钟内未接收，数据消失」
//     -> 404 NOT_FOUND                        no such row, or it is not yours to read
//
//   action = 'consume' { share_id }
//     -> 200 { ok: true, share }              §1.2.4 「标记 consumed = true」
//
// ---------------------------------------------------------------------------------------------
// WHY SEND / FETCH / CONSUME ARE ONE FUNCTION
// ---------------------------------------------------------------------------------------------
// §1.2.4's flow is three steps of one conversation — A sends, B fetches, B imports and marks it
// taken — and all three share the same two questions: 「这两个人是好友吗」 and 「这条分享还活着吗」.
// Split across three Functions, those questions get three implementations, and the day one of them
// answers differently is the day a share is fetchable but not consumable, or consumable after it
// expired. ⚠ The alternative — letting the CLIENT read `friend_shares` over PostgREST and only
// calling a Function for the upload — was rejected because `fetch` has to sign a URL when the body
// lives in Storage, and signing is a service-role operation.
//
// ⚠ THE TWO QUESTIONS ARE ASKED IN BOTH PLACES, ON PURPOSE. 011's read policy answers them for
// PostgREST (so a client that reads the table directly cannot see an expired or unrelated share),
// and this Function asks them again for the paths it serves. That is not a duplicated answer — the
// policy is about the table and these are about the Storage object, which RLS cannot reach.
//
// ---------------------------------------------------------------------------------------------
// §1.2.5'S COUNTER, AND THE RACE THAT IS DELIBERATELY NOT FIXED
// ---------------------------------------------------------------------------------------------
// `daily_quotas` is a read-then-write (read the row, refuse if over, increment). Two sends in the
// same instant can both read 19 and both write 20, so the 21st gets through. That is accepted: the
// quota is a courtesy against a stuck retry loop and a spammer, not a billing system, and the cost
// of the lost update is one extra share. The alternative — counting from `friend_shares` itself —
// is exact and needs no counter, but §1.2.5 asks for this table and the client reads it to show
// 「今日还可发送 7 个」; two sources of one number is the shape this project has paid six times for.
// ⇒ one source, documented race, and `daily_quotas` is the only thing that decides.

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
  type FriendShareRow,
  isShareLive,
  orderPair,
  quotaColumnFor,
  quotaMaxFor,
  refusalMessage,
  serverDate,
  SHARE_INLINE_MAX_BYTES,
  SHARE_KINDS,
  type FriendshipRow,
} from "../_shared/community.ts";

/** The bucket 011_rls_community.sql creates. Private; every read is a signed URL. */
const BUCKET = "temp-shares";
/** How long a signed URL lives. Long enough for the download to start, short enough that a copied
 *  link is useless — the share itself may only have seconds left on its 15-minute clock. */
const SIGNED_URL_SECONDS = 60;

/** §1.2.3's 「简化的元数据」, measured the way §2.3.5's message limit is: UTF-16 code units. */
function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

/** The share as the client receives it. `storage_url` is deliberately NOT included: it is an
 *  internal object name, and a client that had it might try to build a public URL from it. `fetch`
 *  is the only way to the bytes. */
function publicShare(row: FriendShareRow): Record<string, unknown> {
  return {
    id: row.id,
    from_user: row.from_user,
    to_user: row.to_user,
    kind: row.kind,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed: row.consumed,
    // Whether the body rides in the row or has to be fetched as a URL. The client shows 「接收」
    // either way; it needs the flag only to decide whether a download can start without a round
    // trip.
    stored: row.storage_url !== null,
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

    const community = communityRefusal(caller.row);

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const action = typeof body.action === "string" ? body.action : "send";

    // =========================================================================================
    // fetch — §1.2.4 「客户端拉取 payload（或下载 storage_url）」
    // =========================================================================================
    if (action === "fetch") {
      // Reading a share is not 「互动」: §2.4 silences a muted account's WRITES, and a mute that
      // also hid what a friend sent would hide the thing the mute is about.
      const id = typeof body.share_id === "string" ? body.share_id.trim() : "";
      if (!id) return badRequest("Missing share_id");

      const { data, error } = await sb
        .from("friend_shares")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;

      // Same 404-for-not-yours rule as `friend-accept`: answering 「存在，但不是给你的」 would turn
      // this into an oracle for 「这两个人在互相发东西吗」.
      const row = data as FriendShareRow | null;
      if (!row || (row.to_user !== caller.id && row.from_user !== caller.id)) {
        return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such share");
      }
      if (!isShareLive(row)) {
        return fail("SHARE_EXPIRED", HttpStatus.CONFLICT, "This share has expired");
      }

      if (row.payload !== null && row.payload !== undefined) {
        return json({ ok: true, payload: row.payload, kind: row.kind });
      }

      // The body is in Storage. A signed URL is the only way to it — see the bucket policy note in
      // 011: the object is private and the policy admits the two parties, but a signed URL is what
      // the client actually uses, so a share that expires between the two calls cannot be read.
      const { data: signed, error: signError } = await sb.storage
        .from(BUCKET)
        .createSignedUrl(row.storage_url as string, SIGNED_URL_SECONDS);
      if (signError) throw signError;
      return json({
        ok: true,
        url: signed?.signedUrl ?? null,
        expires_in: SIGNED_URL_SECONDS,
        kind: row.kind,
      });
    }

    // =========================================================================================
    // consume — §1.2.4 「若选「导入」，立即写入，并标记 consumed = true」
    // =========================================================================================
    if (action === "consume") {
      const id = typeof body.share_id === "string" ? body.share_id.trim() : "";
      if (!id) return badRequest("Missing share_id");

      const { data, error } = await sb
        .from("friend_shares")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;

      const row = data as FriendShareRow | null;
      if (!row || row.to_user !== caller.id) {
        // ⚠ Only the RECIPIENT may consume, unlike `fetch` where the sender may also look. 「已接收」
        // is a fact about the recipient; letting the sender stamp it would show B a share they never
        // opened as already taken, and §1.2.4's whole UI is built on that distinction.
        return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "No such share");
      }
      if (!isShareLive(row)) {
        return fail("SHARE_EXPIRED", HttpStatus.CONFLICT, "This share has expired");
      }
      // Already consumed is success, not an error: the import happened on another device, and the
      // second press is the same intent. Re-stamping would be a lie about when it was taken.
      if (row.consumed) return json({ ok: true, share: publicShare(row) });

      const { data: updated, error: updateError } = await sb
        .from("friend_shares")
        .update({ consumed: true })
        .eq("id", row.id)
        .select("*")
        .single();
      if (updateError) throw updateError;
      return json({ ok: true, share: publicShare(updated as FriendShareRow) });
    }

    // =========================================================================================
    // send — §1.2.3 / §1.2.4 / §1.2.5
    // =========================================================================================
    if (action !== "send") {
      return badRequest("action must be one of: send, fetch, consume");
    }

    if (community) {
      return fail(community, HttpStatus.FORBIDDEN, refusalMessage(community));
    }

    const toUser = typeof body.to_user === "string" ? body.to_user.trim() : "";
    if (!toUser) return badRequest("Missing to_user");
    if (toUser === caller.id) return badRequest("Cannot share with yourself");

    const kind = typeof body.kind === "string" ? body.kind : "";
    if (SHARE_KINDS.indexOf(kind) === -1) {
      return badRequest(`kind must be one of: ${SHARE_KINDS.join(", ")}`);
    }

    const rawName = body.name;
    if (typeof rawName !== "string" || rawName.trim() === "") {
      return badRequest("Missing name");
    }
    const name = rawName.trim();

    // ---- §1.2.3 requires an ACCEPTED friendship --------------------------------------------
    // The ordered pair again — see `orderPair`. `blocked` is reported separately because §1.5.2
    // says 「对方发来的消息/分享自动拒绝」 and the client can act on that sentence (it can offer
    // 「解除拉黑」); 「还不是好友」 is a different next step (send a request).
    const [userA, userB] = orderPair(caller.id, toUser);
    const { data: link, error: linkError } = await sb
      .from("friendships")
      .select("*")
      .eq("user_a", userA)
      .eq("user_b", userB)
      .maybeSingle();
    if (linkError) throw linkError;

    const relation = link as FriendshipRow | null;
    if (!relation || relation.status !== "accepted") {
      if (relation && relation.status === "blocked") {
        return fail("BLOCKED_BY_USER", HttpStatus.FORBIDDEN, "This relationship is blocked");
      }
      return fail("NOT_FRIENDS", HttpStatus.CONFLICT, "You can only share with friends");
    }

    // ---- §1.2.5 每日上限 ---------------------------------------------------------------------
    const column = quotaColumnFor(kind);
    const max = quotaMaxFor(kind);
    const today = serverDate();

    const { data: quotaRow, error: quotaError } = await sb
      .from("daily_quotas")
      .select("*")
      .eq("user_id", caller.id)
      .eq("date", today)
      .maybeSingle();
    if (quotaError) throw quotaError;

    const used = quotaRow ? Number((quotaRow as Record<string, unknown>)[column] ?? 0) : 0;
    if (used >= max) {
      return fail("QUOTA_EXCEEDED", HttpStatus.CONFLICT,
        `At most ${max} of this kind per day`);
    }

    // ---- the body: inline or Storage (§1.2.3 「< 500KB 时；超出则用 storage_url」) -----------
    const payload = body.payload === undefined ? null : body.payload;
    if (payload === null) return badRequest("Missing payload");

    const size = byteLength(payload);
    let storagePath: string | null = null;

    if (size > SHARE_INLINE_MAX_BYTES) {
      // The path is namespaced by recipient first: a bucket listing is then 「某人的收件箱」, which
      // is what the purge job and any future support question are about. The uuid keeps two sends of
      // the same file from colliding.
      const path = `${toUser}/${crypto.randomUUID()}.json`;
      const upload = await sb.storage.from(BUCKET).upload(
        path,
        new Blob([JSON.stringify(payload)], { type: "application/json" }),
        { contentType: "application/json", upsert: false },
      );
      if (upload.error) throw upload.error;
      storagePath = path;
    }

    const { data: inserted, error: insertError } = await sb
      .from("friend_shares")
      .insert({
        from_user: caller.id,
        to_user: toUser,
        kind,
        // Exactly one of the two is set — `friend_shares_has_body` in 006 enforces it, so a bug
        // here is a loud 23514 rather than a share that opens to nothing.
        payload: storagePath === null ? payload : null,
        storage_url: storagePath,
        size_bytes: size,
      })
      .select("*")
      .single();
    if (insertError) throw insertError;

    // The counter, after the row exists: a quota that was spent on a failed insert would lock a
    // user out of a day's allowance for nothing.
    const { error: bumpError } = await sb
      .from("daily_quotas")
      .upsert(
        {
          user_id: caller.id,
          date: today,
          shares_archive: column === "shares_archive" ? used + 1 : Number(quotaRow?.shares_archive ?? 0),
          shares_config: column === "shares_config" ? used + 1 : Number(quotaRow?.shares_config ?? 0),
        },
        { onConflict: "user_id,date" },
      );
    // ⚠ A failed counter write does NOT fail the share. The bytes are already stored and the row is
    // already committed; tearing that down to keep a courtesy counter accurate would turn a
    // bookkeeping problem into a data-loss problem. It is logged instead.
    if (bumpError) console.error("friend-share quota bump failed:", bumpError);

    return json({ ok: true, share: publicShare(inserted as FriendShareRow) });
  } catch (err) {
    console.error("friend-share failed:", err);
    return internal("Could not share the file");
  }
});
