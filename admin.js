/* admin.js — 管理员操作 (§六 of the 1.0.0 定稿).
 *
 * §6.1 states the rule this file has to obey, and it is a rule about what NOT to do:
 *
 *   「**只能服务端判定**」 … 「**客户端仅显示/隐藏 UI**——所有操作必须通过 Edge Function 二次校验」
 *
 * So `isAdmin()` here exists to decide whether a TAB IS DRAWN. It is not an authorisation check,
 * and nothing in this file treats it as one: every call carries the JWT, every Edge Function
 * re-verifies that token and re-reads `users.is_admin` before touching anything (§6.4's template
 * shows the three lines). The consequence is that a client patched to lie about `is_admin` gains
 * exactly one thing — it can see a list of buttons that all return 403.
 *
 * §6.3 also fixes the SCOPE, and it is deliberately small: 「用 Supabase Studio 完成大部分操作.
 * 扩展内最小集（可选）：生成激活码 / 查看用户列表 / 封禁解封」. Those three are all that is here.
 * 添加徽章 exists server-side (`admin-grant-badge`, §6.2) and is not surfaced in the panel, because
 * §5.1 renders 徽章/成就 as a 「即将推出」 placeholder — a button that grants badges the profile page
 * cannot display would be a door into a room with no floor.
 */
(function (g) {
  'use strict';

  function cloud() { return g.GMCloud; }
  function auth() { return g.GMAuth; }

  function jwt() { var s = auth().session(); return (s && s.jwt) || null; }

  /**
   * Whether the 管理员 tab should exist. See the header: this decides VISIBILITY, nothing else.
   * `isConfigured()` is part of it because an unconfigured build has no server to be an admin of —
   * without that check a profile imported from a build that had `is_admin: true` cached would draw
   * an admin tab in a purely-local install.
   */
  function isAdmin() {
    return !!(cloud().isConfigured() && auth().isAdmin());
  }

  /** One place that refuses early, so every entry point reads the same. */
  function guard() {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED' };
    return { ok: true, jwt: t };
  }

  async function invoke(fn, body, t) {
    var res = await cloud().call(fn, body, { jwt: t });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };
    return { ok: true, data: res.data };
  }

  // ---------------------------------------------------------------------------------------------
  // §6.2's three panel operations
  // ---------------------------------------------------------------------------------------------

  /**
   * 生成激活码. Returns the codes so the caller can show them once — they are never retrievable
   * again from the client's side, which is the point (a code that can be re-listed is a code that
   * leaks the moment an admin session does).
   */
  async function generateCodes(count, note) {
    var gu = guard();
    if (!gu.ok) return gu;
    var n = Math.floor(Number(count));
    // §6.2's `{count, note}`; the range is mirrored from the Edge Function so the operator gets an
    // instant 「1–100」 instead of a round trip that says the same thing.
    if (!isFinite(n) || n < 1 || n > 100) return { ok: false, error: 'BAD_REQUEST' };
    var res = await invoke('admin-generate-code', { count: n, note: String(note || '') }, gu.jwt);
    if (!res.ok) return res;
    return { ok: true, codes: (res.data && res.data.codes) || [] };
  }

  /** 查看用户列表（分页） (§6.2). */
  async function listUsers(opts) {
    var gu = guard();
    if (!gu.ok) return gu;
    var o = opts || {};
    var body = {
      page: Math.max(1, Math.floor(Number(o.page) || 1)),
      // Mirrors the server's clamp so paging maths in the view cannot disagree with what comes back.
      limit: Math.min(200, Math.max(1, Math.floor(Number(o.limit) || 50))),
    };
    if (o.filter) body.filter = o.filter;
    var res = await invoke('admin-list-users', body, gu.jwt);
    if (!res.ok) return res;
    var d = res.data || {};
    return {
      ok: true,
      users: Array.isArray(d.users) ? d.users : [],
      total: Number(d.total) || 0,
      page: body.page,
      limit: body.limit,
    };
  }

  /** §6.2: 「封禁用户 `{ user_id, reason }` → `{ ok }`」. */
  async function banUser(userId, reason) {
    var gu = guard();
    if (!gu.ok) return gu;
    if (!userId) return { ok: false, error: 'BAD_REQUEST' };
    return invoke('admin-ban-user', { user_id: String(userId), reason: String(reason || '') }, gu.jwt);
  }

  /** §6.2: 「解封用户 `{ user_id }` → `{ ok }`」. */
  async function unbanUser(userId) {
    var gu = guard();
    if (!gu.ok) return gu;
    if (!userId) return { ok: false, error: 'BAD_REQUEST' };
    return invoke('admin-unban-user', { user_id: String(userId) }, gu.jwt);
  }

  // ---------------------------------------------------------------------------------------------
  // §3.6 / §6.2 — outside the panel's minimum set, kept because they are the emergency路径
  // ---------------------------------------------------------------------------------------------

  /**
   * §3.6's batch revocation — 「管理员一键**批量撤销** + 用户重新绑定」 (§0 #11).
   *
   * §0 #11 calls this the answer to a LEAK, so it must be reachable fast and must not require
   * picking codes one by one: `{all: true}` is the 「泄露了」 button. The server refuses to revoke
   * an already-redeemed code outside `{all:true}` (see its comment) — that case is what re-issue is
   * for, not revocation.
   */
  async function revokeCodes(spec) {
    var gu = guard();
    if (!gu.ok) return gu;
    var body;
    if (spec && spec.all) body = { all: true };
    else {
      var codes = (spec && spec.codes) || [];
      if (!Array.isArray(codes) || !codes.length) return { ok: false, error: 'BAD_REQUEST' };
      body = { codes: codes };
    }
    var res = await invoke('admin-revoke-codes', body, gu.jwt);
    if (!res.ok) return res;
    return { ok: true, revoked: Number(res.data && res.data.revoked) || 0 };
  }

  /** §6.2's `admin-grant-badge`. Server-side only for now — see the header. */
  async function grantBadge(userId, badgeType) {
    var gu = guard();
    if (!gu.ok) return gu;
    if (!userId || !badgeType) return { ok: false, error: 'BAD_REQUEST' };
    return invoke('admin-grant-badge', { user_id: String(userId), badge_type: String(badgeType) }, gu.jwt);
  }

  /**
   * §3.5's last resort: 「管理员手动重新签发 JWT（通过 Edge Function `admin-reissue-jwt`）」 for an
   * operator who has lost both the activation code and the mailbox. The returned token is handed to
   * the OPERATOR to paste on their own machine — it is not installed on the admin's.
   */
  async function reissueJwt(userId) {
    var gu = guard();
    if (!gu.ok) return gu;
    if (!userId) return { ok: false, error: 'BAD_REQUEST' };
    var res = await invoke('admin-reissue-jwt', { user_id: String(userId) }, gu.jwt);
    if (!res.ok) return res;
    return { ok: true, jwt: (res.data && res.data.jwt) || '', expiresAt: (res.data && res.data.expiresAt) || 0 };
  }

  g.GMAdmin = {
    isAdmin: isAdmin,
    generateCodes: generateCodes,
    listUsers: listUsers,
    banUser: banUser,
    unbanUser: unbanUser,
    revokeCodes: revokeCodes,
    grantBadge: grantBadge,
    reissueJwt: reissueJwt,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMAdmin;
})(typeof globalThis !== 'undefined' ? globalThis : this);
