/* platform.js — 1.0.6 四号 §一.4: the client half of 平台痕迹, for all three consumers.
 *
 *   viewer page   <script src="platform.js">        after cloud.js   → reports 'extension'
 *   service worker importScripts('platform.js')     after cloud.js   → reports 'extension'
 *   web/ (白身网页版, via web/tools/sync-lib.cjs)                     → reports 'web'
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE, AND NOT A FUNCTION IN `auth.js` OR `cloud.js`
 * ---------------------------------------------------------------------------------------------
 * §1.4.1 names THREE triggers — 「登录成功后 / 每次启动扩展 / 每天首次活跃时」 — and they do not happen
 * in one realm:
 *
 *   · 登录成功 and 「每天首次活跃」 are the viewer page's, where `auth.js` lives;
 *   · 「每次启动扩展」 is `background.js`'s `chrome.runtime.onStartup`, and a SERVICE WORKER CANNOT
 *     REACH THE VIEWER'S GLOBALS AT ALL. It is a separate global scope; `GMAuth` does not exist in it,
 *     and there is no extension page guaranteed to be open to relay a message to.
 *
 * ⇒ The reporter has to live in a module BOTH scopes load. It cannot live in `auth.js` (the worker
 * would have to pull in the whole account state machine, `emit()` and all, to make one POST), and it
 * does not belong in `cloud.js` — that file's header states its own job as being 「deliberately tiny」
 * and knowing only the URL shape, the header set and the timeout, and this verb reads the SESSION out
 * of storage, which `cloud.js` is otherwise entirely ignorant of.
 *
 * ⚠ ONE IMPLEMENTATION, AND THAT IS THE POINT OF THE FILE EXISTING AT ALL. The alternative — a POST in
 * `auth.js` and a second, near-identical POST in `background.js` — is this project's most expensive
 * recurring defect (six times over): the copies stay self-consistent and simply stop agreeing, so
 * nothing goes red. It is also the one place where two copies would be invisible: a worker that
 * reported with the wrong body would still get a 200 from… nothing, and the census would just be
 * quietly short.
 *
 * ---------------------------------------------------------------------------------------------
 * ⚠ THE PLATFORM VALUE COMES FROM THE SHARED BLOCK, AND A MISSING BLOCK IS A LOUD FAILURE
 * ---------------------------------------------------------------------------------------------
 * `'extension'` / `'web'` are `GMCommunityShared.PLATFORM`'s values (`_shared/community.ts`), not
 * literals spelled here. ⚠ SO THIS FILE REQUIRES `community-shared.js` TO BE LOADED FIRST, and returns
 * `{ error: 'NO_SHARED' }` rather than guessing if it is not — a fallback literal would be a second
 * spelling of the wire vocabulary, which is exactly the thing the shared block exists to prevent.
 * (All three consumers load it: the viewer and the web by `<script>`, the worker by `importScripts`.)
 *
 * ⚠ `PLATFORM.BOTH` AND `PLATFORM.NONE` ARE REFUSED HERE. They are DERIVED values (§1.2 says so) and
 * `platform-report` answers a 400 for them; refusing locally means a caller that passes one gets a
 * named error instead of a wasted round trip, and means this file cannot become the client-side
 * source of a stored `'both'`.
 *
 * ---------------------------------------------------------------------------------------------
 * ⚠ BEST-EFFORT, LIKE THE ENDPOINT ITSELF: THIS FUNCTION NEVER REJECTS
 * ---------------------------------------------------------------------------------------------
 * §1.4 puts the report on the LOGIN path. A census is not worth failing a sign-in over, and a user on a
 * flaky connection must not see an error from a feature they never asked for. So every failure mode —
 * no session, no backend, offline, a 500 — comes back as `{ ok: false, error: … }` for a caller that
 * cares and is ignored by the three that do not. ⚠ Compare `geo-update`: same posture, same reason,
 * and `syncCountry` is the sibling verb in `auth.js`.
 *
 * ---------------------------------------------------------------------------------------------
 * ⚠ WHY THERE IS NO 「今天报过没有」 KEY, AND WHY §1.4.1's THIRD TRIGGER IS STILL SATISFIED
 * ---------------------------------------------------------------------------------------------
 * §1.4.1's 「每天首次活跃时」 reads like a date key, and storing one is the obvious implementation. It is
 * NOT done, for a reason that only shows up in the other realm: **the web client's `GMStorage` has nine
 * methods and no generic key/value access** (`web/shim/webstore.js` implements exactly the surface
 * `auth.js` touches — the web is a different storage domain, not a different answer). A `platformReportDay`
 * key would therefore need a second store on the web side, i.e. a second home for one fact.
 *
 * ⇒ THE DE-DUPLICATION IS SERVER-SIDE AND THERE IS ONLY ONE OF IT: `platform-report` writes a
 * `platform_logins` row at most once per (account, platform) per `PLATFORM_LOG_MIN_MS` (30 minutes), so
 * every extra report from a reload or a second tab is a no-op that costs one request. 「每天首次活跃」
 * is then satisfied by construction — the product being active is exactly when this is called — and
 * 「近 7 天登录次数」 counts SESSIONS rather than browser starts, which is what the panel's number says.
 *
 * The small in-memory memo below is not the authority for anything; it only saves the redundant POST
 * within one page lifetime.
 */
