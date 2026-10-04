/* profile.js — 用户主页 (§五 of the 1.0.0 定稿).
 *
 * §5.2 asks for something slightly unusual and worth honouring exactly: the object has SEVEN
 * methods, of which four 「现阶段全部返回空」. They exist now so that the day they are implemented
 * 「只需替换数据源」 — the panel, the view and the call sites are already the right shape.
 *
 * The four reserved methods therefore do NOT call the server at all. `profile-get` does return
 * empty `badges`/`achievements`/`accuracy`/`friends` alongside the real fields, and it is tempting
 * to have these read from that payload — but then the day a real implementation lands there would
 * be two sources for one answer, and this project has paid five times for exactly that. The
 * reserved methods are the future seam; `getProfile()` is the present one.
 */
(function (g) {
  'use strict';

  // §0 #9 / §4.4 — 「头像上传限制 2MB，压缩到 256×256」.
  var AVATAR_MAX_BYTES = 2 * 1024 * 1024;
  var AVATAR_SIZE = 256;
  var AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  function auth() { return g.GMAuth; }
  function cloud() { return g.GMCloud; }

  /** The token, or null. Every call here is a no-op without one — §5.1 gates the whole page. */
  function jwt() {
    var s = auth().session();
    return (s && s.jwt) || null;
  }

  /**
   * §5.3: 名字 / 头像 / 加入时间 come from `users`, the sample count from `count(*)` on `samples`,
   * and 「全部通过 Edge Function `profile-get` 一次拉取」 — so this is ONE round trip, not five.
   */
  async function getProfile() {
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED' };
    var res = await cloud().call('profile-get', {}, { jwt: t });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    var d = res.data || {};
    return {
      ok: true,
      user: d.user || null,
      sampleCount: Number(d.sampleCount) || 0,
      // 1.0.5 §三.1 — §3.2.2's other two numbers, added to the Function's own-profile answer. Both
      // default to 0 rather than to `undefined` so a 1.0.4-era server (which does not send them)
      // renders zeros instead of 「NaN」 — the client and the Function are deployed separately and
      // there is always a window where one is ahead of the other.
      archiveCount: Number(d.archiveCount) || 0,
      friendCount: Number(d.friendCount) || 0,
      // Passed through rather than synthesised, so that when the server starts filling them the
      // panel needs no change. Absent means 「还没实现」, and the view renders the grey 「即将推出」
      // block for exactly that case.
      badges: Array.isArray(d.badges) ? d.badges : [],
      achievements: Array.isArray(d.achievements) ? d.achievements : [],
      accuracy: (d.accuracy === undefined) ? null : d.accuracy,
      friends: Array.isArray(d.friends) ? d.friends : [],
    };
  }

  /**
   * §3.2.2's 游戏统计, and §3.2.3's fix for 「主页的样本库数目与实际样本库数目不匹配」.
   *
   * The server half is one `profile-get` call (sampleCount / archiveCount / friendCount / badges —
   * see that Function's own-profile branch). The LOCAL half is the part §3.2.3 is about: the cloud
   * only knows about rows that were ever pushed, and 云同步 是 **off by default**, so a page that
   * renders `sampleCount` alone under-reports every sample the operator has captured since.
   *
   * ⚠ §3.2.3 writes the rule as 「云端计数 + 本地未同步计数 = 真实数量」, and that sum is the size of
   * the UNION — which is worth saying out loud because the two obvious simplifications are both
   * wrong. 「就地取本地条数」 under-counts when another device pushed rows this one never pulled;
   * 「就地取云端计数」 is the defect being fixed. So the local ids are diffed against the cloud's.
   *
   * ⚠ The cloud side of the diff is read as IDS, not as a count: PostgREST cannot subtract two sets,
   * and `count()` would answer 「云端有几条」 — a question that is already answered exactly by
   * `profile-get`. The ids only ever decide WHICH local rows are missing up there. The `limit=1000`
   * is therefore a cap on the diff's accuracy, not on the number shown: past a thousand cloud rows
   * the count stays exact and the diff can only over-report the delta. A player with more than a
   * thousand samples on one account is a case §3.2.3's own arithmetic does not cover either.
   *
   * ⚠ §3.2.3 also sketches a `syncedToCloud` flag written on each sample. There is no such field in
   * this project and adding one would be adding a THIRD answer to 「这条样本上云了吗」 — `sync.js`
   * already decides that by comparing `updated_at` against the remote row (§7.3), and a stored flag
   * would go stale the moment a row was edited on another device. The diff asks the cloud.
   */
  async function getProfileStats() {
    var base = await getProfile();
    if (!base.ok) return base;
    var out = {
      ok: true,
      user: base.user,
      badges: base.badges,
      achievements: base.achievements,
      accuracy: base.accuracy,
      samples: base.sampleCount,
      archives: base.archiveCount,
      // §3.2.2 lists 检测对局 with 「同上」 in the 来源 column: it is the archive count, drawn twice.
      played: base.archiveCount,
      friends: base.friendCount,
      unsynced: 0,
    };

    var local = [];
    try { local = (await g.GMStorage.loadSamples()) || []; } catch (e) { local = []; }
    if (!local.length) return out;

    var t = jwt();
    if (!t || !cloud().isConfigured()) {
      // No cloud at all (or no session): the LOCAL store is the only truth there is, and it is also
      // exactly the number the 样本库 page shows — which is the property §3.2.3 is protecting.
      out.samples = local.length;
      out.unsynced = local.length;
      return out;
    }
    var res = await cloud().rest('samples', { method: 'GET', query: 'select=id&limit=1000', jwt: t });
    if (!res.ok) {
      // The diff failed but the page must still draw. Falling back to the local count here is
      // deliberate: the two numbers on screen are 「这一页」 and 「样本库那一页」, and the whole
      // complaint §3.2.3 answers is that they disagreed.
      out.samples = local.length;
      return out;
    }
    var seen = {};
    var rows = Array.isArray(res.data) ? res.data : [];
    for (var i = 0; i < rows.length; i++) seen[String(rows[i] && rows[i].id)] = true;
    for (var j = 0; j < local.length; j++) {
      if (!seen[String(local[j] && local[j].id)]) out.unsynced++;
    }
    out.samples = base.sampleCount + out.unsynced;
    return out;
  }

  // ---- 预留接口 (§5.2) ------------------------------------------------------------------------
  // 「现阶段全部返回空」. Kept as async functions rather than plain values so the call sites do not
  // change when they start awaiting a network answer.
  async function getBadges() { return []; }
  async function getAchievements() { return []; }
  async function getAccuracy() { return null; }
  async function getFriends() { return []; }

  /**
   * §4.3's 修改账户信息 table, upper half. `email` is deliberately NOT here: that row needs
   * 「输入新邮箱 + 验证邮件」, which is a different flow, and accepting it through this door would
   * let a client change a login identifier without proving control of it.
   */
  async function updateProfile(patch) {
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED' };
    var body = {};
    if (patch && patch.username !== undefined) body.username = patch.username;
    if (patch && patch.bio !== undefined) body.bio = patch.bio;
    if (patch && patch.avatarUrl !== undefined) body.avatarUrl = patch.avatarUrl;
    if (!Object.keys(body).length) return { ok: false, error: 'BAD_REQUEST' };
    var res = await cloud().call('profile-update', body, { jwt: t });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };
    var d = res.data || {};
    // The cached session carries the user projection the account row draws, so a successful edit
    // has to update it or the panel keeps showing the old name until the next login.
    var s = auth().session();
    if (s && d.user) { s.user = d.user; await g.GMStorage.saveCloudSession(s); }
    return { ok: true, user: d.user || null };
  }

  /** §4.2's 登出. Local data untouched — see `GMAuth.logout`. */
  async function logout() { return auth().logout(); }

  /**
   * §4.2's 注销账户. The server sets `deleted_at`, signs every device out and starts the 30-day
   * retention; the client's job afterwards is to forget the session (it is dead) and to make the
   * 「本地数据保留，云端数据将删除」 promise visible, which the view does.
   */
  async function deleteAccount(code) {
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED' };
    var body = {};
    if (code) body.code = auth().normalizeCode(code);
    // Read the id BEFORE the round trip: `logout()` below clears the session, and after that
    // `status().user` is null and there is nothing left to name the credential that must go.
    var meId = ((auth().status() || {}).user || {}).id || '';
    var res = await cloud().call('auth-delete-account', body, { jwt: t });
    if (!res.ok) return { ok: false, error: res.error, status: res.status };
    // 1.0.5 §一.1 — `forgetAccount`, not `forgetAccounts`: the other remembered accounts belong to
    // other people, and deleting one of them is not a statement about the rest. Leaving the deleted
    // one in the list would be worse than untidy — the drawer would offer a 免密 switch to an account
    // the server has already refused, i.e. a button whose every press ends in NEED_PASSWORD.
    await auth().logout();
    if (meId) { try { await auth().forgetAccount(meId); } catch (e) {} }
    return { ok: true, purgeAt: (res.data && res.data.purgeAt) || 0 };
  }

  // ---- 1.0.1 §三 账号设置 --------------------------------------------------------------

  /** `FileReader` → data URL, promise-shaped. The only async gap in the avatar path. */
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('read')); };
      fr.readAsDataURL(blob);
    });
  }

  /**
   * §3.6 头像上传: 「客户端压缩到 256×256（与 1.0.0 一致）；存 Supabase Storage `avatars` 桶；
   * 路径 `avatars/{user_id}.jpg`」.
   *
   * The bytes travel as a data URL in the `profile-update` body rather than from the client straight
   * to Storage. That is deliberate: a direct Storage PUT would be a THIRD outbound route in
   * `cloud.js` (which 1.0.0 narrowed to `call`/`rest` so that 「路由只有一个门」), and it would put
   * the bucket's RLS policy on the critical path of 「换个头像」. The server already holds the service
   * role key, already knows the user's id, and is where the `avatars/{user_id}.jpg` path is decided.
   */
  async function uploadAvatar(file) {
    var v = validateAvatar(file);
    if (!v.ok) return v;
    var c = await compressAvatar(file);
    if (!c.ok) return c;
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED' };
    var dataUrl;
    try { dataUrl = await blobToDataUrl(c.blob); }
    catch (e) { return { ok: false, error: 'AVATAR_FORMAT' }; }
    var res = await cloud().call('profile-update', { avatarData: dataUrl }, { jwt: t });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };
    var d = res.data || {};
    // Same reason as `updateProfile`: the account area and the header's avatar both draw from the
    // cached session, so a successful upload has to land there or they keep showing the old one.
    var s = auth().session();
    if (s && d.user) { s.user = d.user; await g.GMStorage.saveCloudSession(s); }
    return { ok: true, user: d.user || null };
  }

  /**
   * §3.7 修改密码. 当前密码 goes to the server to be verified there — a client-side check would be
   * theatre, since the old password is exactly what an attacker holding the session does not have.
   *
   * §3.7 asks whether to revoke every device's JWT and answers itself: 「建议撤销——密码修改通常是
   * 安全事件，应让所有设备重新登录」. The server revokes, so this session is dead by the time the
   * call returns and the client logs out locally to match, rather than keeping a token the server
   * will answer 401 to.
   */
  async function changePassword(currentPassword, newPassword) {
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED' };
    // §2.3's rule, asked before the round trip so 「新密码太短」 is not reported as a network problem.
    if (!auth().isValidPassword(newPassword)) return { ok: false, error: 'WEAK_PASSWORD' };
    var res = await cloud().call('auth-change-password', {
      currentPassword: String(currentPassword == null ? '' : currentPassword),
      newPassword: String(newPassword),
    }, { jwt: t });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };
    await auth().logout();
    return { ok: true };
  }

  /** §3.8 修改邮箱 — needs the code sent to the NEW address, plus the current password. */
  async function changeEmail(email, emailCode, password) {
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED' };
    var e = auth().normalizeEmail(email);
    if (!auth().isValidEmail(e)) return { ok: false, error: 'BAD_EMAIL' };
    if (!auth().isValidEmailCode(emailCode)) return { ok: false, error: 'BAD_EMAIL_CODE' };
    var res = await cloud().call('auth-change-email', {
      email: e,
      emailCode: String(emailCode).trim(),
      password: String(password == null ? '' : password),
    }, { jwt: t });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, message: res.message };
    var d = res.data || {};
    var s = auth().session();
    if (s && d.user) { s.user = d.user; await g.GMStorage.saveCloudSession(s); }
    return { ok: true, user: d.user || null };
  }

  // ---- 头像 (§4.4) ---------------------------------------------------------------------------

  /**
   * Front-end gate for §4.4's 「格式：jpg / png / webp；大小：≤ 2MB（前端校验）」.
   *
   * ⚠⚠ 1.0.5 — THE TWO CODES ARE ITS OWN, AND THEY USED TO BE `BAD_FORMAT`. `BAD_FORMAT` is the
   * ACTIVATION CODE's malformed-shape code (`GMAuth.validateCode`), and `cloudErrText` resolves it to
   * 「激活码格式形如 BS-XXXX-XXXX-XXXX-XXXX」. So picking a GIF for an avatar answered with the
   * activation code's format rule — a sentence about a different field, in a different flow, shown
   * next to 头像. `TOO_LARGE` had no branch at all and fell through to 「未知错误（TOO_LARGE）」.
   * One code, one meaning: see the two branches added to `cloudErrText`.
   */
  function validateAvatar(file) {
    if (!file) return { ok: false, error: 'AVATAR_FORMAT' };
    if (AVATAR_TYPES.indexOf(file.type) < 0) return { ok: false, error: 'AVATAR_FORMAT' };
    if (file.size > AVATAR_MAX_BYTES) return { ok: false, error: 'AVATAR_TOO_LARGE' };
    return { ok: true };
  }

  /**
   * 「客户端压缩到 256×256，上传压缩后版本」.
   *
   * ⚠ §4.4's sample draws with `ctx.drawImage(img, 0, 0, 256, 256)`, which STRETCHES: a 1024×256
   * source becomes a 256×256 avatar with a 4× vertical squash. 「压缩到 256×256」 is the
   * requirement and the sample is only one way to reach it, so this centre-crops to a square first
   * and then scales — the same rule as every other 规范示例值与公式不符的 case (implement the
   * requirement, and write down what the sample would have done).
   */
  async function compressAvatar(file) {
    var v = validateAvatar(file);
    if (!v.ok) return v;
    var bmp;
    try { bmp = await createImageBitmap(file); }
    catch (e) { return { ok: false, error: 'AVATAR_FORMAT' }; }

    var canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    var ctx = canvas.getContext('2d');
    var side = Math.min(bmp.width, bmp.height);
    var sx = (bmp.width - side) / 2;
    var sy = (bmp.height - side) / 2;
    // JPEG has no alpha; without this a transparent PNG turns black where it was clear, which on a
    // circular avatar is the whole background.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.drawImage(bmp, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    if (bmp.close) bmp.close();

    var blob = await new Promise(function (r) { canvas.toBlob(r, 'image/jpeg', 0.85); });
    if (!blob) return { ok: false, error: 'AVATAR_FORMAT' };
    return { ok: true, blob: blob };
  }

  g.GMProfile = {
    AVATAR_MAX_BYTES: AVATAR_MAX_BYTES,
    AVATAR_SIZE: AVATAR_SIZE,
    AVATAR_TYPES: AVATAR_TYPES,

    getProfile: getProfile,
    getProfileStats: getProfileStats,
    updateProfile: updateProfile,
    uploadAvatar: uploadAvatar,
    changePassword: changePassword,
    changeEmail: changeEmail,
    logout: logout,
    deleteAccount: deleteAccount,

    // 预留 (§5.2) — these four are the shape of the future, not a stub to delete.
    getBadges: getBadges,
    getAchievements: getAchievements,
    getAccuracy: getAccuracy,
    getFriends: getFriends,

    validateAvatar: validateAvatar,
    compressAvatar: compressAvatar,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMProfile;
})(typeof globalThis !== 'undefined' ? globalThis : this);
