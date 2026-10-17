/* 0.4.4 §十五~§十九 — the LLM API client.
 *
 * Loaded in three places, and the difference matters:
 *   - content script  → uses `call()`, which round-trips through the service worker. A content
 *     script's `fetch` is subject to the PAGE's CORS (Chrome 85+), so calling the provider
 *     directly from there fails for every endpoint that does not send CORS headers — which is
 *     all of them except a browser-facing one.
 *   - viewer.html     → an extension page, so it could fetch directly, but it uses `call()` too
 *     so there is exactly ONE request implementation.
 *   - background.js   → `importScripts('llm.js')` and calls `fetchDirect()`, the real thing.
 *
 * Config lives in `settings.llm` so it inherits the settings page's persistence, cross-page
 * sync and export/import. The counters live in their OWN key (`llmUsage`): they are written by
 * the service worker on every call, and folding them into `settings` would race the settings
 * page's read-modify-write chain and lose edits.
 *
 * §19: the key never leaves this machine. Nothing here talks to anything but `cfg.endpoint`.
 */
(function (g) {
  'use strict';

  var SETTINGS_KEY = 'settings';
  var USAGE_KEY = 'llmUsage';

  // §16's table, verbatim.
  var DEFAULTS = {
    enabled: false,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o-mini',
    timeout: 8000,
    monthlyLimit: 500,
  };

  // §19: 连续 3 次失败 → 24 小时内不再尝试。
  var MAX_FAILS = 3;
  var DISABLE_MS = 24 * 60 * 60 * 1000;

  function api() {
    if (g.chrome && g.chrome.storage && g.chrome.storage.local) return g.chrome.storage.local;
    return null;
  }

  function get(keys) {
    var a = api();
    if (!a) return Promise.resolve({});
    return Promise.resolve(a.get(keys)).then(function (r) { return r || {}; });
  }
  function set(obj) {
    var a = api();
    if (!a) return Promise.resolve();
    return Promise.resolve(a.set(obj));
  }

  function err(code, vars) {
    var s = '__i18n:' + code;
    if (vars) for (var k in vars) if (vars.hasOwnProperty(k)) s += '|' + k + '=' + vars[k];
    return new Error(s);
  }

  function monthKey(d) {
    d = d || new Date();
    return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
  }

  function loadConfig() {
    return get(SETTINGS_KEY).then(function (r) {
      var s = (r && r[SETTINGS_KEY]) || {};
      var raw = (s && s.llm) || {};
      var out = {};
      for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) {
        out[k] = raw[k] == null ? DEFAULTS[k] : raw[k];
      }
      return out;
    });
  }

  /**
   * Writes ONLY the `llm` sub-object. Read-modify-write on the whole `settings` blob, because
   * `settings` is one storage key and a blind `set({settings:{llm}})` would drop every other
   * setting. (GMStorage's serialised write chain is not available in the service worker, so
   * this is the one place that touches `settings` outside it — the settings page is the only
   * concurrent writer and the window is a single read-modify-write.)
   */
  function saveConfig(patch) {
    return get(SETTINGS_KEY).then(function (r) {
      var s = (r && r[SETTINGS_KEY]) || {};
      var llm = {};
      var cur = s.llm || {};
      var k;
      for (k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) {
        llm[k] = cur[k] == null ? DEFAULTS[k] : cur[k];
      }
      for (k in patch) if (patch.hasOwnProperty(k)) llm[k] = patch[k];
      s.llm = llm;
      var o = {}; o[SETTINGS_KEY] = s;
      return set(o).then(function () { return llm; });
    });
  }

  function loadUsage() {
    return get(USAGE_KEY).then(function (r) {
      var u = (r && r[USAGE_KEY]) || {};
      var now = monthKey();
      if (u.month !== now) {
        // A new month resets the counter AND the failure streak: §19's 24h disable is about a
        // provider that is currently broken, not about a bad month.
        u = { month: now, used: 0, fails: 0, disabledUntil: 0 };
      }
      return {
        month: u.month, used: u.used || 0, fails: u.fails || 0, disabledUntil: u.disabledUntil || 0,
      };
    });
  }

  function saveUsage(u) {
    var o = {}; o[USAGE_KEY] = u;
    return set(o);
  }

  function bumpUsed() {
    return loadUsage().then(function (u) { u.used++; return saveUsage(u).then(function () { return u; }); });
  }

  function noteFailure() {
    return loadUsage().then(function (u) {
      u.fails = (u.fails || 0) + 1;
      if (u.fails >= MAX_FAILS) u.disabledUntil = Date.now() + DISABLE_MS;
      return saveUsage(u).then(function () { return u; });
    });
  }

  function noteSuccess() {
    return loadUsage().then(function (u) {
      if (!u.fails) return u;
      u.fails = 0;
      return saveUsage(u).then(function () { return u; });
    });
  }

  /** Clears the 24h breaker (the settings page's 「重置」 button). */
  function resetUsage() {
    return saveUsage({ month: monthKey(), used: 0, fails: 0, disabledUntil: 0 });
  }

  function isDisabled() {
    return loadUsage().then(function (u) {
      return u.disabledUntil > Date.now() ? u.disabledUntil : 0;
    });
  }

  // ---------------------------------------------------------------- the request
  //
  // §17's shape, with the additions §19 needs: the abort timer is cleared on BOTH paths (the
  // sketch clears it before the `!res.ok` throw, so a failed request leaked the timer until the
  // timeout fired), and every failure is tagged with an i18n error code so §1.7 决策 3 holds.
  function fetchDirect(prompt, opts) {
    opts = opts || {};
    return loadConfig().then(function (cfg) {
      if (!cfg.enabled || !cfg.apiKey) throw err('llm.notConfigured');
      return loadUsage().then(function (u) {
        if (u.disabledUntil > Date.now()) throw err('llm.autoDisabled');
        if (u.used >= cfg.monthlyLimit) throw err('llm.quotaExceeded');
        return doFetch(cfg, prompt, opts);
      });
    });
  }

  function doFetch(cfg, prompt, opts) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false;
    var to = setTimeout(function () {
      timedOut = true;
      if (ctrl) ctrl.abort();
    }, cfg.timeout || DEFAULTS.timeout);

    var init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature != null ? opts.temperature : 0,
        max_tokens: opts.maxTokens || 64,
      }),
    };
    if (ctrl) init.signal = ctrl.signal;

    return Promise.resolve()
      .then(function () { return fetch(cfg.endpoint, init); })
      .then(function (res) {
        clearTimeout(to);
        if (!res.ok) throw err('llm.httpError', { code: res.status });
        return res.json();
      })
      .then(function (data) {
        var txt = (data && data.choices && data.choices[0] && data.choices[0].message &&
          data.choices[0].message.content) || '';
        return bumpUsed().then(function () { return txt; });
      })
      .catch(function (e) {
        clearTimeout(to);
        var code = timedOut ? err('llm.timeout') : e;
        return noteFailure().then(function () { throw code; });
      });
  }

  /**
   * Caller-side entry point. Returns a Promise<string>; rejects with an `__i18n:`-coded Error
   * that the display layer turns into text via `GMI18n.trError`.
   */
  function call(prompt, opts) {
    if (g.chrome && g.chrome.runtime && g.chrome.runtime.sendMessage) {
      return new Promise(function (resolve, reject) {
        g.chrome.runtime.sendMessage({ type: 'gm-llm', prompt: prompt, opts: opts || {} },
          function (resp) {
            if (g.chrome.runtime.lastError) {
              reject(new Error('__i18n:llm.bridgeFailed|msg=' + g.chrome.runtime.lastError.message));
              return;
            }
            if (!resp || !resp.ok) {
              reject(new Error((resp && resp.error) || '__i18n:llm.bridgeFailed|msg=empty'));
              return;
            }
            resolve(resp.text || '');
          });
      });
    }
    // No runtime bridge (a node test, or an offscreen-style context): go direct.
    return fetchDirect(prompt, opts);
  }

  // §18 — the host permission is optional, so it has to be requested from a user gesture on an
  // extension page. Content scripts cannot call this at all.
  function hasHostPermission(endpoint) {
    if (!g.chrome || !g.chrome.permissions || !g.chrome.permissions.contains) {
      return Promise.resolve(true);
    }
    var origin;
    try { origin = new URL(endpoint).origin + '/*'; } catch (e) { origin = 'https://*/*'; }
    return new Promise(function (resolve) {
      g.chrome.permissions.contains({ origins: [origin] }, function (ok) {
        resolve(!!ok || !g.chrome.runtime.lastError && !!ok);
      });
    });
  }

  function requestHostPermission(endpoint) {
    if (!g.chrome || !g.chrome.permissions || !g.chrome.permissions.request) {
      return Promise.resolve(false);
    }
    var origin;
    try { origin = new URL(endpoint).origin + '/*'; } catch (e) { origin = 'https://*/*'; }
    return new Promise(function (resolve) {
      g.chrome.permissions.request({ origins: [origin] }, function (ok) {
        resolve(!!ok);
      });
    });
  }

  g.GMLLM = {
    DEFAULTS: DEFAULTS,
    MAX_FAILS: MAX_FAILS,
    DISABLE_MS: DISABLE_MS,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    loadUsage: loadUsage,
    resetUsage: resetUsage,
    isDisabled: isDisabled,
    fetchDirect: fetchDirect,
    call: call,
    hasHostPermission: hasHostPermission,
    requestHostPermission: requestHostPermission,
    monthKey: monthKey,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMLLM;
})(typeof globalThis !== 'undefined' ? globalThis : self);