(function (g) {
  'use strict';
  if (g.GMPlatform) return;

  /**
   * How long one page skips re-reporting the SAME platform. ⚠ Not the log's window — that lives in
   * `platform-report` (`PLATFORM_LOG_MIN_MS`) and is the one that decides whether a row is written.
   * This is purely 「don't POST again from this tab for five minutes」, and it is in RAM, so a reload
   * forgets it — deliberately, because a reload IS the product being used again.
   */
  var MEMO_MS = 5 * 60 * 1000;

  /** Per-page memo: `{ platform, at }` or null. See the header for why this is not persisted. */
  var memo = null;

  /** The shared block, or null. See the header on why a missing block is refused rather than guessed. */
  function shared() { return g.GMCommunityShared || null; }

  /**
   * The live session's bearer token, or null.
   *
   * Read through `GMStorage` (whose `loadCloudSession` exists in BOTH storage backends) rather than
   * through `GMAuth`, because the service worker has no `GMAuth`. The caller in the viewer passes its
   * token directly via `opts.jwt`, which is the same value and saves a store round trip there.
   */
  function storedJwt() {
    var S = g.GMStorage;
    if (!S || typeof S.loadCloudSession !== 'function') return Promise.resolve(null);
    var got;
    try { got = S.loadCloudSession(); } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(got).then(function (s) {
      return (s && s.jwt) ? s.jwt : null;
    }, function () { return null; });
  }

  /**
   * §1.4.1's report. `platform` is `'extension'` or `'web'`; `opts.jwt` skips the store read and
   * `opts.force` skips the in-memory memo.
   *
   * Resolves to one of:
   *   { ok: true,  platform, logged: bool }   — the server accepted it
   *   { ok: false, error: 'NOT_CONFIGURED' }  — pure-local build; nothing was attempted
   *   { ok: false, error: 'NO_SHARED' }       — community-shared.js was not loaded (a wiring bug)
   *   { ok: false, error: 'BAD_PLATFORM' }    — not a reportable value (so not 'both' / 'none')
   *   { ok: false, error: 'NO_SESSION' }      — nobody is signed in; nothing was attempted
   *   { ok: false, error: 'SKIPPED' }         — the memo refused a repeat, this page, this platform
   *   { ok: false, error: '<CODE>'|'NETWORK'|'HTTP_<n>', status }   — the call failed
   *
   * Never rejects — see the header.
   */
  async function report(platform, opts) {
    var o = opts || {};
    var cloud = g.GMCloud;
    if (!cloud || typeof cloud.call !== 'function' || !cloud.isConfigured()) {
      return { ok: false, error: 'NOT_CONFIGURED' };
    }

    var S = shared();
    var P = S && S.PLATFORM;
    if (!P) return { ok: false, error: 'NO_SHARED' };
    // ⚠ ONLY the two REPORTABLE values — `BOTH` / `NONE` are derivations (§1.2) and the endpoint
    // refuses them; see the header.
    if (platform !== P.EXTENSION && platform !== P.WEB) {
      return { ok: false, error: 'BAD_PLATFORM' };
    }

    if (!o.force && memo && memo.platform === platform && (Date.now() - memo.at) < MEMO_MS) {
      return { ok: false, error: 'SKIPPED' };
    }

    var jwt = o.jwt || await storedJwt();
    if (!jwt) return { ok: false, error: 'NO_SESSION' };

    // The memo is stamped BEFORE the call, not after: two report() calls fired in the same tick (a
    // login and a boot, which is the ordinary case) must produce ONE request, and stamping on success
    // would let both of them past the guard.
    memo = { platform: platform, at: Date.now() };

    var res;
    try {
      res = await cloud.call('platform-report', { platform: platform },
        { jwt: jwt, timeoutMs: o.timeoutMs || 8000 });
    } catch (e) {
      // `call()` documents that it never rejects; this is belt and braces so that a future change
      // there cannot turn a census into an unhandled rejection on the login path.
      return { ok: false, error: 'NETWORK', status: 0 };
    }
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    var d = res.data || {};
    return { ok: true, platform: platform, logged: d.logged === true };
  }

  /**
   * The two named triggers, one per consumer — so that NO CALL SITE SPELLS A WIRE VALUE.
   *
   * The viewer and the service worker are the extension (§1.4.1); the web page is the web version
   * (§1.4.2). Writing `'extension'` at three call sites would be three spellings of a value the shared
   * block owns, and the day one of them is mistyped the report is a 400 that nobody reads — this file
   * exists because that class of drift is invisible.
   */
  async function reportExtension(opts) {
    var P = shared() && shared().PLATFORM;
    return report(P ? P.EXTENSION : '', opts);
  }
  async function reportWeb(opts) {
    var P = shared() && shared().PLATFORM;
    return report(P ? P.WEB : '', opts);
  }

  g.GMPlatform = {
    PLATFORM_REPORT_MEMO_MS: MEMO_MS,
    report: report,
    reportExtension: reportExtension,
    reportWeb: reportWeb,
    /** Test seam: forget the in-memory memo. Not part of the product's behaviour. */
    _resetMemo: function () { memo = null; },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMPlatform;
})(typeof globalThis !== 'undefined' ? globalThis : this);
