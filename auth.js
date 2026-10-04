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

  // -------------------------------------------------------------------------------------------
  // 1.0.1 §2.3 — 注册字段的校验规则. §2.3's table lists each rule TWICE (`前端校验` and `后端校验`),
  // so a client copy is required rather than a duplicate: the server's copy is the authority and
  // this one exists so the operator sees 「密码不足 8 位」 while typing instead of after a round
  // trip. The two must agree, and the shape below is the one §2.3 writes out.
  // -------------------------------------------------------------------------------------------
  var PASSWORD_MIN = 8;      // 「≥ 8 位，字母 + 数字」
  var PASSWORD_STRONG = 12;  // §2.3's 强度条 top band — 「≥ 12 位 + 字母 + 数字 + 特殊字符」
  var USERNAME_RE = /^[^\s]{2,20}$/;                 // 「2–20 字符，无空格」
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;       // the same shape auth-activate already uses
  var EMAIL_CODE_RE = /^\d{6}$/;                     // 「6 位数字」

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

  // ---- §2.3 的校验规则（只有这一份；UI 与提交路径都读它）--------------------------------------

  /**
   * §2.3's 强度条 as ONE function. The three bands are cumulative and the table is written as a
   * ladder, so they are tested top-down:
   *
   *   强  ≥ 12 位 + 字母 + 数字 + 特殊字符
   *   中  ≥ 8 位 + 字母 + 数字
   *   弱  everything else
   *
   * §2.3 is explicit that only 中 is required — 「『强』级别只是 UI 上的鼓励，不强制」 — which is why
   * there is no separate 强 gate anywhere in this file. A 12-character password with no symbol is
   * therefore 中, not 强, and it is still accepted.
   */
  function passwordStrength(pw) {
    var s = String(pw == null ? '' : pw);
    var letter = /[A-Za-z]/.test(s);
    var digit = /[0-9]/.test(s);
    var special = /[^A-Za-z0-9]/.test(s);
    if (s.length >= PASSWORD_STRONG && letter && digit && special) return 'strong';
    if (s.length >= PASSWORD_MIN && letter && digit) return 'medium';
    return 'weak';
  }

  /** §2.3: 「中」级别即通过. The single predicate the form and the submit path share. */
  function isValidPassword(pw) { return passwordStrength(pw) !== 'weak'; }

  function isValidUsername(u) { return USERNAME_RE.test(String(u == null ? '' : u).trim()); }
  function isValidEmail(e) { return EMAIL_RE.test(String(e == null ? '' : e).trim()); }
  function isValidEmailCode(c) { return EMAIL_CODE_RE.test(String(c == null ? '' : c).trim()); }

  /** Lower-cased and trimmed — the spelling every server row is keyed on. */
  function normalizeEmail(e) { return String(e == null ? '' : e).trim().toLowerCase(); }

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
      // 1.0.5 §二.2 — the caller's OWN role, straight off `users.role` as `toPublicUser` reported it
      // at login. It drives VISIBILITY only (`admin.js:setRole`'s comment says why): a client
      // patched to claim `super_admin` reaches the same 403 as any other impostor.
      // ⚠ `'user'` when there is no session, NOT `null`: three values is the whole vocabulary, and a
      // fourth ("unknown") would force every consumer to handle it for a case that cannot act.
      role: (s && s.user && s.user.role) || 'user',
      isSuperAdmin: !!(s && s.user && s.user.role === 'super_admin'),
    };
  }

  function isActivated() { var st = state(); return st === 'active' || st === 'grace'; }
  function isAdmin() { return !!(g.GMCloud.isConfigured() && _session && _session.user && _session.user.is_admin); }
  /** §二.2 — same shape as `isAdmin()` above, so the two conditionals in the UI read alike. */
  function isSuperAdmin() {
    return !!(g.GMCloud.isConfigured() && _session && _session.user &&
      _session.user.role === 'super_admin');
  }

  /**
   * 1.0.1 §1.2 — **the** 准入判定, and there is exactly one of it.
   *
   * §1.1's matrix has two columns (未激活 / 已激活) and §1.2 says 「未激活时不执行任何 DOM 创建」. Every
   * surface that has a gated half — `content.js`'s overlay, the viewer's nav tabs, the viewer's
   * settings panels, the account area — asks THIS function rather than testing `isActivated()`
   * itself, because a second spelling is how the four surfaces would end up disagreeing about the
   * same operator.
   *
   * ---------------------------------------------------------------------------------------------
   * ⚠ WHY 「NO BACKEND」 IS NOT 「未激活」
   * ---------------------------------------------------------------------------------------------
   * §1.2's pseudocode is `if (!await GMAuth.isActivated())`, which with the shipped empty
   * placeholders would lock every feature behind a door that cannot be opened: with no server there
   * is nobody to issue an activation code and nowhere to validate one. That is not a gate, it is a
   * brick — and it directly contradicts the property 1.0.0 spent a whole release establishing
   * (`cloud.js`: 「出厂状态没有后端，即纯本地」, plus §1.2 of the 1.0.0 定稿: 「不破坏已有用户的本地
   * 使用」). The 1.0.1 定稿 never contemplates an unconfigured build — §七 assumes the operator
   * supplies the keys before launch — so this is recorded explicitly rather than inferred:
   *
   *     「没有门的房间，不需要开门的钥匙。」
   *
   * **Confirmed with the operator before implementing** (the one fork 1.0.1 does not decide). On a
   * configured deployment — which is what ships — this is identical to `isActivated()`, so the
   * product behaviour §1.1 asks for is unaffected.
   */
  function gateOpen() {
    var c = cloud();
    if (!c || !c.isConfigured()) return true;
    return isActivated();
  }

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
    // 1.0.1 §二 superseded this one-step path in the UI (the settings panel and the 「激活」 button
    // both open the two-step flow now), but the endpoint and this verb stay: a deployed 1.0.0
    // client still calls it, and removing either would be a breaking change for a build already in
    // the wild. It shares `adoptSession` with the new flows so a session is still built once.
    await adoptSession(d);
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
    // ⚠ 1.0.6 二号 §1.7.1 — `auth-renew` answers with the server's own projection, so a column the
    // server changed since this session was minted (an activation, a role, a 隐藏国籍) arrives
    // without a relogin. Before this, a session kept the five fields its door happened to know for
    // its whole 30 days. MERGE, not replace: a partial answer must not drop `is_admin`, and the one
    // field a stale local copy must never win on is `id` — so the server's object is layered over
    // the existing one, exactly like `patchUser` below does for a single-field write.
    if (d.user && typeof d.user === 'object') {
      _session.user = Object.assign({}, _session.user || {}, d.user);
    }
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
   * §3.1.2 — 「每次登录时更新」 the account's country, inferred server-side from THIS REQUEST's IP.
   *
   * ⚠⚠ IT HAS TO BE CALLED FROM THE CLIENT, WHICH IS WHY IT IS A CLIENT VERB AT ALL. §1.6.3's 修复
   * 清单 proposes calling `geo-update` FROM `auth-register` / `auth-renew`, and that cannot work:
   * `clientIp` (geo-update) reads the headers of the request it is answering, so a call made
   * server-to-server would geolocate the EDGE FUNCTION's own address — every account would come back
   * with the same country, and 1.6's 「管理员界面未显示地区」 would be replaced by a worse defect that
   * looks like a working feature. The IP has to be the operator's, so the request has to be theirs.
   *
   * ⚠ FAIL-OPEN, LIKE THE ENDPOINT ITSELF. A geolocation flag is a decoration on a profile (§1.3.1's
   * 「🇨🇳 中国大陆」 line); a failure here must never surface in a flow the operator is in the middle
   * of, so the result is returned for a caller that cares and swallowed by the two that do not.
   *
   * The 12-hour throttle lives in the Edge Function (`REFRESH_AFTER_MS`), not here: it is the same
   * answer for every caller and a second copy of it on this side would be a second thing to keep.
   */
  async function syncCountry(force) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    await load();
    if (!_session || !_session.jwt) return { ok: false, error: 'NO_SESSION' };
    var res;
    try {
      res = await cloud().call('geo-update', { force: force === true },
        { jwt: _session.jwt, timeoutMs: 8000 });
    } catch (e) {
      return { ok: false, error: 'NETWORK' };
    }
    if (!res.ok) return { ok: false, error: res.error };
    var d = res.data || {};
    // The server wrote the column; the session's projection is the stale half. Merged rather than
    // re-read, for the reason `patchUser` documents: this is a display field and the caller is
    // already holding the answer the server just gave.
    if (d.country_code) {
      _session.user = Object.assign({}, _session.user || {}, { country_code: d.country_code });
      _loaded = true;
      try { await store().saveCloudSession(_session); } catch (e) { /* the session is what matters */ }
      emit();
    }
    return { ok: true, country_code: d.country_code || null, reason: d.reason || null };
  }

  /**
   * 登出. Local-only (see `clearCloudSession`): §3.6 and §4.2 both require that leaving the account
   * never touches local data, and a logout that needed the network would be unusable exactly when
   * the operator wants it.
   *
   * 1.0.5 §一.1 — it clears the POINTER, not the LIST. §1.1.1 defines 切换账号 as 「保留已登录账号的
   * 会话」, and a 退出登录 that also forgot every credential would leave nothing to switch back to —
   * i.e. it would make the new feature impossible. The consequence is worth stating once, plainly:
   * **a remembered account's sealed token outlives 退出登录**. That is the point of the feature, and
   * it is documented in PRIVACY.md §4.5 next to the other at-rest secrets. `forgetAccount` is how a
   * single credential is thrown away, and `forgetAccounts` how all of them are.
   */
  async function logout() {
    await load();
    await store().clearCloudSession();
    _session = null;
    _loaded = true;
    var got = await store().loadAccounts();
    await store().saveAccounts(got.accounts, '');
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

  // =============================================================================================
  // 1.0.5 §一.1 切换账号（免密登录）
  // =============================================================================================
  // §1.1.1「区别于退出登录」 is the whole design: 退出登录 clears the LIVE session and nothing else,
  // while 切换账号 keeps a list of credentials that survive it — which is what 「免密」 means.
  //
  // ⚠⚠ **THIS PROJECT HAS NO REFRESH TOKEN, AND THE FIXTURE THIS FEATURE WAS SPECCED AGAINST IS
  // SUPABASE AUTH.** §1.1.2's storage sketch carries `refreshToken` and §1.1.3 calls
  // `supabase.auth.setSession({access_token, refresh_token})`. Neither exists here: 1.0.0 mints its
  // own 30-day JWT (`signJwt` in `_shared/client.ts`) and the only way to exchange it for a fresh
  // one is `auth-renew` — which takes a Bearer token and re-signs it, accepting a token up to 30
  // days past `exp` (its own `RENEW_GRACE_DAYS`). That function IS this project's refresh, so
  // `switchAccount` calls it with the TARGET account's token, and the row stores `expiresAt`
  // instead of a `refreshToken` that nothing could ever fill.
  // A stored `refreshToken: null` would have been the worse answer: a field that is always null
  // reads as 「not implemented yet」 to everyone who comes after, and the storage shape would then
  // be telling a story the code does not.
  //
  // Everything else in §1.1.2 holds literally: at most five accounts, same account updates in
  // place, and the JWT is sealed with AES-256-GCM before it is written.

  /** §1.1.4's seal, and the ONLY place the device key is resolved. A `null` answer means WebCrypto
   *  is missing (a stripped harness) — the caller refuses to remember rather than store a token in
   *  the clear, because a plaintext credential is worse than no convenience. */
  async function sealToken(jwt) {
    if (!g.GMCrypto || !g.GMCrypto.available()) return null;
    return g.GMCrypto.encryptToken(jwt, await store().getDeviceKey());
  }

  async function openToken(envelope) {
    if (!g.GMCrypto || !g.GMCrypto.available()) return null;
    return g.GMCrypto.decryptToken(envelope, await store().getDeviceKey());
  }

  /**
   * §1.1.2's upsert. Newest first, because storage.js's ceiling is 「淘汰最旧的」 and it can only cut
   * from one end — the sort lives in storage.js beside the cut so both read the same field.
   */
  async function rememberAccount(session) {
    var s = session || _session;
    var u = s && s.user;
    if (!u || !u.id) return null;
    var envelope = await sealToken(s.jwt);
    if (!envelope) return null;
    var got = await store().loadAccounts();
    var row = {
      userId: String(u.id),
      username: u.username || '',
      email: u.email || '',
      // §1.1.2 spells it `avatarUrl`; the `users` column is `avatar_url`. Mapped here, at the one
      // boundary where a server row becomes a stored credential.
      avatarUrl: u.avatar_url || '',
      // ⚠⚠ 1.0.6 二号 §1.7.1 — `activatedAt` IS PART OF THE CREDENTIAL ROW, and its absence was the
      // whole of 「切换账号后聊天室显示「未激活」」. This row is where a switch rebuilds the live
      // session FROM (there is no refresh token to ask — see the header), so a field missing here is
      // a field missing from the session, and `cmReadOnly()` reads `activated_at`: switching to an
      // ACTIVATED account produced a session that looked unactivated, and the room locked itself.
      //
      // ⚠ It rides here as well as on `auth-renew`'s answer because the two cover different paths:
      // the server's projection is authoritative when the network answers, and this row is all there
      // is when it does not (the documented offline switch below).
      activatedAt: u.activated_at || null,
      jwt: envelope,
      // The addition §1.1.2 does not have — see the header block: this is what lets the drawer say
      // 「免密」 instead of guessing, without a network call.
      expiresAt: Number(s.expiresAt) || 0,
      lastLoginAt: Date.now(),
      isAdmin: u.is_admin === true,
    };
    var next = [row].concat(got.accounts.filter(function (a) { return a.userId !== row.userId; }));
    return store().saveAccounts(next, row.userId);
  }

  /** §1.1.2's list, newest login first — the order the drawer draws and the order the ceiling cuts. */
  async function getStoredAccounts() {
    var got = await store().loadAccounts();
    return got.accounts;
  }

  /** §1.1.2's writer, exposed so the drawer can act on the list without re-deriving the pointer. */
  function saveStoredAccounts(accounts, activeId) {
    return store().saveAccounts(accounts, activeId);
  }

  /** Forget every remembered account — 「删除账号」 only. 退出登录 deliberately keeps them. */
  function forgetAccounts() { return store().clearAccounts(); }

  /** §一.1 — throw away ONE credential (删除账号 for that account). The others are untouched: they
   *  are different people's sessions and this action says nothing about them. */
  async function forgetAccount(userId) {
    var id = String(userId == null ? '' : userId);
    var got = await store().loadAccounts();
    var next = got.accounts.filter(function (a) { return a.userId !== id; });
    var active = got.activeId === id ? '' : got.activeId;
    return store().saveAccounts(next, active);
  }

  /**
   * §1.1.3's `switchAccount`, adapted to the token model described above.
   *
   * Two questions have to be answered before a stored credential may become the live session:
   * 「它还能用吗」 and 「服务端还认它吗」. The first is local (`expiresAt`), the second is `auth-renew`
   * — the same call §3.4 already makes every 7 days, so a switch costs exactly one request and
   * leaves the operator holding a token that is good for another 30 days rather than the remainder
   * of the old one. On success the new session goes through `adoptSession`, so the row is re-sealed
   * with the FRESH token and marked active — one funnel, no second write path.
   *
   * The failure cases, and why each gets the answer it does:
   *   ACCOUNT_NOT_FOUND  the id is not in the list (a stale drawer).
   *   NEED_PASSWORD      §1.1.5's 「refresh token 过期 → 弹出密码输入」. Reached when the local copy is
   *                      past `expiresAt`, when the seal will not open (key rotated / store edited),
   *                      or when the server rejects it with 401/403 — a revoked `token_epoch`, a
   *                      deleted account, a ban. All four mean the same thing to the operator: this
   *                      account cannot be entered without the password.
   *   offline            a transport failure is NOT a rejection. If the local copy is still inside
   *                      its window the switch proceeds with it (the boot-time `renew()` will verify
   *                      it and clear it on a 401), because refusing would make 切换账号 useless for
   *                      the developer who is testing a build with the network off.
   */
  /**
   * The `user` projection a switch rebuilds when `auth-renew` did NOT answer with one (transport
   * failure — see `switchAccount`).
   *
   * ⚠ 1.0.6 二号 §1.7.1 — THIS FUNCTION EXISTS BECAUSE THE SAME SIX-LINE LITERAL WAS WRITTEN TWICE,
   * and the field that had gone missing from both was the one nothing drew: `activated_at`. It is
   * not decoration — `cmReadOnly()` (viewer.js) is 「未激活」's ONLY predicate, and the room's whole
   * write surface asks it. `is_admin` was the field somebody remembered to add when this literal was
   * copy-pasted; this is the version where the next one cannot be forgotten.
   *
   * A field the stored row does not have stays `null` rather than being omitted, so the shape of a
   * rebuilt session matches the shape `auth-renew` returns (`toPublicUser`).
   */
  function sessionUserFromAccount(target) {
    return {
      id: target.userId,
      username: target.username,
      email: target.email,
      avatar_url: target.avatarUrl,
      is_admin: target.isAdmin === true,
      activated_at: target.activatedAt || null,
    };
  }

  async function switchAccount(userId) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    await load();
    var id = String(userId == null ? '' : userId);
    var got = await store().loadAccounts();
    var target = null;
    for (var i = 0; i < got.accounts.length; i++) {
      if (got.accounts[i].userId === id) { target = got.accounts[i]; break; }
    }
    if (!target) return { ok: false, error: 'ACCOUNT_NOT_FOUND' };
    if (_session && _session.user && _session.user.id === id) {
      return { ok: true, user: _session.user, already: true };
    }
    var exp = Number(target.expiresAt) || 0;
    if (!(exp > Date.now())) return { ok: false, error: 'NEED_PASSWORD' };
    var jwt = await openToken(target.jwt);
    if (!jwt) return { ok: false, error: 'NEED_PASSWORD' };

    var deviceId = await store().getDeviceId();
    var res = await cloud().call('auth-renew', { deviceId: deviceId },
      { jwt: jwt, timeoutMs: 8000 });
    if (res.ok) {
      var d = res.data || {};
      await adoptSession({
        jwt: d.jwt || jwt,
        expiresAt: d.expiresAt,
        // ⚠ §1.7.1 — the SERVER's projection when it is there, the remembered row when it is not.
        // `auth-renew` answers with `toPublicUser(row)`, so this is a complete session rather than
        // the five fields the drawer happens to draw.
        user: d.user || sessionUserFromAccount(target),
      });
      return { ok: true, user: _session.user };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'NEED_PASSWORD', status: res.status };
    // Transport failure (offline / timeout / 5xx). The credential is still locally valid.
    await adoptSession({
      jwt: jwt,
      expiresAt: exp,
      user: sessionUserFromAccount(target),
    });
    return { ok: true, user: _session.user, unverified: true };
  }

  /** `status()` plus the expiry, for the account row's 「有效期至 …」 line. */
  function expiresAt() { return _session ? (Number(_session.expiresAt) || 0) : 0; }

  /**
   * 1.0.4 §P1 — merge fields into the cached `user` projection and persist.
   *
   * §3.1.6's 隐藏国籍 and §3.2.3's 在线状态 are written straight to `users` through PostgREST (011
   * grants update on exactly those two columns), so the write's effect on the SESSION is the
   * caller's problem. Without this the operator changes 在线状态 to 隐身, the row is updated, and
   * the presence channel — which reads `myManualStatus()` off this projection — keeps announcing
   * 在线 until the page is reloaded. Two answers to 「我的状态是什么」, one of them stale.
   *
   * ⚠ It merges rather than replaces, and it does not accept `is_admin` / `is_banned` / `id` /
   * `role`: those are the fields the server decides on every call, and a local write to them would
   * be this project's recurring 「客户端复述服务端判据」 defect in the one place where it would also
   * be a privilege escalation. The caller passes the row PostgREST returned; the merge is
   * field-by-field so a column the policy did not let through simply is not there.
   */
  async function patchUser(fields) {
    await load();
    if (!_session || !_session.user || !fields) return null;
    var allowed = ['username', 'bio', 'avatar_url', 'hide_country', 'manual_status',
                   'country_code', 'last_seen_at', 'muted_until', 'activated_at'];
    for (var i = 0; i < allowed.length; i++) {
      var k = allowed[i];
      if (Object.prototype.hasOwnProperty.call(fields, k)) _session.user[k] = fields[k];
    }
    await store().saveCloudSession(_session);
    emit();
    return _session.user;
  }

  // =============================================================================================
  // 1.0.1 §二 两步注册、登录、找回密码
  // =============================================================================================
  // §2.1 replaces 1.0.0's one-shot 「输码即建号」 with 「验证激活码 → 注册窗口 → auth-register」. The
  // three verbs below are that flow; `activate()` above stays for the 1.0.0 client (see its own note)
  // and every one of them funnels into `adoptSession()`, so a session is built in exactly one place.

  /**
   * Turn a successful `{ jwt, expiresAt, user }` answer into the cached session. Extracted rather
   * than repeated because three flows now mint one (activate / register / login) and this project
   * has paid five times for a second copy of an answer.
   */
  async function adoptSession(data) {
    var d = data || {};
    _session = {
      jwt: d.jwt,
      expiresAt: Number(d.expiresAtMs) || Date.parse(d.expiresAt) || (Date.now() + JWT_DAYS * DAY_MS),
      user: d.user || null,
      // Set to NOW, not to 0: §3.4 renews 「每 7 天」 counting from a successful exchange, and a
      // fresh activation IS one. Zero here would make the very next boot fire a renewal.
      lastRenewAt: Date.now(),
    };
    _loaded = true;
    await store().saveCloudSession(_session);
    // 1.0.5 §一.1.2 — a fresh session is also a remembering. FOUR callers funnel through here
    // (activate / register / login / switchAccount), and §1.1.2's 「同一账号重复登录时更新记录，
    // 不重复添加」 is exactly an upsert, so it belongs at the funnel rather than at each door.
    // Failures are swallowed on purpose: not remembering an account costs the operator a password
    // next time, while throwing here would undo a login that already succeeded.
    try { await rememberAccount(_session); } catch (e) { /* the session is what matters, not the memo */ }
    emit();
    return _session;
  }

  /**
   * §2.2 第一步：验证激活码. A QUERY, not a command: §2.2's contract is `{ valid, reason }` on a 200,
   * because 「这个码不存在」 is a normal answer to 「这个码能用吗」 rather than a transport failure.
   *
   * The reason vocabulary is §2.2's own (`NOT_FOUND` / `REVOKED` / `ALREADY_USED`) and is mapped
   * here onto the error codes the rest of the client already renders (`INVALID_CODE` /
   * `CODE_REVOKED` / `CODE_ALREADY_USED`), so the two steps of one flow cannot word the same
   * failure differently.
   */
  async function validateCode(rawCode) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var code = normalizeCode(rawCode);
    if (!CODE_RE.test(code)) return { ok: false, error: 'BAD_FORMAT' };
    var res = await cloud().call('auth-validate-code', { code: code });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    var d = res.data || {};
    if (d.valid === true) return { ok: true, code: code };
    var reason = d.reason;
    if (reason === 'REVOKED') return { ok: false, error: 'CODE_REVOKED' };
    if (reason === 'ALREADY_USED') return { ok: false, error: 'CODE_ALREADY_USED' };
    return { ok: false, error: 'INVALID_CODE' };
  }

  /** §2.4 发送邮箱验证码. Resend lives behind the Edge Function; the key never reaches the client. */
  async function sendCode(email) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var e = normalizeEmail(email);
    if (!EMAIL_RE.test(e)) return { ok: false, error: 'BAD_EMAIL' };
    var res = await cloud().call('auth-send-code', { email: e });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    return { ok: true };
  }

  /**
   * §2.3 实时检查唯一性. Debounced by the caller — this is a network call and §2.3 asks it to run
   * 「实时」, which means "while typing", not "on every keystroke".
   *
   * `field` is 'username' or 'email' and is validated here so a typo cannot become a query for an
   * arbitrary column.
   */
  async function checkAvailable(field, value) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    if (field !== 'username' && field !== 'email') return { ok: false, error: 'BAD_REQUEST' };
    var v = field === 'email' ? normalizeEmail(value) : String(value == null ? '' : value).trim();
    if (field === 'email' ? !EMAIL_RE.test(v) : !isValidUsername(v)) {
      return { ok: false, error: 'BAD_FORMAT' };
    }
    var res = await cloud().call('auth-check-available', { field: field, value: v });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    return { ok: true, available: !!(res.data && res.data.available) };
  }

  /**
   * The §2.3 form, validated once. Returns the normalised body or an error code — so the form, the
   * submit button and the suite all read the same rules instead of three copies of §2.3's table.
   */
  function validateRegistration(form) {
    var f = form || {};
    var out = {
      code: normalizeCode(f.code),
      username: String(f.username == null ? '' : f.username).trim(),
      email: normalizeEmail(f.email),
      password: String(f.password == null ? '' : f.password),
      confirm: String(f.confirm == null ? '' : f.confirm),
      emailCode: String(f.emailCode == null ? '' : f.emailCode).trim(),
    };
    if (!CODE_RE.test(out.code)) return { ok: false, error: 'BAD_FORMAT' };
    if (!isValidUsername(out.username)) return { ok: false, error: 'BAD_USERNAME' };
    if (!EMAIL_RE.test(out.email)) return { ok: false, error: 'BAD_EMAIL' };
    if (!isValidPassword(out.password)) return { ok: false, error: 'WEAK_PASSWORD' };
    // §2.3 lists 确认密码 as a FRONT-END-ONLY row (`后端校验` is 「——」), so this is the only place
    // that can check it and the request never carries it.
    if (out.confirm !== out.password) return { ok: false, error: 'PASSWORD_MISMATCH' };
    if (!EMAIL_CODE_RE.test(out.emailCode)) return { ok: false, error: 'BAD_EMAIL_CODE' };
    return { ok: true, body: out };
  }

  /** §2.5 注册提交 → Edge Function `auth-register` → 建号 + 绑码 + 签发 JWT. */
  async function register(form) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var v = validateRegistration(form);
    if (!v.ok) return v;
    var b = v.body;
    var res = await cloud().call('auth-register', {
      code: b.code,
      username: b.username,
      email: b.email,
      password: b.password,
      emailCode: b.emailCode,
      deviceId: await store().getDeviceId(),
      userAgent: (g.navigator && g.navigator.userAgent) || '',
    });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };
    await adoptSession(res.data);
    return { ok: true, user: _session.user };
  }

  /** §2.6 已有账户登录. */
  async function login(email, password) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var e = normalizeEmail(email);
    if (!EMAIL_RE.test(e)) return { ok: false, error: 'BAD_EMAIL' };
    if (!password) return { ok: false, error: 'BAD_CREDENTIALS' };
    var res = await cloud().call('auth-login', {
      email: e,
      password: String(password),
      deviceId: await store().getDeviceId(),
      userAgent: (g.navigator && g.navigator.userAgent) || '',
    });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };
    await adoptSession(res.data);
    return { ok: true, user: _session.user };
  }

  /**
   * §2.6 忘记密码 — the same email-code mechanism as registration. No session is minted: the
   * operator proves control of the mailbox, sets a new password, and then logs in through the
   * normal door, which is one flow fewer than auto-login would be.
   */
  async function resetPassword(form) {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var f = form || {};
    var email = normalizeEmail(f.email);
    var emailCode = String(f.emailCode == null ? '' : f.emailCode).trim();
    var password = String(f.password == null ? '' : f.password);
    var confirm = String(f.confirm == null ? '' : f.confirm);
    if (!EMAIL_RE.test(email)) return { ok: false, error: 'BAD_EMAIL' };
    if (!EMAIL_CODE_RE.test(emailCode)) return { ok: false, error: 'BAD_EMAIL_CODE' };
    if (!isValidPassword(password)) return { ok: false, error: 'WEAK_PASSWORD' };
    if (confirm !== password) return { ok: false, error: 'PASSWORD_MISMATCH' };
    var res = await cloud().call('auth-reset-password', {
      email: email, emailCode: emailCode, password: password,
    });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };
    return { ok: true };
  }

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
    // §2.3's field rules.
    PASSWORD_MIN: PASSWORD_MIN,
    PASSWORD_STRONG: PASSWORD_STRONG,
    USERNAME_RE: USERNAME_RE,
    EMAIL_RE: EMAIL_RE,
    EMAIL_CODE_RE: EMAIL_CODE_RE,

    normalizeCode: normalizeCode,
    isValidCode: isValidCode,
    normalizeEmail: normalizeEmail,
    passwordStrength: passwordStrength,
    isValidPassword: isValidPassword,
    isValidUsername: isValidUsername,
    isValidEmail: isValidEmail,
    isValidEmailCode: isValidEmailCode,
    validateRegistration: validateRegistration,

    load: load,
    session: session,
    state: state,
    status: status,
    stateOf: stateOf,          // pure — the suite drives §3.4's table through this
    expiresAt: expiresAt,
    patchUser: patchUser,      // 1.0.4 §P1 — merge into the cached user projection
    renewAfterMs: renewAfterMs,
    isActivated: isActivated,
    isAdmin: isAdmin,
    isSuperAdmin: isSuperAdmin,
    gateOpen: gateOpen,        // 1.0.1 §1.2 — the ONE 准入判定; every gated surface asks this

    activate: activate,
    renew: renew,
    boot: boot,
    // 1.0.6 二号 §1.6 — §3.1.2's country inference. A client verb because the IP has to be the
    // CALLER's; see the function's own note for why the spec's server-side call site cannot work.
    syncCountry: syncCountry,
    logout: logout,
    refresh: refresh,
    onChange: onChange,

    // 1.0.5 §一.1 — 切换账号. `switchAccount` is the only verb the UI calls; the other four are the
    // list's readers/writers, exported so the drawer does not have to reach into `GMStorage` itself
    // (and so a future caller cannot invent a second write path around `saveAccounts`).
    switchAccount: switchAccount,
    getStoredAccounts: getStoredAccounts,
    saveStoredAccounts: saveStoredAccounts,
    forgetAccount: forgetAccount,
    forgetAccounts: forgetAccounts,

    // 1.0.1 §二 — the two-step flow and its neighbours.
    validateCode: validateCode,
    sendCode: sendCode,
    checkAvailable: checkAvailable,
    register: register,
    login: login,
    resetPassword: resetPassword,
    adoptSession: adoptSession,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMAuth;
})(typeof globalThis !== 'undefined' ? globalThis : this);
