/* archive-db.js — 1.0.7 续 ③ (快照二 §一.1): the archive library moves to IndexedDB.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY IT HAS TO MOVE
 * ---------------------------------------------------------------------------------------------
 * 快照二 §一.1 asks for the archive cap to go from 200 to 1000. The blocker is arithmetic: a
 * measured archive is **22 029 bytes** on average (65 real ones in `_tools/_archives.json`,
 * median 21 001, max 42 596) and `chrome.storage.local` is capped at 10 MB — the manifest does
 * NOT ask for `unlimitedStorage`, and it should not start: 1000 × 22 KB = 22 MB, and the same
 * 10 MB is already shared with samples (cap 300) and the blacklist (cap 500).
 *
 * The second reason is not size but SHAPE. Every mutation used to be a read-modify-write of the
 * WHOLE array — `saveArchive` read all 200 records, unshifted one, and wrote all 201 back. That
 * is 4.4 MB of JSON parsed and re-serialised per finished game today, and it would be 22 MB at
 * the new cap. IndexedDB gives one transaction per record, so `put` costs one record.
 *
 * ---------------------------------------------------------------------------------------------
 * ⚠⚠ THE CONTENT SCRIPT CANNOT OPEN THIS DATABASE — AND MUST NOT TRY
 * ---------------------------------------------------------------------------------------------
 * A content script's `indexedDB` is the **HOST PAGE's**, not the extension's. This is the same
 * constraint storage.js documents for backgrounds (§5.1) and custom-engine.js for weight packs,
 * and it is why the background worker exists as the owner of every extension-origin store.
 * `saveArchive` is called FROM content.js, so the transport is chosen by REALM, not by
 * preference:
 *
 *   extension page / worker / offscreen  ->  IndexedDB, directly (this file)
 *   content script                        ->  a `gm-archive-*` message to the worker, which
 *                                             runs the identical code on the extension origin
 *   neither (node unit suites)            ->  storage.js's in-memory shim
 *
 * `available()` is what answers "am I a content script?", and the test is the ORIGIN — a content
 * script is the only context that has `chrome.runtime.id` yet is not running on
 * `chrome-extension:`. ⚠ It is deliberately NOT "does `chrome` exist": the behaviour suites load
 * `viewer.html` over `http://127.0.0.1` with a stub whose `runtime` has `getManifest` / `getURL` /
 * `sendMessage` but no `id`, so they get a REAL IndexedDB (the harness page's own, which is
 * exactly right there) and exercise this file's adapter rather than a double.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 * ---------------------------------------------------------------------------------------------
 * It carries no POLICY. The cap, the newest-first ordering and the `replaceId` semantics all stay
 * in storage.js, exactly once, because those are the product's answers and an adapter is not
 * allowed a second copy of them. This file is transport: open, get, put, delete, count, prune the
 * oldest past a number it is TOLD.
 *
 * `MAX_ARCHIVES` in particular is NOT defined here. It lives in storage.js and is passed into
 * `pruneOldest(max)` — one definition, the same reason `MAX_DEVICES` has exactly one home.
 */
