// Service worker. Two jobs: own the offscreen document, and open the viewer page.
//
// MV3 constraint that forced this design: a content script belongs to the PAGE's
// origin, so `new Worker(chrome.runtime.getURL('worker.js'))` throws
// "Script at 'chrome-extension://<id>/worker.js' cannot be accessed from origin
// 'https://gomoku.com'". Only an extension-origin page may spawn a worker from an
// extension URL — hence the offscreen document.
'use strict';

// ---- 0.3.6 §1.2: the language switch that lives on the toolbar icon ----
// One of the two switch entry points (the other is the viewer's settings dropdown). The
// manifest action has no default_popup, so a right-click on the icon is free for a menu.
//
// i18n.js and the eight locale tables are pulled in with importScripts rather than
// reimplemented, because the PARENT title has to be localised (「语言」/「Language」/…). The
// eight child titles are endonyms — 「日本語」 reads 「日本語」 under every UI language — so they
// come from the tables too, but every table holds the same eight strings.
importScripts('i18n.js',
  'locale/zh-CN.js', 'locale/zh-TW.js', 'locale/ja.js', 'locale/ko.js',
  'locale/en.js', 'locale/ru.js', 'locale/fr.js', 'locale/de.js',
  'locale/vi.js', 'locale/es.js', 'locale/es-MX.js', 'locale/ms.js', 'locale/ar.js', 'locale/mn.js',
  'locale/lzh.js',
  'llm.js',
  'storage.js');

// 0.5.1 §2.2 — custom-engine.js is here so this worker can answer "which custom models exist?"
// for the on-page panel. The panel cannot read it itself: a content script's `indexedDB` is the
// HOST PAGE's storage, not the extension's. The worker runs on the extension origin, so it sees
// the same database the offscreen document and the viewer write.
importScripts('custom-engine.js');

// 0.5.2 §2.1 — 一键更新. Loaded here because `chrome.downloads` is not exposed to content
// scripts at all, so the panel's button has to be answered from the worker. The viewer page
// could call it directly (it is an extension page), but routing BOTH through the same message
// keeps one implementation — the same reason the update CHECK is routed here (see the
// gm-check-update handler below).
importScripts('update.js');

// 1.0.6 四号 §一.4.1 — 平台痕迹. `cloud.js` and `platform.js` are what the report verb needs (the
// shared block for the platform values, the cloud seam for the POST, the verb itself), and
// `community-shared.js` must precede `platform.js` — see `platform.js`'s header on why a missing
// shared block is a loud failure rather than a guessed literal. None of the three touches a DOM.
importScripts('community-shared.js', 'cloud.js', 'platform.js');

// 0.4.8 §2 — chrome.storage.session defaults to TRUSTED_CONTEXTS only, so a content script
// cannot see it at all. Opening it to content scripts is what makes the §2 migration real;
// without this call content.js's sessionArea() finds no `session` area, and since 1.0.5
// (audit P3) that means the state stays in MEMORY — it is no longer written to `local`, which
// was the on-disk behaviour §2 is moving away from. Runs at worker start (this file is a
// module-scope script), so it is re-applied after every teardown.
try {
  if (chrome.storage && chrome.storage.session && chrome.storage.session.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  }
} catch (e) { /* older Chrome — content.js keeps that state in memory and still works */ }

var LANG_MENU = 'gm-lang';
var LANG_PREFIX = LANG_MENU + ':';

function createMenu(props) {
  try {
    var p = chrome.contextMenus.create(props);
    if (p && p.catch) p.catch(function () {});
  } catch (e) { /* duplicate id during a fast reload — harmless */ }
}

function updateMenu(id, props) {
  try {
    var p = chrome.contextMenus.update(id, props);
    if (p && p.catch) p.catch(function () {});
  } catch (e) { /* the menu was not built yet */ }
}

// `setting` is the raw stored value ('auto' or a locale code); everything downstream works
// with the resolved locale, which is what the radio checkmark and the parent title follow.
function buildLangMenu(setting) {
  var lang = GMI18n.resolveLang(setting);
  GMI18n.setLocale(lang);   // setLocale no-ops on the DOM here — a worker has none
  chrome.contextMenus.removeAll(function () {
    createMenu({ id: LANG_MENU, title: GMI18n.t('menu.lang'), contexts: ['action'] });
    GMI18n.LOCALES.forEach(function (code) {
      createMenu({
        id: LANG_PREFIX + code,
        parentId: LANG_MENU,
        // 0.4.6 §2.4 — same label format as the panel and the viewer dropdown: 「English（英语）」.
        // The context menu is where it matters most, because a submenu of thirteen endonyms is
        // the one place the operator cannot see which language they are reading it in.
        title: GMI18n.langLabel(code),
        type: 'radio',
        checked: code === lang,
        contexts: ['action'],
      });
    });
  });
}

