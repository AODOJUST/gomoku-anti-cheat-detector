/* 0.5.1 §2.1.2 — the engine registry.
 *
 * Two questions, deliberately kept apart. Fusing them is what made the 0.5.0 定稿's sketch
 * unbuildable, so they get separate fields:
 *
 *   kind      HOW the engine is hosted
 *             'wasm'  a JS+WASM bundle inside this extension, run by worker.js
 *             'http'  a server the operator points us at
 *   protocol  WHAT we say to it
 *             'yxboard'     Rapfi's `YXBOARD x,y,side … DONE` + `YXNBEST n`
 *             'gtp'         Go Text Protocol — `clear_board` / `play B Q16` /
 *                           `kata-genmove_analyze`, plus the gomoku extensions
 *                           `kata-set-rule {freestyle|standard|renju}` and
 *                           `kata-set-board-size`.
 *             'katago-json' KataGo's analysis-engine JSON: the one wire format that already has
 *                           running server implementations in the wild, so an operator can put
 *                           KataGomo behind it without inventing anything.
 *
 * ── Why KataGomo is 'http' and not the 'wasm' the 定稿 sketched ──
 * The 定稿 registered it as `kind: 'wasm'`, `protocol: 'gtp'`, with two
 * `engine/katagomo-*-simd128.js` builds. Those files cannot exist. hzyhhzy/KataGomo is a fork of
 * KataGo — C++/CUDA MCTS with an ONNX/TensorRT backend — and its releases ship native
 * Windows/Linux binaries plus `.bin.gz` neural nets (`KatagomoConnect6_20260406.7z`,
 * `KataGomoku3d_20260620.zip`, …). There is no WASM target and no road to one. The 定稿's own
 * §2.1.1 fallback therefore applies ("若 KataGomo 无 WASM 构建 → 只能作为服务端引擎"), and the
 * operator confirmed it on 2026-10-01: KataGomo arrives over HTTP.
 *
 * The 'gtp' protocol is still implemented (app.js `_configureGTP` / `_searchGTP`) and still
 * exercised by the suite against a stub worker — the transcript it builds is a pure function of
 * the position, so it can be verified without an engine. It is simply not attached to any
 * engine yet. Attaching it to one that cannot run would create exactly the failure this project
 * has paid for three times: two spellings of one answer, one of them never executed.
 */
