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
  'locale/vi.js', 'locale/es.js', 'locale/ms.js', 'locale/ar.js', 'locale/mn.js',
  'llm.js',
  'storage.js');

// 0.4.8 §2 — chrome.storage.session defaults to TRUSTED_CONTEXTS only, so a content script
// cannot see it at all. Opening it to content scripts is what makes the §2 migration real;
// without this call content.js's sessionArea() finds no `session` area and quietly falls back
// to `local`, which is exactly the on-disk behaviour §2 is moving away from. Runs at worker
// start (this file is a module-scope script), so it is re-applied after every teardown.
try {
  if (chrome.storage && chrome.storage.session && chrome.storage.session.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  }
} catch (e) { /* older Chrome — content.js falls back to local and still works */ }

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
});

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
  // Chrome/Edge 116+. Older builds fall through to the create-and-swallow path.
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

  if (msg.type === 'gm-open-viewer') {
    openViewer()
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