// Menus survive a service-worker teardown, so they are built on install/update only. The
// title refresh also runs on startup, because `settings` may have changed while this worker
// was asleep (a language picked in the viewer, or a storage sync from another machine).
chrome.runtime.onInstalled.addListener(function () {
  GMStorage.loadSettings().then(
    function (s) { buildLangMenu(s && s.lang); },
    function () { buildLangMenu('auto'); }
  );
  scheduleUpdateCheck();
});

chrome.runtime.onStartup.addListener(function () {
  GMStorage.loadSettings().then(
    function (s) { buildLangMenu(s && s.lang); },
    function () { buildLangMenu('auto'); }
  );
  scheduleUpdateCheck();
  reportPlatform();
});

// ---- 1.0.6 四号 §一.4.1 「每次启动扩展」 ---------------------------------------------------------
// The report itself is ONE implementation, in `platform.js` — loaded here rather than re-written,
// because a worker that POSTed its own hand-built body would be the second spelling of a wire
// contract, and the failure would be invisible (a census that is quietly short).
//
// ⚠ THE WORKER IS A SEPARATE GLOBAL SCOPE, which is the whole reason `platform.js` exists as a file:
// `GMAuth`, `GMCommunity`, the viewer's DOM — none of it is reachable from here. `importScripts` is
// the only way in, and these three modules are what the verb needs: the shared block (the platform
// values), the cloud seam (the POST), and the verb. `storage.js` is already imported above, so the
// session read inside `reportExtension()` works here.
//
// ⚠ FIRE-AND-FORGET, AND THAT IS THE DESIGN. `onStartup` fires on a cold profile start, often before
// the network is up; `report()` never rejects and its answer is not consulted. The same 30-minute
// server-side throttle that makes a reload harmless makes a failed startup report harmless too —
// the next boot, login or viewer open reports again.
function reportPlatform() {
  // The guard is belt and braces: `importScripts` is synchronous, so `GMPlatform` exists by the time
  // this runs. It is here so that a module that failed to load leaves the worker working rather than
  // throwing inside a startup listener — the one failure mode that would look like 「扩展坏了」.
  if (typeof GMPlatform === 'undefined' || !GMPlatform) return;
  try {
    GMPlatform.reportExtension().catch(function () {});
  } catch (e) { /* a census must never break the worker's startup */ }
}

chrome.contextMenus.onClicked.addListener(function (info) {
  var id = String((info && info.menuItemId) || '');
  if (id.indexOf(LANG_PREFIX) !== 0) return;
  // background.js only writes the setting; the repaint is driven by the storage.onChanged
  // broadcast that every surface listens to (§1.8), so nothing here has to know who is open.
  GMStorage.saveSetting('lang', id.slice(LANG_PREFIX.length)).catch(function () {});
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes || !changes.settings) return;
  var lang = GMI18n.resolveLang(changes.settings.newValue && changes.settings.newValue.lang);
  GMI18n.setLocale(lang);
  updateMenu(LANG_MENU, { title: GMI18n.t('menu.lang') });
  GMI18n.LOCALES.forEach(function (code) {
    // 0.4.6 §2.4 — the title is refreshed too, not just the checkmark. `langLabel()` renders
    // 「English（英语）」, whose parenthetical is written in the CURRENT language, so every label
    // changes when the language does. Leaving the old titles in place would keep the menu in the
    // language the operator just switched away from until the next service-worker restart.
    updateMenu(LANG_PREFIX + code, { checked: code === lang, title: GMI18n.langLabel(code) });
  });
});