(function (g) {
  'use strict';
  if (g.GMArchiveDB) return;

  var DB_NAME = 'bai-shen-archives';
  // v1: `archives` + `meta`. Any future schema change bumps this and adds a step in
  // `onupgradeneeded`, which is the one place a migration belongs.
  var DB_VERSION = 1;
  var STORE = 'archives';
  var META = 'meta';

  var _db = null;
  var _opening = null;

  /** The one context whose `indexedDB` is somebody else's. See the header. */
  function isContentScript() {
    var c = g.chrome;
    if (!c || !c.runtime || !c.runtime.id) return false;
    return String((g.location && g.location.protocol) || '') !== 'chrome-extension:';
  }

  function available() {
    return typeof indexedDB !== 'undefined' && !!indexedDB && !isContentScript();
  }

  function open() {
    if (!available()) return Promise.reject(new Error('archive-db unavailable in this realm'));
    if (_db) return Promise.resolve(_db);
    // One in-flight open per context: two concurrent `open()` calls would otherwise race the
    // `onupgradeneeded` and the loser would resolve with a connection that never got the store.
    if (_opening) return _opening;
    _opening = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { _opening = null; reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var s = db.createObjectStore(STORE, { keyPath: 'id' });
          // The index is what makes pruning a cursor walk instead of a full read. ⚠ It only
          // covers records that HAVE the key, which is why `put()` normalises `createdAt` on the
          // way in (see `stamp()`).
          s.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () {
        _db = req.result;
        _opening = null;
        // Another context (the viewer while the worker is open, or vice versa) bumping the
        // version needs this connection gone or its upgrade blocks forever. Closing and
        // forgetting the handle means the next call reopens at the new version.
        _db.onversionchange = function () { try { _db.close(); } catch (e) {} _db = null; };
        resolve(_db);
      };
      req.onerror = function () { _opening = null; reject(req.error || new Error('indexedDB open failed')); };
      req.onblocked = function () { _opening = null; reject(new Error('indexedDB blocked by another context')); };
    });
    return _opening;
  }

  /** One transaction, one store.
   *
   *  ⚠⚠ `fn(store)` returns a HOLDER — `{value: …}` — and the returned promise resolves with
   *  `holder.value` **on `oncomplete`**, never earlier. Two bugs are avoided by that and both of
   *  them were in the first draft of this file:
   *
   *    · A value read off a request (`cursor.result`, `count()`) arrives in `onsuccess`, which is
   *      strictly before the transaction commits. Resolving there reports success for a write
   *      that may still ABORT — 「删了 5 条」 said by a transaction that deleted nothing.
   *    · Capturing the value at call time (`{n: gone}`) freezes it at 0, because the handlers that
   *      increment `gone` have not run yet. Writing into a holder is what makes the late read work.
   *
   *  `fn` may also return a plain promise, in which case the promise's own value is used; that is
   *  for the walks that need to sequence several requests. */
  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t;
        try { t = db.transaction(store, mode); } catch (e) { reject(e); return; }
        var holder;
        var settled = false;
        function fail(e) { if (!settled) { settled = true; reject(e); } }
        try { holder = fn(t.objectStore(store), t); } catch (e) { fail(e); return; }
        t.oncomplete = function () {
          if (settled) return;
          settled = true;
          resolve(holder && typeof holder.then === 'function' ? undefined : (holder ? holder.value : undefined));
        };
        t.onerror = function () { fail(t.error || new Error('indexedDB transaction failed')); };
        t.onabort = function () { fail(t.error || new Error('indexedDB transaction aborted')); };
        if (holder && typeof holder.then === 'function') {
          // A promise-returning `fn` supplies its own value; it must already have finished by the
          // time the transaction commits, which is true for every walk below because the last
          // request in the walk is what resolves it.
          holder.then(function () {}, fail);
        }
      });
    });
  }

  /** ⚠ An archive with no timestamp would be invisible to the `createdAt` index, and therefore
   *  the ONE record pruning could never reach: it would sit in the store forever while the cap
   *  deleted its neighbours. The product's sort already treats a missing stamp as 0 (oldest), so
   *  the honest repair is to give it one — 「now」 keeps the newest-looking record rather than
   *  throwing it away. */
  function stamp(rec) {
    if (rec && !(typeof rec.createdAt === 'number' && isFinite(rec.createdAt))) {
      rec.createdAt = Date.now();
    }
    return rec;
  }

  function all() {
    return tx(STORE, 'readonly', function (store) {
      var box = { value: [] };
      var req = store.getAll();
      req.onsuccess = function () {
        var list = req.result || [];
        // Newest first, the order the whole product assumes — `(createdAt || 0)` rather than a
        // bare subtraction, so a record that somehow lost its stamp sorts last instead of NaN.
        list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        box.value = list;
      };
      return box;
    });
  }

  function get(id) {
    return tx(STORE, 'readonly', function (store) {
      var box = { value: null };
      var req = store.get(id);
      req.onsuccess = function () { box.value = req.result || null; };
      return box;
    });
  }

  function put(rec) {
    stamp(rec);
    return tx(STORE, 'readwrite', function (store) {
      store.put(rec);
      return { value: rec };
    });
  }

  /** One transaction for a whole list — the migration's and an import's path. All-or-nothing: a
   *  half-written migration is worse than a failed one, and the caller's progress bar is allowed
   *  to be approximate precisely because the commit is not. */
  function putMany(list) {
    var rows = (list || []).slice();
    for (var i = 0; i < rows.length; i++) stamp(rows[i]);
    return tx(STORE, 'readwrite', function (store) {
      for (var j = 0; j < rows.length; j++) store.put(rows[j]);
      return { value: rows.length };
    });
  }

  function remove(id) {
    return tx(STORE, 'readwrite', function (store) {
      var box = { value: false };
      var req = store.get(id);
      req.onsuccess = function () {
        if (!req.result) return;
        store.delete(id);
        box.value = true;
      };
      return box;
    });
  }

  function removeMany(ids) {
    var list = (ids || []).slice();
    return tx(STORE, 'readwrite', function (store) {
      var box = { value: 0 };
      list.forEach(function (id) {
        var req = store.get(id);
        req.onsuccess = function () { if (req.result) { store.delete(id); box.value++; } };
      });
      return box;
    });
  }

  function clear() {
    return tx(STORE, 'readwrite', function (store) {
      store.clear();
      return { value: true };
    });
  }

  function count() {
    return tx(STORE, 'readonly', function (store) {
      var box = { value: 0 };
      var req = store.count();
      req.onsuccess = function () { box.value = req.result; };
      return box;
    });
  }

  /** Delete the oldest `count - max` records and return how many went. The whole walk is one
   *  transaction, so a concurrent `put` from another context either lands before it (and may be
   *  pruned) or after it (and is kept) — never inside a half-applied state. */
  function pruneOldest(max) {
    if (!(max > 0)) return Promise.resolve(0);
    return tx(STORE, 'readwrite', function (store) {
      var box = { value: 0 };
      var cnt = store.count();
      var cur = null;
      cnt.onsuccess = function () {
        var excess = cnt.result - max;
        if (excess <= 0) return;
        cur = store.index('createdAt').openKeyCursor(null, 'next');   // ascending = oldest first
        cur.onsuccess = function () {
          var c = cur.result;
          if (!c || box.value >= excess) return;
          store.delete(c.primaryKey);
          box.value++;
          c.continue();
        };
      };
      return box;
    });
  }

  function metaGet(key) {
    return tx(META, 'readonly', function (store) {
      var box = { value: null };
      var req = store.get(key);
      req.onsuccess = function () { box.value = req.result ? req.result.value : null; };
      return box;
    });
  }

  function metaSet(key, value) {
    return tx(META, 'readwrite', function (store) {
      store.put({ key: key, value: value });
      return { value: value };
    });
  }

  g.GMArchiveDB = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE: STORE,
    META: META,
    available: available,
    isContentScript: isContentScript,
    open: open,
    all: all,
    get: get,
    put: put,
    putMany: putMany,
    remove: remove,
    removeMany: removeMany,
    clear: clear,
    count: count,
    pruneOldest: pruneOldest,
    metaGet: metaGet,
    metaSet: metaSet,
  };
})(typeof self !== 'undefined' ? self : this);