(function (g) {
  'use strict';
  if (g.GMEngines) return;

  var DEFAULT_ID = 'rapfi';

  // The Rapfi build order (multi-threaded first; see app.js for the measurements behind it).
  // Written here rather than in app.js because a custom model reuses these builds with a
  // different weight package, so the list has to be reachable from the registry.
  var RAPFI_BUILDS = [
    'engine/rapfi-multi-simd128.js',
    'engine/rapfi-multi.js',
    'engine/rapfi-single-simd128.js',
    'engine/rapfi-single.js',
  ];

  var OFFICIAL = {
    rapfi: {
      id: 'rapfi',
      name: 'Rapfi',
      kind: 'wasm',
      protocol: 'yxboard',
      builds: RAPFI_BUILDS.slice(),
      official: true,
      custom: false,
    },
    katagomo: {
      id: 'katagomo',
      name: 'KataGomo',
      kind: 'http',
      protocol: 'katago-json',
      // No `builds`: see the header. Nothing here can be loaded from the package.
      official: true,
      custom: false,
    },
  };

  // id -> { id, name, dataId, fileName, size, addedAt }. Registered from IndexedDB records by
  // whichever extension context has them (offscreen.js for the engine, viewer.js for the
  // settings panel, content.js for the picker — a content script's IndexedDB belongs to the
  // PAGE, so it can only ever learn about them through a message).
  var customs = {};

  // The operator's server address, pushed in by whoever reads settings. Kept as a plain string
  // here so this file stays free of storage and stays loadable in all three worlds.
  var httpBase = '';

  // `http://127.0.0.1:2718` and `http://127.0.0.1:2718/` both mean "the server root"; anything
  // with a path is taken literally, so an operator whose endpoint is `/select-move/rapfi` is
  // not second-guessed. The default path is the one the de-facto REST implementation uses.
  function analysisEndpoint(base) {
    var u = String(base == null ? '' : base).trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) return '';
    if (/^https?:\/\/[^/]+\/?$/i.test(u)) return u.replace(/\/+$/, '') + '/api/v1/analysis';
    return u;
  }

  function normalizeBase(base) {
    var u = String(base == null ? '' : base).trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) return '';
    return u;
  }

  // A custom model is a WEIGHT PACKAGE for the Rapfi build, not a new engine binary: MV3's
  // extension CSP allows no script source but 'self' and 'wasm-unsafe-eval', so a user-supplied
  // `.js` could only be run through `new Worker(blob:)` — a path Chromium currently permits via
  // its blob inner-URL check but which the spec does not (crbug 40945262). A `.data` package
  // needs none of that: it is `fetch`ed by the emscripten runtime, and fetch is unrestricted.
  // So the compose below IS the definition of "custom engine".
  // §2.2.4 — what to CALL a custom model, resolved in exactly one place: the operator's name,
  // then the file name, then 「自定义模型 N」. Four surfaces render this name (the panel's menu,
  // the viewer's three dropdowns, the settings list, and the fallback notice), and four copies of
  // a fallback chain is how one of them ends up saying `custom-3` while the others say a name.
  //
  // The N is the SLOT, which is what `custom-engine.js`'s free-slot allocation exists for: an id
  // is an allocation slot, not a name, and a profile that deleted and re-added a model should not
  // be told its only model is number 7.
  //
  // GMI18n is absent under Node (the suites load this file directly), hence the literal fallback
  // — which is also the zh-CN text, so a context without i18n still reads correctly.
  function customName(rec) {
    if (rec.name) return rec.name;
    if (rec.fileName) return rec.fileName;
    var n = slot(rec.id);
    if (typeof GMI18n !== 'undefined' && GMI18n && GMI18n.t) {
      return GMI18n.t('viewer|自定义模型 {n}', { n: n });
    }
    return '自定义模型 ' + n;
  }

  function composeCustom(rec) {
    return {
      id: rec.id,
      // Never empty: the caller may pass '' and customName() still produces a label.
      name: customName(rec),
      kind: 'wasm',
      protocol: 'yxboard',
      builds: RAPFI_BUILDS.slice(),
      official: false,
      custom: true,
      dataId: rec.dataId || rec.id,
      fileName: rec.fileName || '',
      size: rec.size || 0,
    };
  }

  function get(id) {
    if (OFFICIAL[id]) {
      var cfg = OFFICIAL[id];
      // http engines carry the address live: the operator can retype it without a reload, and
      // an engine object that had cached the old one would keep talking to the old server.
      if (cfg.kind === 'http') {
        return {
          id: cfg.id, name: cfg.name, kind: cfg.kind, protocol: cfg.protocol,
          official: true, custom: false, url: analysisEndpoint(httpBase), base: httpBase,
        };
      }
      return {
        id: cfg.id, name: cfg.name, kind: cfg.kind, protocol: cfg.protocol,
        official: true, custom: false, builds: cfg.builds.slice(),
      };
    }
    var rec = customs[id];
    return rec ? composeCustom(rec) : null;
  }

  // Registration order is `custom-1, custom-2, …` — the ids are allocation slots, and sorting
  // them as strings would put `custom-10` before `custom-2`. The slot numbers are kept small
  // by reusing freed ones (see custom-engine.js), so this stays a nicety rather than a fix.
  function list() {
    return Object.keys(OFFICIAL).map(get).filter(Boolean)
      .concat(customList());
  }

  function customList() {
    return Object.keys(customs)
      .sort(function (a, b) { return slot(a) - slot(b); })
      .map(function (id) { return composeCustom(customs[id]); });
  }

  function slot(id) {
    var m = /^custom-(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) : 0;
  }

  function register(rec) {
    if (!rec || !rec.id) return null;
    customs[rec.id] = {
      id: rec.id,
      name: rec.name || '',
      dataId: rec.dataId || rec.id,
      fileName: rec.fileName || '',
      size: rec.size || 0,
      addedAt: rec.addedAt || 0,
    };
    return get(rec.id);
  }

  function unregister(id) { delete customs[id]; }

  // Drop every custom registration and re-add the given records. Used when the list is
  // refreshed from storage — a plain loop of `register` would leave a removed model behind.
  function sync(recs) {
    customs = {};
    (recs || []).forEach(register);
    return customList();
  }

  function setHttpBase(url) { httpBase = normalizeBase(url); }
  function httpUrl() { return analysisEndpoint(httpBase); }

  // "Is this engine usable right now" — asked by the picker (to grey an option out) and by the
  // fallback chain (to skip a hopeless candidate without a failed request). Rapfi is always
  // present as a package file; an http engine needs an address.
  function usable(id) {
    var cfg = get(id);
    if (!cfg) return false;
    if (cfg.kind === 'http') return !!cfg.url;
    return true;
  }

  function isOfficial(id) { return !!OFFICIAL[id]; }

  g.GMEngines = {
    DEFAULT_ID: DEFAULT_ID,
    RAPFI_BUILDS: RAPFI_BUILDS.slice(),
    get: get,
    list: list,
    register: register,
    unregister: unregister,
    sync: sync,
    customs: customList,
    isOfficial: isOfficial,
    usable: usable,
    customName: customName,
    // A MIRROR: `custom-engine.js` has the same regex, because the store needs the slot to pick a
    // free id and this file needs it to sort and to build the default name. Exported so the suite
    // can assert the two agree — a mirror whose other half is unreachable is not checkable, which
    // is how this project's two previous mirror pairs drifted.
    slot: slot,
    setHttpBase: setHttpBase,
    httpUrl: httpUrl,
    analysisEndpoint: analysisEndpoint,
    normalizeBase: normalizeBase,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);

// Node test hook (no-op in a browser). The suites load this file before app.js so that the
// registry exists as a global by the time app.js's engine wrapper reads it.
if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.GMEngines;