// ---- 0.4.0 §一: remote update check ----
// `chrome.runtime.requestUpdateCheck()` is deliberately NOT used: it answers only for
// Chrome Web Store installs, and this extension is loaded unpacked from a GitHub repository,
// where it would report "no update" forever. Instead the newest version is read from
// `version.json` in the repository root (which IS this directory — see storage.js, where the
// URLs and the version comparison live so both this worker and the viewer share one copy).
//
// The fetch is best-effort in every direction: it never throws into a caller, a failure
// writes nothing, and the only thing the operator sees on a failure is the manual button's
// own status line.
var UPDATE_DELAY_MS = 5000;   // §一.3 — let the engine load and the panel paint first
// §一.6 requires a failed check to be silent and NON-BLOCKING. A network that neither answers
// nor refuses (a dropped route, a captive portal, a corporate proxy that black-holes the host)
// leaves `fetch` pending indefinitely — and on the manual path that pins the button at
// 「检测中…」 forever, which is the opposite of silent. So every request gets a deadline.
var UPDATE_TIMEOUT_MS = 8000;

// 0.5.1 §2.1.3 — the KataGomo HTTP call, relayed for the same reason as gm-llm above: the
// request has to originate from the extension origin. The body is already the exact JSON the
// KataGo analysis engine parses (app.js `buildKatagoRequest`), so this forwards it untouched —
// a second place that shaped the request would be a second answer to what the wire format is.
//
// The caller enforces its own deadline; the one here is a backstop for a server that accepts the
// connection and then says nothing, which would otherwise hold the service worker open for as
// long as the socket lives.
function engineHttp(msg) {
  var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  var budget = Math.max(1000, Math.min(600000, parseInt(msg.timeoutMs, 10) || 60000));
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, budget + 2000);
  var opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg.body),
  };
  if (ctl) opts.signal = ctl.signal;
  return fetch(msg.url, opts).then(function (res) {
    return res.text().then(function (text) {
      clearTimeout(timer);
      // A non-2xx is still worth showing. Both the analysis engine and the REST servers in front
      // of it answer with a body naming the field that was wrong, and that text is what
      // §2.2.3's 「验证失败时显示明确错误」 has to put on screen — "HTTP 400" alone would send the
      // operator looking in the wrong place.
      if (!res.ok) {
        return {
          ok: false, status: res.status,
          error: 'HTTP ' + res.status + (text ? ': ' + String(text).slice(0, 300) : ''),
        };
      }
      return { ok: true, status: res.status, text: text };
    });
  }, function (e) {
    clearTimeout(timer);
    // A missing host permission lands here as an opaque network error, and it is by far the most
    // likely failure on first use — the operator typed an address and granted nothing. Say what
    // it actually is, because "Failed to fetch" points at the wrong thing entirely.
    var m = String((e && e.message) || e);
    if (/Failed to fetch|NetworkError|load failed/i.test(m)) {
      m = 'fetch failed — is the server running, and did you grant access to ' + msg.url + '?';
    }
    throw new Error(m);
  });
}

function fetchJson(url) {
  // `cache: 'no-store'` plus a cache-busting query: raw.githubusercontent.com is served
  // through a CDN with a few minutes of edge caching, and a stale copy of version.json is
  // exactly the bug this feature exists to avoid.
  var bust = url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, UPDATE_TIMEOUT_MS);
  var opts = { cache: 'no-store' };
  if (ctl) opts.signal = ctl.signal;
  return fetch(bust, opts).then(function (res) {
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    return res.json();
  }).then(function (v) {
    clearTimeout(timer);
    return v;
  }, function (e) {
    clearTimeout(timer);
    throw e;
  });
}

// §一.2's fallback path: the repository's own manifest.json carries a version even when
// nobody remembered to bump version.json. It has no notes or download link, so those are
// synthesised from the repository URL rather than left blank in the banner.
function fromManifest(mf) {
  return {
    version: String((mf && mf.version) || ''),
    releaseNotes: '',
    downloadUrl: GMStorage.UPDATE_ZIP,
    releaseUrl: GMStorage.UPDATE_RELEASES,
  };
}

function normalizeRemote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var version = String(raw.version || '').trim();
  if (!version) return null;
  return {
    version: version,
    releaseNotes: String(raw.releaseNotes || raw.notes || ''),
    downloadUrl: String(raw.downloadUrl || GMStorage.UPDATE_ZIP),
    releaseUrl: String(raw.releaseUrl || raw.url || GMStorage.UPDATE_RELEASES),
  };
}

