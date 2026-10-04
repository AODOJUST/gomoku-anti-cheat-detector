// geo-update — §3.1.1/§3.1.2: infer `users.country_code` from the caller's IP.
//
// POST { force?: boolean }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, country_code, updated_at, reason? }
//   -> 401 { error: 'UNAUTHORIZED' }
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// ⚠ IT ALWAYS ANSWERS 200 WHEN THE ACCOUNT IS FINE. A geolocation lookup is a DECORATION on the
// profile (§1.3.1's 「🇨🇳 中国大陆」 line), and every failure mode below is reported in `reason`
// rather than as an error status: 「no_ip」 / 「not_configured」 / 「lookup_failed」 / 「throttled」.
// The alternative — a 5xx for a missing token — would make an unrelated client call fail, and this
// endpoint is called on the login path (§3.1.2 「每次登录时更新」). A profile without a flag is a
// profile; a login that fails because ipinfo.io is down is an outage. The client shows 白旗
// (`FLAG_FALLBACK`) either way, which is also what §3.1.6's hidden country renders as.
//
// ---------------------------------------------------------------------------------------------
// WHY IPINFO.IO, AND WHAT IT COSTS
// ---------------------------------------------------------------------------------------------
// §3.1.1 offers MaxMind GeoLite2 (「免费、离线数据库、需定期更新」) or ipinfo.io (「API 调用、有免费额度、
// 简单」). ipinfo.io is what ships, and the deciding factor is not simplicity: a GeoLite2 `.mmdb` is
// a binary blob that has to live inside this Function's bundle and be refreshed every couple of
// weeks, and a stale geolocation database fails SILENTLY — the code is plausible and wrong. An API
// either answers or does not.
//
// ⚠ `IPINFO_TOKEN` is optional-as-in-degradable, not optional-as-in-unnecessary: without it,
// `https://ipinfo.io/<ip>/json` answers 401 for a tokenless request from a server. So a missing
// token is `reason: 'not_configured'` and nothing else happens — this is the one place in this
// release where "missing config" is fail-open, because the feature is decorative. (Compare
// `friend-share-purge`, where the same situation must be fail-CLOSED: a purge that silently stops
// is a promise broken, a missing flag is a missing flag.)
//
// ---------------------------------------------------------------------------------------------
// §3.1.7 「IP 本身不存储，只存储推断出的国家代码」
// ---------------------------------------------------------------------------------------------
// ⚠ THE IP LIVES IN THIS FUNCTION'S STACK FRAME AND NOWHERE ELSE. It is not written to `users`, not
// logged (a log line is storage), and not returned to the caller — the response carries the country
// code and only that. The country code IS returned because the caller may want to render it
// immediately; it is not a secret (§3.1.3 puts it on the profile), and §3.1.6's hidden mode is a
// DISPLAY preference, applied by every reader, not a confidentiality boundary.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { accountRefusal, requireUser, serviceClient } from "../_shared/client.ts";
import { COUNTRY_CODE_RE } from "../_shared/community.ts";

/** How long a stored inference is trusted before a normal (non-forced) call refreshes it.
 *  §3.1.2 「每次登录时更新；每天首次活跃时更新」 — one of the two is enough, and 12 hours means a user
 *  who logs in twice in a morning makes one lookup, not two. */
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;
/** ipinfo.io's timeout. Short: this sits on the login path and it is decorating a profile. */
const LOOKUP_TIMEOUT_MS = 4000;

/**
 * The caller's IP, from the headers Supabase's edge proxy sets.
 *
 * ⚠ `x-forwarded-for` is a LIST and the CLIENT-CONTROLLED part is everything after the first entry.
 * Taking `[0]` is taking the value the proxy appended, which is the peer it accepted the connection
 * from; a later entry can be anything the caller sent. This is the one line where getting the order
 * wrong turns §3.1 into a feature that reports whatever country the user types.
 */
function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  return null;
}

/**
 * Is this address worth looking up?
 *
 * Loopback / private / link-local ranges are refused because a local development instance (or a
 * misconfigured proxy) would otherwise send `127.0.0.1` to ipinfo.io and get back whatever that
 * resolves to — a wrong country is worse than none, because nothing marks it as wrong.
 */
function routable(ip: string): boolean {
  if (!ip) return false;
  // IPv6 loopback / link-local.
  if (ip === "::1" || /^fe80:/i.test(ip) || /^fc/i.test(ip) || /^fd/i.test(ip)) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 0) return false;
    return true;
  }
  // Anything else that parses as an IPv6 address is assumed routable; a value that is neither
  // family is refused rather than sent.
  return /^[0-9a-f:]+$/i.test(ip) && ip.indexOf(":") !== -1;
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

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const force = body.force === true;

    const current = caller.row?.country_code ?? null;

    // §3.1.2's throttle. `force` is for the settings panel's 「立即更新」 button, where the user has
    // explicitly asked and waiting 12 hours would look broken.
    const updatedAt = caller.row?.country_updated_at ?? null;
    if (!force && updatedAt && Date.parse(updatedAt) > Date.now() - REFRESH_AFTER_MS) {
      return json({ ok: true, country_code: current, updated_at: updatedAt, reason: "throttled" });
    }

    const ip = clientIp(req);
    if (!ip || !routable(ip)) {
      return json({ ok: true, country_code: current, updated_at: updatedAt, reason: "no_ip" });
    }

    const token = Deno.env.get("IPINFO_TOKEN");
    if (!token) {
      return json({
        ok: true,
        country_code: current,
        updated_at: updatedAt,
        reason: "not_configured",
      });
    }

    // ---- the lookup --------------------------------------------------------------------------
    let country: string | null = null;
    try {
      const res = await fetch(
        `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
      );
      if (res.ok) {
        const payload = await res.json().catch(() => null) as { country?: unknown } | null;
        const raw = payload && typeof payload.country === "string"
          ? payload.country.toUpperCase()
          : "";
        // §3.1.2's 「ISO 3166-1 alpha-2」, checked here rather than trusted: ipinfo answers `""` for
        // an address it cannot place, and `users_country_code_shape` (010) would answer that with a
        // 23514 — an error status for a decorative feature, which is what this file exists to avoid.
        if (COUNTRY_CODE_RE.test(raw)) country = raw;
      }
    } catch (lookupErr) {
      // Swallowed on purpose — see the header. `reason` is how it is reported.
      console.error("geo-update lookup failed:", lookupErr);
    }

    if (!country) {
      // ⚠ `country_updated_at` is NOT stamped on a failure: the throttle reads it, and stamping it
      // would mean one bad lookup freezes the flag for 12 hours.
      return json({
        ok: true,
        country_code: current,
        updated_at: updatedAt,
        reason: "lookup_failed",
      });
    }

    const nowIso = new Date().toISOString();
    // ⚠ THE STORED CODE IS THE REAL ONE. §3.1.5's 港澳台 → 五星红旗 mapping happens in
    // `countryFlagChinaUnified` at DISPLAY time and is never applied here — writing 'CN' for an 'HK'
    // address would destroy the fact §3.1.5 explicitly says to keep.
    const { error } = await sb
      .from("users")
      .update({ country_code: country, country_updated_at: nowIso })
      .eq("id", caller.id);
    if (error) throw error;

    // The IP is out of scope from here on: not stored, not logged, not returned.
    return json({ ok: true, country_code: country, updated_at: nowIso });
  } catch (err) {
    console.error("geo-update failed:", err);
    return internal("Could not update the country");
  }
});
