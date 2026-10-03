/* auth.js — 激活码、会话、续期、离线宽限 (§三 of the 1.0.0 定稿).
 *
 * The account system is the part of 1.0.0 that can lock an operator out of their own tool, so the
 * single most important property of this file is what it does when it CANNOT reach the server.
 * §1.2 fixes that: an unactivated or offline operator keeps 「自动采集 / 检测分析 / 本地存档 / 学习
 * 机制 / 黑名单」 — everything except the four cloud rows — and §3.4 extends it to 30 days of grace
 * after the token expires, after which 「云功能锁定，**本地功能仍可用**」.
 *
 * There is therefore no code path here that disables a local feature. `state()` returns a string
 * describing the CLOUD half; nothing on the detection path ever asks for it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE FOUR STATES (§3.4's table, one function)
 * ---------------------------------------------------------------------------------------------
 *   'none'    no session at all — never activated, or the operator pressed 登出
 *   'active'  `now < expiresAt`                    「全部功能」
 *   'grace'   `expiresAt ≤ now < expiresAt + 30d`  「云功能受限（同步、主页），本地功能正常；
 *                                                   每次启动尝试续期」 — read-only cloud access
 *   'locked'  `now ≥ expiresAt + 30d`              「云功能锁定，本地功能仍可用；提示『请联网续期』」
 *   'banned'  the server said so (§6.2) — orthogonal to the clock, so it is checked first
 *
 * The grace window is anchored on `expiresAt`, NOT on when we last saw the server. That matters:
 * §3.4 says 「JWT 过期 1–30 天」, i.e. the 30 days start when the token dies. A client that was
 * offline for a year and comes back has a token that is 365 days past expiry, which is 'locked'
 * until the renewal below succeeds — and a successful renewal puts it straight back to 'active'.
 */
