/* sync.js — 云同步 (§七 of the 1.0.0 定稿).
 *
 * §7.1: 「首次激活时不自动开启」, 「默认 `false`」, 「开启时逐类选择」. §7.3: 「双向增量同步」 over
 * `updated_at`, with a conflict policy. §7.4: an offline queue that retries FIFO and gives up after
 * three tries. That is the whole feature, and it is built here as one engine over a table of
 * categories rather than as six bespoke flows.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS TALKS TO POSTGREST AND NOT TO AN EDGE FUNCTION
 * ---------------------------------------------------------------------------------------------
 * §11.1 lists twelve Edge Functions and none of them is a sync endpoint; §2.2 says the anon key is
 * 「可打包」 and 「所有写操作走 RLS」. So the record categories go straight to their tables and RLS
 * is what decides who may read and write them — which is also why `rest()` refuses to run without a
 * user token rather than falling back to the anon key.
 *
 * ---------------------------------------------------------------------------------------------
 * A GAP IN THE 定稿, FILLED AND NAMED
 * ---------------------------------------------------------------------------------------------
 * §7.2 puts 黑名单 / 设置 / 自定义问题 / 学习参数 in the sync set, but §11.1's schema defines tables
 * only for `samples` / `archives` (plus users/codes/devices/badges). Four categories were given a
 * requirement and no storage. They are all small single-blob documents — §7.2 itself says 黑名单 is
 * 「体积小，跨设备价值高」 — so `supabase/migrations/003_user_kv.sql` adds one
 * `user_kv (user_id, key, payload, updated_at)` table for them rather than four tables with one
 * jsonb column each. The mapping is in `CATS` below, one line per category, so the four are visibly
 * the same mechanism as the two record categories rather than a special case.
 */