// `force` skips the 12-hour throttle — that is the manual button (§一.3).
async function checkForUpdate(force) {
  var current = chrome.runtime.getManifest().version;

  if (!force) {
    var prev = await GMStorage.loadUpdateInfo();
    if (prev && prev.checkedAt && (Date.now() - prev.checkedAt) < GMStorage.UPDATE_INTERVAL_MS) {
      return { ok: true, skipped: true, info: prev };
    }
  }

  var remote = null;
  try {
    remote = normalizeRemote(await fetchJson(GMStorage.UPDATE_SOURCE));
  } catch (e) { /* try the fallback below */ }
  if (!remote) {
    try { remote = normalizeRemote(fromManifest(await fetchJson(GMStorage.UPDATE_FALLBACK))); }
    catch (e) { remote = null; }
  }

  if (!remote) {
    // §一.6: silent on the automatic path. The manual path gets the reason so the settings
    // page can say 「检测失败」 instead of appearing to do nothing.
    return { ok: false, error: 'unreachable', currentVersion: current };
  }

  var info = {
    available: GMStorage.compareVersion(remote.version, current) > 0,
    latestVersion: remote.version,
    currentVersion: current,
    releaseNotes: remote.releaseNotes,
    downloadUrl: remote.downloadUrl,
    releaseUrl: remote.releaseUrl,
    checkedAt: Date.now(),
  };
  await GMStorage.saveUpdateInfo(info);
  return { ok: true, info: info };
}

function scheduleUpdateCheck() {
  // 5s is far inside the service worker's idle window, so the timer fires even though a
  // bare setTimeout does not by itself keep the worker alive.
  setTimeout(function () { checkForUpdate(false).catch(function () {}); }, UPDATE_DELAY_MS);
}

var creating = null;

function openViewer() {
  // viewer.html replaces the retired localhost page. The manifest action has no
  // default_popup, so clicking the toolbar icon lands here instead of opening a
  // cramped popup the replay list would not fit into.
  return chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
}

async function hasOffscreen() {
  // Chrome/Edge 116+. Below that there is no way to ASK, so this returns false and
  // ensureOffscreen() falls through to the create-and-swallow path below: the document already
  // exists, createDocument rejects with "Only a single offscreen document may be created", and
  // the regex there ignores exactly that message. That is the documented fallback for
  // 109–115 — which is why manifest.json declares `minimum_chrome_version: "109"` (0.4.11
  // §一.9): below 109 `chrome.offscreen` does not exist at all and every engine call would
  // fail with a raw English `chrome.runtime.lastError`.
  if (!chrome.runtime.getContexts) return false;
  try {
    var contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch (e) {
    return false;
  }
}

function ensureOffscreen() {
  if (creating) return creating;

  creating = (async function () {
    // Recreate when the browser has evicted the previous document (they are not
    // guaranteed to live forever), so analysis can be retried from a cold start.
    if (await hasOffscreen()) return;

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification:
          'Run the Rapfi WASM check engine in a Web Worker. Content scripts cannot construct workers from extension URLs.',
      });
    } catch (e) {
      // "Only a single offscreen document may be created" — a concurrent call won.
      var message = String((e && e.message) || e);
      if (!/single offscreen|already exists|Only a single/i.test(message)) throw e;
    }
  })().finally(function () { creating = null; });

  return creating;
}

// 0.2.3 splits the icon's job in two. On a gomoku.com tab the panel is the thing the
// operator is most likely missing — either they hit `×` or `—`, or the page was loaded
// without it. So a click first asks that tab to bring the panel back, and only falls
// through to the viewer when there was nothing to restore (the panel was already up).
async function onClicked(tab) {
  var url = (tab && tab.url) || '';
  if (/^https?:\/\/(www\.)?gomoku\.com\//.test(url) && tab.id != null) {
    try {
      var res = await chrome.tabs.sendMessage(tab.id, { type: 'gm-restore-panel' });
      if (res && res.restored) return;
    } catch (e) {
      // No content script (extension just reloaded, page not refreshed yet): the viewer
      // is the useful thing to open, since the panel cannot be reached from here.
    }
  }
  return openViewer();
}

