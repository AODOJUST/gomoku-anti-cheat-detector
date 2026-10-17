/* chat-cache.js — 1.0.6 §1.2 聊天室的**本机缓存**：消息、分享文件、同步水位。
 *
 * 为什么有这一层
 * --------------
 *   ① **进房间先用本地画出来**。今天 `chatSubscribe` 要等一页网络回来才有东西可画，掉线时
 *      房间就是空的 —— 而聊天室是「刚才大家说了什么」，一页 50 行的往返是纯等待。
 *   ② **撤回必须是删除，不是标记**（§1.2.5）。服务端**故意**把撤回去的正文与附件留在表里
 *      （021：举报复核要看），而本机没有复核这个用途：留着它，「撤回」在这台设备上等于没发生。
 *      `put()` 是唯一一处把「recalled」翻译成动作的地方 —— 见它的注释。
 *   ③ **同一个分享不重下**（§1.2.4）。`cloudShareFetch` 走 `cloud-share`，服务端还要签一个
 *      60 秒的下载 URL；看第二遍同一份棋局没有任何理由再走一趟网络。
 *
 * ⚠ 判据（保留期、分享 TTL、页大小）**一条都不在这里**。它们全部读共享块
 *   （`community-shared.js`，由 `_tools/gen-community-shared.cjs` 从 Edge Function 逐字镜像）：
 *   7 天 = `CHAT_RETENTION_DAYS`，15 分钟 = `SHARE_TTL_MS`。在这里写死一个 7 或一个 900 就是
 *   同一件事的第二份答案，而它会在服务端改窗口的那一版静默过期。
 *
 * ⚠ 这里失败是**静默**的，而且是故意的：IDB 被禁用、配额满、schema 被降级——每一个都只让
 *   「缓存」这一层退场，网络那条路一个字都不受影响（读里返回空数组、写里吞掉异常）。
 *   房间画不出来才是缺陷；缓存没命中不是。
 *
 * ⚠ **IDB 是按 origin 分的，而这个文件只在查看器里跑**（`viewer.html`），拿到的是扩展自己的库。
 *   content script 的 `indexedDB` 是**宿主页面**的库——那是 `background.js` 里 `gm-bg-get`
 *   存在的原因，也是这个文件绝不能被打包进 content script 的原因。
 *
 * 单房间
 * ------
 * §2.3.1「全部已激活用户共享一个公共聊天室」= 一张表里只有一个房间，所以 `room_id` 是一个
 * 常量 `'public'`，而**不是**每行一个不同的值。字段留着（§1.2.2 的 schema 里有它），因为
 * 「将来会有第二个房间」与「现在按房间分库」是两件事：后者在没有第二个房间的时候只会把
 * 每个键都染上一个永不变化的字面量。
 */
