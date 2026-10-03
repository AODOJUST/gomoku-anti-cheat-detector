/* cloud.js — the ONE place that knows where the Baishen backend lives.
 *
 * 1.0.0 turns the extension from a purely local tool into a product with an account system
 * (§十四: 「从『纯本地扩展』升级为『云账号 + 激活码 + 管理员』的完整产品」). This file is the
 * seam between those two halves, and it is deliberately tiny: everything that talks to Supabase
 * goes through `GMCloud.call`, so there is exactly one place that knows the URL shape, the
 * header set, the timeout, and — most importantly — what happens when there is no backend.
 *
 * ---------------------------------------------------------------------------------------------
 * THE SHIPPED STATE IS 「NOT CONFIGURED」, AND THAT IS NOT AN ERROR
 * ---------------------------------------------------------------------------------------------
 * §十三 tells the operator to supply `SUPABASE_URL` / the anon key / the service-role key after
 * they create the project. Until they do, the two constants below are EMPTY STRINGS, and:
 *
 *   * `isConfigured()` returns false,
 *   * `call()` returns `{ok:false, error:'NOT_CONFIGURED'}` **without touching the network**,
 *   * and every caller above this file degrades to 「纯本地」 — the detection, archiving, samples,
 *     learning and blacklist are all local-only features and are unaffected.
 *
 * That is not a fallback bolted on afterwards; it is the shape §1.2 asks for:
 *
 *   「**不破坏已有用户的本地使用**」 — 自动采集 ✅ 检测分析 ✅ 本地存档 ✅ 学习机制 ✅ 黑名单 ✅
 *   云同步 ❌ 用户主页 ❌ 徽章 ❌ 跨设备同步 ❌        (无账号用户 column, verbatim)
 *
 * A 0.5.x operator who never types an activation code must see exactly the extension they had,
 * minus two nav buttons. Anything that throws instead of returning `NOT_CONFIGURED` would break
 * that promise, so `call()` never rejects.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT MAY AND MAY NOT BE IN THIS FILE
 * ---------------------------------------------------------------------------------------------
 * The ANON key is public and is DESIGNED to ship inside a client (§2.2: 「Anon Key 可打包 —
 * 公开密钥，所有写操作走 RLS」). The **service-role key must never appear here or anywhere else
 * in the extension** (§2.2: it lives only in the Edge Functions' environment). `verify-062`
 * asserts that this file knows no key other than the anon one, so a well-meaning future edit
 * that pastes the service key in 「just to test」 goes red instead of shipping.
 */