chrome.action.onClicked.addListener(function (tab) {
  onClicked(tab).catch(function () {});
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;

  // 0.4.0 §一.3 — the settings page's「检测更新」button. Routed through the worker rather than
  // fetched in the page so there is exactly one implementation of the check, and so the
  // result lands in `updateInfo` for the banner to pick up on every other surface.
  if (msg.type === 'gm-check-update') {
    checkForUpdate(true)
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  // 0.4.4 §十七 — the LLM call. It has to live in the worker: a content script's `fetch` is
  // bound to the PAGE's origin (Chrome 85+), so a request to api.openai.com from there is a
  // cross-origin request the provider answers without CORS headers, and it fails. The worker
  // runs on the extension origin and holds the optional host permission, so the same request
  // succeeds. `GMLLM.fetchDirect` is the single implementation — this handler only relays.
  if (msg.type === 'gm-llm') {
    GMLLM.fetchDirect(msg.prompt, msg.opts || {})
      .then(function (text) { sendResponse({ ok: true, text: text }); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  // 0.5.1 §2.2 — the panel's model picker. Answered from here rather than from the offscreen
  // document so it works before any engine has been warmed up (which is exactly when the
  // operator is most likely to be choosing one).
  if (msg.type === 'gm-engine-list') {
    var send = function (models, error) { sendResponse({ ok: !error, models: models || [], error: error || '' }); };
    try {
      GMCustomEngines.list().then(function (rows) { send(rows); },
        function (e) { send([], String((e && e.message) || e)); });
    } catch (e) { send([], String((e && e.message) || e)); }
    return true;
  }

  // 0.5.1 §2.1.3 — the KataGomo HTTP call. Relayed for the same reason as the LLM call above,
  // and it is the same single-exit rule: the body is already the exact JSON the analysis engine
  // parses, so this handler forwards it untouched.
  if (msg.type === 'gm-engine-http') {
    engineHttp(msg)
      .then(function (r) { sendResponse(r); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  // 0.5.2 §2.1 — 「一键更新」. The download itself has to run here: `chrome.downloads` is not
  // available in a content script, so the panel's button could not do this even in principle.
  // Never rejects — a failed download must report an error and leave every other feature alone.
  if (msg.type === 'gm-download-update') {
    var reply = function (r) { sendResponse(r || { ok: false, error: 'no result' }); };
    try {
      if (typeof GMUpdate === 'undefined' || !GMUpdate || !GMUpdate.downloadUpdate) {
        reply({ ok: false, error: 'update module unavailable' });
      } else {
        GMUpdate.downloadUpdate().then(reply, function (e) {
          reply({ ok: false, error: String((e && e.message) || e) });
        });
      }
    } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
    return true;
  }

  // 0.5.2 §5.1 — the overlay's background image. A content script's `indexedDB` is the HOST
  // PAGE's store, so the panel cannot read the extension's background table at all; this handler
  // is the only route. It answers with a DATA URL rather than a blob URL because the overlay's
  // CSS is evaluated in the page's origin, where `blob:chrome-extension://…` is cross-origin and
  // subject to the page's own `img-src`.
  //
  // `{ ok: false }` for "no background set" is deliberate and not an error: the caller's job is
  // then to remove the class, and a rejection would only add a failure path to a normal state.
  if (msg.type === 'gm-bg-get') {
    var slot = msg.slot || 'bg-overlay';
    GMStorage.loadBackground(slot).then(function (bg) {
      if (!bg) { sendResponse({ ok: true, set: false }); return; }
      GMStorage.blobToDataUrl(bg.blob).then(function (url) {
        sendResponse({
          ok: true, set: !!url, dataUrl: url,
          opacity: bg.opacity, blur: bg.blur,
          offsetX: bg.offsetX, offsetY: bg.offsetY, scale: bg.scale,
        });
      }, function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    }, function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  // 0.5.2 §5.1 — the relay. The settings page is the only writer of the background store, and
  // IndexedDB fires no `storage.onChanged` for anybody, so without this an open game tab would
  // keep the old picture (or no picture at all) until it was reloaded.
  //
  // A per-tab failure is swallowed on purpose: a tab that cannot receive messages (a chrome://
  // page, a discarded tab, a tab whose content script has not been injected) is an ordinary
  // state, and one bad tab must not stop the rest from being told.
  if (msg.type === 'gm-bg-changed') {
    var bgSlot = msg.slot || 'bg-overlay';
    try {
      chrome.tabs.query({}, function (tabs) {
        (tabs || []).forEach(function (t) {
          if (!t || t.id == null) return;
          try {
            chrome.tabs.sendMessage(t.id, { type: 'gm-bg-changed', slot: bgSlot }, function () {
              void chrome.runtime.lastError;
            });
          } catch (e) { /* nothing to do for this tab */ }
        });
        sendResponse({ ok: true });
      });
    } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    return true;
  }

  if (msg.type === 'gm-open-viewer') {    openViewer()
      .then(function () { sendResponse({ ok: true }); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  if (msg.type !== 'gm-ensure-offscreen') return;
  ensureOffscreen()
    .then(function () { sendResponse({ ok: true }); })
    .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
  return true;
});
