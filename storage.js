/* Gomoku Detector — shared storage layer.
 *
 * This file is loaded by BOTH the page content script (isolated world) and the
 * extension viewer page, so it is a classic script that publishes one global:
 * `GMStorage`. No modules — content scripts cannot use them.
 *
 * Five records live in chrome.storage.local:
 *   settings     : one flat object, written on every change (no save button).
 *   archives     : array of finished games, newest first, capped at MAX_ARCHIVES.
 *   overlayState : size / minimised flag of the on-page panel.
 *   samples      : 0.3.3 sample library — hand-entered games with multi-label
 *                  annotations. Kept SEPARATE from archives (0.3.3 §1.1): an
 *                  archive is what the collector happened to catch, a sample is
 *                  what the operator deliberately curated, and neither overwrites
 *                  the other.
 *   learnedParams: 0.3.3 output of the sample-driven learner (weights, thresholds,
 *                  feature library). Deliberately NOT derived on read (0.3.3 §3.6):
 *                  deleting a sample must not silently move the detector's numbers,
 *                  so the operator re-runs 重新学习 by hand.
 *
 * Everything that is pure (naming, sorting, slimming) is a plain function on the
 * published object so it can be unit-tested without a browser; the storage calls
 * fall back to an in-memory shim when `chrome` is absent.
 */