(function (g) {
  'use strict';

  // -------------------------------------------------------------------------------------------
  // OPERATOR-FILLED PLACEHOLDERS — see supabase/README.md for the whole deployment walk-through.
  // -------------------------------------------------------------------------------------------
  // Empty = not configured = purely local. `http://127.0.0.1:54321` is the address `supabase
  // start` gives a local stack, which is what a developer testing against a local backend would
  // paste in here; it is accepted by `isConfigured()` on purpose.
  var SUPABASE_URL = '';
  var SUPABASE_ANON_KEY = '';

  var FUNCTIONS_PATH = '/functions/v1/';
  // 20s is generous for a cold Edge Function (they spin up on first call) and still short enough
  // that a dead network does not leave a 「正在激活…」 spinner on screen until the operator gives
  // up. The renewal path uses a shorter one — see auth.js — because it runs at boot and nobody
  // is waiting for it.
  var TIMEOUT_MS = 20000;

  // The deployment it talks to is either the hosted product (https://<ref>.supabase.co) or a
  // local `supabase start` stack (http://127.0.0.1:54321). Anything else — including a typo'd
  // value or a half-pasted URL — reads as "not configured" rather than as "configured but
  // broken", because the operator's remedy is the same and a failed boot is a worse outcome
  // than a feature that quietly stays local.
  var URL_RE = /^https?:\/\/([a-z0-9-]+\.supabase\.(co|in)|127\.0\.0\.1|localhost)(:\d+)?$/i;

  function isConfigured() {
    return URL_RE.test(SUPABASE_URL) && String(SUPABASE_ANON_KEY).length >= 20;
  }

  function endpoint(fn) {
    return SUPABASE_URL.replace(/\/+$/, '') + FUNCTIONS_PATH + fn;
  }

  /**
   * The single outbound call. NEVER rejects.
   *
   * Resolves to exactly one of:
   *   { ok: true,  data: <payload>, status: 200 }
   *   { ok: false, error: 'NOT_CONFIGURED' }
   *   { ok: false, error: 'NETWORK', status: 0 }          — offline, DNS, TLS, timeout, abort
   *   { ok: false, error: '<CODE>', status: <n>, message } — the server's own error envelope
   *
   * `opts.jwt` is the caller's bearer token; without it the anon key is used both as `apikey` and
   * as the bearer, which is what the activation call needs (it is by definition made by someone
   * who does not have a token yet).
   */
  async function call(fn, body, opts) {
    if (!isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var o = opts || {};
    var jwt = o.jwt || SUPABASE_ANON_KEY;
    var timeout = o.timeoutMs || TIMEOUT_MS;
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (ctl) timer = setTimeout(function () { ctl.abort(); }, timeout);

    var res, text;
    try {
      res = await fetch(endpoint(fn), {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + jwt,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body || {}),
        signal: ctl ? ctl.signal : undefined,
      });
      text = await res.text();
    } catch (e) {
      // A timeout and a dead network are the same thing to the operator ("try again later"), so
      // they share one code rather than growing a distinction nothing acts on. The only caller
      // that would care is the offline queue, and it treats both as "retry".
      if (timer) clearTimeout(timer);
      return { ok: false, error: 'NETWORK', status: 0, message: (e && e.message) || 'network' };
    }
    if (timer) clearTimeout(timer);

    var data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

    if (!res.ok) {
      // The Edge Functions answer failures with `{error:'CODE', message:'…'}` (§ contract in
      // supabase/README.md). A non-JSON body means something in front of the function answered —
      // a proxy, the platform's own 404 for a function that is not deployed — so it is reported
      // as an HTTP status rather than being forced into the error vocabulary, which would make
      // 「函数没部署」 look like 「激活码无效」.
      var code = (data && data.error) ? data.error : ('HTTP_' + res.status);
      return { ok: false, error: code, status: res.status, message: (data && data.message) || '' };
    }
    return { ok: true, data: data, status: res.status };
  }

  /**
   * PostgREST, for the tables §11.1 puts behind RLS rather than behind a Function.
   *
   * The 定稿 lists twelve Edge Functions and NOT ONE of them is a sync endpoint: §7.3 describes
   * 「双向增量同步」 over `updated_at`, §11.1 defines `samples`/`archives` tables, and §2.2 says
   * 「Anon Key 可打包 — 公开密钥，所有写操作走 RLS」. That is PostgREST with a user token, and it is
   * why this entry point exists: routing sync through a Function would mean re-implementing RLS in
   * TypeScript, which is the opposite of §2.2's 「RLS 默认拒绝」.
   *
   * `opts.jwt` is mandatory here — unlike `call()`, an anon key would simply be rejected by every
   * policy, so a missing token is answered locally rather than with a pointless round trip.
   */
  async function rest(table, opts) {
    if (!isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var o = opts || {};
    if (!o.jwt) return { ok: false, error: 'UNAUTHORIZED', status: 401 };
    var url = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + table + (o.query ? ('?' + o.query) : '');
    var headers = {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + o.jwt,
      'Content-Type': 'application/json',
    };
    // PostgREST reads its write intent from these two. `resolution=merge-duplicates` is what makes
    // an upsert an upsert, and `Prefer: return=representation` is how the caller gets the rows back
    // instead of a 201 with an empty body.
    if (o.prefer) headers['Prefer'] = o.prefer;
    if (!o.method || o.method === 'GET') headers['Prefer'] = headers['Prefer'] || 'return=representation';

    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (ctl) timer = setTimeout(function () { ctl.abort(); }, o.timeoutMs || TIMEOUT_MS);
    var res, text;
    try {
      res = await fetch(url, {
        method: o.method || 'GET',
        headers: headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: ctl ? ctl.signal : undefined,
      });
      text = await res.text();
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, error: 'NETWORK', status: 0, message: (e && e.message) || 'network' };
    }
    if (timer) clearTimeout(timer);

    var data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) {
      var code = (data && (data.error || data.code)) ? (data.error || data.code) : ('HTTP_' + res.status);
      return { ok: false, error: code, status: res.status, message: (data && data.message) || '' };
    }
    return { ok: true, data: data, status: res.status };
  }

  g.GMCloud = {
    // Constants the rest of the cloud code reads instead of re-declaring. Same rule as
    // BASE_WEIGHTS: one spelling per fact (this project has paid five times for a second copy).
    URL: SUPABASE_URL,
    FUNCTIONS_PATH: FUNCTIONS_PATH,
    TIMEOUT_MS: TIMEOUT_MS,

    isConfigured: isConfigured,
    endpoint: endpoint,
    call: call,
    rest: rest,
  };

  // Same dual-export shape as storage.js: the browser gets `GMCloud` on the global, and a Node
  // suite gets the same object back from `require`. Without this line a headless suite would load
  // this file and find `{}` — which is how a whole file can be "covered" by a suite that never
  // actually ran a line of it.
  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMCloud;
})(typeof globalThis !== 'undefined' ? globalThis : this);
