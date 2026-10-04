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
 * 扩展内最小集（可选）：生成激活码 / 查看用户列表 / 封禁解封」. Those three are all 1.0.0 shipped.
 *
 * ⚠ 1.0.4 §P0 WIDENS THIS, AND THE OLD SENTENCE IS LEFT HERE BECAUSE IT WAS THE REASON FOR A GAP.
 * The 1.0.0 note below read 「添加徽章 exists server-side (`admin-grant-badge`, §6.2) and is not
 * surfaced in the panel, because §5.1 renders 徽章/成就 as a 「即将推出」 placeholder — a button that
 * grants badges the profile page cannot display would be a door into a room with no floor」. The
 * reasoning was sound and the conclusion was not: 举报 / 反馈 / 新闻 / 全局开关 all had the same
 * shape (a shipped Function, no in-extension entry) and collectively left the operator 「只能在
 * Supabase Studio 里手动处理」 — 1.0.4 §P0. The badge button follows the same correction, and the
 * 即将推出 placeholder is what it is; an admin granting a badge to an account that cannot yet show
 * it is a smaller problem than a moderation queue nobody can work.
 *
 * What is STILL not surfaced, and why: 激活码的生成历史 (the server cannot re-list a code — see
 * `generateCodes`) and 「标记 reviewing」 on a report (`admin-handle-report` has no such action; its
 * ladder is 警告 / 禁言 24h / 禁言 7d / 封禁 / 不处理).
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

  /** §6.2's `admin-grant-badge`. Surfaced by 1.0.4 §P0 — see the header. */
  async function grantBadge(userId, badgeType) {
    var gu = guard();
    if (!gu.ok) return gu;
    if (!userId || !badgeType) return { ok: false, error: 'BAD_REQUEST' };
    return invoke('admin-grant-badge', { user_id: String(userId), badge_type: String(badgeType) }, gu.jwt);
  }

  /**
   * 1.0.5 §二.2.3 — 任命 / 罢免普通管理员, the two rows only a super admin may press.
   *
   * ⚠ THIS IS A PASS-THROUGH AND THE CLIENT DOES NOT DECIDE WHO MAY CALL IT. §2.2.3's table is
   * enforced in `admin-set-role` (`requireSuperAdmin`), and the button that reaches this function is
   * rendered only when `GMAuth.status().role === 'super_admin'` — which is a VISIBILITY rule, the
   * same kind `isAdmin()` above is. A client patched to draw the button gets a 403 and nothing else.
   *
   * `role` is passed through unvalidated for the same reason `handleReport` passes `action`: the
   * Function owns the set (`'admin' | 'user'`) and a second copy here could only ever be wrong.
   * §2.2.5's 「视觉上完全相同」 is what keeps `super_admin` off the client's list of things it may
   * ask for — see `toRole`'s note in `_shared/client.ts`.
   */
  async function setRole(userId, role) {
    var gu = guard();
    if (!gu.ok) return gu;
    if (!userId || !role) return { ok: false, error: 'BAD_REQUEST' };
    var res = await invoke('admin-set-role', { user_id: String(userId), role: String(role) }, gu.jwt);
    if (!res.ok) return res;
    return { ok: true, user: (res.data && res.data.user) || null };
  }

  // ---------------------------------------------------------------------------------------------
  // 1.0.4 §P0 — the operations panel's six new doors, and the reads behind its three lists
  // ---------------------------------------------------------------------------------------------
  // The four Functions below have shipped since 1.0.3 and had no caller in the extension: the
  // console could only be used from Supabase Studio, which is the gap §P0 names. Each is a thin
  // pass-through ON PURPOSE — the validation, the moderation ladder and the wording rules all live
  // in the Function, and a client-side copy of any of them would be a second answer that the
  // server's version could then disagree with (and the server is the one that decides).

  /**
   * §2.3.1's four sanctions plus 「不处理」. `action` is passed through unvalidated: `ADMIN_ACTIONS`
   * is in the shared block and the Function refuses anything outside it with a 400 naming the set,
   * so a second list here could only ever be wrong.
   */
  async function handleReport(reportId, action, note) {
    var gu = guard();
    if (!gu.ok) return gu;
    if (!reportId || !action) return { ok: false, error: 'BAD_REQUEST' };
    var res = await invoke('admin-handle-report', {
      report_id: String(reportId),
      action: String(action),
      note: note == null ? '' : String(note),
    }, gu.jwt);
    if (!res.ok) return res;
    return { ok: true, report: res.data && res.data.report, user: res.data && res.data.user };
  }

  /** §2.5.6's reply. `mailed` is a fact about the CALL (the provider accepted the message), not
   *  about the reader — the UI must not say 「已通知」 on the strength of it. */
  async function replyFeedback(feedbackId, reply) {
    var gu = guard();
    if (!gu.ok) return gu;
    if (!feedbackId || !reply) return { ok: false, error: 'BAD_REQUEST' };
    var res = await invoke('admin-reply-feedback', {
      feedback_id: String(feedbackId), reply: String(reply),
    }, gu.jwt);
    if (!res.ok) return res;
    return { ok: true, mailed: !!(res.data && res.data.mailed) };
  }

  /**
   * §2.4.5's publish. The body is passed as typed and the Function validates it — including
   * `translations`, which is the whole reason the Function exists rather than Studio (§2.4.5's
   * 「简单直接」 recommendation is about the simple case).
   */
  async function publishNews(entry) {
    var gu = guard();
    if (!gu.ok) return gu;
    var e = entry || {};
    if (!e.category || !e.title || !e.content) return { ok: false, error: 'BAD_REQUEST' };
    var body = {
      category: String(e.category),
      title: String(e.title),
      content: String(e.content),
    };
    if (e.lang) body.lang = String(e.lang);
    if (e.is_pinned) body.is_pinned = true;
    if (e.translations && typeof e.translations === 'object') body.translations = e.translations;
    var res = await invoke('admin-publish-news', body, gu.jwt);
    if (!res.ok) return res;
    return { ok: true, id: res.data && res.data.id };
  }

  /**
   * §2.3.2 / §2.3.3's two switches. Both keys are always sent, because the Function answers with
   * both read back from the database and a partial patch would make the untouched switch look like
   * it changed — the panel paints from the RESPONSE, never from the checkbox.
   */
  async function setGlobalMute(chatEnabled, globalMute) {
    var gu = guard();
    if (!gu.ok) return gu;
    var res = await invoke('admin-global-mute', {
      chat_enabled: !!chatEnabled, global_mute: !!globalMute,
    }, gu.jwt);
    if (!res.ok) return res;
    var s = (res.data && res.data.settings) || {};
    return { ok: true, chatEnabled: !!s.chat_enabled, globalMute: !!s.global_mute };
  }

  /**
   * The console's reads. PostgREST + RLS, not a Function: 011_rls_community.sql writes the admin
   * policies (`reports_read_admin`, `feedback_read_admin`) precisely so the console can read these
   * without a new endpoint, and going through RLS means 「谁看得见什么」 has one answer rather than
   * two. ⚠ The one thing RLS cannot give the console is `users.email`, because 011 narrowed the
   * column grant for EVERYONE including admins — that is why the user card is filled from
   * `admin-list-users` (service role) rather than from a `users` read.
   */
  function readTable(table, query) {
    var gu = guard();
    if (!gu.ok) return Promise.resolve(gu);
    return cloud().rest(table, { query: query, jwt: gu.jwt }).then(function (r) {
      if (!r.ok) return { ok: false, error: r.error, status: r.status };
      return { ok: true, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  /** §2.2's queue. `status: ''` means 「all」 — an empty filter must not become `status=eq.`. */
  function listReports(opts) {
    var o = opts || {};
    var query = 'select=*&order=created_at.desc&limit=' + Math.min(200, Math.max(1, Number(o.limit) || 50));
    if (o.status) query += '&status=eq.' + encodeURIComponent(String(o.status));
    if (o.reportedId) query += '&reported_id=eq.' + encodeURIComponent(String(o.reportedId));
    return readTable('reports', query);
  }

  function listFeedback(limit) {
    return readTable('feedback',
      'select=*&order=created_at.desc&limit=' + Math.min(200, Math.max(1, Number(limit) || 50)));
  }

  /** §2.3.3's two booleans, for the panel's initial state. */
  function readGlobal() {
    return readTable('global_settings', 'select=key,value').then(function (r) {
      if (!r.ok) return r;
      var out = { chatEnabled: true, globalMute: false };
      r.rows.forEach(function (row) {
        if (row && row.key === 'chat_enabled') out.chatEnabled = row.value !== false;
        if (row && row.key === 'global_mute') out.globalMute = row.value === true;
      });
      return { ok: true, chatEnabled: out.chatEnabled, globalMute: out.globalMute };
    });
  }

  function listNews(limit) {
    return readTable('news',
      'select=id,category,title,lang,is_pinned,published_at&order=is_pinned.desc,published_at.desc&limit=' +
      Math.min(100, Math.max(1, Number(limit) || 20)));
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
    setRole: setRole,        // 1.0.5 §二.2.3 — super-admin only, enforced server-side
    reissueJwt: reissueJwt,
    // 1.0.4 §P0 — the operations panel.
    handleReport: handleReport,
    replyFeedback: replyFeedback,
    publishNews: publishNews,
    setGlobalMute: setGlobalMute,
    readTable: readTable,
    listReports: listReports,
    listFeedback: listFeedback,
    readGlobal: readGlobal,
    listNews: listNews,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMAdmin;
})(typeof globalThis !== 'undefined' ? globalThis : this);
