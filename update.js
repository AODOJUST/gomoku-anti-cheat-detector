// 0.5.2 §二.1 — 一键更新（方案 B）.
//
// ---------------------------------------------------------------------------
// Why 方案 B and not a self-update
// ---------------------------------------------------------------------------
// An MV3 extension CANNOT rewrite its own files. There is no API to replace a script on disk,
// and `chrome.runtime.reload()` only restarts the worker from the SAME files. Anything that
// looks like a self-update (writing into the extension directory, re-registering the extension)
// is blocked by the security model, and the workarounds that exist are policy violations.
//
// So the honest flow is: the extension can only FETCH the new build and hand it to the operator,
// who performs the one step Chrome reserves for a human — 重新加载 in chrome://extensions.
//
//   1. detect a newer version           (already exists — background.js's 12-hourly check)
//   2. the banner offers 「一键更新」
//   3. chrome.downloads.download()      → the GitHub archive lands in the 下载 folder
//   4. chrome.notifications.create()    → says where it is and what to do next
//   5. the notification's button opens chrome://extensions/
//
// ⚠ §2.1.1 step 4 also asks the extension to UNPACK the zip into 下载/baishen-update/ with JSZip.
// NOT DONE, and §2.1.2 agrees twice over: it marks 解压 as 「可选增强，MVP 可暂不做」 and closes
// with 「MVP 简化：不自动解压，只下载 zip 并提示」. Unpacking would also mean vendoring ~100KB of
// JSZip into an extension that currently has zero third-party code, to save the operator one
// right-click. The notification therefore says 解压 + 重新加载 rather than pointing at a folder
// that was never created.
//
// ⚠ The repo coordinates below are the ones the project's own update check already uses
// (see background.js / storage.js UPDATE_RELEASES) — this file does not invent a second source.
'use strict';