(function (g) {
  'use strict';
  if (g.GMChatCache) return;

  /** §1.2.2 的库名。**改名等于换库**：老库留在盘上，而 `prune` 再也够不到它。 */
  var DB_NAME = 'baishen-cache';
  /** ⚠ 改 `put()` 里存进去的字段集、或 `STORES` 的形状，就 **+1**。老结构读进来会被当成
   *  「没有」，而不是被按新规则解释——后者会让一批老行在某一版之后突然少掉字段且不报错。 */
  var DB_VERSION = 1;
  var STORE_MSGS = 'chat_messages';
  var STORE_FILES = 'shared_files';
  var STORE_META = 'sync_meta';
  /** 唯一的房间。见文件头「单房间」。 */
  var ROOM_ID = 'public';

  /** §1.2.7.1「首次进入聊天室立即显示本地缓存」——画多少行。**只影响「画」**：`chatSubscribe`
   *  照样发它那一次网络同步，所以这个数小一点只是首屏短一点，不是「消息断了」。
   *  ⚠ 有上限。不设上限就是一条会慢慢撑爆配额的曲线（配额满时写失败是静默的）。 */
  var PAINT_ROWS = 100;

  /** `sync_meta` 的键。一个房间一个键，因为只有一条同步水位。 */
  var META_KEY = 'chat:' + ROOM_ID;

  // ---------------------------------------------------------------------------------------------
  // 共享块（保留期 / 分享 TTL）。⚠ 缺席时**不猜**：读不到就退成「不清理」与「文件不过期」，
  // 让这一层变成纯缓存，而不是拿一个自己编的数去删用户的东西。
  // ---------------------------------------------------------------------------------------------
  function shared() {
    try { return (g.GMCommunity && g.GMCommunity.shared && g.GMCommunity.shared()) || null; }
    catch (e) { return null; }
  }
  /** §1.2.6「聊天消息 7 天」——`CHAT_RETENTION_DAYS`，与 `chatRetentionCutoff()` 同源。 */
  function retentionMs() {
    var S = shared();
    var d = S && S.CHAT_RETENTION_DAYS;
    return (typeof d === 'number' && d > 0) ? d * 24 * 60 * 60 * 1000 : null;
  }
  /** §1.2.4「15 分钟过期」——`SHARE_TTL_MS`，与 `friend_shares.expires_at` 的默认值同源。 */
  function shareTtlMs() {
    var S = shared();
    var t = S && S.SHARE_TTL_MS;
    return (typeof t === 'number' && t > 0) ? t : null;
  }

  // ---------------------------------------------------------------------------------------------
  // 一个极小的 IDB promise 包装。三个 store 的每一处访问都从这里走，所以「务必要关事务」
  // 只有一种写法。
  // ---------------------------------------------------------------------------------------------
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      var idb = g.indexedDB;
      if (!idb) { resolve(null); return; }
      var req;
      try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_MSGS)) {
          var msgs = db.createObjectStore(STORE_MSGS, { keyPath: 'id' });
          // §1.2.2 的 `created_at`。索引是给 `rows()` 的「最后 N 行」用的：没有它就得把整库
          // 读进内存再排序，而那一份数据量正是这个模块要避免的东西。
          msgs.createIndex('by_created', 'created_at');
        }
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: 'cloud_id' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      // ⚠ 打不开就是「没有缓存」，不是错误：隐私模式下 IDB 抛的是这里，而房间照样能用。
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }

  /** 一个事务跑完（`onsuccess` 或 `onerror`），再把它里面收集到的结果交出来。
   *  ⚠ 结果在**收集时**取（游标 / `get` 的 `onsuccess` 里），不在事务结束后取：事务一提交，
   *  `request.result` 仍然有效，但「事务成功」并不保证每个请求都被读过——先取就不会踩到
   *  「拿到一个空结果却发现其实有数据」。 */
  function tx(storeName, mode, work) {
    return openDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var out = { value: null };
        var t;
        try { t = db.transaction(storeName, mode); } catch (e) { resolve(null); return; }
        var store = t.objectStore(storeName);
        try { work(store, out); } catch (e) { resolve(null); return; }
        t.oncomplete = function () { resolve(out.value); };
        t.onerror = t.onabort = function () { resolve(null); };
      });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // 消息
  // ---------------------------------------------------------------------------------------------

  /** 一个请求的结果，取在 `onsuccess` 里。`null` 表示「没有」。 */
  function ask(req, out, map) {
    req.onsuccess = function () { out.value = map ? map(req.result) : req.result; };
  }

  /**
   * §1.2.3 的「从 IndexedDB 读取最近的 100 条消息 → 立即渲染」。
   *
   * 返回**升序**（房间的读法）。库里是降序取的：`created_at` 上没有「最后 N 行」这种查询，
   * 只有「从最新往回走 N 步」，所以取完再翻一次——两头的顺序在图上是同一个东西，而调用者
   * （`cmPush` → `cmRows.sort`）虽然会再排一遍，也不该指望它替这一层收尾。
   */
  function rows(limit) {
    var n = Math.max(1, Math.floor(Number(limit) || PAINT_ROWS));
    return tx(STORE_MSGS, 'readonly', function (store, out) {
      var got = [];
      var cur = store.index('by_created').openCursor(null, 'prev');
      cur.onsuccess = function () {
        var c = cur.result;
        if (!c || got.length >= n) { out.value = got.slice().reverse(); return; }
        got.push(c.value);
        c.continue();
      };
      // 一条都读不出来（空库 / 索引缺失）时 `onsuccess` 仍然会来一次，`c` 是 null，所以这里
      // 不需要单独的兜底分支。
    }).then(function (v) { return Array.isArray(v) ? v : []; });
  }

  /**
   * §1.2.5 的唯一一处：**一行的到达意味着什么**。
   *
   * ⚠⚠ 撤回 = **删除**，而且这里就是那个决定。四个到达点（`chatLoad` 的一页、`rtEmit` 的
   * INSERT、`rtRoom` 的 UPDATE、`chatSend`/`chatRecall` 的回包）全部调这一个函数，**没有一处
   * 自己判**——一处判一次的话，四条路里只要有一条漏了，撤回就在那条路上失效，而它看起来
   * 完全正常（消息还在，只是没被删掉）。
   *
   * ⚠ 存**整行**，不是 §1.2.2 列的那几个字段。`attachment` / `reply_preview` / `mention` /
   * `recalled` 都是渲染要用的，少存一个字段的后果不是「缓存更小」，而是**同一行在缓存里与
   * 在网络上长得不一样**——那种缺陷只在断网时才看得见。
   */
  function put(row) {
    if (!row || row.id == null) return Promise.resolve(null);
    var id = String(row.id);
    if (row.recalled === true) return remove(id);
    var rec = {};
    for (var k in row) { if (Object.prototype.hasOwnProperty.call(row, k)) rec[k] = row[k]; }
    rec.id = id;
    rec.room_id = row.room_id || ROOM_ID;
    rec.cached_at = new Date().toISOString();
    return tx(STORE_MSGS, 'readwrite', function (store) { store.put(rec); })
      .then(function () { return rec; });
  }

  function putMany(list) {
    var arr = Array.isArray(list) ? list : [];
    if (!arr.length) return Promise.resolve(0);
    // ⚠ 顺序逐个走，不是 `Promise.all`：一张表里 50 行的写要在一个事务里才有意义，而
    //  `tx()` 每次开一个事务——并发的 50 个事务在 Chrome 里会互相排队，慢且不必要。
    //  这里只用它做「一页落盘」，所以串行是对的。
    var done = 0;
    var chain = Promise.resolve();
    arr.forEach(function (r) {
      chain = chain.then(function () { return put(r); }).then(function (v) { if (v) done++; });
    });
    return chain.then(function () { return done; });
  }

  function remove(id) {
    var key = String(id == null ? '' : id);
    if (!key) return Promise.resolve(false);
    return tx(STORE_MSGS, 'readwrite', function (store) { store.delete(key); })
      .then(function () { return true; });
  }

  // ---------------------------------------------------------------------------------------------
  // 分享文件（§1.2.4）
  // ---------------------------------------------------------------------------------------------

  /** 一份还活着的缓存条目（`{cloud_id, kind, payload, expires_at}`），或 `null`。
   *
   *  ⚠ 交回**整条记录**，不是只交 payload：`kind` 是 `resolveSharePayload` 的四个字段之一，
   *  而「缓存命中」与「网络命中」在调用者眼里必须是同一个形状——只回 payload 就等于让
   *  缓存这条路少一个字段，而少掉的正是决定「图什么」的那个。
   *
   *  过期就地删掉——一个过期的条目留在库里只会让下一次查询多读一行，而它的存在还会让
   *  `prune` 之外的第二个地方以为它有效。
   *
   *  `key` 由调用者拼（`'friend:' + id` / `'cloud:' + id`）：两扇门是两个 uuid 空间，
   *  「门的身份是 id 的一部分」这条在 `cmDoorFetch` 已经写过一次，这里不另立一份。 */
  function file(key) {
    var id = String(key == null ? '' : key);
    if (!id) return Promise.resolve(null);
    return tx(STORE_FILES, 'readonly', function (store, out) {
      ask(store.get(id), out);
    }).then(function (rec) {
      if (!rec) return null;
      var exp = rec.expires_at ? Date.parse(rec.expires_at) : NaN;
      if (isFinite(exp) && exp <= Date.now()) {
        return tx(STORE_FILES, 'readwrite', function (store) { store.delete(id); })
          .then(function () { return null; });
      }
      return rec.payload === undefined ? null : rec;
    });
  }

  /**
   * ⚠ THE WINDOW IS AN ARGUMENT, BECAUSE THERE ARE TWO OF THEM AND THE DIFFERENCE IS §1.2.4's WHOLE
   * POINT. A friend's share (`friend_shares`) lives 15 minutes (`SHARE_TTL_MS`); a room attachment
   * (`cloud_shares`) lives as long as the message that carries it — the same seven days the room
   * keeps (`CHAT_RETENTION_DAYS`). Both windows already exist in the shared block, and this function
   * refuses to pick between them: the caller knows which door it came through (it composed `key`),
   * so it passes `ttlMs`. A single hard-coded 15 here would make a room attachment stop being
   * readable locally after a quarter of an hour while the card still said 「7 天后过期」.
   *
   * `baseIso` is the SERVER's `created_at` when callers have it and 「now」 when they do not, never
   * 「now」 unconditionally: `created_at + ttl` is the rule both tables use for `expires_at`, and
   * starting the clock at the moment of the download would let a share the server has already
   * expired stay readable here.
   *
   * A missing `ttlMs` means 「no expiry recorded」 — the entry is kept until `prune` or a rewrite.
   * That is the honest default when the shared block cannot be read: it is the direction that
   * cannot delete something the user was still allowed to see.
   */
  function saveFile(key, kind, payload, ttlMs, baseIso) {
    var id = String(key == null ? '' : key);
    if (!id || payload === undefined) return Promise.resolve(false);
    var ttl = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : null;
    var base = Date.parse(baseIso || '');
    if (!isFinite(base)) base = Date.now();
    var rec = { cloud_id: id, kind: kind || '', payload: payload,
                cached_at: new Date().toISOString(),
                expires_at: ttl ? new Date(base + ttl).toISOString() : null };
    return tx(STORE_FILES, 'readwrite', function (store) { store.put(rec); })
      .then(function (v) { return v !== null; });
  }

  // ---------------------------------------------------------------------------------------------
  // 同步水位（§1.2.2 的 sync_meta）
  // ---------------------------------------------------------------------------------------------

  function meta(key) {
    var k = String(key || META_KEY);
    return tx(STORE_META, 'readonly', function (store, out) { ask(store.get(k), out); })
      .then(function (r) { return r || null; });
  }

  function touch(key, lastMessageId) {
    var k = String(key || META_KEY);
    var rec = { key: k, last_fetched_at: new Date().toISOString() };
    if (lastMessageId != null) rec.last_message_id = String(lastMessageId);
    return tx(STORE_META, 'readwrite', function (store) { store.put(rec); })
      .then(function (v) { return v !== null; });
  }

  // ---------------------------------------------------------------------------------------------
  // §1.2.6 清理
  // ---------------------------------------------------------------------------------------------

  /**
   * 「每次进入聊天室时检查，删除过期项」。
   *
   * 两条判据，两条都在**同一个事务的游标里**判：消息按 `created_at < cutoff`，文件按
   * `expires_at <= now`。删的是「已经不该在屏幕上」的东西，所以它不需要对谁报账。
   *
   * ⚠ 保留期读不到时**一条都不删**（见 `retentionMs`）：没有共享块就没有判据，凭一个自己编的
   * 窗口删用户的本机数据，比不删糟得多。
   */
  function prune() {
    var cutoffMs = retentionMs();
    var msgCut = cutoffMs ? new Date(Date.now() - cutoffMs).toISOString() : null;
    var nowIso = new Date().toISOString();
    var p1 = !msgCut ? Promise.resolve(0) : tx(STORE_MSGS, 'readwrite', function (store, out) {
      var killed = 0;
      var cur = store.openCursor();
      cur.onsuccess = function () {
        var c = cur.result;
        if (!c) { out.value = killed; return; }
        var v = c.value || {};
        if (typeof v.created_at === 'string' && v.created_at < msgCut) { c.delete(); killed++; }
        c.continue();
      };
    }).then(function (v) { return v || 0; });
    var p2 = tx(STORE_FILES, 'readwrite', function (store, out) {
      var killed = 0;
      var cur = store.openCursor();
      cur.onsuccess = function () {
        var c = cur.result;
        if (!c) { out.value = killed; return; }
        var v = c.value || {};
        var exp = v.expires_at ? Date.parse(v.expires_at) : NaN;
        if (isFinite(exp) && exp <= Date.parse(nowIso)) { c.delete(); killed++; }
        c.continue();
      };
    }).then(function (v) { return v || 0; });
    return Promise.all([p1, p2]).then(function (r) {
      return { messages: r[0], files: r[1] };
    });
  }

  /** 注销时用：把三个 store 清空。房间是公共的，所以这个调用不是隐私动作，而是
   *  「这台设备上那个账号的工作集」的收尾——与网页端 `GMCache` 的按账号分命名空间同源。 */
  function clear() {
    return Promise.all([STORE_MSGS, STORE_FILES, STORE_META].map(function (s) {
      return tx(s, 'readwrite', function (store) { store.clear(); });
    })).then(function () { return true; });
  }

  g.GMChatCache = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    ROOM_ID: ROOM_ID,
    PAINT_ROWS: PAINT_ROWS,
    META_KEY: META_KEY,
    ready: prune,
    prune: prune,
    rows: rows,
    put: put,
    putMany: putMany,
    remove: remove,
    file: file,
    saveFile: saveFile,
    meta: meta,
    touch: touch,
    clear: clear,
    retentionMs: retentionMs,
    shareTtlMs: shareTtlMs,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
