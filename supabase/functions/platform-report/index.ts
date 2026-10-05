// platform-report — 1.0.6 四号 §一.4.3: record which client the caller is signed in from.
//
// POST { platform: 'extension' | 'web' }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, platforms: string[], logged: boolean }
//   -> 400 { error: 'BAD_REQUEST' }         the body named no known platform
//   -> 401 { error: 'UNAUTHORIZED' }
//   -> 403 { error: 'BANNED' }
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHAT IT WRITES, AND WHICH HALF OF IT IS IDEMPOTENT
// ---------------------------------------------------------------------------------------------
// §1.4.3's five steps, in order, and step 3 is a SET rather than a push:
//
//   users.platforms        ← the union of what is there and what arrived, SORTED and de-duplicated
//   users.last_platform    ← this report's platform
//   users.last_platform_at ← now
//   platform_logins        ← one row, UNLESS this account already logged this platform recently
//
// ⚠ THE STATE WRITE ALWAYS RUNS; THE LOG WRITE IS THROTTLED, AND THE TWO ARE NOT THE SAME KIND OF
// THING. `platforms` / `last_platform` are STATE — writing them twice with the same value is a no-op
// that leaves them correct, so they are unconditionally updated and any report at all brings the row
// up to date. The log is a COUNT of §1.5.3's 「近 7 天登录次数」, and an unconditional INSERT would make
// that number 「这台浏览器启动了几次」: §1.4.1 fires this endpoint on login success, on every browser
// start (`onStartup`) and on the day's first activity, and a reload loop would inflate it without
// bound. One row per (account, platform) per `PLATFORM_LOG_MIN_MS` reads as 「这次会话」, which is what
// the panel's number means.
//
// ⚠ SORTED, AND §1.2's `both` IS STILL NOT STORED. The array is written `['extension','web']` in
// alphabetical order whatever the arrival order was, so two accounts with the same history have
// byte-identical arrays (which is what makes a `platforms = '{extension,web}'` comparison in a test
// or a hand-run query mean anything). The derived tag stays derived — `platformTag()` on the client,
// `public.platform_tag()` in SQL — and `users_platforms_known` (023) refuses a stored `'both'`.
//
// ---------------------------------------------------------------------------------------------
// ⚠ IT DOES NOT LOOK UP THE IP, AND IT DOES NOT TOUCH `country_code`
// ---------------------------------------------------------------------------------------------
// §1.3's `ip_country` is 「与 geo-update 同源」, implemented by COPYING `users.country_code` — the
// value `geo-update` already inferred from the login IP. The IP never reaches this function:
//
//   * No `clientIp(req)`, no ipinfo call, no `IPINFO_TOKEN`. A second inference would be a second
//     answer to 「这个账号在哪」, free to disagree with the profile's own flag and to double the
//     token spend — and §1.3 says 「同源」, which is a statement about there being ONE source.
//   * `country_code` is not written here at all; that column belongs to `geo-update`, and §3.1.7
//     keeps the IP out of storage by keeping the inference in one place.
//
// ⚠ The copy can be `null` for exactly one case: an account whose very first report raced its very
// first `geo-update` (both run on the login path). Null is the honest value there — 「这次登录时还不
// 知道国家」 — and it is not backfilled, because backfilling would mean a second writer of a row that
// is a snapshot of a moment.
//
// ---------------------------------------------------------------------------------------------
// ⚠ WHY IT READS `caller.row` INSTEAD OF §1.4.3's OWN SELECT
// ---------------------------------------------------------------------------------------------
// The spec's step 2 issues `select('platforms').eq('id', user.id)`. `requireUser` has ALREADY loaded
// that whole row to answer 「他是不是管理员 / 被封禁了吗」, and `Caller.row` is that row — so the SELECT
// would be a second read of the same record, inside the same request, to learn one field it is
// already holding. `caller.row` is narrowed through 023's migration in the sense that matters: the
// field is `null`/absent on a database where 023 has not run yet, and the code reads it as 「还没报过」.
//
// ⚠ AND THE WRITE IS A READ-MODIFY-WRITE, WHICH IS SAFE HERE FOR A REASON WORTH STATING: the read and
// the write are in one request, the value is a SET that only ever grows, and the loser of a race is a
// concurrent report from the same account — i.e. the same platform being added twice, which the Set
// makes idempotent. It is not the shape `GMStorage.enqueue()` exists to serialise (that is the
// client's own storage), and a lost update here could not lose a PLATFORM: the only way to lose one is
// for two DIFFERENT platforms to report in the same instant, and then the next report from either one
// restores the union.
//
// ---------------------------------------------------------------------------------------------
// ⚠ THE CLIENT CALLS THIS FIRE-AND-FORGET
// ---------------------------------------------------------------------------------------------
// `reportPlatform()` in `auth.js` / the web client does not await a result and does not surface a
// failure: §1.4 puts this on the login path, and a census is not worth failing a sign-in for. That is
// the CLIENT's decision and it is stated here so the `500` above is not mistaken for 「登录会因此失败」
// — a genuine write failure answers honestly rather than dressing up as `{ ok: true }`, because an
// operator reading the logs is the one who can fix it.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { accountRefusal, requireUser, serviceClient } from "../_shared/client.ts";
import { PLATFORM_VALUES } from "../_shared/community.ts";