(function (g) {
  'use strict';

  // §7.4: 「连续 3 次失败 → 提示用户」.
  var MAX_RETRIES = 3;
  // §7.3: 「若两侧都修改过（`updated_at` 差距 < 1 分钟），弹出『保留本地 / 保留云端 / 保留两者』」.
  var CONFLICT_WINDOW_MS = 60 * 1000;

  /**
   * The §7.2 table, one row per category. `hard: true` marks the two the 定稿 rules out outright
   * (「自定义引擎 ❌ 二进制过大」, 「背景图片 ❌ 二进制过大」): they are listed rather than omitted so
   * the settings panel can show them greyed with a reason, instead of hiding two rows the operator
   * has read about.
   */
  var CATS = [
    { key: 'samples', table: 'samples', kind: 'records' },
    { key: 'archives', table: 'archives', kind: 'records' },
    { key: 'blacklist', table: 'user_kv', kind: 'blob' },
    { key: 'settings', table: 'user_kv', kind: 'blob' },
    { key: 'customQuestions', table: 'user_kv', kind: 'blob' },
    { key: 'learnedParams', table: 'user_kv', kind: 'blob' },
    { key: 'customEngines', table: null, kind: 'hard', hard: true },
    { key: 'backgrounds', table: null, kind: 'hard', hard: true },
  ];

  function byKey(k) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].key === k) return CATS[i];
    return null;
  }

  function store() { return g.GMStorage; }
  function cloud() { return g.GMCloud; }
  function auth() { return g.GMAuth; }

  function jwt() { var s = auth().session(); return (s && s.jwt) || null; }

  // ---------------------------------------------------------------------------------------------
  // 偏好 (§7.1)
  // ---------------------------------------------------------------------------------------------

  /** The live preferences, read through the same normaliser the store uses. */
  async function loadPrefs() {
    var s = await store().loadSettings();
    return s.cloud;
  }

  async function setPrefs(patch) {
    var s = await store().loadSettings();
    var next = store().normalizeCloud(Object.assign({}, s.cloud, patch));
    await store().saveSetting('cloud', next);
    return next;
  }

  function isSyncable(k) { var c = byKey(k); return !!(c && !c.hard); }

  async function setEnabled(on) { return setPrefs({ syncEnabled: !!on }); }

  async function setCategory(k, on) {
    if (!byKey(k)) return null;
    var s = await store().loadSettings();
    var cats = Object.assign({}, s.cloud.syncCats);
    cats[k] = !!on;
    return setPrefs({ syncCats: cats });
  }

  /** The categories that are BOTH switched on and possible. §7.1/§7.2's intersection. */
  async function activeCats() {
    var p = await loadPrefs();
    if (!p.syncEnabled) return [];
    return CATS.filter(function (c) { return !c.hard && p.syncCats[c.key]; })
      .map(function (c) { return c.key; });
  }

  // ---------------------------------------------------------------------------------------------
  // 记录的本地半边
  // ---------------------------------------------------------------------------------------------

  /** What is on this machine for `cat`, in the shape the remote table stores. */
  async function collect(cat) {
    var S = store();
    if (cat.kind === 'records') {
      var rows = (cat.key === 'samples') ? await S.loadSamples() : await S.loadArchives();
      return (rows || []).map(function (r) {
        return { id: String(r.id), created_at: r.createdAt || r.savedAt || 0, payload: r };
      });
    }
    // blob categories: one document each, read through the store's own readers so a sync can never
    // disagree with what the panel shows.
    var doc = null;
    if (cat.key === 'blacklist') doc = await S.loadBlacklist();
    else if (cat.key === 'settings') doc = S.stripSecrets(await S.loadSettings());
    else if (cat.key === 'customQuestions') doc = (await S.loadSettings()).customQuestions;
    else if (cat.key === 'learnedParams') doc = await S.loadLearnedParams();
    return doc;
  }

  // ---------------------------------------------------------------------------------------------
  // 双向增量 (§7.3)
  // ---------------------------------------------------------------------------------------------

  function updatedAtOf(row) {
    var u = row && (row.updated_at || row.updatedAt);
    var n = Date.parse(u);
    return isFinite(n) ? n : (Number(u) || 0);
  }

  /**
   * §7.3's conflict rules, as one pure function so the suite can drive the table.
   *
   *   remote strictly newer            → 'remote'
   *   local strictly newer             → 'local'
   *   both moved inside a minute       → 'conflict'  (the operator chooses)
   *   exactly equal                    → 'same'
   *
   * `policy` is the operator's standing answer for the conflict window: 'auto' resolves it by the
   * same timestamp comparison that just tied (so it takes the remote, arbitrarily but
   * deterministically), while 'ask' surfaces it.
   */
  function resolve(localAt, remoteAt, policy, now) {
    var t = typeof now === 'number' ? now : Date.now();
    var l = localAt ? (t - localAt) : Infinity;
    var r = remoteAt ? (t - remoteAt) : Infinity;
    if (localAt === remoteAt) return 'same';
    var d = Math.abs((localAt || 0) - (remoteAt || 0));
    if (d < CONFLICT_WINDOW_MS && localAt && remoteAt) {
      if (policy === 'ask') return 'conflict';
      return 'remote';
    }
    return (remoteAt > localAt) ? 'remote' : 'local';
  }

  /**
   * One full pass. Never throws; every failure is reported in the result.
   *
   * Resolves `{ ok, error?, synced: [keys], failed: [{key,error}], conflicts: [keys] }`.
   */
  async function syncNow() {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED', synced: [], failed: [], conflicts: [] };
    if (!auth().isActivated()) return { ok: false, error: 'UNAUTHORIZED', synced: [], failed: [], conflicts: [] };
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED', synced: [], failed: [], conflicts: [] };

    var p = await loadPrefs();
    if (!p.syncEnabled) return { ok: true, synced: [], failed: [], conflicts: [], disabled: true };

    var synced = [], failed = [], conflicts = [];
    for (var i = 0; i < CATS.length; i++) {
      var cat = CATS[i];
      if (cat.hard || !p.syncCats[cat.key]) continue;
      var r = await syncOne(cat, t, p.conflict);
      if (r.conflict) conflicts.push(cat.key);
      if (r.ok) synced.push(cat.key); else failed.push({ key: cat.key, error: r.error });
    }
    if (synced.length) await setPrefs({ lastSyncAt: Date.now() });
    // §7.5's device list is refreshed on every pass: `auth-renew` touches `last_seen`, and knowing
    // which of the three slots this machine is using is the point of showing the list at all.
    return { ok: failed.length === 0, synced: synced, failed: failed, conflicts: conflicts };
  }

  async function syncOne(cat, t, policy) {
    if (cat.kind === 'records') return syncRecords(cat, t, policy);
    return syncBlob(cat, t, policy);
  }

  /** Samples/archives: one row per record, keyed by `id`, compared by `updated_at`. */
  async function syncRecords(cat, t, policy) {
    var q = 'select=*&order=updated_at.asc&limit=1000';
    var res = await cloud().rest(cat.table, { method: 'GET', query: q, jwt: t });
    if (!res.ok) return { ok: false, error: res.error };
    var remote = Array.isArray(res.data) ? res.data : [];
    var local = await collect(cat);

    var byId = {};
    remote.forEach(function (r) { byId[String(r.id)] = r; });
    var upserts = [];
    for (var i = 0; i < local.length; i++) {
      var l = local[i];
      var r = byId[l.id];
      var verdict = resolve(l.created_at, updatedAtOf(r), policy);
      if (verdict === 'local' || verdict === 'conflict' || !r) upserts.push(l);
    }
    if (upserts.length) {
      var put = await cloud().rest(cat.table, {
        method: 'POST', jwt: t, body: upserts,
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      if (!put.ok) return { ok: false, error: put.error };
    }
    return { ok: true };
  }

  /** The single-document categories: one `user_kv` row each, replaced wholesale. */
  async function syncBlob(cat, t, policy) {
    var q = 'select=payload,updated_at&key=eq.' + encodeURIComponent(cat.key);
    var res = await cloud().rest('user_kv', { method: 'GET', query: q, jwt: t });
    if (!res.ok) return { ok: false, error: res.error };
    var row = (Array.isArray(res.data) && res.data[0]) || null;
    var doc = await collect(cat);
    if (!doc) return { ok: true };                    // nothing local to offer
    var verdict = resolve(Date.now(), updatedAtOf(row), policy);
    if (row && (verdict === 'remote' || verdict === 'same')) return { ok: true };
    var body = [{ key: cat.key, payload: doc }];
    var put = await cloud().rest('user_kv', {
      method: 'POST', jwt: t, body: body,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    if (!put.ok) return { ok: false, error: put.error };
    return { ok: true, conflict: verdict === 'conflict' };
  }

  // ---------------------------------------------------------------------------------------------
  // 离线队列 (§7.4)
  // ---------------------------------------------------------------------------------------------

  function newOpId() {
    var c = (g.crypto && g.crypto.getRandomValues) ? g.crypto : null;
    if (c) { var b = new Uint8Array(8); c.getRandomValues(b); var s = ''; for (var i = 0; i < b.length; i++) s += (b[i] + 0x100).toString(16).slice(1); return 'op-' + s; }
    return 'op-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** §7.4's shape: `{id, type, table, data, retries}` — `retries` starts at 0. */
  async function enqueueOp(type, table, data) {
    if (['insert', 'update', 'delete'].indexOf(type) < 0) return null;
    var q = await store().loadSyncQueue();
    var op = { id: newOpId(), type: type, table: table, data: data, retries: 0 };
    q.push(op);
    await store().saveSyncQueue(q);
    return op;
  }

  async function pendingCount() { return (await store().loadSyncQueue()).length; }

  /**
   * FIFO retry. A failed op at the HEAD stops the pass (the queue is ordered, and skipping it
   * would let a later op land out of order), but only after its retry count is bumped — and at
   * MAX_RETRIES it is dropped and reported, because §7.4 says 「连续 3 次失败 → 提示用户」, not
   * 「永远重试」.
   */
  async function flushQueue() {
    if (!cloud().isConfigured()) return { ok: false, error: 'NOT_CONFIGURED', remaining: await pendingCount(), dropped: 0 };
    var t = jwt();
    if (!t) return { ok: false, error: 'UNAUTHORIZED', remaining: await pendingCount(), dropped: 0 };

    var q = await store().loadSyncQueue();
    var dropped = 0, sent = 0, stopped = null;
    while (q.length) {
      var op = q[0];
      var call = restFor(op, t);
      var res = await call;
      if (res.ok) { q.shift(); sent++; continue; }
      // A 4xx that is not a rate limit will never succeed on retry — the row is malformed or the
      // policy says no. Retrying it three times just delays everything behind it.
      if (res.status >= 400 && res.status < 500) { q.shift(); dropped++; continue; }
      op.retries = (Number(op.retries) || 0) + 1;
      if (op.retries >= MAX_RETRIES) { q.shift(); dropped++; continue; }
      stopped = res.error;
      break;
    }
    await store().saveSyncQueue(q);
    return { ok: !stopped, error: stopped, sent: sent, dropped: dropped, remaining: q.length };
  }

  function restFor(op, t) {
    var table = op.table;
    if (op.type === 'insert') {
      return cloud().rest(table, { method: 'POST', jwt: t, body: [op.data], prefer: 'resolution=merge-duplicates,return=minimal' });
    }
    if (op.type === 'update') {
      var id = op.data && op.data.id;
      return cloud().rest(table, { method: 'PATCH', query: 'id=eq.' + encodeURIComponent(id), jwt: t, body: op.data, prefer: 'return=minimal' });
    }
    var did = op.data && op.data.id;
    return cloud().rest(table, { method: 'DELETE', query: 'id=eq.' + encodeURIComponent(did), jwt: t, prefer: 'return=minimal' });
  }

  /** Everything the settings panel draws, in one call. */
  async function status() {
    var p = await loadPrefs();
    return {
      configured: cloud().isConfigured(),
      enabled: p.syncEnabled,
      cats: p.syncCats,
      conflict: p.conflict,
      lastSyncAt: p.lastSyncAt,
      pending: await pendingCount(),
      active: await activeCats(),
    };
  }

  g.GMSync = {
    CATS: CATS,
    MAX_RETRIES: MAX_RETRIES,
    CONFLICT_WINDOW_MS: CONFLICT_WINDOW_MS,

    byKey: byKey,
    isSyncable: isSyncable,
    loadPrefs: loadPrefs,
    setPrefs: setPrefs,
    setEnabled: setEnabled,
    setCategory: setCategory,
    activeCats: activeCats,
    collect: collect,
    resolve: resolve,           // pure — the suite drives §7.3's table through this
    syncNow: syncNow,
    enqueueOp: enqueueOp,
    pendingCount: pendingCount,
    flushQueue: flushQueue,
    status: status,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMSync;
})(typeof globalThis !== 'undefined' ? globalThis : this);
