/* 0.5.1 §2.2 — custom detection models, stored as WEIGHT PACKAGES.
 *
 * What is stored is a `.data` package, not an engine. That is a deliberate narrowing of the
 * 定稿's §2.2.1, which sketched `custom-1/model.js` + `custom-1/model.data` — a whole
 * emscripten bundle. The operator confirmed the change on 2026-10-01, and the reason is MV3's
 * CSP: `extension_pages`'s `script-src` may contain only 'self', 'none' and 'wasm-unsafe-eval',
 * so a user-supplied `.js` cannot be imported by any legal route. It currently CAN be run,
 * through `new Worker(blob:)` — Chromium checks a blob URL against its inner URL, which here is
 * the extension origin (crbug 40945262) — but that is recorded as a bug rather than a feature
 * and would take the whole feature down with it when fixed.
 *
 * A weight package needs none of that. Rapfi's build asks for `rapfi.data` through emscripten's
 * `locateFile`, and worker.js already remaps every `rapfi*.data` name onto it; all we add is the
 * ability to answer that one request with a blob URL instead of the packaged file. `fetch` of a
 * blob: URL is plain same-origin I/O — no CSP directive touches it.
 *
 * So the upload is: pick a file → check its size → store the Blob in IndexedDB → hand the blob
 * URL to worker.js → run one real search on it. If the package is not a Rapfi weight file, that
 * search is what fails, and §2.2.3 step 5 is the message the operator gets. There is no cheaper
 * honest test: the data package's own format is opaque (emscripten file table + NNUE weights),
 * so nothing short of loading it can tell us whether it works.
 *
 * Loaded in extension pages only — offscreen.html (which creates the blob URL worker.js needs)
 * and viewer.html (the settings panel). NOT in the content script: a content script's
 * `indexedDB` is the HOST PAGE's storage, not the extension's, so content.js can only ever learn
 * the model list through a message.
 */
(function (g) {
  'use strict';
  if (g.GMCustomEngines) return;

  var DB_NAME = 'bai-shen-custom-engines';
  var DB_VERSION = 1;
  var STORE = 'models';

  // The operator's limits (2026-10-01). 100MB is generous next to the shipped 39MB `rapfi.data`
  // — a bigger NNUE is plausible, a bigger one than this is a mistake — and five models is
  // five times the shipped engine's footprint, which is already 200MB of IndexedDB.
  var MAX_BYTES = 100 * 1024 * 1024;
  var MAX_COUNT = 5;

  var _dbPromise = null;

  function hasIDB() {
    return typeof indexedDB !== 'undefined' && !!indexedDB;
  }

  function open() {
    if (!hasIDB()) return Promise.reject(new Error('indexedDB unavailable'));
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
      // A second context (the offscreen document and the viewer can both be open) asking for a
      // version we already have is normal; blocking is not, so step aside rather than hang.
      req.onblocked = function () { reject(new Error('indexedDB blocked by another context')); };
    });
    // Cache the rejection out of the cache slot so a transient failure is retryable.
    _dbPromise.catch(function () { _dbPromise = null; });
    return _dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out;
        try { out = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error || new Error('indexedDB transaction failed')); };
        t.onabort = function () { reject(t.error || new Error('indexedDB transaction aborted')); };
      });
    });
  }

  function reqOf(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  // Records are returned WITHOUT the blob. The list is read by the viewer's settings panel and
  // relayed to the panel in the page; shipping 100MB per row through `chrome.runtime` once per
  // dropdown open is not a mistake worth making twice.
  function strip(rec) {
    if (!rec) return null;
    return {
      id: rec.id, name: rec.name, fileName: rec.fileName,
      size: rec.size, addedAt: rec.addedAt,
    };
  }

  function list() {
    return tx('readonly', function (store) { return reqOf(store.getAll()); })
      .then(function (rows) {
        return (rows || []).map(strip).sort(function (a, b) { return slot(a.id) - slot(b.id); });
      });
  }

  function slot(id) {
    var m = /^custom-(\d+)$/.exec(String(id || ''));
    return m ? parseInt(m[1], 10) : 0;
  }

  function get(id) {
    return tx('readonly', function (store) { return reqOf(store.get(id)); }).then(function (r) {
      return r || null;
    });
  }

  // Slots are reused rather than counted up: the id decides the default display name
  // ("自定义模型 N", §2.2.4 priority 4), so a profile that has deleted and re-added models
  // should not end up being told its single model is 「自定义模型 7」.
  function freeSlot(rows) {
    var used = {};
    rows.forEach(function (r) { used[slot(r.id)] = true; });
    for (var i = 1; i <= MAX_COUNT; i++) if (!used[i]) return i;
    return 0;
  }

  // §2.2.3 step 1/6: the file is chosen and stored, but NOT yet trusted — `add` does the checks
  // that can be done from the file alone (size, count) and returns the record the caller then
  // offers to name and verify. Verification is app.js's job, because only it can run a search.
  function add(file, name) {
    if (!file) return Promise.reject(new Error('__i18n:custom.noFile'));
    var size = file.size || 0;
    if (size > MAX_BYTES) {
      var e = new Error('__i18n:custom.tooBig');
      e.vars = { mb: Math.round(MAX_BYTES / 1048576) };
      e.maxBytes = MAX_BYTES;
      e.size = size;
      return Promise.reject(e);
    }
    return tx('readonly', function (store) { return reqOf(store.getAllKeys()); })
      .then(function (keys) {
        if ((keys || []).length >= MAX_COUNT) {
          var e2 = new Error('__i18n:custom.tooMany');
          e2.vars = { max: MAX_COUNT };
          e2.maxCount = MAX_COUNT;
          throw e2;
        }
        return tx('readonly', function (store) { return reqOf(store.getAll()); });
      })
      .then(function (rows) {
        var n = freeSlot(rows || []);
        var rec = {
          id: 'custom-' + n,
          name: name || '',
          fileName: (file.name || '').trim(),
          size: size,
          addedAt: Date.now(),
          blob: file,
        };
        return tx('readwrite', function (store) { return reqOf(store.put(rec)); }).then(function () {
          return strip(rec);
        });
      });
  }

  function rename(id, name) {
    return get(id).then(function (rec) {
      if (!rec) return null;
      rec.name = String(name == null ? '' : name);
      return tx('readwrite', function (store) { return reqOf(store.put(rec)); })
        .then(function () { return strip(rec); });
    });
  }

  function remove(id) {
    return tx('readwrite', function (store) { return reqOf(store.delete(id)); }).then(function () {
      return true;
    });
  }

  // The blob URL worker.js answers `locateFile` with. Whoever creates it owns revoking it —
  // `Engine` holds the string for as long as its worker lives and revokes on teardown. Revoking
  // early would break the engine *silently*: emscripten already fetched the package by then, but
  // a later `downgrade()` re-instantiates and would ask for the dead URL.
  function blobUrl(id) {
    return get(id).then(function (rec) {
      if (!rec || !rec.blob) return '';
      try { return URL.createObjectURL(rec.blob); } catch (e) { return ''; }
    });
  }

  function revoke(url) {
    if (!url) return;
    try { URL.revokeObjectURL(url); } catch (e) { /* already gone */ }
  }

  g.GMCustomEngines = {
    MAX_BYTES: MAX_BYTES,
    MAX_COUNT: MAX_COUNT,
    DB_NAME: DB_NAME,
    STORE: STORE,
    available: hasIDB,
    list: list,
    get: get,
    add: add,
    rename: rename,
    remove: remove,
    blobUrl: blobUrl,
    revoke: revoke,
    slot: slot,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