(function (g) {
  'use strict';
  if (g.GMUpdate) return;

  // The archive URL is NOT declared here. `storage.js` already owns the repository coordinates
  // (UPDATE_REPO / UPDATE_SOURCE / UPDATE_ZIP) and background.js's version check reads them, so
  // a second literal would be a second source of truth for "which repository is this" — and the
  // two would drift the first time the repo moved. Read lazily rather than at load time because
  // this file's IIFE may run before storage.js in a bare harness; the literal below is the
  // belt-and-braces default for exactly that case and is asserted equal to GMStorage.UPDATE_ZIP
  // by the suite, so the fallback cannot silently diverge.
  var ZIP_URL_FALLBACK = 'https://github.com/AODOJUST/gomoku-anti-cheat-detector/archive/refs/heads/main.zip';
  function zipUrl() {
    if (g.GMStorage && g.GMStorage.UPDATE_ZIP) return g.GMStorage.UPDATE_ZIP;
    return ZIP_URL_FALLBACK;
  }
  var ZIP_NAME = 'baishen-update.zip';
  var ICON = 'icon/128.png';
  var NOTIF_ID = 'gm-update-ready';

  // The download is a few MB over a possibly slow link. `chrome.downloads.onChanged` reports
  // progress; this is only the ceiling for "it never reported anything at all", so it is
  // deliberately generous. A timeout is needed because a download that is silently cancelled
  // (the operator closes the 下载 bubble, the profile blocks it) never fires `interrupted` on
  // some Chrome builds, and without this the button would stay disabled forever.
  var DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

  function t(key, vars) {
    // i18n.js is loaded in every context this file runs in (the service worker via
    // importScripts, the viewer page via a <script> tag). Guarded so a bare Node harness that
    // loads this file for its shape does not throw.
    if (g.GMI18n && g.GMI18n.t) return g.GMI18n.t(key, vars);
    return key;
  }

  // `inFlight` is the double-click guard. The banner's button is re-enabled from the response,
  // but two fast clicks can both get through before the first response lands — and two
  // concurrent downloads of the same filename would make Chrome save the second as
  // `baishen-update (1).zip`, which the operator then has to disambiguate by hand.
  var inFlight = null;

  function waitForDownload(id) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function finish(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { chrome.downloads.onChanged.removeListener(listener); } catch (e) { /* gone */ }
        err ? reject(err) : resolve();
      }
      var timer = setTimeout(function () { finish(new Error('download timed out')); },
        DOWNLOAD_TIMEOUT_MS);
      function listener(delta) {
        if (!delta || delta.id !== id) return;
        if (delta.state && delta.state.current === 'complete') return finish(null);
        if (delta.state && delta.state.current === 'interrupted') {
          // `error` is a Chrome enum ('NETWORK_FAILED', 'USER_CANCELED', …). Passed through
          // rather than translated: it is a diagnostic, and inventing a sentence for every
          // member would be worse than showing the enum the operator can search for.
          return finish(new Error('interrupted: ' + ((delta.error && delta.error.current) || '?')));
        }
      }
      chrome.downloads.onChanged.addListener(listener);
    });
  }

  function downloadUpdate() {
    if (inFlight) return inFlight;

    if (!chrome.downloads || !chrome.downloads.download) {
      return Promise.resolve({ ok: false, error: 'downloads API unavailable' });
    }

    inFlight = new Promise(function (resolve) {
      chrome.downloads.download({ url: zipUrl(), filename: ZIP_NAME, saveAs: false },
        function (id) {
          if (chrome.runtime.lastError || id == null) {
            resolve({ ok: false, error: (chrome.runtime.lastError &&
              chrome.runtime.lastError.message) || 'download did not start' });
            return;
          }
          waitForDownload(id).then(function () {
            notifyReady();
            resolve({ ok: true, downloadId: id, filename: ZIP_NAME });
          }, function (e) {
            resolve({ ok: false, error: String((e && e.message) || e) });
          });
        });
    // Cleared on settle, so a failed attempt can be retried without a reload.
    }).then(function (r) { inFlight = null; return r; },
            function (e) { inFlight = null; return { ok: false, error: String(e) }; });

    return inFlight;
  }

  function notifyReady() {
    if (!chrome.notifications || !chrome.notifications.create) return;
    try {
      chrome.notifications.create(NOTIF_ID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL(ICON),
        title: t('update.readyTitle'),
        // Names the file, because the operator has to find it. The 下载 folder path itself is
        // not printed: `chrome.downloads` does not expose it without the `downloads.open`
        // permission, and a guessed path would be wrong on any profile that moved it.
        message: t('update.readyBody', { file: ZIP_NAME }),
        buttons: [{ title: t('update.openExtensions') }],
        priority: 2,
      }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* notifications unavailable — the banner still reports success */ }
  }

  // The button. Registered here rather than in background.js so the notification and the
  // listener that answers it are one unit — the id is also cleared on click, because a stale
  // notification whose button still works is a trap after the operator has already updated.
  if (chrome.notifications && chrome.notifications.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener(function (notifId, btnIdx) {
      if (notifId !== NOTIF_ID || btnIdx !== 0) return;
      try { chrome.notifications.clear(NOTIF_ID, function () { void chrome.runtime.lastError; }); }
      catch (e) { /* already gone */ }
      openExtensionsPage();
    });
  }

  function openExtensionsPage() {
    // chrome:// URLs cannot be opened from a content script, which is why the notification's
    // button is handled here in the worker rather than by the page.
    try {
      if (chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: 'chrome://extensions/' }, function () {
          void chrome.runtime.lastError;
        });
      }
    } catch (e) { /* no tabs permission — the notification text still names the page */ }
  }

  g.GMUpdate = {
    downloadUpdate: downloadUpdate,
    openExtensionsPage: openExtensionsPage,
    ZIP_URL: ZIP_URL_FALLBACK,
    ZIP_NAME: ZIP_NAME,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
