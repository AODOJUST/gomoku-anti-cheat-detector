// friend-share-purge — §1.2.4 「Supabase Cron 每 1 分钟扫描并删除过期记录 + Storage 文件」.
//
// POST {}   x-purge-secret: <PURGE_SECRET>      NO bearer token — this is not a user endpoint.
//   -> 200 { ok: true, shares: n, objects: m, chat: k, cloud: j }
//   -> 401 { error: 'UNAUTHORIZED' }   missing or wrong secret, or the secret is not configured
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY THIS IS THE TENTH FUNCTION, WHEN §实现清单 LISTS NINE
// ---------------------------------------------------------------------------------------------
// §1.2.4 promises 「数据消失」 and §1.2.4's own sketch of the job is a `pg_cron` entry. A pure SQL
// job cannot keep that promise: `delete from storage.objects` removes the METADATA row and leaves
// the object's bytes in the bucket's backend, so the replay is still there for anyone who had the
// path — and the path is exactly what the recipient was handed. The deletion has to go through the
// Storage API, which means a Function, which means this file. 006_friends.sql ships the cron line
// commented and names this endpoint in it.
//
// ⚠ WHY A SHARED SECRET RATHER THAN A JWT: the caller is `pg_cron`, which has no user and no
// token. `verify_jwt = false` in `config.toml` is therefore load-bearing, and the secret below is
// the entire authorisation. It must be a long random string set with
// `supabase secrets set PURGE_SECRET=...` and it must NOT be the service-role key (that value is
// injected by the platform and could be leaked by a verbose log line; this one only ever appears in
// one header comparison).
//
// ⚠ AN UNCONFIGURED SECRET IS A REFUSAL, NOT AN OPEN DOOR. If `PURGE_SECRET` is missing the function
// answers 401 and deletes nothing — the failure mode has to be 「the cleanup stopped」 and not 「anyone
// can call it」. This is the one place in the codebase where the "missing config" branch must be
// fail-closed rather than degrade gracefully.
//
// ---------------------------------------------------------------------------------------------
// IT ALSO RUNS 1.0.2'S CHAT PURGE, ON PURPOSE
// ---------------------------------------------------------------------------------------------
// 005_community.sql shipped §2.3.5's 「历史保留 最近 7 天」 as a second commented cron entry. Since a
// maintenance Function now exists, everything with a deadline is swept by one job: fewer things for
// the operator to enable, and one place where 「什么时候数据会消失」 is answered. The windows are
// read from the shared block (`CHAT_RETENTION_DAYS`) rather than typed here, so the job and the read
// query cannot disagree about what 「7 天」 means.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { internal, json, methodNotAllowed, unauthorized } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/client.ts";
import { CHAT_RETENTION_DAYS } from "../_shared/community.ts";

const BUCKET = "temp-shares";

/**
 * How many rows one run will handle per table.
 *
 * ⚠ A bound rather than 「everything」: the job runs every minute forever, and the first run after
 * an outage can meet a year of backlog. Unbounded, it would hold a database transaction open long
 * enough to be killed half-way — which is the one outcome worse than being late, because a partial
 * sweep looks exactly like a complete one. Whatever is left is picked up by the next tick.
 */
const BATCH = 500;

/** Constant-time-ish comparison for the shared secret. Not `===`, so the loop's timing does not
 *  leak how many leading characters were right. */
function secretMatches(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** Delete the Storage objects behind a set of rows, then report how many paths were offered. */
async function removeObjects(
  sb: ReturnType<typeof serviceClient>,
  paths: string[],
): Promise<number> {
  if (paths.length === 0) return 0;
  const { error } = await sb.storage.from(BUCKET).remove(paths);
  // ⚠ A storage failure does NOT stop the row deletion. The promise §1.2.4 makes is that the data
  // is gone; a row that survives because its object could not be deleted keeps the METADATA (and so
  // the share stays fetchable through `friend-share`). Deleting the row first and leaving an
  // unreferenced object is the safer failure: the object is no longer addressable by any code path,
  // and the next run cannot find it either. Logged, not thrown.
  if (error) console.error("purge: storage remove failed:", error);
  return paths.length;
}

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  const expected = Deno.env.get("PURGE_SECRET");
  if (!expected) {
    // Fail closed. See the header.
    console.error("purge: PURGE_SECRET is not configured; refusing to run");
    return unauthorized("Purge is not configured");
  }
  const given = req.headers.get("x-purge-secret") ?? req.headers.get("X-Purge-Secret");
  if (!secretMatches(given, expected)) {
    return unauthorized("Invalid purge secret");
  }

  try {
    const sb = serviceClient();
    const nowIso = new Date().toISOString();

    // ---- 1. §1.2.4's friend shares ------------------------------------------------------------
    const { data: deadShares, error: shareError } = await sb
      .from("friend_shares")
      .select("id, storage_url")
      .lt("expires_at", nowIso)
      .limit(BATCH);
    if (shareError) throw shareError;

    const shareRows = (deadShares ?? []) as { id: string; storage_url: string | null }[];
    const sharePaths = shareRows
      .map((r) => r.storage_url)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    const objects = await removeObjects(sb, sharePaths);

    let shares = 0;
    if (shareRows.length > 0) {
      const { error } = await sb
        .from("friend_shares")
        .delete()
        .in("id", shareRows.map((r) => r.id));
      if (error) throw error;
      shares = shareRows.length;
    }

    // ---- 2. §1.1.2's room shares (same 7-day window as the message) ----------------------------
    const { data: deadCloud, error: cloudError } = await sb
      .from("cloud_shares")
      .select("id, storage_url")
      .lt("expires_at", nowIso)
      .limit(BATCH);
    if (cloudError) throw cloudError;

    const cloudRows = (deadCloud ?? []) as { id: string; storage_url: string | null }[];
    const cloudPaths = cloudRows
      .map((r) => r.storage_url)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    const cloudObjects = await removeObjects(sb, cloudPaths);

    let cloud = 0;
    if (cloudRows.length > 0) {
      const { error } = await sb
        .from("cloud_shares")
        .delete()
        .in("id", cloudRows.map((r) => r.id));
      if (error) throw error;
      cloud = cloudRows.length;
    }

    // ---- 3. §2.3.5's chat window (005 shipped this commented; it lives here now) ---------------
    // ⚠ The cutoff is computed from CHAT_RETENTION_DAYS, the same constant the read query uses, so
    // 「7 天」 is one number. `chat_messages.reply_to` is `on delete set null` (008), so deleting an
    // old message cannot cascade into newer replies.
    const cutoff = new Date(Date.now() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: deadChat, error: chatError } = await sb
      .from("chat_messages")
      .select("id")
      .lt("created_at", cutoff)
      .limit(BATCH);
    if (chatError) throw chatError;

    let chat = 0;
    if (deadChat && deadChat.length > 0) {
      const { error } = await sb
        .from("chat_messages")
        .delete()
        .in("id", (deadChat as { id: string }[]).map((r) => r.id));
      if (error) throw error;
      chat = deadChat.length;
    }

    return json({
      ok: true,
      shares,
      objects,
      cloud,
      cloud_objects: cloudObjects,
      chat,
      // A full batch means there is more waiting; the next tick takes it. Reported so an operator
      // watching the logs can tell 「quiet」 from 「backlogged」.
      more: shareRows.length >= BATCH || cloudRows.length >= BATCH ||
        (deadChat?.length ?? 0) >= BATCH,
    });
  } catch (err) {
    console.error("friend-share-purge failed:", err);
    return internal("Purge failed");
  }
});