(function (g) {
  'use strict';

  // §0 #8 — 「JWT 有效期 30 天，每 7 天尝试续期」. Both numbers live here and nowhere else; the
  // server's 30-day expiry is the authority and this constant is only used for the RENEWAL cadence
  // and for the display, so the two cannot drift into a client-sided lie.
  var JWT_DAYS = 30;
  var RENEW_EVERY_DAYS = 7;
  // §0 #6 — 「支持 30 天（离线宽限），超期降级不锁死」.
  var GRACE_DAYS = 30;
  // §0 #2 — 「限制同时在线的设备数为 3 台」. Enforced server-side; repeated here so the client can
  // explain the limit before the operator wastes an attempt.
  var DEVICE_LIMIT = 3;

  var DAY_MS = 24 * 3600 * 1000;

  // §3.1: `BS-XXXX-XXXX-XXXX-XXXX`, Base32 with the confusable `I/O/0/1` removed. The alphabet
  // `A-HJ-NP-Z2-9` is exactly `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` expressed as ranges, and it is
  // written as ranges only because a 32-character class is easier to read than to verify.
  //
  // ⚠ §3.1 also says 「总长度 23 字符」. The pattern it prints is `BS-` + 16 + three hyphens = 22.
  // The pattern is what the Edge Function generates and what the server compares against, so the
  // pattern wins and the count in the prose is wrong by one (this project's standing rule: 规范
  // 示例值与公式不符时实现公式, and say so). The suite pins 22 and records the disagreement.
  var CODE_RE = /^BS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

  var _session = null;      // { jwt, expiresAt, user, lastRenewAt } or null
  var _loaded = false;
  var _listeners = [];

  function cloud() { return g.GMCloud; }
  function store() { return g.GMStorage; }

  function onChange(cb) { if (typeof cb === 'function') _listeners.push(cb); }
  function emit() {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](status()); } catch (e) { /* a listener must not break the caller */ }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 激活码
  // ---------------------------------------------------------------------------------------------

  /**
   * Why the operator's typing has to be repaired rather than rejected: §3.1's code is 22 characters
   * that people read off a card and retype. Grouping the characters and upper-casing them is the
   * difference between 「粘贴时少了一个连字符」 being a typo the operator fixes in two seconds and
   * being a failed activation they blame on us.
   *
   * Dashes and spaces are stripped and the tail is regrouped 4×4; anything that is not an allowed
   * Base32 character is left in place so `isValidCode()` can reject it and say so.
   */
  function normalizeCode(raw) {
    var s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.indexOf('BS') === 0) s = s.slice(2);
    if (s.length !== 16) return String(raw == null ? '' : raw).trim().toUpperCase();
    return 'BS-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16);
  }

  function isValidCode(raw) { return CODE_RE.test(normalizeCode(raw)); }

  // ---------------------------------------------------------------------------------------------
  // 会话
  // ---------------------------------------------------------------------------------------------

  /** The cached session, loaded from the store on first use. */
  async function load() {
    if (_loaded) return _session;
    _session = await store().loadCloudSession();
    _loaded = true;
    return _session;
  }

  /** Synchronous read of whatever is already in memory. `null` before the first `load()`. */
  function session() { return _session; }

  function daysBetween(a, b) { return (b - a) / DAY_MS; }

  /**
   * §3.4's table as a pure function of the session and the clock. Pure so the suite can drive the
   * whole table at any date without waiting 30 days or touching storage.
   */
  function stateOf(sess, now) {
    if (!sess || !sess.jwt) return 'none';
    // §6.2's 封禁 is orthogonal to the clock — a banned account with a perfectly fresh token is
    // still banned — so it is tested first and short-circuits the timing entirely.
    if (sess.user && sess.user.is_banned) return 'banned';
    var exp = Number(sess.expiresAt) || 0;
    if (!exp) return 'active';           // no clock to judge by: treat as live, the server still gates
    if (now < exp) return 'active';
    if (now < exp + GRACE_DAYS * DAY_MS) return 'grace';
    return 'locked';
  }

  function state() { return stateOf(_session, Date.now()); }

  /** Everything the UI needs to draw the account row, in one call. */
  function status() {
    var s = _session;
    var st = stateOf(s, Date.now());
    var exp = s ? (Number(s.expiresAt) || 0) : 0;
    return {
      configured: cloud().isConfigured(),
      state: st,
      user: (s && s.user) || null,
      // Negative once expired, which is what the 「已过期 N 天」 line wants; 0 when there is no
      // session at all (nothing to count from).
      daysLeft: exp ? Math.floor(daysBetween(Date.now(), exp)) : 0,
      // §1.2's table, as one boolean: does the cloud half work right now? 'grace' counts as usable
      // for the read-only features §3.4 names (同步、主页), and those are exactly the cloud
      // features, so there is no second finer-grained flag to keep in sync.
      cloudUsable: st === 'active' || st === 'grace',
      isAdmin: !!(s && s.user && s.user.is_admin),
    };
  }

  function isActivated() { var st = state(); return st === 'active' || st === 'grace'; }
  function isAdmin() { return !!(g.GMCloud.isConfigured() && _session && _session.user && _session.user.is_admin); }

  // ---------------------------------------------------------------------------------------------
  // 激活 (§3.2)
  // ---------------------------------------------------------------------------------------------

  /**
   * 用户输入激活码 → Edge Function `auth-activate` → JWT 缓存到 chrome.storage.local (§3.2).
   *
   * Every failure mode the server can report is mapped to something the operator can act on,
   * because the raw codes are useless to them: `INVALID_CODE` and `CODE_REVOKED` both mean 「stop
   * retyping this one」, `CODE_ALREADY_USED` means 「this code belongs to somebody else」, and
   * `DEVICE_LIMIT` means 「free a slot first」 (§7.5: 「已达设备数上限，请在其他设备登出」).
   */
  async function activate(rawCode) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var code = normalizeCode(rawCode);
    if (!CODE_RE.test(code)) return { ok: false, error: 'BAD_FORMAT' };

    var deviceId = await store().getDeviceId();
    var res = await cloud().call('auth-activate', {
      code: code,
      deviceId: deviceId,
      userAgent: (g.navigator && g.navigator.userAgent) || '',
    });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };

    var d = res.data || {};
    _session = {
      jwt: d.jwt,
      expiresAt: d.expiresAt || (Date.now() + JWT_DAYS * DAY_MS),
      user: d.user || null,
      // Set to NOW, not to 0: §3.4 renews 「每 7 天」 counting from a successful exchange, and a
      // fresh activation IS one. Zero here would make the very next boot fire a renewal.
      lastRenewAt: Date.now(),
    };
    _loaded = true;
    await store().saveCloudSession(_session);
    emit();
    return { ok: true, user: _session.user };
  }

  /**
   * §3.4 续期. Fire-and-forget by design: it runs at boot, nobody is waiting for it, and a failure
   * is not an event — the next boot tries again. `force` bypasses the 7-day gate for the 「立即
   * 续期」 affordance on the account row.
   *
   * Resolves to `{ ok, error? }` so a caller CAN report it; the boot path ignores the result.
   */
  async function renew(force) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    await load();
    if (!_session || !_session.jwt) return { ok: false, error: 'NO_SESSION' };
    if (stateOf(_session, Date.now()) === 'banned') return { ok: false, error: 'BANNED' };

    var last = Number(_session.lastRenewAt) || 0;
    // §3.4: 「if (Date.now() - last < 7 * 24 * 3600 * 1000) return;」 — but a token that has
    // already EXPIRED is always worth renewing early, regardless of the 7-day clock. Without this
    // an operator whose token died on day 31 would sit in 'grace' until their stale `lastRenewAt`
    // came round, which is the exact moment the grace window exists to cover.
    var expired = Date.now() >= (Number(_session.expiresAt) || 0);
    if (!force && !expired && (Date.now() - last) < RENEW_EVERY_DAYS * DAY_MS) {
      return { ok: false, error: 'TOO_SOON' };
    }

    var deviceId = await store().getDeviceId();
    // 8s, not the default 20: this one runs while the viewer is opening, and a spinner nobody asked
    // for is worse than a renewal that happens on the next boot.
    var res = await cloud().call('auth-renew', { deviceId: deviceId },
      { jwt: _session.jwt, timeoutMs: 8000 });
    if (!res.ok) {
      // §3.6: 「客户端下次联网续期时收到 401；客户端清除 JWT，回到未激活状态；本地数据不受影响」.
      // Doing that here is what turns a revoked code into an actual logout instead of a client that
      // keeps believing a dead token. `BANNED` deliberately does NOT clear — §6.2's 封禁 is
      // reversible by an admin, and the session keeps the flag so the UI can say so.
      if (res.status === 401 || res.status === 403) {
        await store().clearCloudSession();
        _session = null;
        emit();
      }
      return { ok: false, error: res.error, status: res.status };
    }
    var d = res.data || {};
    _session.jwt = d.jwt || _session.jwt;
    _session.expiresAt = d.expiresAt || (Date.now() + JWT_DAYS * DAY_MS);
    _session.lastRenewAt = Date.now();
    await store().saveCloudSession(_session);
    emit();
    return { ok: true };
  }

  /** Boot hook: the first half of §3.4's 「每次启动尝试续期」. */
  async function boot() {
    await load();
    if (_session && _session.jwt && cloud().isConfigured()) {
      try { await renew(false); } catch (e) { /* offline is an expected outcome, not a failure */ }
    }
    return status();
  }

  /**
   * 登出. Local-only (see `clearCloudSession`): §3.6 and §4.2 both require that leaving the account
   * never touches local data, and a logout that needed the network would be unusable exactly when
   * the operator wants it.
   */
  async function logout() {
    await load();
    await store().clearCloudSession();
    _session = null;
    _loaded = true;
    emit();
    return { ok: true };
  }

  /** Re-read the session from the store — used after another realm wrote it (SW, or an import). */
  async function refresh() {
    _session = await store().loadCloudSession();
    _loaded = true;
    emit();
    return status();
  }

  /** `status()` plus the expiry, for the account row's 「有效期至 …」 line. */
  function expiresAt() { return _session ? (Number(_session.expiresAt) || 0) : 0; }

  function renewAfterMs() {
    if (!_session) return 0;
    var due = (Number(_session.lastRenewAt) || 0) + RENEW_EVERY_DAYS * DAY_MS;
    return Math.max(0, due - Date.now());
  }

  g.GMAuth = {
    // Constants — the suite pins these against §0's decision table rather than against a literal.
    JWT_DAYS: JWT_DAYS,
    RENEW_EVERY_DAYS: RENEW_EVERY_DAYS,
    GRACE_DAYS: GRACE_DAYS,
    DEVICE_LIMIT: DEVICE_LIMIT,
    CODE_RE: CODE_RE,

    normalizeCode: normalizeCode,
    isValidCode: isValidCode,

    load: load,
    session: session,
    state: state,
    status: status,
    stateOf: stateOf,          // pure — the suite drives §3.4's table through this
    expiresAt: expiresAt,
    renewAfterMs: renewAfterMs,
    isActivated: isActivated,
    isAdmin: isAdmin,

    activate: activate,
    renew: renew,
    boot: boot,
    logout: logout,
    refresh: refresh,
    onChange: onChange,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMAuth;
})(typeof globalThis !== 'undefined' ? globalThis : this);