/**
 * The log's minimum spacing, per (account, platform) — see the header for why a number is needed at
 * all. Thirty minutes is longer than any reload burst and much shorter than a working day, so a
 * user who signs in twice in a morning produces one row while two people on one machine produce two.
 *
 * ⚠ IT LIVES HERE RATHER THAN IN THE SHARED BLOCK because no client needs it: the client's own
 * restraint is about not MAKING the request (a per-day key in `storage.js`), and this is about not
 * RECORDING it. Two different questions with two different homes, deliberately.
 */
const PLATFORM_LOG_MIN_MS = 30 * 60 * 1000;

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const { caller } = auth;

    // Banned and soft-deleted accounts do not report. Consistent with `geo-update`, and it keeps the
    // operator's census to accounts in good standing — a banned account's existing record stays.
    const refusal = accountRefusal(caller.row);
    if (refusal) return refusal;

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const platform = typeof body.platform === "string" ? body.platform : "";

    // ⚠ WHITELIST, NOT A SHAPE TEST. The body comes from a client, and the value ends up in a CHECK
    // constraint and in a runtime tag; anything outside `PLATFORM_VALUES` is refused rather than
    // stored-and-ignored, so a typo'd client is a visible 400 instead of an account that is counted
    // in no bucket of §1.5.3's panel.
    if (PLATFORM_VALUES.indexOf(platform) === -1) {
      return badRequest("platform must be one of: " + PLATFORM_VALUES.join(", "));
    }

    const current = caller.row?.platforms ?? [];
    const next = Array.from(new Set([...current, platform])).sort();
    const nowIso = new Date().toISOString();

    // Step 4 — the state. Unconditional: a repeat report is a no-op with the same values.
    const { error: upErr } = await sb
      .from("users")
      .update({
        platforms: next,
        last_platform: platform,
        last_platform_at: nowIso,
      })
      .eq("id", caller.id);
    if (upErr) throw upErr;

    // Step 5 — the log, throttled per the header. `head: true` asks PostgREST for the count without
    // the rows, the same trick `recentCount` (community.ts) uses for the rate limits: the question is
    // 「有没有一条」 and fetching one to find out would be the same round trip twice.
    const since = new Date(Date.now() - PLATFORM_LOG_MIN_MS).toISOString();
    const { count, error: cntErr } = await sb
      .from("platform_logins")
      .select("id", { count: "exact", head: true })
      .eq("user_id", caller.id)
      .eq("platform", platform)
      .gte("logged_in_at", since);
    if (cntErr) throw cntErr;

    let logged = false;
    if (!count) {
      const { error: insErr } = await sb.from("platform_logins").insert({
        user_id: caller.id,
        platform,
        // ⚠ THE COUNTRY ON RECORD, not the IP — see the header. Null on a first-report race.
        ip_country: caller.row?.country_code ?? null,
      });
      if (insErr) throw insErr;
      logged = true;
    }

    // The union is returned so a caller (or a test) can see the accumulated state without a second
    // read. The client ignores it — see the header on the fire-and-forget contract.
    return json({ ok: true, platforms: next, logged });
  } catch (err) {
    console.error("platform-report failed:", err);
    return internal("Could not record the platform");
  }
});
