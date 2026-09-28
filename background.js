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
  'storage.js');

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
        title: GMI18n.t('lang.' + code),
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
});

chrome.runtime.onStartup.addListener(function () {
  GMStorage.loadSettings().then(
    function (s) { buildLangMenu(s && s.lang); },
    function () { buildLangMenu('auto'); }
  );
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
    updateMenu(LANG_PREFIX + code, { checked: code === lang });
  });
});

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