(function (g) {
  'use strict';
  if (g.GMStorage) return;

  // 0.3.6: display strings go through the shared translator. `i18n.js` is loaded before this
  // file in both the content script and the viewer, but this module is also required directly
  // by the unit suites (no browser, no locale files), so every call has to survive its
  // absence — falling back to the Chinese source text is exactly what t() does anyway.
  function T(key, vars) {
    if (g.GMI18n && g.GMI18n.t) return g.GMI18n.t(key, vars);
    var i = String(key).indexOf('|');
    return i >= 0 ? String(key).slice(i + 1) : key;
  }
  // A stored canonical value (tag / annotation label / risk level) rendered in the current
  // language. Never used on the way INTO storage — see the note in i18n.js.
  function TO(ns, value, vars) {
    if (g.GMI18n && g.GMI18n.tOr) return g.GMI18n.tOr(ns, value, vars);
    return value == null ? '' : String(value);
  }

  var SETTINGS_KEY = 'settings';
  var ARCHIVES_KEY = 'archives';
  var OVERLAY_KEY = 'overlayState';
  var SAMPLES_KEY = 'samples';
  var LEARNED_KEY = 'learnedParams';
  // 0.4.0 §一.3: the result of the last remote version check, and the「暂不更新」record.
  // The two are separate keys on purpose — `updateInfo` is overwritten by EVERY check, so a
  // dismissal stored inside it would be wiped by the next 12-hourly poll and the banner the
  // operator just closed would come back.
  var UPDATE_KEY = 'updateInfo';
  var UPDATE_DISMISS_KEY = 'updateDismissed';
  var MAX_ARCHIVES = 200;
  // Samples carry a full record + report + annotations each — bigger per item than an
  // archive — so the cap is lower. The 10MB chrome.storage.local budget is shared with
  // the archives, and a curated set is small by nature.
  var MAX_SAMPLES = 300;

  // Every detection knob the operator can change is remembered. `aiThinkMs: null`
  // means "follow thinkMs" — the AI-think control in the viewer mirrors it.
  var DEFAULTS = {
    suspect: 'both',        // 'both' | 'B' | 'W'
    mode: 'global',         // 'global' | 'stepwise'
    thinkMs: 2000,          // 检测思考时间（逐步分析的预算上限）
    aiThinkMs: null,        // AI 思考时间，null = 跟随 thinkMs
    openingCutoff: 8,       // 开局排除手数
    threadNum: 0,           // 引擎线程数；0 = 自动（clamp(floor(hardwareConcurrency/2), 1, 16)）
    autoAnalyze: true,      // 对局结束自动分析
    minArchiveMoves: 14,    // 少于这么多手不写存档（5–30）
    // 0.3.6 §1.3 — 'auto' means "follow the browser UI language". It is a setting value, not
    // a locale: `GMI18n.resolveLang()` is what turns it into one of the 8 concrete locales.
    lang: 'auto',
  };

  var MIN_MOVES_LO = 5;
  var MIN_MOVES_HI = 30;

  // Thread count: 0 keeps the automatic choice (`defaultThreadNum()` in app.js). Anything
  // else is an explicit override. The ceiling is 16 rather than 8 because 0.3.7 §二.1 asks
  // the default to follow the machine — a 32-core host defaults to 16 — and a lower ceiling
  // would silently clip the automatic value back down. It still bounds a hand-edited storage
  // entry, which would otherwise spawn an unbounded pthread pool.
  var THREADS_HI = 16;

  // The automatic thread count, for the settings UI ("自动（16 线程）") and the engine line.
  // MUST stay in step with `defaultThreadNum()` in app.js: the offscreen document loads only
  // app.js + offscreen.js, so this file is not available there and the formula is duplicated
  // by necessity. Same reason, same constant — change one, change the other.
  function detectedThreads() {
    var hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    var half = Math.floor(hc / 2);
    if (!isFinite(half) || half < 1) half = 1;
    return half > THREADS_HI ? THREADS_HI : half;
  }

  function clampThreadNum(v) {
    if (v === '' || v == null) return 0;
    var n = parseInt(v, 10);
    if (!isFinite(n) || n <= 0) return 0;
    return n > THREADS_HI ? THREADS_HI : n;
  }

  // Out-of-range input (typing, an old stored value) is pulled back to a usable number
  // rather than rejected, so the gate can never be disabled by accident.
  function clampMinMoves(v) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return DEFAULTS.minArchiveMoves;
    return Math.max(MIN_MOVES_LO, Math.min(MIN_MOVES_HI, n));
  }

  // ---------- storage shim ----------
  var _mem = {};
  var memApi = {
    get: function (keys) {
      return Promise.resolve().then(function () {
        if (keys == null) return Object.assign({}, _mem);
        var list = Array.isArray(keys) ? keys : [keys];
        var out = {};
        for (var i = 0; i < list.length; i++) if (list[i] in _mem) out[list[i]] = _mem[list[i]];
        return out;
      });
    },
    set: function (obj) { return Promise.resolve().then(function () { Object.assign(_mem, obj); }); },
    remove: function (keys) {
      return Promise.resolve().then(function () {
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete _mem[k]; });
      });
    },
    clear: function () { return Promise.resolve().then(function () { _mem = {}; }); },
  };

  function api() {
    if (g.chrome && g.chrome.storage && g.chrome.storage.local) return g.chrome.storage.local;
    return memApi;
  }

  // Every write here is a read-modify-write of a whole key ("read the settings object,
  // patch one field, write it back"). Two of those in flight at once each write a
  // snapshot that predates the other, so the loser's field silently reverts to its old
  // value — a setting the operator just changed, dropped without a word. Changing two
  // knobs in quick succession is enough to hit it, so all writers go through one chain.
  var writeChain = Promise.resolve();
  function enqueue(task) {
    var run = writeChain.then(task, task);
    writeChain = run.then(function () {}, function () {});
    return run;
  }

  // ---------- settings ----------
  async function loadSettings() {
    var got = null;
    try { got = await api().get(SETTINGS_KEY); } catch (e) { got = null; }
    var raw = (got && got[SETTINGS_KEY]) || {};
    // Merge, then project back onto DEFAULTS so stale/unknown keys never linger
    // (an older build's key would otherwise be carried forward forever).
    var out = {};
    for (var k in DEFAULTS) out[k] = (k in raw) ? raw[k] : DEFAULTS[k];
    out.minArchiveMoves = clampMinMoves(out.minArchiveMoves);
    out.threadNum = clampThreadNum(out.threadNum);
    return out;
  }

  function saveSettings(patch) {
    return enqueue(async function () {
      var s = await loadSettings();
      if (patch) for (var k in patch) if (k in DEFAULTS) s[k] = patch[k];
      s.minArchiveMoves = clampMinMoves(s.minArchiveMoves);
      s.threadNum = clampThreadNum(s.threadNum);
      var put = {}; put[SETTINGS_KEY] = s;
      try { await api().set(put); } catch (e) {}
      return s;
    });
  }

  function saveSetting(key, value) {
    var patch = {}; patch[key] = value;
    return saveSettings(patch);
  }

  function defaults() { return Object.assign({}, DEFAULTS); }

  // ---------- overlay (on-page panel) ----------
  // `height: 0` means auto — the panel grows with its content up to 86vh, which is how
  // it behaves until the operator drags the resize handle. A hard 400px default would
  // clip the expanded "更多设置" section on first run.
  // `left: null` means "anchor by `right`" — that is the original corner placement. Once
  // the drag bar has been used, `left` holds the position and `right` is ignored, so the
  // two anchors are mutually exclusive rather than fighting over the same box.
  // `state` is 0.3.1's three-state: 'normal' (full panel) / 'compact' (eval only) /
  // 'mini' (shield icon). `minimized` is kept for backward compatibility and is exactly
  // true when `state === 'mini'`; loadOverlay() reconstructs it from `state` so an older
  // profile that only wrote `minimized` still restores to a mini icon.
  var DEFAULT_OVERLAY = { state: 'normal', minimized: false, width: 580, height: 0, top: 12, right: 12, left: null };
  var NULLABLE_OVERLAY = { left: true };

  async function loadOverlay() {
    var got = null;
    try { got = await api().get(OVERLAY_KEY); } catch (e) { got = null; }
    var raw = (got && got[OVERLAY_KEY]) || {};
    var out = {};
    for (var k in DEFAULT_OVERLAY) {
      var v = raw[k];
      // `left` is the one nullable field: a number is a dragged position, anything else
      // (missing, null, junk from an older build) means "anchor by right". It cannot go
      // through the generic branch below, whose `typeof DEFAULT_OVERLAY[k] === 'number'`
      // test fails for a null default and would silently drop every stored value.
      if (NULLABLE_OVERLAY[k]) {
        out[k] = (typeof v === 'number' && isFinite(v)) ? v : null;
        continue;
      }
      out[k] = (typeof DEFAULT_OVERLAY[k] === 'number')
        ? (typeof v === 'number' && isFinite(v) ? v : DEFAULT_OVERLAY[k])
        : (typeof v === 'boolean' ? v : DEFAULT_OVERLAY[k]);
    }
    // Normalise the two-state fields into one source of truth: `minimized` was the 0.2.x
    // state; `state` is 0.3.1's. An old profile only wrote `minimized`, so derive `state`
    // from it; a 0.3.1 profile wrote `state`, so derive `minimized` from it. Either way a
    // blank or junk value lands on 'normal'.
    if (raw.state === 'compact' || raw.state === 'mini') out.state = raw.state;
    else if (out.minimized) out.state = 'mini';
    else out.state = 'normal';
    out.minimized = (out.state === 'mini');
    return out;
  }

  function saveOverlay(patch) {
    return enqueue(async function () {
      var st = await loadOverlay();
      if (patch) for (var k in patch) if (k in DEFAULT_OVERLAY) st[k] = patch[k];
      var put = {}; put[OVERLAY_KEY] = st;
      try { await api().set(put); } catch (e) {}
      return st;
    });
  }

  function overlayDefaults() { return Object.assign({}, DEFAULT_OVERLAY); }

  // ---------- 0.4.0 §一: remote update check ----------
  // Why not `chrome.runtime.requestUpdateCheck()`: that API only sees extensions installed
  // from the Chrome Web Store. This one is loaded unpacked from a GitHub repository, so it
  // always answers "no update" — the check has to be built out of a fetch of a version file.
  //
  // The repository root IS the extension directory (unpacked install), so `version.json`
  // lives next to `manifest.json` and is served over raw.githubusercontent.com. Everything
  // in this section is pure or storage-only: the fetch itself lives in background.js (the
  // service worker owns network access) and the banner lives in content.js / viewer.js.
  var UPDATE_REPO = 'https://github.com/AODOJUST/gomoku-anti-cheat-detector';
  var UPDATE_SOURCE = UPDATE_REPO.replace('github.com', 'raw.githubusercontent.com') + '/main/version.json';
  // §一.2 allows falling back to the repository's own manifest.json, which carries the version
  // even if nobody remembered to bump version.json. It has no release notes or download URL,
  // so those are synthesised from the repository URL.
  var UPDATE_FALLBACK = UPDATE_REPO.replace('github.com', 'raw.githubusercontent.com') + '/main/manifest.json';
  var UPDATE_RELEASES = UPDATE_REPO + '/releases';
  var UPDATE_ZIP = UPDATE_REPO + '/archive/refs/heads/main.zip';
  var UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;      // §一.3 — auto-check at most once every 12h
  var UPDATE_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;   // §一.4 — 「暂不更新」silences this version 7 days

  // §一.2. Segment by segment, numerically, missing segments read as 0 — so `1.0` and `1.0.0`
  // are equal and `0.4.0 > 0.3.7`. Anything non-numeric in a segment degrades to 0 rather
  // than to NaN: a NaN comparison is false against everything, which would silently report
  // "up to date" for a version string with a suffix in it (`0.4.0-beta`).
  function compareVersion(a, b) {
    var pa = String(a == null ? '' : a).split('.');
    var pb = String(b == null ? '' : b).split('.');
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var va = parseInt(pa[i], 10); if (!isFinite(va)) va = 0;
      var vb = parseInt(pb[i], 10); if (!isFinite(vb)) vb = 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  async function loadUpdateInfo() {
    var got = null;
    try { got = await api().get(UPDATE_KEY); } catch (e) { got = null; }
    var raw = got && got[UPDATE_KEY];
    return (raw && typeof raw === 'object') ? raw : null;
  }

  function saveUpdateInfo(info) {
    return enqueue(async function () {
      var put = {}; put[UPDATE_KEY] = info;
      try { await api().set(put); } catch (e) {}
      return info;
    });
  }

  async function loadUpdateDismissed() {
    var got = null;
    try { got = await api().get(UPDATE_DISMISS_KEY); } catch (e) { got = null; }
    var raw = got && got[UPDATE_DISMISS_KEY];
    return (raw && typeof raw === 'object') ? raw : null;
  }

  // Mutes exactly ONE version. A later release re-arms the banner without the operator having
  // to remember that they waved off an older one.
  function dismissUpdate(version, now) {
    return enqueue(async function () {
      var rec = { version: String(version == null ? '' : version), until: (now || Date.now()) + UPDATE_DISMISS_MS };
      var put = {}; put[UPDATE_DISMISS_KEY] = rec;
      try { await api().set(put); } catch (e) {}
      return rec;
    });
  }

  // Pure predicate so the tests can pin the window without touching the clock.
  function isUpdateDismissed(dismissed, latestVersion, now) {
    if (!dismissed || latestVersion == null) return false;
    if (String(dismissed.version) !== String(latestVersion)) return false;
    return (dismissed.until || 0) > (now || Date.now());
  }

  // The one call the two banners make: "is there an update worth showing right now?".
  // Returns the info object, or null when there is nothing (no update / already dismissed /
  // never checked). Never throws — a banner must not be able to break the host page.
  async function pendingUpdate(now) {
    var info = await loadUpdateInfo();
    if (!info || !info.available) return null;
    var dis = await loadUpdateDismissed();
    if (isUpdateDismissed(dis, info.latestVersion, now)) return null;
    return info;
  }

  // ---------- archives ----------
  async function loadArchives() {
    var got = null;
    try { got = await api().get(ARCHIVES_KEY); } catch (e) { got = null; }
    var list = got && got[ARCHIVES_KEY];
    return Array.isArray(list) ? list : [];
  }

  async function writeArchives(list) {
    var put = {}; put[ARCHIVES_KEY] = list;
    await api().set(put);
  }

  function uid() {
    return 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // Keep the newest MAX_ARCHIVES; the array is always stored newest-first.
  function pruneList(list) {
    var sorted = list.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    if (sorted.length <= MAX_ARCHIVES) return sorted;
    return sorted.slice(0, MAX_ARCHIVES);
  }

  async function pruneArchives() {
    return enqueue(async function () {
      var list = await loadArchives();
      var out = pruneList(list);
      if (out.length !== list.length) await writeArchives(out);
      return out.length;
    });
  }

  // Insert (or replace) one archive. Returns the stored entry. `replaceId` lets the
  // live stepwise session rewrite its own record instead of stacking duplicates.
  function saveArchive(entry, opts) {
    opts = opts || {};
    return enqueue(async function () {
      var list = await loadArchives();
      if (opts.replaceId) list = list.filter(function (a) { return a.id !== opts.replaceId; });
      if (entry.id) list = list.filter(function (a) { return a.id !== entry.id; });
      list.unshift(entry);
      list = pruneList(list);
      try {
        await writeArchives(list);
      } catch (e) {
        // QuotaExceeded: give up half the history rather than lose the new game.
        var half = Math.max(1, Math.floor(list.length / 2));
        await writeArchives(list.slice(0, half));
        entry.quotaTrimmed = true;
      }
      return entry;
    });
  }

  function deleteArchive(id) {
    return enqueue(async function () {
      var list = await loadArchives();
      var next = list.filter(function (a) { return a.id !== id; });
      await writeArchives(next);
      return next.length !== list.length;
    });
  }

  function renameArchive(id, name) {
    return enqueue(async function () {
      var list = await loadArchives();
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { list[i].name = name; hit = list[i]; }
      }
      if (hit) await writeArchives(list);
      return hit;
    });
  }

  function categorizeArchive(id, category) {
    return enqueue(async function () {
      var list = await loadArchives();
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { list[i].category = category || null; hit = list[i]; }
      }
      if (hit) await writeArchives(list);
      return hit;
    });
  }

  // Categories are never stored on their own — they are derived from the archives,
  // so a category disappears exactly when its last member does.
  function listCategories(list) {
    var seen = {}, out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var c = list[i].category;
      if (c && !seen[c]) { seen[c] = true; out.push(c); }
    }
    return out.sort();
  }

  function renameCategory(from, to) {
    if (!from || !to || from === to) return Promise.resolve(0);
    return enqueue(async function () {
      var list = await loadArchives();
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i].category === from) { list[i].category = to; n++; }
      }
      if (n) await writeArchives(list);
      return n;
    });
  }

  function deleteCategory(name) {
    return enqueue(async function () {
      var list = await loadArchives();
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i].category === name) { list[i].category = null; n++; }
      }
      if (n) await writeArchives(list);
      return n;
    });
  }

  // ---------- 0.3.5 §3.3 archive batch + import/export ----------
  // Batch edits are ONE read-modify-write each, never N calls to the single-item API: 200
  // archives × (get + set) is 400 storage round-trips for one click, and every intermediate
  // state is a window where a second tab can interleave its own write and lose half the work.
  function idsSet(ids) {
    var m = {};
    (ids || []).forEach(function (id) { if (id) m[id] = true; });
    return m;
  }

  function deleteArchives(ids) {
    var kill = idsSet(ids);
    return enqueue(async function () {
      var list = await loadArchives();
      var next = list.filter(function (a) { return !kill[a.id]; });
      var n = list.length - next.length;
      if (n) await writeArchives(next);
      return n;
    });
  }

  function setArchivesCategory(ids, category) {
    var want = idsSet(ids);
    var cat = category ? String(category).slice(0, 60) : null;
    return enqueue(async function () {
      var list = await loadArchives();
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        if (want[list[i].id]) { list[i].category = cat; n++; }
      }
      if (n) await writeArchives(list);
      return n;
    });
  }

  // An empty name is skipped rather than applied: the single-item rename refuses it too, and
  // a batch rename that silently blanked 30 titles would be unrecoverable.
  function renameArchives(ids, name) {
    var want = idsSet(ids);
    var nm = String(name == null ? '' : name).trim().slice(0, 120);
    if (!nm) return Promise.resolve(0);
    return enqueue(async function () {
      var list = await loadArchives();
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        if (want[list[i].id]) { list[i].name = nm; n++; }
      }
      if (n) await writeArchives(list);
      return n;
    });
  }

  // An archive read off disk is untrusted input. The bar is the same one normalizeSample
  // sets: without a usable `record.moves` there is no board to replay, and the entry would
  // be a row in the list that opens onto nothing. `report` is optional — an archive captured
  // before it was analysed is legitimate — but when present it goes through slimReport,
  // which both rebuilds the exact shape the rest of the code expects and throws away
  // anything a foreign build may have added.
  function normalizeArchive(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var rec = raw.record;
    if (!rec || !Array.isArray(rec.moves) || !rec.moves.length) return null;
    var moves = [];
    for (var i = 0; i < rec.moves.length; i++) {
      var c = rec.moves[i];
      if (!Array.isArray(c) || c.length < 2) return null;
      var x = Number(c[0]), y = Number(c[1]);
      if (!isFinite(x) || !isFinite(y)) return null;
      moves.push([x, y]);
    }
    var rep = null;
    if (raw.report && typeof raw.report === 'object') {
      // slimReport is shape-tolerant but not a validator: a `steps` that is not an array
      // would come back as [] and quietly turn an analysed game into an unanalysed one (and
      // it would throw on the way, taking the whole import down with it). Refuse the entry
      // instead of silently downgrading it — and check BEFORE slimReport, not after.
      if (raw.report.steps != null && !Array.isArray(raw.report.steps)) return null;
      rep = slimReport(raw.report);
    }
    var black = rep && rep.black, white = rep && rep.white;
    var bRisk = black ? Math.round(black.risk) : 0;
    var wRisk = white ? Math.round(white.risk) : 0;
    var entry = {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : null,
      name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
      category: (typeof raw.category === 'string' && raw.category) ? raw.category.slice(0, 60) : null,
      createdAt: Number(raw.createdAt) || Date.now(),
      mode: raw.mode === 'stepwise' ? 'stepwise' : 'global',
      rule: raw.rule || (rec.meta && rec.meta.rule) || 'freestyle',
      suspect: raw.suspect || 'both',
      totalMoves: Number(raw.totalMoves) || moves.length,
      forcedCount: Number(raw.forcedCount) || 0,
      outcome: raw.outcome || (rec.meta && rec.meta.outcome) || 'unknown',
      opening: (typeof raw.opening === 'string' && raw.opening)
        ? raw.opening : ((rec.meta && rec.meta.opening && rec.meta.opening.code) || null),
      identity: raw.identity || (rec.meta && rec.meta.identity) || null,
      terminated: !!(rep && rep.terminal),
      blackRisk: bRisk,
      whiteRisk: wRisk,
      maxRisk: Math.max(bRisk, wRisk),
      blackLevel: black ? black.level : '低风险',
      whiteLevel: white ? white.level : '低风险',
      players: (raw.players && typeof raw.players === 'object') ? raw.players : { black: null, white: null },
      record: {
        moves: moves,
        stones: Array.isArray(rec.stones) ? rec.stones.slice(0, moves.length) : [],
        times: Array.isArray(rec.times) ? rec.times.slice(0, moves.length) : [],
        sources: Array.isArray(rec.sources) ? rec.sources.slice(0, moves.length) : [],
        meta: (rec.meta && typeof rec.meta === 'object') ? rec.meta : {},
      },
      report: rep,
    };
    // Derived fields are recomputed above, but the NAME is the operator's: only fill it in
    // when the file carried none, so an import never renames a curated archive.
    if (!entry.name) entry.name = defaultArchiveName(entry);
    // 0.4.2 §4.1: the family, when the specific opening is not known. Derived from whatever
    // the entry or the record carries, so a pre-0.4.2 archive (code only) answers the 大类
    // filter too.
    entry.openingFamily = openingFamilyOf(entry);
    return entry;
  }

  // Merge an exported archive array back in. Same rule as importSamples: an id that already
  // exists locally is treated as a DIFFERENT copy and gets a fresh id, because the file may
  // come from another machine and silently overwriting a local game with a same-id stranger
  // loses real work.
  function importArchives(incoming) {
    return enqueue(async function () {
      var list = await loadArchives();
      var have = {};
      list.forEach(function (a) { have[a.id] = true; });
      var added = 0, remapped = 0;
      (incoming || []).forEach(function (raw) {
        if (!raw || typeof raw !== 'object') return;
        var a = normalizeArchive(raw);
        if (!a) return;
        if (!a.id || have[a.id]) { a.id = uid(); remapped++; }
        have[a.id] = true;
        a.importedAt = Date.now();
        list.unshift(a);
        added++;
      });
      if (!added) return { added: 0, remapped: 0, total: list.length };
      list = pruneList(list);
      try {
        await writeArchives(list);
      } catch (e) {
        var half = Math.max(1, Math.floor(list.length / 2));
        await writeArchives(list.slice(0, half));
      }
      return { added: added, remapped: remapped, total: list.length };
    });
  }

  // ---------- 0.3.3 sample library ----------
  // The preset tag vocabulary (0.3.3 §1.6). Custom tags live alongside these in the
  // samples themselves — `listSampleTags()` unions the two, so the vocabulary is never
  // stored twice and a custom tag disappears exactly when its last sample does.
  // 0.3.5 §3.4: 黑方AI / 白方AI say which SIDE was the AI. They sit alongside the
  // game-level 样本 tags rather than replacing them, because the two answer different
  // questions — 双方样本 is about which moves are evidence, 黑方AI is about who played
  // them — and a game can legitimately carry both. learn.js gives the side tag priority
  // (it is the more precise claim) and falls back to the game-level tag.
  var PRESET_TAGS = [
    '标准样本', '存疑样本',
    '黑方打谱样本', '白方打谱样本', '双方样本',
    'AI 样本', '人类样本',
    '黑方AI', '白方AI',
  ];

  // The annotation vocabulary (0.3.3 §2.1, extended in 0.3.5 §3.1). `判断准确`/`判断错误` are
  // about the DETECTOR's verdict; `AI步骤`/`冲四`/`无用冲四` are about the MOVE itself; `可疑`
  // is a weak mark. All are independent, so a step can carry any subset.
  //
  // 0.3.5 adds two, and the reason they are separate labels rather than one is that they make
  // different claims:
  //   豁免 — the operator confirms this hand was the ONLY defence (a positive sample for
  //          validating the engine's automatic 冲四豁免 / forcedDefense rule, which is a
  //          heuristic: gap >= 0.15 && the played move is top-1). The two are recorded
  //          independently on purpose, so the manual mark can be used to check the rule
  //          rather than being overwritten by it.
  //   冲四 — neutral: this hand IS a 冲四. 无用冲四 is the negative version (a pointless
  //          delay while already lost). Both can be on at once, which is the whole point of
  //          splitting them.
  var ANN_LABELS = ['判断准确', '判断错误', 'AI步骤', '冲四', '无用冲四', '可疑', '豁免'];
  // Short glyphs for the step-table buttons (§2.2). Order matches ANN_LABELS.
  var ANN_BTN = {
    '判断准确': '✓', '判断错误': '✗', 'AI步骤': 'AI',
    '冲四': '四',      // 中性描述
    '无用冲四': '冲',  // 带负面评价
    '可疑': '?',
    '豁免': '豁',      // 与检测器的 forcedDefense 对应
  };

  var MAX_NOTE_LEN = 500;

  function sampleUid() {
    return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  async function loadSamples() {
    var got = null;
    try { got = await api().get(SAMPLES_KEY); } catch (e) { got = null; }
    var list = got && got[SAMPLES_KEY];
    return Array.isArray(list) ? list : [];
  }

  async function writeSamples(list) {
    var put = {}; put[SAMPLES_KEY] = list;
    await api().set(put);
  }

  // `annotations` is keyed by moveNo, so it survives a re-analysis that renumbers nothing
  // but rebuilds the step array. Every reader goes through here so a sample written by an
  // older build (no field at all) never throws.
  function annotationsOf(s) {
    if (!s) return {};
    if (!s.annotations || typeof s.annotations !== 'object') s.annotations = {};
    return s.annotations;
  }

  // 0.3.1's binary `manualAI` -> 0.3.3's multi-label (0.3.3 §2.1). Runs on the way in and
  // on the way out so an archive converted to a sample, or a sample built from a report
  // that still carries the old flag, ends up with the same 人工标注 as one annotated by hand.
  function migrateAnnotations(s) {
    var ann = annotationsOf(s);
    var steps = (s && s.report && s.report.steps) || [];
    for (var i = 0; i < steps.length; i++) {
      var st = steps[i];
      if (st && st.manualAI && st.moveNo != null && !ann[st.moveNo]) {
        ann[st.moveNo] = { labels: ['AI步骤'] };
      }
    }
    return ann;
  }

  function sampleLabels(s, moveNo) {
    var ann = annotationsOf(s)[moveNo];
    return (ann && Array.isArray(ann.labels)) ? ann.labels : [];
  }

  // A step counts as annotated when a human put ANYTHING on it — a label or just a note.
  // Counting labels alone would report a step carrying only a note ("唯一防点秒下") as
  // untouched, and the 有无标注 filter is exactly what the operator uses to find those.
  function countAnnotated(s) {
    var ann = annotationsOf(s), n = 0;
    for (var k in ann) {
      var e = ann[k];
      if (!e) continue;
      var hasLabels = Array.isArray(e.labels) && e.labels.length > 0;
      var hasNote = typeof e.note === 'string' && e.note.length > 0;
      if (hasLabels || hasNote) n++;
    }
    return n;
  }

  function loadSample(id) {
    return loadSamples().then(function (list) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    });
  }

  // Insert (or replace) one sample. Returns the stored entry. The caller owns `version`:
  // a first save carries version 1, an edit carries the incremented value (0.3.3 §1.5),
  // because only the editor knows whether this is a create or an update.
  function saveSample(s) {
    return enqueue(async function () {
      var list = await loadSamples();
      if (s.id) list = list.filter(function (x) { return x.id !== s.id; });
      else s.id = sampleUid();
      migrateAnnotations(s);
      list.unshift(s);
      if (list.length > MAX_SAMPLES) list = list.slice(0, MAX_SAMPLES);
      try {
        await writeSamples(list);
      } catch (e) {
        // QuotaExceeded: drop the oldest half rather than lose the sample just saved.
        var half = Math.max(1, Math.floor(list.length / 2));
        await writeSamples(list.slice(0, half));
        s.quotaTrimmed = true;
      }
      return s;
    });
  }

  function deleteSample(id) {
    return enqueue(async function () {
      var list = await loadSamples();
      var next = list.filter(function (x) { return x.id !== id; });
      await writeSamples(next);
      return next.length !== list.length;
    });
  }

  function renameSample(id, name) {
    return enqueue(async function () {
      var list = await loadSamples();
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { list[i].name = name; list[i].updatedAt = Date.now(); hit = list[i]; }
      }
      if (hit) await writeSamples(list);
      return hit;
    });
  }

  // 0.3.3 §2.3: toggle one label on one step and persist. `version++` and `updatedAt` move
  // together — `version` is what the learner reads ("学习最新版本"), so a mark that did not
  // bump it would be invisible to 重新学习.
  function toggleSampleLabel(id, moveNo, label) {
    return enqueue(async function () {
      var list = await loadSamples();
      var s = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) s = list[i];
      if (!s) return null;
      var ann = annotationsOf(s);
      var cur = ann[moveNo] || { labels: [] };
      if (!Array.isArray(cur.labels)) cur.labels = [];
      var idx = cur.labels.indexOf(label);
      if (idx >= 0) cur.labels.splice(idx, 1);
      else cur.labels.push(label);
      // An entry with neither labels nor a note carries no information — drop it so
      // `countAnnotated` and the learner's filters stay honest.
      if (!cur.labels.length && !cur.note) delete ann[moveNo];
      else ann[moveNo] = cur;
      s.version = (s.version || 1) + 1;
      s.updatedAt = Date.now();
      await writeSamples(list);
      return s;
    });
  }

  function setSampleNote(id, moveNo, note) {
    return enqueue(async function () {
      var list = await loadSamples();
      var s = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) s = list[i];
      if (!s) return null;
      var ann = annotationsOf(s);
      var cur = ann[moveNo] || { labels: [] };
      var txt = String(note == null ? '' : note).slice(0, MAX_NOTE_LEN);
      if (txt) cur.note = txt; else delete cur.note;
      if (!cur.labels || !cur.labels.length) {
        if (txt) { cur.labels = cur.labels || []; ann[moveNo] = cur; }
        else delete ann[moveNo];
      } else ann[moveNo] = cur;
      s.version = (s.version || 1) + 1;
      s.updatedAt = Date.now();
      await writeSamples(list);
      return s;
    });
  }

  function setSampleTags(id, tags) {
    return enqueue(async function () {
      var list = await loadSamples();
      var s = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) s = list[i];
      if (!s) return null;
      s.tags = (tags || []).slice();
      s.updatedAt = Date.now();
      await writeSamples(list);
      return s;
    });
  }

  // ---- 0.3.4 batch operations -------------------------------------------
  // These exist so the list's bulk actions are ONE read-modify-write each. Looping the
  // single-item calls above would be correct but would rewrite the whole `samples` blob N times
  // — on a store that has no unlimitedStorage, that is a real quota hazard, not just slow.

  function deleteSamples(ids) {
    return enqueue(async function () {
      var want = {};
      (ids || []).forEach(function (id) { want[id] = true; });
      var list = await loadSamples();
      var next = list.filter(function (x) { return !want[x.id]; });
      if (next.length === list.length) return 0;
      await writeSamples(next);
      return list.length - next.length;
    });
  }

  // add/remove tags across a set of samples. `version++` moves with `updatedAt` for the same
  // reason as the single-sample path: the learner reads the latest version.
  function setSamplesTags(ids, addTags, removeTags) {
    return enqueue(async function () {
      var want = {};
      (ids || []).forEach(function (id) { want[id] = true; });
      var add = (addTags || []).filter(Boolean);
      var rem = {};
      (removeTags || []).forEach(function (t) { rem[t] = true; });
      var list = await loadSamples();
      var touched = 0;
      list.forEach(function (s) {
        if (!want[s.id]) return;
        var cur = (s.tags || []).filter(function (t) { return !rem[t]; });
        add.forEach(function (t) { if (cur.indexOf(t) < 0) cur.push(t); });
        s.tags = cur;
        s.updatedAt = Date.now();
        s.version = (s.version || 1) + 1;
        touched++;
      });
      if (touched) await writeSamples(list);
      return touched;
    });
  }

  // Merge an exported sample array back in. An id that is already present is treated as a
  // DIFFERENT copy and gets a fresh id, because the exported file may come from another
  // machine: silently overwriting a local sample with a same-id stranger loses real work.
  function importSamples(incoming) {
    return enqueue(async function () {
      var list = await loadSamples();
      var have = {};
      list.forEach(function (x) { have[x.id] = true; });
      var added = 0, remapped = 0;
      (incoming || []).forEach(function (raw) {
        if (!raw || typeof raw !== 'object') return;
        var s = normalizeSample(raw);
        if (!s) return;
        if (!s.id || have[s.id]) { s.id = sampleUid(); remapped++; }
        have[s.id] = true;
        migrateAnnotations(s);
        s.importedAt = Date.now();
        list.unshift(s);
        added++;
      });
      if (!added) return { added: 0, remapped: 0, total: list.length };
      var trimmed = false;
      if (list.length > MAX_SAMPLES) { list = list.slice(0, MAX_SAMPLES); trimmed = true; }
      try {
        await writeSamples(list);
      } catch (e) {
        var half = Math.max(1, Math.floor(list.length / 2));
        await writeSamples(list.slice(0, half));
        trimmed = true;
      }
      return { added: added, remapped: remapped, total: list.length, trimmed: trimmed };
    });
  }

  // Every tag in use: the presets first (a stable, familiar order), then the custom ones
  // in first-seen order. Derived, never stored — the same rule categories follow.
  function listSampleTags(list) {
    var seen = {}, out = PRESET_TAGS.slice();
    for (var i = 0; i < PRESET_TAGS.length; i++) seen[PRESET_TAGS[i]] = true;
    for (var j = 0; j < (list || []).length; j++) {
      var t = list[j].tags || [];
      for (var k = 0; k < t.length; k++) {
        if (t[k] && !seen[t[k]]) { seen[t[k]] = true; out.push(t[k]); }
      }
    }
    return out;
  }

  // "黑方打谱样本 01"-style default. Built from what the sample actually contains so two
  // samples are tellable apart in the list without opening either.
  //
  // 0.3.6: this is a NAME — display text stored once at creation time, never matched against
  // — so it is generated in the language active when the sample was made. That is the one
  // place where the spec's "新建的标签跟随当前语言" applies literally: the tag it is built
  // from is stored canonically and translated here, while the name itself is frozen.
  function defaultSampleName(s) {
    var rec = (s && s.record) || {};
    var moves = (rec.moves || []).length;
    var tags = (s && s.tags) || [];
    var head = tags.length ? TO('tag', tags[0]) : T('samples|样本');
    return head + ' · ' + moves + T('samples|手') + ' · ' + beijingTime((s && s.createdAt) || Date.now());
  }

  // Sample list ordering: newest / longest / name / most-edited.
  function compareSamples(a, b, key) {
    if (key === 'moves') return ((b.record && b.record.moves ? b.record.moves.length : 0) -
                                 (a.record && a.record.moves ? a.record.moves.length : 0)) ||
                                ((b.updatedAt || 0) - (a.updatedAt || 0));
    if (key === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
    if (key === 'version') return ((b.version || 0) - (a.version || 0)) || ((b.updatedAt || 0) - (a.updatedAt || 0));
    return ((b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  }

  function sortSamples(list, key, dir) {
    var sorted = list.slice().sort(function (a, b) { return compareSamples(a, b, key); });
    if (dir === 'asc') sorted.reverse();
    return sorted;
  }

  // Filter spec (all optional, all ANDed):
  //   tag        null (all) | '__none__' | a tag string
  //   rule       'all' | 'freestyle' | 'renju'
  //   annotated  'yes' | 'no'      (has at least one annotated step)
  //   ageId      one of AGE_BUCKETS ids, or 'custom' with ageFrom/ageTo (ms ago)
  function filterSamples(list, f) {
    f = f || {};
    var now = Date.now();
    return list.filter(function (s) {
      if (f.tag) {
        var tags = s.tags || [];
        if (f.tag === '__none__') { if (tags.length) return false; }
        else if (tags.indexOf(f.tag) < 0) return false;
      }
      if (f.rule && f.rule !== 'all' && s.rule !== f.rule) return false;
      if (f.annotated === 'yes' && countAnnotated(s) === 0) return false;
      if (f.annotated === 'no' && countAnnotated(s) > 0) return false;
      if (f.ageId) {
        var age = now - (s.updatedAt || s.createdAt || 0);
        if (f.ageId === 'custom') {
          if (f.ageFrom != null && age < f.ageFrom) return false;
          if (f.ageTo != null && age > f.ageTo) return false;
        } else {
          var b = null;
          for (var i = 0; i < AGE_BUCKETS.length; i++) if (AGE_BUCKETS[i].id === f.ageId) b = AGE_BUCKETS[i];
          if (b) {
            if (b.id === 'old') { if (age <= AGE_BUCKETS[AGE_BUCKETS.length - 2].ms) return false; }
            else if (age >= b.ms) return false;
          }
        }
      }
      return true;
    });
  }

  function countActiveSampleFilters(f) {
    f = f || {};
    var n = 0;
    if (f.tag) n++;
    if (f.rule && f.rule !== 'all') n++;
    if (f.annotated) n++;
    if (f.ageId) n++;
    return n;
  }

  // Build a sample out of a finished analysis. Mirrors buildArchive's inputs so the
  // "存档 → 转为样本" path is a straight copy, and an archive's `manualAI` flags ride
  // across as 人工标注 via migrateAnnotations.
  // 0.3.4: the shape an imported sample must have before it is allowed into the store. A file
  // picked off disk is untrusted input — anything without a usable `record.moves` array is
  // refused outright (it would poison 重新学习 with an empty feature vector), and every scalar
  // is coerced to the type the rest of the code assumes. Returns null for a rejected entry.
  function normalizeSample(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var rec = raw.record;
    if (!rec || !Array.isArray(rec.moves) || !rec.moves.length) return null;
    var moves = [];
    for (var i = 0; i < rec.moves.length; i++) {
      var c = rec.moves[i];
      if (!Array.isArray(c) || c.length < 2) return null;
      var x = Number(c[0]), y = Number(c[1]);
      if (!isFinite(x) || !isFinite(y)) return null;
      moves.push([x, y]);
    }
    var tags = Array.isArray(raw.tags)
      ? raw.tags.filter(function (t) { return typeof t === 'string' && t; }).slice(0, 24)
      : [];
    return {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : null,
      name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
      note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE_LEN) : '',
      tags: tags,
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
      version: Math.max(1, parseInt(raw.version, 10) || 1),
      rule: raw.rule === 'renju' ? 'renju' : 'freestyle',
      mode: raw.mode === 'stepwise' ? 'stepwise' : 'global',
      suspect: (raw.suspect === 'B' || raw.suspect === 'W') ? raw.suspect : 'both',
      record: {
        moves: moves,
        stones: Array.isArray(rec.stones) ? rec.stones.slice(0, moves.length) : [],
        times: Array.isArray(rec.times) ? rec.times.slice(0, moves.length) : [],
        sources: Array.isArray(rec.sources) ? rec.sources.slice(0, moves.length) : [],
        meta: (rec.meta && typeof rec.meta === 'object') ? rec.meta : {},
      },
      // The report is re-derived by the engine on the importing machine if the operator wants
      // verdicts. Carrying a foreign report would mean shipping verdicts from a different
      // engine build next to this machine's numbers.
      report: null,
      annotations: (raw.annotations && typeof raw.annotations === 'object') ? raw.annotations : {},
    };
  }

  function buildSample(input) {
    var rep = (input && input.report) || {};
    var record = (input && input.record) || { moves: [], times: [], sources: [] };
    var now = Date.now();
    var s = {
      id: (input && input.id) || sampleUid(),
      name: (input && input.name) || '',
      note: (input && input.note) || '',
      tags: (input && input.tags) ? input.tags.slice() : [],
      createdAt: (input && input.createdAt) || now,
      updatedAt: now,
      version: (input && input.version) || 1,
      rule: (input && input.rule) || (record.meta && record.meta.rule) || 'freestyle',
      mode: (input && input.mode) === 'stepwise' ? 'stepwise' : 'global',
      suspect: (input && input.suspect) || 'both',
      record: {
        moves: record.moves || [],
        stones: record.stones || [],
        times: record.times || [],
        sources: record.sources || [],
        meta: record.meta || {},
      },
      report: slimReport(rep),
      annotations: (input && input.annotations) || {},
    };
    if (!s.name) s.name = defaultSampleName(s);
    migrateAnnotations(s);
    return s;
  }

  // ---------- 0.3.3 learned parameters ----------
  // The learner's output. `null` means "never trained" — the detector then uses the
  // 0.3.1 defaults, which is exactly the pre-0.3.3 behaviour.
  // 0.3.3 §3.5 / 0.4.2 §2.3. `evasion` and `winBlunder` are a SURCHARGE on top of the six
  // 0.3.1 terms, not a slice of them. 0.4.2's own acceptance criteria require an unchanged
  // risk score whenever neither signal fires (§2.6 #6, §五 #5), and making room for the two by
  // scaling the six down to 0.90 would multiply every existing score by ~0.9 — enough to flip
  // a game sitting exactly on the 70 cut from 高风险 to 可疑. So the six keep the values that
  // sum to 1 and the surcharge is additive; app.js clamps the total at 100. Same literal as
  // app.js BASE_WEIGHTS and learn.js FALLBACK_WEIGHTS — the three are one set of numbers.
  var DEFAULT_WEIGHTS = {
    top1: 0.20, acpl: 0.08, sharp: 0.22, out: 0.27, desperate: 0.08, time: 0.15,
    evasion: 0.06, winBlunder: 0.04,
  };
  var DEFAULT_THRESHOLDS = {
    top1Lo: 0.72, top1Hi: 0.90,     // aTop1 ramp: at/below Lo -> 0, at/above Hi -> 1
    acplLo: 0.003, acplHi: 0.015,   // aAcpl ramp: lower loss is better
    sharpHitLo: 0.65, sharpHitSpan: 0.35,
    outTop5Hi: 0.03,                // aOut ramp
    riskHigh: 70, riskMid: 40,      // 高风险 / 可疑 cut lines
    simWeight: 0.10,                // share of the risk score the feature library may claim
    // 0.4.2 §4.3: the evasion thresholds, learnable through the same mechanism as the rest
    // (learn.js merges its own copy of this object key by key, and only for keys it knows).
    // These defaults are the ones §2.3 documents.
    evasionLoss: 0.20,              // "a blunder": win rate the side gave up on that hand
    goodLoss: 0.05,                 // "a good hand": ceiling for the two neighbours
    evasionMin: 3,                  // fewest evasions before the rhythm score means anything
    evasionReg: 0.35,               // stddev / mean ceiling for "a regular rhythm"
    winningWR: 0.85,                // "winning" for the 将胜乱下 signal
  };
  // 0.3.3 §3.5: below this many samples 重新学习 is disabled outright; below LOW it runs
  // but is labelled unreliable. The two are separate so a 6-sample run is still allowed
  // to be tried (and visibly flagged) instead of being blocked.
  var MIN_SAMPLES = 5;
  var LOW_SAMPLES = 20;
  // 0.4.1 §一.5: how much the sample set has to grow before the operator is told the learned
  // parameters are worth refreshing. Nothing here trains automatically — 0.3.3 §3.6 is
  // deliberate about that (adding or deleting a sample must not move the detector's numbers
  // behind the operator's back) — so a corpus that has quietly doubled is exactly the case
  // where the numbers on screen are stale and nobody would notice.
  //
  // `learnedParams.sampleCount` is already written by learn.js at training time, so this
  // needs no new field and no new storage key. Pure, so it is unit-testable without a browser
  // — and shared, so the 学习 panel and the settings page cannot disagree about the drift.
  var SAMPLE_DRIFT_RATIO = 0.2;
  function sampleDrift(trainedCount, currentCount) {
    var was = Number(trainedCount) || 0;
    var now = Number(currentCount) || 0;
    // No training run to compare against: the caller shows 尚未学习 instead.
    if (was <= 0) return { grown: false, pct: 0, was: was, now: now };
    if (now < was * (1 + SAMPLE_DRIFT_RATIO)) return { grown: false, pct: 0, was: was, now: now };
    return { grown: true, pct: Math.round((now / was - 1) * 100), was: was, now: now };
  }

  async function loadLearnedParams() {
    var got = null;
    try { got = await api().get(LEARNED_KEY); } catch (e) { got = null; }
    var p = got && got[LEARNED_KEY];
    return (p && typeof p === 'object') ? p : null;
  }

  function saveLearnedParams(p) {
    return enqueue(async function () {
      var put = {}; put[LEARNED_KEY] = p;
      try { await api().set(put); } catch (e) {}
      return p;
    });
  }

  // 0.3.3 §3.6 重置学习: drop the key entirely rather than write defaults, so "never
  // trained" and "trained, then reset" land on the same state and the detector falls
  // back to the compiled-in constants.
  function resetLearnedParams() {
    return enqueue(async function () {
      try { await api().remove(LEARNED_KEY); } catch (e) {}
      return null;
    });
  }

  // ---------- formatting ----------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Timestamps are always rendered in Beijing time, whatever the machine's zone.
  function beijingTime(ts) {
    var d = new Date(ts || Date.now());
    try {
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(d);
      var o = {};
      for (var i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
      return o.year + '-' + o.month + '-' + o.day + ' ' + o.hour + ':' + o.minute;
    } catch (e) {
      var t = new Date(d.getTime() + 8 * 3600 * 1000);
      return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate()) +
             ' ' + pad2(t.getUTCHours()) + ':' + pad2(t.getUTCMinutes());
    }
  }

  function modeLabel(mode) { return mode === 'stepwise' ? T('mode|逐步') : T('mode|全局'); }

  // "PlayerA VS PlayerB  黑72/白85  全局  42手  2026-09-27 14:33"
  // The name pair is dropped entirely when neither side is known.
  //
  // 0.3.6: a name is display text frozen at creation time (nothing matches against it), so it
  // is built in the language active then. `players`, `outcome` and `mode` keep their canonical
  // stored values — only the framing around them is translated.
  function defaultArchiveName(a) {
    var p = a.players || {};
    var pair = '';
    if (p.black && p.white) pair = p.black + ' VS ' + p.white + '  ';
    else if (p.self || p.opponent) pair = (p.self || '?') + ' VS ' + (p.opponent || '?') + '  ';
    // A drawn game has no winner to name, which used to leave the title identical to a game
    // that simply never ended. Saying 和棋 is the whole difference.
    var outcome = a.outcome === 'draw' ? T('archive|和棋') + '  ' : '';
    // 0.3.1: a game detection stopped early on a live four. The suffix is the only place the
    // list shows it without opening the detail, so it has to survive into the name.
    var early = a.terminated ? T('archive|[活四终止] ') : '';
    return pair + early + outcome +
      T('archive|黑') + (a.blackRisk || 0) + '/' + T('archive|白') + (a.whiteRisk || 0) + '  ' +
      modeLabel(a.mode) + '  ' + (a.totalMoves || 0) + T('archive|手') + '  ' +
      beijingTime(a.createdAt);
  }

  // ---------- report slimming ----------
  // bestline is the engine's principal variation — tens of coordinates per candidate
  // that nothing renders. Dropping it keeps a game near 20KB, so 200 games fit in
  // chrome.storage.local's 10MB without requesting unlimitedStorage.
  function slimStep(s) {
    var cands = (s.cands || []).map(function (c) {
      return { move: c.move, winrate: c.winrate, eval: c.eval };
    });
    return {
      moveNo: s.moveNo, side: s.side, source: s.source,
      // The record index this step judged. Without it the replay board can only guess how
      // many stones a step number corresponds to — which is how a 25-move mid-join game
      // ended up drawing the first 13 stones (the order-unknown prefix plus one) instead of
      // all 25. small integer, so it costs nothing to keep.
      i: typeof s.i === 'number' ? s.i : null,
      actual: s.actual, actualStr: s.actualStr,
      best: s.best, bestStr: s.bestStr,
      top1: !!s.top1, top3: !!s.top3, top5: !!s.top5, outsideTop5: !!s.outsideTop5,
      bestWR: s.bestWR, actualWR: s.actualWR, loss: s.loss,
      isSharp: !!s.isSharp, forcedDefense: !!s.forcedDefense, desperate: !!s.desperate,
      // 0.4.2 §2.3: this hand is a deliberate-looking blunder with good hands either side —
      // an evasion. Kept per step so the badge survives a reload and the per-side evasion
      // figures can be recomputed from the archive without re-analysing it.
      evasion: !!s.evasion,
      isOpening: !!s.isOpening, analyzed: !!s.analyzed,
      // 0.3.1: the operator's own mark, set from the viewer on any step. A flagged step is
      // the engine's verdict; a manually-marked one is a human "this looks like AI" — the
      // two are independent and both must survive into the archive.
      manualAI: !!s.manualAI,
      // 0.3.3 C: the feature-library similarity match. Only ever true once 重新学习 has built
      // a library; kept in the archive so the badge survives a reload.
      aiSimilar: !!s.aiSimilar,
      aiSim: s.aiSim == null ? null : s.aiSim,
      orderKnown: s.orderKnown !== false,
      thinkMs: s.thinkMs == null ? null : s.thinkMs,
      budgetMs: s.budgetMs == null ? null : s.budgetMs,
      cands: cands,
      candStrs: cands.map(function (c) {
        return coordStr(c.move) + '(' + (c.winrate != null ? (c.winrate * 100).toFixed(0) + '%' : '?') + ')';
      }),
    };
  }

  var COL = 'abcdefghijklmno';
  function coordStr(p) {
    if (!p || p.length < 2) return '—';
    return COL[p[0]] + (15 - p[1]);
  }

  function slimReport(rep) {
    if (!rep) return null;
    var agg = function (a) {
      if (!a) return null;
      return {
        side: a.side, n: a.n, risk: a.risk, level: a.level,
        top1: a.top1, top3: a.top3, top5: a.top5, meanLoss: a.meanLoss,
        sharpHit: a.sharpHit, sharpCount: a.sharpCount, outTop5: a.outTop5,
        desperateCount: a.desperateCount,
        // 0.4.2 §二: how many of this side's hands were evasions, how regular their rhythm was
        // (0..1), and how many were 将胜乱下. Excluded from n/top1/meanLoss above — that
        // exclusion is the point of the signal, so the totals here and the percentages there
        // deliberately count different hands.
        evasionCount: a.evasionCount || 0,
        winBlunderCount: a.winBlunderCount || 0,
        evasionRegularity: a.evasionRegularity || 0,
        // 0.3.3 C: how many of this side's steps fingerprint-matched a known AI move.
        simCount: a.simCount || 0,
        time: a.time || null,
        contributions: a.contributions || null,
      };
    };
    return {
      createdAt: rep.createdAt || null,
      mode: rep.mode || null,
      suspects: rep.suspect || null,
      // Already-slimmed input (0.3.3's 存档 → 转为样本 path feeds an archive's stored report
      // straight back in) carries these two under their slimmed names, not inside `opts`.
      // Reading both keeps slimReport idempotent instead of silently dropping them.
      optThinkMs: rep.opts ? rep.opts.thinkMs : (rep.optThinkMs != null ? rep.optThinkMs : null),
      openingCutoff: rep.opts ? rep.opts.openingCutoff : (rep.openingCutoff != null ? rep.openingCutoff : null),
      totalMoves: rep.totalMoves || 0,
      scoredCount: rep.scoredCount || 0,
      prejoinCount: rep.prejoinCount || 0,
      // Mid-game join: the board is complete but the first N moves have no recoverable
      // order, so they cannot be scored. Recorded explicitly (not just as a count) so
      // the report, the list and the exports can all say "data incomplete" out loud.
      incomplete: (rep.prejoinCount || 0) > 0,
      orderKnown: rep.orderKnown !== false,
      // Two same-coloured moves in a row: the capture lost or duplicated a stone, so the
      // per-side numbers below are built on a wrong order. Stored so the replay pane can
      // say so instead of presenting them as fact.
      orderSuspect: !!rep.orderSuspect,
      orderIssues: rep.orderIssues || [],
      // 0.3.1 活四停止: when detection stopped early because a live four appeared, the
      // report says where and why. `originalTotalMoves` is the real game length (the board
      // was complete at analysis time); `totalMoves` below is only the hands we actually
      // scored — the two diverge exactly when detection was cut short.
      terminal: rep.terminal || null,
      originalTotalMoves: rep.originalTotalMoves || 0,
      forcedCount: rep.forcedCount || 0,
      hasTime: !!rep.hasTime,
      // Which engine produced these verdicts: a report run on the single-threaded fallback
      // reaches a shallower depth in the same budget, so the two are not comparable and the
      // difference has to survive into the archive.
      engine: rep.engine || null,
      // 0.3.3: which learned parameter set produced the risk numbers, if any. A run on
      // learned weights and a run on the 0.3.1 defaults give different scores for the same
      // game, so an archive has to say which one it came from or the two are
      // indistinguishable in the list.
      learned: rep.learned || null,
      black: agg(rep.black), white: agg(rep.white),
      steps: (rep.steps || []).map(slimStep),
    };
  }

  // ---------- archive assembly ----------
  // 0.4.2 §4.1: the ONE-LEVEL-UP answer, for a capture that pinned 直止/斜止 but not which of
  // the 13 openings it was. `opening` (the code) is null in that case, and without this field
  // the game would be filed under 未识别 even though its family IS known — and the viewer's
  // list badge and its 大类 filter would then disagree. Derived rather than stored blindly, so
  // every reader works on pre-0.4.2 archives too (code only, no `openingFamily`).
  //
  // The two category strings are hardcoded for the same reason `低风险` is a few lines above:
  // storage.js is the shared layer and must not depend on openings.js being loaded.
  function openingFamilyOf(entry) {
    if (entry.openingFamily) return entry.openingFamily;
    if (typeof entry.opening === 'string' && entry.opening) return entry.opening.charAt(0);
    var op = entry.record && entry.record.meta && entry.record.meta.opening;
    if (op && op.stage === 'family') {
      return op.category === '直止' ? 'D' : (op.category === '斜止' ? 'I' : null);
    }
    return null;
  }

  // `record` keeps `prejoin` provenance: those stones must be replayed (the board is
  // complete) but must never be scored.
  function buildArchive(input) {
    var rep = input.report || {};
    var record = input.record || { moves: [], times: [], sources: [] };
    var black = rep.black, white = rep.white;
    // Rounded on the way in: the name, the list and the risk filters all work in whole
    // points, so store the same number the operator actually sees.
    var bRisk = black ? Math.round(black.risk) : 0;
    var wRisk = white ? Math.round(white.risk) : 0;
    var entry = {
      id: input.id || uid(),
      name: '',
      category: input.category || null,
      createdAt: Date.now(),
      mode: input.mode === 'stepwise' ? 'stepwise' : 'global',
      rule: input.rule || (record.meta && record.meta.rule) || 'freestyle',
      suspect: input.suspect || 'both',
      totalMoves: rep.totalMoves || record.moves.length || 0,
      forcedCount: rep.forcedCount || 0,
      outcome: (input.outcome || (record.meta && record.meta.outcome) || 'unknown'),
      // The RIF opening, as the three-character code only ("D1" / "I13"). The name and the
      // family are recoverable from it via GMOpening.byCode(), so storing the full object
      // here would be 40 redundant bytes per game in a store that has no unlimitedStorage.
      // `record.meta.opening` keeps the readable object for the detail view.
      opening: (record.meta && record.meta.opening && record.meta.opening.code) || null,
      // How the operator was logged in when the game was captured (registered / guest /
      // spectator). A guest game used to be indistinguishable from a broken capture, and
      // detection now depends on it, so it is worth the few bytes.
      identity: (record.meta && record.meta.identity) || null,
      // 0.4.1 §三.4: how far the record behind these numbers can be trusted — good / partial /
      // suspect, derived by content.js's toRecord() (or app.js's parseRecord() for an
      // imported one). Lifted out of `record.meta` for the same reason as `identity`: the
      // list draws a badge from it without opening the detail, where a game whose move order
      // is wrong otherwise looks exactly like a clean one. Absent on pre-0.4.1 archives, so
      // every reader has to cope with null.
      quality: (record.meta && record.meta.quality) || null,
      // 0.3.1 活四停止: true when detection was cut short by a live four (report.terminal).
      // Used for the "[活四终止]" name suffix and the "提前终止" filter — a game that was
      // stopped early is a different animal from one that ran to a real end.
      terminated: !!(rep.terminal),
      blackRisk: bRisk,
      whiteRisk: wRisk,
      maxRisk: Math.max(bRisk, wRisk),
      blackLevel: black ? black.level : '低风险',
      whiteLevel: white ? white.level : '低风险',
      players: input.players || { black: null, white: null },
      record: {
        moves: record.moves || [],
        // The colour of each stone. `moves[i]` -> `stones[i]`; kept so the replay board
        // and the per-side grouping use the recorded colour instead of re-deriving it
        // from the index.
        stones: record.stones || [],
        times: record.times || [],
        sources: record.sources || [],
        meta: record.meta || {},
      },
      report: slimReport(rep),
    };
    entry.name = defaultArchiveName(entry);
    // 0.4.2 §4.1: see openingFamilyOf. A family-only capture has `opening: null` (the code IS
    // the name of a specific opening, and there is not one) but a known family, so the list
    // badge can say 直止/斜止 and the 大类 filter can find it.
    entry.openingFamily = openingFamilyOf(entry);
    return entry;
  }

  // ---------- list ordering / filtering (pure) ----------
  // Default three-key sort: AI率 desc -> 步数 desc -> 时间 desc.
  function compareArchives(a, b, key, dir) {
    if (key === 'moves') return (b.totalMoves - a.totalMoves) || (b.createdAt - a.createdAt);
    if (key === 'time') return (b.createdAt - a.createdAt) || (b.maxRisk - a.maxRisk);
    if (key === 'risk') return (b.maxRisk - a.maxRisk) || (b.totalMoves - a.totalMoves) || (b.createdAt - a.createdAt);
    // automatic (three keys, no explicit choice)
    return (b.maxRisk - a.maxRisk) || (b.totalMoves - a.totalMoves) || (b.createdAt - a.createdAt);
  }

  function sortArchives(list, key, dir) {
    var sorted = list.slice().sort(function (a, b) { return compareArchives(a, b, key); });
    if (dir === 'asc') sorted.reverse();
    return sorted;
  }

  var AGE_BUCKETS = [
    { id: '10min', label: '<10min', ms: 10 * 60 * 1000 },
    { id: '1h', label: '<1h', ms: 60 * 60 * 1000 },
    { id: '12h', label: '<12h', ms: 12 * 60 * 60 * 1000 },
    { id: '1d', label: '<1d', ms: 24 * 60 * 60 * 1000 },
    { id: '1w', label: '<1w', ms: 7 * 24 * 60 * 60 * 1000 },
    { id: 'old', label: '>1w', ms: Infinity },
  ];

  // Filter spec (all optional, all ANDed):
  //   riskMin/riskMax  0..100 applied to the selected risk field
  //   riskField        'max' | 'any' | 'black' | 'white'  (default 'max')
  //   movesMin/movesMax
  //   ageId            one of AGE_BUCKETS ids, or 'custom' with ageFrom/ageTo (ms ago)
  //   category         null (all) | '__none__' | a category string
  //   mode             'all' | 'global' | 'stepwise'
  //   rule             'all' | 'freestyle' | 'renju'
  //   opening          null (all) | '__none__' (未识别) | 'D'/'I' (whole family) | 'D1'…
  function filterArchives(list, f) {
    f = f || {};
    var now = Date.now();
    return list.filter(function (a) {
      if (f.riskMin != null || f.riskMax != null) {
        var field = f.riskField || 'max';
        var v = field === 'any' ? Math.max(a.blackRisk || 0, a.whiteRisk || 0)
              : field === 'black' ? (a.blackRisk || 0)
              : field === 'white' ? (a.whiteRisk || 0)
              : (a.maxRisk || 0);
        if (f.riskMin != null && v < f.riskMin) return false;
        if (f.riskMax != null && v > f.riskMax) return false;
      }
      if (f.movesMin != null && (a.totalMoves || 0) < f.movesMin) return false;
      if (f.movesMax != null && (a.totalMoves || 0) > f.movesMax) return false;

      if (f.ageId) {
        var age = now - (a.createdAt || 0);
        if (f.ageId === 'custom') {
          if (f.ageFrom != null && age < f.ageFrom) return false;   // 更久远 => 过滤掉
          if (f.ageTo != null && age > f.ageTo) return false;       // 太久远 => 过滤掉
        } else {
          var b = null;
          for (var i = 0; i < AGE_BUCKETS.length; i++) if (AGE_BUCKETS[i].id === f.ageId) b = AGE_BUCKETS[i];
          if (b) {
            // "X" bucket means "more recent than X", except the last one which is older.
            if (b.id === 'old') { if (age <= AGE_BUCKETS[AGE_BUCKETS.length - 2].ms) return false; }
            else if (age >= b.ms) return false;
          }
        }
      }

      if (f.category) {
        if (f.category === '__none__') { if (a.category) return false; }
        else if (a.category !== f.category) return false;
      }
      if (f.mode && f.mode !== 'all' && a.mode !== f.mode) return false;
      if (f.rule && f.rule !== 'all' && a.rule !== f.rule) return false;
      // 0.3.1 提前终止: 'yes' keeps only 活四停止 games, 'no' keeps only full ones.
      if (f.terminated === 'yes' && !a.terminated) return false;
      if (f.terminated === 'no' && a.terminated) return false;
      // Three levels of one field: the family ("D" 直止 / "I" 斜止) is a prefix of the code,
      // so the whole-family case is a prefix test and the single-opening case an equality.
      // 0.4.2 §4.1: a family-only capture has no code but does have a family, so it belongs in
      // the 大类 filter and does NOT belong in 未识别 — `openingFamily` is what makes those
      // two answers agree with the badge the list draws.
      if (f.opening) {
        if (f.opening === '__none__') { if (a.opening || a.openingFamily) return false; }
        else if (f.opening.length === 1) {
          if ((a.opening || a.openingFamily || '').charAt(0) !== f.opening) return false;
        } else if (a.opening !== f.opening) return false;
      }
      return true;
    });
  }

  function countActiveFilters(f) {
    f = f || {};
    var n = 0;
    if (f.riskMin != null || f.riskMax != null) n++;
    if (f.movesMin != null || f.movesMax != null) n++;
    if (f.ageId) n++;
    if (f.category) n++;
    if (f.mode && f.mode !== 'all') n++;
    if (f.rule && f.rule !== 'all') n++;
    if (f.terminated) n++;
    if (f.opening) n++;
    return n;
  }

  g.GMStorage = {
    DEFAULTS: DEFAULTS,
    MAX_ARCHIVES: MAX_ARCHIVES,
    MAX_SAMPLES: MAX_SAMPLES,
    AGE_BUCKETS: AGE_BUCKETS,
    PRESET_TAGS: PRESET_TAGS,
    ANN_LABELS: ANN_LABELS,
    ANN_BTN: ANN_BTN,
    MAX_NOTE_LEN: MAX_NOTE_LEN,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    MIN_SAMPLES: MIN_SAMPLES,
    LOW_SAMPLES: LOW_SAMPLES,
    SAMPLE_DRIFT_RATIO: SAMPLE_DRIFT_RATIO,
    sampleDrift: sampleDrift,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    saveSetting: saveSetting,
    defaults: defaults,
    clampMinMoves: clampMinMoves,
    MIN_MOVES_LO: MIN_MOVES_LO,
    MIN_MOVES_HI: MIN_MOVES_HI,
    clampThreadNum: clampThreadNum,
    THREADS_HI: THREADS_HI,
    detectedThreads: detectedThreads,
    DEFAULT_OVERLAY: DEFAULT_OVERLAY,
    loadOverlay: loadOverlay,
    saveOverlay: saveOverlay,
    overlayDefaults: overlayDefaults,
    // ---- 0.4.0 §一 remote update check ----
    UPDATE_REPO: UPDATE_REPO,
    UPDATE_SOURCE: UPDATE_SOURCE,
    UPDATE_FALLBACK: UPDATE_FALLBACK,
    UPDATE_RELEASES: UPDATE_RELEASES,
    UPDATE_ZIP: UPDATE_ZIP,
    UPDATE_INTERVAL_MS: UPDATE_INTERVAL_MS,
    UPDATE_DISMISS_MS: UPDATE_DISMISS_MS,
    compareVersion: compareVersion,
    loadUpdateInfo: loadUpdateInfo,
    saveUpdateInfo: saveUpdateInfo,
    loadUpdateDismissed: loadUpdateDismissed,
    dismissUpdate: dismissUpdate,
    isUpdateDismissed: isUpdateDismissed,
    pendingUpdate: pendingUpdate,
    loadArchives: loadArchives,
    saveArchive: saveArchive,
    deleteArchive: deleteArchive,
    renameArchive: renameArchive,
    categorizeArchive: categorizeArchive,
    listCategories: listCategories,
    renameCategory: renameCategory,
    deleteCategory: deleteCategory,
    // 0.3.5 §3.3 batch + import/export
    deleteArchives: deleteArchives,
    setArchivesCategory: setArchivesCategory,
    renameArchives: renameArchives,
    importArchives: importArchives,
    normalizeArchive: normalizeArchive,
    pruneArchives: pruneArchives,
    buildArchive: buildArchive,
    slimReport: slimReport,
    defaultArchiveName: defaultArchiveName,
    beijingTime: beijingTime,
    modeLabel: modeLabel,
    coordStr: coordStr,
    sortArchives: sortArchives,
    compareArchives: compareArchives,
    filterArchives: filterArchives,
    countActiveFilters: countActiveFilters,
    uid: uid,
    // ---- 0.3.3 sample library ----
    sampleUid: sampleUid,
    loadSamples: loadSamples,
    loadSample: loadSample,
    saveSample: saveSample,
    deleteSample: deleteSample,
    // 0.3.4 batch (one write per action, not one per item)
    deleteSamples: deleteSamples,
    setSamplesTags: setSamplesTags,
    importSamples: importSamples,
    normalizeSample: normalizeSample,
    renameSample: renameSample,
    setSampleTags: setSampleTags,
    toggleSampleLabel: toggleSampleLabel,
    setSampleNote: setSampleNote,
    annotationsOf: annotationsOf,
    migrateAnnotations: migrateAnnotations,
    sampleLabels: sampleLabels,
    countAnnotated: countAnnotated,
    listSampleTags: listSampleTags,
    defaultSampleName: defaultSampleName,
    buildSample: buildSample,
    sortSamples: sortSamples,
    compareSamples: compareSamples,
    filterSamples: filterSamples,
    countActiveSampleFilters: countActiveSampleFilters,
    // ---- 0.3.3 learned params ----
    loadLearnedParams: loadLearnedParams,
    saveLearnedParams: saveLearnedParams,
    resetLearnedParams: resetLearnedParams,
    __memApi: memApi,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMStorage;
})(typeof globalThis !== 'undefined' ? globalThis : self);
