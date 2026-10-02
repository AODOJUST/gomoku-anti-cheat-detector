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
  // 0.4.9 §一.4 — the local player blacklist. Keyed by the site's USERNAME (`playerId`), never by
  // the display name: a display name is editable and repeatable, an id is neither. It stays in
  // `chrome.storage.local` and is never uploaded anywhere (§1.1) — the whole feature is a
  // local note-to-self, and the note lives and dies on this machine.
  var BLACKLIST_KEY = 'blacklist';
  // Same reasoning as MAX_SAMPLES: the 10MB budget is shared, and a blacklist nobody prunes is a
  // hoarding problem. 500 ids is far past any real operator's encounter rate.
  var MAX_BLACKLIST = 500;
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
    // 0.4.5 §二.2 — 游戏规则. null = 「自动」, i.e. infer from the site (gomoku.com's /renju/
    // path → 连珠, everything else → 自由). 0 自由 / 1 标准 / 2 连珠 = the operator's explicit
    // choice, which wins. papergames.io has no renju mode at all, so without this a 连珠 game
    // played there could never be analysed under 禁手.
    rule: null,
    // 0.5.6 补增 §三 — the operator's own per-signal weights. A SPARSE override map: only the
    // signals the operator actually changed appear, and anything absent (or null) follows the
    // compiled-in default (through `learnedParams`, if the learner has run).
    //
    // Sparse rather than a full thirteen-key table for the reason tagWiki stores a `weightKey`
    // and not a figure: a full table would freeze every untouched term at the default of the
    // day, so a later release that rebalances `BASE_WEIGHTS` would leave this profile pinned to
    // the old numbers while the panel still showed them as if they were the defaults.
    //
    // The values are ABSOLUTE weights (a fraction of the score, like every number in
    // BASE_WEIGHTS), not shares to be renormalised: the operator's table is allowed to sum to
    // anything up to SIGNAL_WEIGHT_SUM_MAX — and the SHIPPED table itself is exactly 1.30, the
    // whole ceiling (补增 §三 后续: 0.5.3's six statistics at 1.00, plus its seven behaviour signals
    // scaled to 0.30). A table that still summed to 1.00 by construction would make the 130% ceiling
    // unstatable, and it would also mean an operator who lifted every signal by the same factor saw
    // no change at all. The cost is the one 0.5.5 §1.3 wrote down: the score stops being comparable
    // across releases. That is the operator's call here, and the panel says so next to the total.
    //
    // The DOMAIN is 0–SIGNAL_WEIGHT_MAX per signal and 0–SIGNAL_WEIGHT_SUM_MAX for the resolved
    // table, enforced here as well as by the inputs' own `max` — the stored profile is the one
    // input the UI never validates, and it is also the one input that arrives from a stranger's
    // backup file. Out-of-range is DROPPED, not clamped: silently rewriting an operator's 0.21 to
    // 1.00 is worse than ignoring it and saying so.
    signalWeights: {},
    threadNum: 0,           // 引擎线程数；0 = 自动（clamp(floor(hardwareConcurrency/2), 1, 16)）
    // 0.5.1 §2.1.4 — which detection engine to use. 'rapfi' is the shipped WASM build;
    // 'katagomo' is an http server the operator runs (its address is `engineUrl` below);
    // 'custom-N' is a weight package uploaded through the settings page. Both directions are
    // validated against the registry, so a model deleted from IndexedDB falls back to Rapfi
    // instead of to an id nothing answers to.
    engineId: 'rapfi',
    // 0.5.1 §2.1.1 — the base address of the operator's KataGomo server. Empty means "not
    // configured", which is what greys KataGomo out in both pickers rather than letting the
    // operator select something that cannot possibly answer. A bare host gets the analysis path
    // appended; anything with a path is used verbatim (GMEngines.analysisEndpoint).
    engineUrl: '',
    autoAnalyze: true,      // 对局结束自动分析
    minArchiveMoves: 14,    // 少于这么多手不写存档（5–30）
    // 0.3.6 §1.3 — 'auto' means "follow the browser UI language". It is a setting value, not
    // a locale: `GMI18n.resolveLang()` is what turns it into one of the 8 concrete locales.
    lang: 'auto',
    // 0.4.4 §七~§十二 — the master switch for AUTOMATIC outbound chat: the §7 anti-cheat
    // announcement and the §8 language-matched replies. Both put words in the operator's mouth
    // in front of a real opponent, which cannot be taken back, so the default is OFF even though
    // §7.1 describes the announcement as automatic. The operator confirmed this deviation
    // (2026-09-29): 「默认关，首次确认一次」. The §12 「提问」 button is NOT gated by this — it is
    // an explicit click, not something the extension decides to do.
    chatAuto: false,
    // 0.4.10 §2.2 — a SECOND, narrower switch for the announcement alone, defaulting ON so that
    // an operator who turns on 自动发送 gets exactly the 0.4.9 behaviour. It exists because the
    // one switch was doing two jobs that the operator thinks about separately: 「开局要不要替你
    // 声明」 (an ethical choice about speaking for them) and 「要不要把预设问题发出去」 (which is
    // not automatic at all — the operator picks every question by hand). Answering a question
    // here never consults this key; only `maybeAnnounce()` does.
    autoSendAnnouncement: true,
    // 0.4.7 §三.1 — the colour scheme. 'auto' follows the OS via prefers-color-scheme, which is
    // the behaviour the viewer had before there was a setting at all, so it is the default: an
    // operator who never opens the settings page sees exactly what they saw in 0.4.6.
    theme: 'auto',
    // 0.5.3 §1.1 — TRANSPARENCY, and the direction matters.
    //
    // 0.4.7 §三.2 called this setting `opacity` and read it with CSS `opacity` semantics:
    // `level: 100` meant FULLY OPAQUE and 0 meant fully transparent. The requirement's own
    // wording — 「透明度最高可以到 95%」 — is the opposite way round: 透明度 is TRANSPARENCY,
    // so 0% is opaque and 100% is invisible. Half the operators read "透明度 60%" as
    // "60% see-through" and the other half as "60% opaque"; 0.4.7 picked the minority reading
    // and the slider has been backwards ever since. 0.5.3 §1.1 replaces it outright.
    //
    //   cssOpacity = 1 - transparencyPercent / 100
    //
    // Five INDEPENDENT parts, each with its own ceiling — the ceilings are the requirement's
    // 「最高为 X%」 values and they are enforced here (see clampTransparencyNum), not merely
    // suggested by a slider's `max`, because the profile is the one input the UI never
    // validates:
    //
    //              transparency   background alpha
    //   viewer     element  0–95   1.00–0.05        + elementBlur 0–8px
    //              button   0–80   1.00–0.20
    //   overlay    background 0–95 1.00–0.05        + backgroundBlur 0–12px
    //              element  0–90   1.00–0.10        + elementBlur 0–8px
    //              button   0–80   1.00–0.20
    //
    // It applies to the UI LAYER only — containers and buttons. The background PICTURE (§5.1) is
    // never faded: it is the bottom layer, and making the bottom layer translucent just shows the
    // page through it. `enabled: false` means every derived value is exactly 1, so an untouched
    // profile renders byte-identically to the previous release.
    //
    // 0.5.4 §二.1 — the SCOPE is narrowed and the button blur is gone. Two changes, one cause:
    // 0.5.3 faded a whole container with CSS `opacity`, which fades its text, its inputs and its
    // progress bars along with its fill — 「元素透明度 60%」 made a panel unreadable rather than
    // letting it become glass. §2.1.1 asks for the fill to carry the alpha and nothing else, so
    // every part below is now a BACKGROUND alpha (`rgba(var(--x-rgb), alpha)`), and the type
    // inside keeps opacity 1 by construction rather than by a rule someone has to remember.
    //
    // 按钮模糊度 is deleted outright (§2.1.2): a blurred backdrop behind a 41px button is not a
    // look, it is a button you cannot read. The blur axis stays on containers, where §2.1.3 says
    // it means 毛玻璃 — it blurs what is BEHIND the element, and it does nothing visible unless
    // that element's own background is translucent, which is why the settings page says so.
    transparency: {
      viewer: { enabled: false, element: 0, elementBlur: 0, button: 0 },
      overlay: {
        enabled: false, background: 0, backgroundBlur: 0,
        element: 0, elementBlur: 0, button: 0,
      },
    },
    // 0.5.3 §2.1 — 回放过滤. A game whose risk lands inside [minRisk, maxRisk] is analysed and
    // shown but NOT archived. The default (0–54) is the range an operator most often does not
    // want filling the archive list: below 55 is 「职业选手」 and weaker (see classifySide), and
    // a low-risk game is the one they are least likely to come back to. `enabled: false` means
    // every game is archived, which is exactly 0.5.2's behaviour.
    archiveFilter: { enabled: false, minRisk: 0, maxRisk: 54 },
    // 0.5.4 §一.3 — 存储过滤. The same "do not keep this game" decision as `archiveFilter`
    // above, asked about the SHAPE of the capture rather than about its score, and the two
    // compose (their judgement functions are both consulted; either one can refuse).
    //
    //   有序手 < minOrdered   ⇒ 不存档   (too little to say anything about)
    //   无序手 > maxUnordered ⇒ 不存档   (too much of the board arrived without an order)
    //
    // Both default to the values §1.3 names. `enabled: false` means every game is archived,
    // which is exactly 0.5.3's behaviour — an untouched profile cannot notice this release.
    storageFilter: { enabled: false, minOrdered: 14, maxUnordered: 5 },
    // 0.4.4 §十六 — the LLM panel. The DEFAULTS live in llm.js (GMLLM.DEFAULTS) because the
    // service worker loads that file too; a second literal here would drift. `llm.js` is loaded
    // before this file (manifest order), so the reference resolves. `{}` in a broken build is
    // deliberate: the panel then shows blanks instead of inventing values.
    llm: (g.GMLLM && g.GMLLM.DEFAULTS) ? Object.assign({}, g.GMLLM.DEFAULTS) : {},
    // 0.5.2 §4.1 — the operator's own questions. See MAX_CUSTOM_QUESTIONS below for the shape
    // and the mandatory-English rule. Empty by default, so an untouched profile has no custom
    // menu at all and 0.5.1's question menu is exactly what it was.
    customQuestions: [],
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

  // 0.5.1 §2.1.4. The validation is against the REGISTRY, not a literal list, because the
  // interesting case is a custom model: the operator picks 「自定义模型 2」, then deletes it. The
  // stored id still looks well-formed and the settings page would happily keep showing it,
  // while the offscreen document has nothing to load. A bare unit test has no registry, and is
  // handed the value unchanged — "unknown" and "not checked" are different answers, and only the
  // registry can tell them apart.
  function clampEngineId(v) {
    var id = String(v == null ? '' : v).trim();
    if (!id) return DEFAULTS.engineId;
    var reg = g.GMEngines;
    if (!reg || !reg.get) return id;
    // A custom slot may not be registered yet in THIS context (storage.js is loaded before the
    // list is read from IndexedDB), so its shape is all that can be checked here. `getEngine`
    // still degrades to Rapfi at load time if the record is gone.
    if (/^custom-\d+$/.test(id)) return id;
    return reg.get(id) ? id : DEFAULTS.engineId;
  }

  // An address that is not http(s) is not a server we can reach, and keeping it would make the
  // picker offer KataGomo as available and then fail on the first search. The length cap is a
  // guard against a paste accident, not a legal limit.
  function clampEngineUrl(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) return '';
    return s.slice(0, 300);
  }

  // Out-of-range input (typing, an old stored value) is pulled back to a usable number
  // rather than rejected, so the gate can never be disabled by accident.
  function clampMinMoves(v) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return DEFAULTS.minArchiveMoves;
    return Math.max(MIN_MOVES_LO, Math.min(MIN_MOVES_HI, n));
  }

  // ---------- 0.4.7 §三: theme + translucency ----------
  // The three theme values are the only ones the viewer's CSS has a rule for. Anything else
  // (an old build's value, a hand-edited profile, a typo) falls back to 'auto', because 'auto'
  // is what every pre-0.4.7 build behaved as and so is the one answer that cannot surprise
  // anyone. Two live surfaces read this: viewer.js's applyTheme() and content.js's overlay.
  var THEMES = ['light', 'dark', 'auto'];
  function clampTheme(v) {
    return (typeof v === 'string' && THEMES.indexOf(v) >= 0) ? v : 'auto';
  }

  // ---------- 0.5.3 §1.1 transparency ----------
  // The five ceilings, in one table so no caller can invent a sixth. §1.1.2 gives each part a
  // 「最高为 X%」; the value is the TRANSPARENCY percentage, so it is also the CSS-opacity FLOOR
  // (transparency 95 ⇒ opacity 0.05). A part with no ceiling of its own is not configurable.
  var TRANSPARENCY_LIMITS = {
    viewer: { element: 95, button: 80, elementBlur: 8 },
    overlay: { background: 95, element: 90, button: 80, backgroundBlur: 12, elementBlur: 8 },
  };

  /** One numeric field of one part, clamped to its own ceiling. */
  function clampTransparencyNum(part, key, v, dflt) {
    var lim = TRANSPARENCY_LIMITS[part] && TRANSPARENCY_LIMITS[part][key];
    if (lim == null) return dflt;
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    return Math.max(0, Math.min(lim, Math.round(n)));
  }

  /**
   * Rebuild `transparency` field by field rather than trusting it, like every other setting:
   * the profile is the one input the UI never validates. Two things a hand-edited profile must
   * not be able to do — push a part past its ceiling, and reach the DOM as a non-number (a
   * `--viewer-elem-bg-alpha` of `"abc"` makes the whole `rgba()` declaration
   * invalid-at-computed-value-time, so the fill silently stays opaque and the operator reports
   * the slider as broken).
   *
   * `buttonBlur` is NOT among the fields any more (0.5.4 §2.1.2) and that is also why an old
   * profile cannot keep it: this function rebuilds the object, so the field is dropped the next
   * time anything is saved rather than being migrated forward into a control that no longer
   * exists.
   *
   * A FRESH object every time is deliberate: callers hold the result, and handing back a
   * reference into DEFAULTS would let one file's edit change every other caller's "default".
   */
  function normalizeTransparency(v) {
    var src = (v && typeof v === 'object') ? v : {};
    var vw = (src.viewer && typeof src.viewer === 'object') ? src.viewer : {};
    var ov = (src.overlay && typeof src.overlay === 'object') ? src.overlay : {};
    var d = DEFAULTS.transparency;
    return {
      viewer: {
        enabled: !!vw.enabled,
        element: clampTransparencyNum('viewer', 'element', vw.element, d.viewer.element),
        elementBlur: clampTransparencyNum('viewer', 'elementBlur', vw.elementBlur, d.viewer.elementBlur),
        button: clampTransparencyNum('viewer', 'button', vw.button, d.viewer.button),
      },
      overlay: {
        enabled: !!ov.enabled,
        background: clampTransparencyNum('overlay', 'background', ov.background, d.overlay.background),
        backgroundBlur: clampTransparencyNum('overlay', 'backgroundBlur', ov.backgroundBlur, d.overlay.backgroundBlur),
        element: clampTransparencyNum('overlay', 'element', ov.element, d.overlay.element),
        elementBlur: clampTransparencyNum('overlay', 'elementBlur', ov.elementBlur, d.overlay.elementBlur),
        button: clampTransparencyNum('overlay', 'button', ov.button, d.overlay.button),
      },
    };
  }

  /** Transparency percent -> CSS opacity. The ONE conversion, so no caller can invert it. */
  function cssOpacity(transparencyPercent) {
    var t = Number(transparencyPercent);
    if (!isFinite(t)) t = 0;
    t = Math.max(0, Math.min(100, t));
    return Math.round((1 - t / 100) * 1000) / 1000;
  }

  // ---------- 0.5.3 §2.1 回放过滤 ----------
  function normalizeArchiveFilter(v) {
    var d = DEFAULTS.archiveFilter;
    var src = (v && typeof v === 'object') ? v : {};
    var n = function (x, dflt) {
      var y = parseInt(x, 10);
      if (!isFinite(y)) return dflt;
      return Math.max(0, Math.min(100, Math.round(y)));
    };
    return {
      enabled: !!src.enabled,
      minRisk: n(src.minRisk, d.minRisk),
      maxRisk: n(src.maxRisk, d.maxRisk),
    };
  }

  /**
   * Should this report be kept OUT of the archive? §2.2.2.
   *
   * Both sides are analysed, so the question "how risky was this game" has two answers; §2.2
   * says to judge by the HIGHER one. Taking the max rather than the average is the conservative
   * reading: a game with one AI side is a game worth remembering, and averaging would let a
   * clean opponent drag a 90 down into the filtered band.
   *
   * `minRisk > maxRisk` is an INVALID configuration (§2.2.5) and filters nothing — a range
   * that cannot contain any number would otherwise silently archive everything while the
   * settings page showed a switch that was on.
   */
  function shouldSkipArchive(report, filter) {
    var f = normalizeArchiveFilter(filter);
    if (!f.enabled) return false;
    if (f.minRisk > f.maxRisk) return false;
    if (!report) return false;
    var b = (report.black && isFinite(report.black.risk)) ? report.black.risk : 0;
    var w = (report.white && isFinite(report.white.risk)) ? report.white.risk : 0;
    var risk = Math.max(b, w);
    return risk >= f.minRisk && risk <= f.maxRisk;
  }

  /** True when the stored filter is enabled but its range is impossible (§2.2.5's warning). */
  function archiveFilterInvalid(filter) {
    var f = normalizeArchiveFilter(filter);
    return !!f.enabled && f.minRisk > f.maxRisk;
  }

  // ---------- 0.5.4 §一.3 存储过滤 ----------
  // Two independent thresholds over the SHAPE of the capture, both slidered 0–50 (§1.1). The
  // ceilings live here rather than in the markup for the reason every other bound does: the
  // stored profile is the one input the UI never validates, and a hand-edited `minOrdered: 9000`
  // would refuse every game while the panel showed a slider that could not have produced it.
  var STORAGE_FILTER_LIMITS = { minOrdered: 50, maxUnordered: 50 };

  function normalizeStorageFilter(v) {
    var d = DEFAULTS.storageFilter;
    var src = (v && typeof v === 'object') ? v : {};
    var n = function (x, dflt, hi) {
      var y = parseInt(x, 10);
      if (!isFinite(y)) return dflt;
      return Math.max(0, Math.min(hi, Math.round(y)));
    };
    return {
      enabled: !!src.enabled,
      minOrdered: n(src.minOrdered, d.minOrdered, STORAGE_FILTER_LIMITS.minOrdered),
      maxUnordered: n(src.maxUnordered, d.maxUnordered, STORAGE_FILTER_LIMITS.maxUnordered),
    };
  }

  /**
   * 0.5.6 补增 §三 — the operator's per-signal pins, filtered down to things the detector can
   * actually use.
   *
   * The key list is `DEFAULT_WEIGHTS`'s own, read at CALL time rather than copied: that table is
   * already the one authority on which thirteen terms exist, and a second hard-coded list here
   * would be one more thing a rebalancing release has to remember to update. (`var` is fine —
   * this function only runs long after the whole file has been evaluated.)
   *
   * Absent/null means "not pinned" and is left out of the result, which is what makes this map
   * sparse. A non-finite or out-of-range value is dropped too, for the reason in DEFAULTS: this
   * is the one input the UI never validates. An empty result is a legitimate answer — it means
   * "no pins", i.e. the previous behaviour exactly.
   *
   * The SUM rule arrives with the 130% ceiling, and it is refused as a set rather than repaired
   * entry by entry: trimming a pin to make the total fit would store a table the operator never
   * asked for, and the panel would then show numbers that are not the numbers they typed. The
   * 0.5.6 §一.6.1 rule for the import path is the same rule — 「越界项退回原值，绝不 clamp」 — one
   * level up. (The all-zero table is inside this check: its resolved total is 0, so it fails
   * `sum > 0` before the ceiling is ever consulted.)
   */
  function normalizeSignalWeights(v) {
    var src = (v && typeof v === 'object') ? v : {};
    var out = {};
    for (var k in DEFAULT_WEIGHTS) {
      if (!DEFAULT_WEIGHTS.hasOwnProperty(k) || src[k] == null) continue;
      var n = Number(src[k]);
      if (!isFinite(n) || n < 0 || n > SIGNAL_WEIGHT_MAX) continue;
      out[k] = n;
    }
    var sum = signalWeightTableSum(out);
    if (!(sum > 0) || sum > SIGNAL_WEIGHT_SUM_MAX + SIGNAL_WEIGHT_EPS) return {};
    return out;
  }

  /**
   * What the table `pins` RESOLVES to would sum to, against `base` (the compiled defaults unless
   * a caller has a better base in hand).
   *
   * ONE implementation of that sum, because the 130% ceiling is compared against it from three
   * places — the write path above, the import validator below, and (through the same number on
   * the same table) app.js's `effectiveSignalWeights` — and this project has paid five times for a
   * quantity that existed in more than one spelling. app.js mirrors this arithmetic rather than
   * calling it: the offscreen document and the unit harnesses load app.js with no storage.js at
   * all, so app.js has to own its own copy of the formula. The two are pinned equal by the suite.
   *
   * ⚠ The BASE is the one place the two can disagree, and it is a real, documented limitation: a
   * profile whose learner has run has a different table from the compiled defaults, so a set that
   * fits against one can miss the other by the learner's own drift at the pinned keys. Storage can
   * only see DEFAULT_WEIGHTS; app.js re-checks against the table it will actually score with and
   * refuses a set that does not fit — the panel reads the same function, so what it shows is what
   * the detector will use, in both directions.
   */
  function signalWeightTableSum(pins, base) {
    var b = base || DEFAULT_WEIGHTS;
    var sum = 0;
    for (var k in b) {
      if (!b.hasOwnProperty(k)) continue;
      var v = (pins && pins[k] != null) ? Number(pins[k]) : b[k];
      if (isFinite(v) && v > 0) sum += v;
    }
    return sum;
  }

  /**
   * Should this game be kept OUT of the archive on account of how much of it we actually have?
   * §1.4. Returns `null` when the game passes, or a `{reason, …}` record naming which threshold
   * was hit and by how much — the caller turns that into a sentence, and the reason code is what
   * lets it say WHICH rule fired rather than a generic 「未存档」.
   *
   * The two counts, in the ONE reading §1.2's table allows here:
   *
   *   无序手 = record.meta.unorderedCount, or report.prejoinCount when the record has none
   *   有序手 = record.moves.length - 无序手
   *
   * ⚠ §1.2 also offers `report.orderKnownCount` for 有序手, and it is deliberately NOT used.
   * Two readings of one quantity is the failure mode this project has paid for four times: the
   * overlay builds the record and the viewer builds the record, and if one of them subtracts
   * while the other takes the report's own count, the same game is archived from one surface and
   * refused from the other — silently, because both numbers look reasonable. The subtraction is
   * the one that holds for BOTH builders, so it is the one that is implemented.
   *
   * ⚠ §1.4's signature is `(record, report)` and reads `S.storageFilter` out of a global. There
   * is no live settings object in this file — it is loaded by three different pages and by none
   * of them as the owner of `S` — so the filter is the THIRD argument, exactly as
   * `shouldSkipArchive(report, filter)` above takes it. Same rule, same reason.
   */
  function shouldSkipByCounts(record, report, filter) {
    var f = normalizeStorageFilter(filter);
    if (!f.enabled) return null;
    var moves = (record && record.moves) || [];
    // `!= null` and not `||`: 0 is a real answer (an ordered game), and `||` would send it to the
    // report — which for a prejoin-heavy game says something quite different from 0.
    var meta = (record && record.meta) || {};
    var unordered = meta.unorderedCount != null
      ? meta.unorderedCount
      : ((report && report.prejoinCount) || 0);
    if (!isFinite(unordered) || unordered < 0) unordered = 0;
    var ordered = Math.max(0, moves.length - unordered);
    if (ordered < f.minOrdered) {
      return { reason: 'ordered-too-few', ordered: ordered, min: f.minOrdered };
    }
    if (unordered > f.maxUnordered) {
      return { reason: 'unordered-too-many', unordered: unordered, max: f.maxUnordered };
    }
    return null;
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
    out.engineId = clampEngineId(out.engineId);
    out.engineUrl = clampEngineUrl(out.engineUrl);
    // 0.4.7 §三. Both new settings are clamped on the way IN as well as on the way out: a
    // hand-edited profile is the one input the UI never validates, and `theme` reaching the
    // DOM as an arbitrary string would match no `[data-theme=…]` rule — i.e. the page would
    // silently fall back to its light defaults, which is the hardest kind of bug to notice.
    // Same reasoning as clampMinMoves above.
    out.theme = clampTheme(out.theme);
    // 0.5.3 §1.1 replaces 0.4.7's `opacity`. The old key is NOT migrated: its value means the
    // opposite thing (level 100 was "fully opaque"), so carrying it forward would silently give
    // an operator who had transparency ON a profile that reads as fully transparent. It is
    // simply absent from DEFAULTS, and the projection loop above drops any key not in DEFAULTS —
    // so an old profile loses it on the first read, which is the honest outcome.
    out.transparency = normalizeTransparency(out.transparency);
    out.archiveFilter = normalizeArchiveFilter(out.archiveFilter);
    out.storageFilter = normalizeStorageFilter(out.storageFilter);
    // 0.5.6 补增 §三: the per-signal pins are filtered on the way IN as well as out, like every
    // other setting — and here it matters twice over, because this is also the key a stranger's
    // backup file lands in.
    out.signalWeights = normalizeSignalWeights(out.signalWeights);
    // 0.5.2 §4.1 — clamped on the way IN as well as out, like every other setting: the profile
    // is the one input the UI never validates, and a hand-edited list must not be able to put a
    // non-array (or a 200-row list, or a row with no English) in front of the send path.
    out.customQuestions = clampCustomQuestions(out.customQuestions);
    return out;
  }

  function saveSettings(patch) {
    return enqueue(async function () {
      var s = await loadSettings();
      if (patch) for (var k in patch) if (k in DEFAULTS) s[k] = patch[k];
      s.minArchiveMoves = clampMinMoves(s.minArchiveMoves);
      s.threadNum = clampThreadNum(s.threadNum);
      s.engineId = clampEngineId(s.engineId);
      s.engineUrl = clampEngineUrl(s.engineUrl);
      s.theme = clampTheme(s.theme);
      s.transparency = normalizeTransparency(s.transparency);
      s.archiveFilter = normalizeArchiveFilter(s.archiveFilter);
      s.storageFilter = normalizeStorageFilter(s.storageFilter);
      s.signalWeights = normalizeSignalWeights(s.signalWeights);
      s.customQuestions = clampCustomQuestions(s.customQuestions);
      var put = {}; put[SETTINGS_KEY] = s;
      try { await api().set(put); } catch (e) {}
      return s;
    });
  }

  function saveSetting(key, value) {
    var patch = {}; patch[key] = value;
    return saveSettings(patch);
  }

  // A shallow copy is not enough for the object-valued settings. `Object.assign({}, DEFAULTS)`
  // shares the nested objects, so `defaults().transparency.viewer.element = 50` — or anything
  // that mutates a nested field in place — would edit DEFAULTS itself and change the meaning of
  // "default" for the rest of the session. That was harmless while the only object-valued keys
  // were read-only, and stopped being harmless the moment `transparency` and `archiveFilter`
  // arrived: both are rebuilt field by field and it would be easy to write a mutating
  // "normalise in place" helper later without noticing.
  //
  // The two normalisers already return FRESH objects, so this is belt and braces — but it is the
  // cheap kind: it removes the hazard rather than relying on every future caller being careful.
  function defaults() {
    var out = Object.assign({}, DEFAULTS);
    out.transparency = normalizeTransparency(DEFAULTS.transparency);
    out.archiveFilter = normalizeArchiveFilter(DEFAULTS.archiveFilter);
    out.storageFilter = normalizeStorageFilter(DEFAULTS.storageFilter);
    return out;
  }

  // ---------- 0.5.2 §4.1 玩家自定义问题 ----------
  // A list of questions the operator writes themselves, each with a mandatory English version.
  // Stored under one settings key rather than in its own storage area: it is small (8 rows of
  // text), it is edited on the settings page, and it has to travel with the rest of the profile.
  //
  // Why English is mandatory (§4.1.2): it is the FALLBACK. §4.1.3 sends the translation matching
  // `questionLang` and, when there is none, sends the English version — deliberately NOT the
  // original text, because an operator who picked 日本語 and got a Chinese sentence has sent
  // their opponent something they cannot read. Requiring English is what makes that fallback
  // always available; a list without it would have a hole exactly where the fallback is needed.
  var MAX_CUSTOM_QUESTIONS = 8;
  // Not in the spec. A guard against a hand-edited profile: the text is rendered into a menu and
  // sent to a game server, and neither has any use for a 100KB string.
  var MAX_QUESTION_LEN = 300;

  function cleanQuestionText(v) {
    if (typeof v !== 'string') return '';
    var s = v.replace(/[\r\n\t]+/g, ' ').trim();
    return s.length > MAX_QUESTION_LEN ? s.slice(0, MAX_QUESTION_LEN) : s;
  }

  // A question is only usable with BOTH the original text and English. Anything else is dropped
  // rather than kept half-built: a row that cannot be sent is worse than no row, because the
  // menu would offer it and the send would do nothing.
  function normalizeQuestion(q, idx) {
    if (!q || typeof q !== 'object') return null;
    var text = cleanQuestionText(q.text);
    var tr = (q.translations && typeof q.translations === 'object') ? q.translations : {};
    var out = {};
    for (var lang in tr) {
      var v = cleanQuestionText(tr[lang]);
      if (v) out[lang] = v;
    }
    if (!text || !out.en) return null;
    return {
      id: (typeof q.id === 'string' && q.id) ? q.id : ('cq-' + (idx + 1) + '-' + Date.now()),
      text: text,
      translations: out,
      createdAt: isFinite(q.createdAt) ? q.createdAt : Date.now(),
    };
  }

  function clampCustomQuestions(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_CUSTOM_QUESTIONS; i++) {
      var q = normalizeQuestion(list[i], i);
      if (q) out.push(q);
    }
    return out;
  }

  function loadCustomQuestions() {
    return loadSettings().then(function (s) { return clampCustomQuestions(s.customQuestions); });
  }

  function saveCustomQuestions(list) {
    return saveSetting('customQuestions', clampCustomQuestions(list));
  }

  // `id` is generated here rather than by the caller so two questions added in the same
  // millisecond cannot collide: the index is included, and the counter is checked.
  function addCustomQuestion(q) {
    return loadCustomQuestions().then(function (list) {
      if (list.length >= MAX_CUSTOM_QUESTIONS) {
        return { ok: false, error: 'limit', list: list };
      }
      var next = normalizeQuestion(q, list.length);
      if (!next) return { ok: false, error: 'invalid', list: list };
      var seen = {};
      for (var i = 0; i < list.length; i++) seen[list[i].id] = 1;
      while (seen[next.id]) next.id = next.id + '-x';
      list.push(next);
      return saveCustomQuestions(list).then(function (saved) {
        return { ok: true, question: next, list: saved };
      });
    });
  }

  function updateCustomQuestion(id, patch) {
    return loadCustomQuestions().then(function (list) {
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) { idx = i; break; }
      if (idx < 0) return { ok: false, error: 'not-found', list: list };
      var merged = normalizeQuestion(Object.assign({}, list[idx], patch || {}, { id: id }), idx);
      if (!merged) return { ok: false, error: 'invalid', list: list };
      merged.createdAt = list[idx].createdAt;
      list[idx] = merged;
      return saveCustomQuestions(list).then(function (saved) {
        return { ok: true, question: merged, list: saved };
      });
    });
  }

  function removeCustomQuestion(id) {
    return loadCustomQuestions().then(function (list) {
      var next = list.filter(function (q) { return q.id !== id; });
      return saveCustomQuestions(next).then(function (saved) {
        return { ok: next.length !== list.length, list: saved };
      });
    });
  }

  // 0.5.2 §4.1.3 — which text to actually send. Pure, so the suite can drive every branch
  // without a browser. The order is: the requested language, then English, then the original —
  // and the last step is unreachable for any question that got through clampCustomQuestions()
  // (English is mandatory), which is the point of keeping it: it is the only safe answer if a
  // future edit relaxes that requirement.
  function pickCustomQuestionText(q, lang) {
    if (!q) return '';
    var tr = q.translations || {};
    if (lang && tr[lang]) return tr[lang];
    if (tr.en) return tr.en;
    return q.text || '';
  }

  // ---------- 0.5.2 §5.1 自定义背景 ----------
  // §5.1.2 stores the image in IndexedDB, and that is right for the size — a photo is orders of
  // magnitude bigger than a settings blob, and chrome.storage.local's ~10MB is already shared
  // with 200 archives.
  //
  // ⚠ But IndexedDB here belongs to the EXTENSION origin, and a content script's `indexedDB` is
  // the HOST PAGE's (the same constraint custom-engine.js documents). So the 浮层 can never read
  // this store itself — content.js gets its image as a DATA URL through a `gm-bg-get` message
  // (see background.js). A data URL is used rather than a blob URL because the overlay's CSS is
  // evaluated in the page's origin, where a `blob:chrome-extension://…` URL is cross-origin and
  // subject to the page's own `img-src`.
  //
  // The two slots are independent (§5.1.5): different file, opacity, blur and offset.
  var BG_DB_NAME = 'bai-shen-backgrounds';
  var BG_DB_VERSION = 1;
  var BG_STORE = 'backgrounds';
  var BG_SLOTS = ['bg-overlay', 'bg-viewer'];
  // 4MB. A background is decorative and the whole thing round-trips as base64 (≈+33%) to reach
  // the overlay, so a larger file would cost more than it shows.
  var BG_MAX_BYTES = 4 * 1024 * 1024;
  var DEFAULT_BG = { opacity: 80, blur: 0, offsetX: 50, offsetY: 50, scale: 100 };

  function clampBgConfig(c) {
    var src = (c && typeof c === 'object') ? c : {};
    var n = function (v, lo, hi, dflt) {
      var x = Number(v);
      return isFinite(x) ? Math.max(lo, Math.min(hi, x)) : dflt;
    };
    return {
      opacity: Math.round(n(src.opacity, 0, 100, DEFAULT_BG.opacity)),
      blur: Math.round(n(src.blur, 0, 20, DEFAULT_BG.blur)),
      offsetX: Math.round(n(src.offsetX, 0, 100, DEFAULT_BG.offsetX)),
      offsetY: Math.round(n(src.offsetY, 0, 100, DEFAULT_BG.offsetY)),
      scale: Math.round(n(src.scale, 100, 400, DEFAULT_BG.scale)),
    };
  }

  function bgDb() {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      return Promise.reject(new Error('indexedDB unavailable'));
    }
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(BG_DB_NAME, BG_DB_VERSION); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(BG_STORE)) {
          db.createObjectStore(BG_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
      req.onblocked = function () { reject(new Error('indexedDB blocked by another context')); };
    });
  }

  function bgTx(mode, fn) {
    return bgDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t;
        try { t = db.transaction(BG_STORE, mode); } catch (e) { reject(e); return; }
        var store = t.objectStore(BG_STORE);
        var out;
        try { out = fn(store); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error || new Error('indexedDB transaction failed')); };
        t.onabort = function () { reject(t.error || new Error('indexedDB transaction aborted')); };
      });
    });
  }

  // Returns `{blob, ...config}` or null. A row with no blob is treated as absent: an image is
  // the only reason the row exists, and a config with nothing to paint would be a slider panel
  // that controls nothing.
  function loadBackground(slot) {
    if (BG_SLOTS.indexOf(slot) < 0) return Promise.resolve(null);
    return bgDb().then(function (db) {
      return new Promise(function (resolve) {
        var t;
        try { t = db.transaction(BG_STORE, 'readonly'); } catch (e) { resolve(null); return; }
        var req = t.objectStore(BG_STORE).get(slot);
        req.onsuccess = function () {
          var row = req.result;
          if (!row || !row.blob) { resolve(null); return; }
          resolve(Object.assign({ blob: row.blob }, clampBgConfig(row)));
        };
        req.onerror = function () { resolve(null); };
      });
    }, function () { return null; });
  }

  function saveBackground(slot, blob, config) {
    if (BG_SLOTS.indexOf(slot) < 0) return Promise.reject(new Error('unknown slot'));
    var cfg = clampBgConfig(config);
    if (blob && blob.size > BG_MAX_BYTES) {
      return Promise.reject(new Error('too-large:' + blob.size));
    }
    return bgTx('readwrite', function (store) {
      store.put(Object.assign({ key: slot, blob: blob, updatedAt: Date.now() }, cfg));
      return true;
    });
  }

  // The sliders move without a new file, so the blob is read back and written through. Returns
  // false when there was nothing to update, which is what stops the panel from creating a
  // config-only row.
  function saveBackgroundConfig(slot, config) {
    return loadBackground(slot).then(function (cur) {
      if (!cur) return false;
      return saveBackground(slot, cur.blob, Object.assign({}, cur, config)).then(function () { return true; });
    });
  }

  function clearBackground(slot) {
    if (BG_SLOTS.indexOf(slot) < 0) return Promise.resolve(false);
    return bgTx('readwrite', function (store) { store.delete(slot); return true; });
  }

  // The blob → data URL conversion, in one place. Only the extension origin can call this
  // usefully (FileReader is origin-independent, but the BLOB has to be readable first).
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      if (!blob) { resolve(''); return; }
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { reject(fr.error || new Error('read failed')); };
        fr.readAsDataURL(blob);
      } catch (e) { reject(e); }
    });
  }

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
        if (list[i].id === id) { list[i].name = name; list[i].nameIsDefault = false; hit = list[i]; }
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

  // ---------- 0.4.3 §1.4/§1.5: the two operator overrides ----------
  // Hand-drawn segments and a hand-picked AI class. Both live INSIDE `report` (so they travel
  // with the report through 存档 → 样本 and through an export, and the detail pane, the sample
  // editor and the learner all read one place) and both start as null, which is exactly what
  // makes 恢复自动分段 / 恢复自动分类 a matter of setting the override back to null rather than
  // deleting a field.
  //
  // §1.4 sketches a single `saveSegments(archiveId | sampleId, side, segments)`. Archives and
  // samples live under two different storage keys with two different shapes, and an id does
  // not say which library it came from — so the "which library" half cannot be inferred. The
  // viewer always knows which pane is open, and these entry points make it say so.
  function mutateReport(kind, id, fn) {
    return enqueue(async function () {
      var isArch = kind !== 'sample';
      var list = isArch ? await loadArchives() : await loadSamples();
      var hit = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { hit = list[i]; break; }
      }
      if (!hit) return null;
      if (!hit.report || typeof hit.report !== 'object') hit.report = {};
      fn(hit);
      if (isArch) await writeArchives(list); else await writeSamples(list);
      return hit;
    });
  }

  function segSlot(report) {
    if (!report.manualSegments || typeof report.manualSegments !== 'object') {
      report.manualSegments = { B: null, W: null };
    }
    return report.manualSegments;
  }
  function typeSlot(report) {
    if (!report.manualType || typeof report.manualType !== 'object') {
      report.manualType = { B: null, W: null };
    }
    return report.manualType;
  }

  function saveArchiveSegments(id, side, segments) {
    return mutateReport('archive', id, function (a) {
      segSlot(a.report)[side] = copySegList(segments);
    });
  }
  function saveSampleSegments(id, side, segments) {
    return mutateReport('sample', id, function (s) {
      segSlot(s.report)[side] = copySegList(segments);
    });
  }
  // `value` is a type code (see app.js TYPE_OF_BAND / classifySide) or null to drop back to
  // the automatic answer. The archive's lifted `types` copy is refreshed in the same write so
  // the list badge and the detail row can never disagree about which one is authoritative.
  function saveArchiveType(id, side, value) {
    return mutateReport('archive', id, function (a) {
      typeSlot(a.report)[side] = (typeof value === 'string' && value) ? value : null;
      var lifted = (a.types && typeof a.types === 'object') ? a.types : (a.types = { B: null, W: null });
      lifted[side] = resolveType(a.report, side);
    });
  }
  function saveSampleType(id, side, value) {
    return mutateReport('sample', id, function (s) {
      typeSlot(s.report)[side] = (typeof value === 'string' && value) ? value : null;
    });
  }

  // Categories are never stored on their own — they are derived from the archives,
  // so a category disappears exactly when its last member does.
  function listCategories(list) {    var seen = {}, out = [];
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
        if (want[list[i].id]) { list[i].name = nm; list[i].nameIsDefault = false; n++; }
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
    var hadName = !!entry.name;
    if (!entry.name) entry.name = defaultArchiveName(entry);
    // 0.4.11 §一.4 — carry the flag across an export/import. An entry exported by 0.4.11 says
    // for itself whether its name was generated; one from an older build (or hand-written)
    // does not, and the honest reading is "the file carried a name, so it is the operator's".
    entry.nameIsDefault = (typeof raw.nameIsDefault === 'boolean') ? raw.nameIsDefault : !hadName;
    // 0.4.2 §4.1: the family, when the specific opening is not known. Derived from whatever
    // the entry or the record carries, so a pre-0.4.2 archive (code only) answers the 大类
    // filter too.
    entry.openingFamily = openingFamilyOf(entry);
    // 0.4.3 §4.3: re-lift the AI class whenever raw.types is missing (an archive exported by
    // a pre-0.4.3 build, or hand-written) so buildArchive and normalizeArchive cannot produce
    // two entries that disagree about the same game.
    entry.types = { B: resolveType(entry.report, 'B'), W: resolveType(entry.report, 'W') };
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
  // 0.3.3 §3.5 / 0.4.2 §2.3. Every term of the risk score lives in ONE table. Through 0.5.5 §1.3 and
  // 0.5.6 §2 that table summed to 1.00 as a whole (好点池 became a first-class term, and §2 moved the
  // split without moving the total). **0.5.6 补增 §三 replaced that total**, and **补增 §三 后续
  // replaced its composition**: the operator tunes the table in the 检测信号权重 panel, and 补增 §三
  // shipped their hand-tuned 1.30 — which scored 36.8 on their own 127 archived sides against 0.5.3's
  // 46.9, because 34% of it sat on terms that never fire. 后续 restored 0.5.3's shape (six statistics
  // 1.00 + seven behaviour signals 0.30) and kept the total at **1.30 — exactly the 130% ceiling**,
  // so the invariant is still 「0 < Σ ≤ SIGNAL_WEIGHT_SUM_MAX (1.30)」. See app.js BASE_WEIGHTS for
  // the history and for what the change means for a score.
  //
  // This is the same literal set as app.js BASE_WEIGHTS and learn.js FALLBACK_WEIGHTS — the three
  // are one set of numbers. A value that is absent or non-numeric here is ignored by riskParams(),
  // so a profile written before this build simply keeps its own stored numbers.
  var DEFAULT_WEIGHTS = {
    top1: 0.20, acpl: 0.08, sharp: 0.22, out: 0.27, desperate: 0.08, time: 0.15,
    evasion: 0.07, winBlunder: 0.04,
    uselessFour: 0.06,
    sharpStreak: 0.04,
    sharpTotal: 0.03,
    goodPool: 0.03,
    liveThree: 0.03,
  };
  // 0.5.6 补增 §三 — the two ceilings on the operator's own weight table (see DEFAULTS above).
  //
  // `SIGNAL_WEIGHT_MAX` is one signal as a fraction of the score: 1.00 means "this signal alone
  // could carry a full 100-point score". `SIGNAL_WEIGHT_SUM_MAX` is the whole table: since
  // 补增 §三 the SHIPPED default is **1.30, i.e. the entire ceiling** (see DEFAULT_WEIGHTS) and an
  // operator may not go above it. It is a ceiling and not a target: a profile that never opened the
  // panel runs at the shipped 1.30, which is 0.5.3's table (1.28) with its seven behaviour signals
  // scaled up to fill the ceiling.
  //
  // The sum is deliberately NOT a renormalisation budget. The risk score is
  // `clamp(Σ weight_i × a_i × 100, 0, 100)` against the 70/40 cuts, so a table of 1.30 makes a
  // game cross those cuts more easily and lets the clamp at 100 be reached without every signal
  // firing —「更容易过线」, not「分数能到 130」. That is the whole meaning of the headroom, and the
  // reason it is bounded at all: without a ceiling a stray profile is a detector that flags
  // everything.
  var SIGNAL_WEIGHT_MAX = 1;
  var SIGNAL_WEIGHT_SUM_MAX = 1.30;
  // See app.js's SIGNAL_WEIGHT_EPS: the operator's percentages sum in binary floating point, and a
  // table that reaches exactly 130% by hand can land one ulp above it. Both files absorb that with
  // the same tolerance, because a ceiling that refuses a set the other side accepted is two
  // answers to one question.
  var SIGNAL_WEIGHT_EPS = 1e-9;
  var DEFAULT_THRESHOLDS = {
    // 0.4.3 §1.1: the ramp aTop1 reads now that it is fed a graded proximity instead of a
    // top-1 rate. `top1Lo`/`top1Hi` below are kept — a pre-0.4.3 archive and the
    // `opts.legacyTop1` comparison path still describe themselves with them — but the
    // detector no longer consumes them.
    // 0.4.7 §1.2: Lo moves 0.50 -> 0.45 so the three-tier proximity of stepProximity() is
    // actually reachable. See app.js BASE_THRESHOLDS for the reasoning.
    topProxLo: 0.45, topProxHi: 0.90, // aTop1 proximity ramp
    top1Lo: 0.72, top1Hi: 0.90,     // 0.3.1 top-1 ramp, retained for compatibility
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
    // 0.4.3 §1.6: the four cut lines behind the five risk bands. Right-open on whole points —
    // 75 is AI, 74 is 疑似AI. A band is a summary of the risk score, not a second opinion
    // about it: nothing here feeds back into the score.
    typeAiMin: 75, typeSuspectMin: 55, typeProMin: 45, typeExpertMin: 30,
    // 0.4.7 §1.1: the two win-rate bounds a four run is classified with — the value of the best
    // move in the position BEFORE the run started. >= fourVcfWR is a conversion (VCF, not
    // scored); <= fourLostWR is a lost player firing fours that change nothing (scored).
    // Anything between is 防御性冲四: real, reported, not scored.
    fourVcfWR: 0.90, fourLostWR: 0.10,
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

  // ============================================================================
  // 0.4.9 §一.4 — the local player blacklist
  // ============================================================================
  // §1.1 is explicit about what this is for and — more to the point — what it is not: the
  // username is collected so that a cheat can be written down locally and warned about on the
  // next meeting. Nothing here ever leaves the machine; there is no endpoint, no telemetry and
  // no "share" path, and every write goes to `chrome.storage.local` through the same serial
  // chain as every other key.
  //
  // §1.2 is the reason the key is `id` and not the display name. A display name is user-editable
  // and not unique (two players can both be 「宇髓天元突破」); the username is neither. The
  // display name is still stored, but only as a label to show a human — it is refreshed on every
  // encounter and never matched on.
  //
  // The whole object is ONE key so that the list is written atomically: a read-modify-write of
  // `players` cannot interleave with another and lose an entry, which is exactly the failure
  // `enqueue()` exists to prevent.

  function blacklistId(v) {
    if (v == null) return null;
    var s = String(v).trim();
    return s ? s : null;
  }

  // Ids are compared case-insensitively and trimmed on both sides. The three collection routes
  // (§1.3: the page meta, the socket payload, the profile URL) are three different renderings of
  // one id, and a route that disagrees about case would otherwise produce a second entry for the
  // same player — i.e. a blacklist that warns about someone the operator already blocked.
  function blacklistEq(a, b) {
    var x = blacklistId(a), y = blacklistId(b);
    if (x == null || y == null) return false;
    return x.toLowerCase() === y.toLowerCase();
  }

  function blacklistIndexOf(list, id) {
    for (var i = 0; i < list.length; i++) if (blacklistEq(list[i] && list[i].id, id)) return i;
    return -1;
  }

  function sanitizeBlacklistEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = blacklistId(raw.id);
    if (!id) return null;                       // an entry with no username cannot be matched
    var now = Date.now();
    var added = Number(raw.addedAt);
    var seen = Number(raw.lastSeen);
    var n = Number(raw.encounterCount);
    return {
      id: id,
      displayName: raw.displayName == null ? null : String(raw.displayName).slice(0, 40),
      note: raw.note == null ? null : String(raw.note).slice(0, 200),
      addedAt: isFinite(added) && added > 0 ? added : now,
      lastSeen: isFinite(seen) && seen > 0 ? seen : (isFinite(added) && added > 0 ? added : now),
      encounterCount: isFinite(n) && n > 0 ? Math.floor(n) : 1,
      // Anything that is not a value this build writes is treated as a manual entry: the field is
      // a label, and an unknown value from an older/hand-edited profile must not become a state
      // the UI has no wording for. 0.4.11 §一.7 adds the third value — see addToBlacklist.
      source: BLACKLIST_SOURCES[raw.source] ? raw.source : 'manual',
    };
  }

  function normalizeBlacklist(raw) {
    var list = raw && Array.isArray(raw.players) ? raw.players : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = sanitizeBlacklistEntry(list[i]);
      if (!e) continue;
      // De-duplicate on the way in as well as on the way out. A hand-edited JSON, or a profile
      // written by a build whose id comparison differed, is the one input neither writer sees.
      if (blacklistIndexOf(out, e.id) >= 0) continue;
      out.push(e);
    }
    return { version: 1, players: out };
  }

  async function loadBlacklist() {
    var got = null;
    try { got = await api().get(BLACKLIST_KEY); } catch (e) { got = null; }
    return normalizeBlacklist(got && got[BLACKLIST_KEY]);
  }

  function writeBlacklist(bl) {
    return enqueue(async function () {
      var put = {}; put[BLACKLIST_KEY] = bl;
      try { await api().set(put); } catch (e) {}
      return bl;
    });
  }

  /** Add (or refresh) an entry. §1.6's overlay button and §1.7's manual form both come here. */
  // 0.4.11 §一.7 — `source` is a PARAMETER, not a constant. It used to be hard-coded to
  // 'overlay', so an id typed into the viewer's 黑名单 page — where there is no overlay and no
  // game in progress — was filed as 「来自浮层」. The default is 'manual' rather than 'overlay'
  // because the unsafe direction is the one that claims a provenance it cannot have: the
  // caller that really is the overlay says so explicitly.
  var BLACKLIST_SOURCES = { overlay: 1, manual: 1, import: 1 };

  function addToBlacklist(id, displayName, note, source) {
    source = BLACKLIST_SOURCES[source] ? source : 'manual';
    return enqueue(async function () {
      var got = null;
      try { got = await api().get(BLACKLIST_KEY); } catch (e) { got = null; }
      var bl = normalizeBlacklist(got && got[BLACKLIST_KEY]);
      var now = Date.now();
      var at = blacklistIndexOf(bl.players, id);
      var cleanId = blacklistId(id);
      if (!cleanId) return bl;
      if (at >= 0) {
        // Already there: refresh the label and the note rather than stacking a duplicate.
        var cur = bl.players[at];
        if (displayName) cur.displayName = String(displayName).slice(0, 40);
        if (note != null) cur.note = String(note).slice(0, 200);
      } else {
        bl.players.push({
          id: cleanId,
          displayName: displayName ? String(displayName).slice(0, 40) : null,
          note: note != null ? String(note).slice(0, 200) : null,
          addedAt: now,
          lastSeen: now,
          encounterCount: 0,
          source: source,
        });
      }
      // Newest first, and capped. Trimming from the TAIL keeps the most recently added entries,
      // which is the opposite of the archive list's rule and correct here: a block list is
      // ordered by when the operator last cared, not by when the game happened.
      bl.players.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
      if (bl.players.length > MAX_BLACKLIST) bl.players = bl.players.slice(0, MAX_BLACKLIST);
      var put = {}; put[BLACKLIST_KEY] = bl;
      try { await api().set(put); } catch (e) {}
      return bl;
    });
  }

  function removeFromBlacklist(id) {
    return enqueue(async function () {
      var got = null;
      try { got = await api().get(BLACKLIST_KEY); } catch (e) { got = null; }
      var bl = normalizeBlacklist(got && got[BLACKLIST_KEY]);
      var at = blacklistIndexOf(bl.players, id);
      if (at < 0) return bl;
      bl.players.splice(at, 1);
      var put = {}; put[BLACKLIST_KEY] = bl;
      try { await api().set(put); } catch (e) {}
      return bl;
    });
  }

  function setBlacklistNote(id, note) {
    return enqueue(async function () {
      var got = null;
      try { got = await api().get(BLACKLIST_KEY); } catch (e) { got = null; }
      var bl = normalizeBlacklist(got && got[BLACKLIST_KEY]);
      var at = blacklistIndexOf(bl.players, id);
      if (at < 0) return bl;
      bl.players[at].note = note == null || note === '' ? null : String(note).slice(0, 200);
      var put = {}; put[BLACKLIST_KEY] = bl;
      try { await api().set(put); } catch (e) {}
      return bl;
    });
  }

  /** §1.5 — the match-time lookup. Returns the ENTRY, not a boolean: the caller shows its note. */
  async function isBlacklisted(id) {
    var cleanId = blacklistId(id);
    if (!cleanId) return null;
    var bl = await loadBlacklist();
    var at = blacklistIndexOf(bl.players, cleanId);
    return at < 0 ? null : bl.players[at];
  }

  /**
   * §1.5 — bump lastSeen / encounterCount for a player we just met again.
   *
   * Deliberately bumps the count only when the entry was LAST SEEN at an earlier time than the
   * same session's previous bump would allow… in practice: every call is one encounter, and the
   * caller is the per-game blacklist check, which runs once per game. A guard against a double
   * count inside one game therefore lives in content.js (the check is keyed on the game epoch),
   * not here — a storage layer that second-guessed its caller could not know what a game is.
   */
  function touchBlacklistEntry(id, displayName) {
    return enqueue(async function () {
      var got = null;
      try { got = await api().get(BLACKLIST_KEY); } catch (e) { got = null; }
      var bl = normalizeBlacklist(got && got[BLACKLIST_KEY]);
      var at = blacklistIndexOf(bl.players, id);
      if (at < 0) return bl;
      var cur = bl.players[at];
      if (displayName) cur.displayName = String(displayName).slice(0, 40);
      cur.lastSeen = Date.now();
      cur.encounterCount = (Number(cur.encounterCount) || 0) + 1;
      var put = {}; put[BLACKLIST_KEY] = bl;
      try { await api().set(put); } catch (e) {}
      return bl;
    });
  }

  /**
   * §1.7 — import, on the same envelope the archive/sample libraries use. Accepts the written
   * envelope, a bare array, or a `{players:[…]}` object, because the three are all things a
   * person might hand it and refusing two of them would only look like a bug.
   *
   * `mode` is 'merge' (default) or 'replace'. Merge keeps existing entries and updates the ones
   * the file names; replace is the escape hatch for "restore this backup exactly".
   */
  function importBlacklist(incoming, mode) {
    return enqueue(async function () {
      var list = Array.isArray(incoming) ? incoming
        : (incoming && Array.isArray(incoming.players)) ? incoming.players : null;
      if (!list) return { added: 0, updated: 0, total: 0 };
      var got = null;
      try { got = await api().get(BLACKLIST_KEY); } catch (e) { got = null; }
      var bl = mode === 'replace' ? { version: 1, players: [] } : normalizeBlacklist(got && got[BLACKLIST_KEY]);
      var added = 0, updated = 0;
      for (var i = 0; i < list.length; i++) {
        var e = sanitizeBlacklistEntry(list[i]);
        if (!e) continue;
        // 0.4.11 §一.7 — a row that arrived in a file is marked as such, whatever the file
        // claimed: `source` describes how THIS copy got into the list. Re-importing an export
        // therefore re-labels everything 导入, which is the honest description of what happened.
        e.source = 'import';
        var at = blacklistIndexOf(bl.players, e.id);
        if (at >= 0) {
          var cur = bl.players[at];
          cur.displayName = e.displayName || cur.displayName;
          cur.note = e.note != null ? e.note : cur.note;
          cur.addedAt = Math.min(cur.addedAt || e.addedAt, e.addedAt);
          cur.lastSeen = Math.max(cur.lastSeen || 0, e.lastSeen || 0);
          cur.encounterCount = Math.max(Number(cur.encounterCount) || 0, e.encounterCount);
          updated++;
        } else {
          bl.players.push(e);
          added++;
        }
      }
      bl.players.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
      if (bl.players.length > MAX_BLACKLIST) bl.players = bl.players.slice(0, MAX_BLACKLIST);
      var put = {}; put[BLACKLIST_KEY] = bl;
      try { await api().set(put); } catch (e) {}
      return { added: added, updated: updated, total: bl.players.length };
    });
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
  //
  // 0.4.6 §一: this function never wrote "unnamed" — the reported "unnamed game" came from
  // viewer.js's displayName(), which is where the real fix is. What was still wrong here is the
  // half-filled COLOUR pair: `black` known and `white` not produced no pair at all, throwing away
  // the one name the record actually had. The self/opponent branch below has always covered its
  // own half; this makes the colour branch do the same.
  function defaultArchiveName(a) {
    var p = a.players || {};
    var pair = '';
    if (p.black && p.white) pair = p.black + ' VS ' + p.white + '  ';
    else if (p.self || p.opponent) pair = (p.self || '?') + ' VS ' + (p.opponent || '?') + '  ';
    else if (p.black || p.white) pair = (p.black || T('archive|黑')) + ' VS ' + (p.white || T('archive|白')) + '  ';
    // 完全无名时不写 pair —— 手数 + 时间 + 风险分已足够识别
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
      // 0.4.7 §1.4: the sixth-to-eighth candidate tier. Only ever true on a hand whose recorded
      // thinking time exceeded 6s (see app.js nbestFor), so a pre-0.4.7 archive — which has no
      // such field — reads as false and grades exactly as it did before.
      top8: !!s.top8,
      bestWR: s.bestWR, actualWR: s.actualWR, loss: s.loss,
      isSharp: !!s.isSharp, forcedDefense: !!s.forcedDefense, desperate: !!s.desperate,
      // 0.4.8 §1.1: which test produced the exemption — 'shape' (the board's only blocking
      // point) or 'engine' (the 0.4.7 win-rate gap). Kept so the operator can tell a hand the
      // shape test rescued from a hand the engine had already agreed about, and so a
      // regression in either path is visible in an archived game rather than only in a rerun.
      forcedDefenseHow: s.forcedDefenseHow || null,
      // 0.5.0 §1.1: this hand held a 跳四 + 活三, which is NOT a 四三杀, so detection did not
      // stop here. Kept per step because the badge is the only way the operator can see WHY a
      // four that looks like a kill did not end the game — the absence of a stopReason is
      // otherwise indistinguishable from a detection that simply missed it.
      jumpFourFlag: !!s.jumpFourFlag,
      // 0.4.8 §1.3: present only on a four-three hand. `counter: true` records that the
      // defender's block was itself a four, which is why detection did NOT stop there.
      fourThreeCounter: s.fourThreeCounter || null,
      // 0.4.8 §1.2: this hand's position inside its 唯一手 run (0 when it is not a hit). Stamped
      // by sharpStreakStats() in app.js so the step table can print 「唯一手（连续 K）」 without
      // re-deriving the run — see that function for why the walk exists in exactly one place.
      sharpStreak: isFinite(s.sharpStreak) ? s.sharpStreak : 0,
      // 0.5.2 §1.1/§1.2: the two pool figures for this hand, plus the three 活三 flags. Kept per
      // step for the same reason `sharpStreak` above is: the step table prints the run length
      // beside the hand that ended it, and re-deriving the run in the viewer would be a second
      // copy of the walk. `liveThreeDefense` is kept because the badge has to survive a reload —
      // it is the only place the operator can see that a hand was scored on a two-way defence.
      goodPool: isFinite(s.goodPool) ? s.goodPool : 0,
      liveThreePool: isFinite(s.liveThreePool) ? s.liveThreePool : 0,
      liveThreeDefense: !!s.liveThreeDefense,
      // 0.5.5 §四: the 好点 predicate's own verdict, persisted so a reader does not have to
      // re-derive the rule from top5/top8/thinkMs — three of the fields it reads, and the one
      // of them (top8) that only exists on a hand the engine was given eight candidates for.
      // `liveThreeDefense` above is kept for the same class of reason.
      isGood: !!s.isGood,
      // 0.4.7 §1.1: the four-run classification. Kept per step so the badge survives a reload,
      // and `prevBestWR` beside it because the archive's own reader may want to re-derive the
      // kind (the classification is a function of this one number plus the run's extent).
      fourRun: isFinite(s.fourRun) ? s.fourRun : 0,
      fourKind: s.fourKind || null,
      // 0.4.7 §1.1 — the raw input the two fields above are DERIVED from: scoreStep() stamps it
      // from the board after the hand, markFourRuns() groups it into runs and labels them. Kept
      // for the same reason `prevBestWR` is: the archive claims to be re-derivable, and a reader
      // that re-ran markFourRuns() over these steps would get zero runs for every game if the
      // flag it reads were dropped here. It is a boolean, so it costs one byte.
      four: !!s.four,
      prevBestWR: s.prevBestWR == null ? null : s.prevBestWR,
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

  // ---------- share-string coordinates ----------
  // §4.1.2 of 0.5.4 needs 棋谱代码 in the OVERLAY — a content script, which does not load
  // app.js — and app.js has had `coordToShare()` since 0.1.0. Two readings of one mapping is
  // the failure this project has paid for four times, and there were in fact already two: the
  // `coordStr()` below is the same mapping with a `—` for a bad point. So the mapping moved
  // HERE, into the one file loaded by every realm that needs it — the viewer (`viewer.html`),
  // the engine host (`offscreen.html`) and the content script (`manifest.content_scripts`) —
  // and app.js's two names are now thin aliases.
  //
  // The convention, spelled out once because it is the confusing part:
  //   `(x, y)` in this codebase has x = column 0..14 left→right and y = ROW 0..14 TOP→BOTTOM;
  //   a share token is `COL[x]` + a row number counted from the BOTTOM, i.e. `SIZE - y`.
  //   So y = 0 (top) is row 15 and y = 14 (bottom) is row 1 — the same thing `shareToCoord`
  //   inverts ("y:0=top -> number = SIZE - y"), and `verify-057` round-trips all 225 points.
  var BOARD_SIZE = 15;
  var SHARE_COL = 'abcdefghijklmno';

  /** `[x, y]` -> "h8". Null (not a throw) for anything off the board or not a pair. */
  function coordToShare(p) {
    if (!p || p.length < 2) return null;
    var x = p[0], y = p[1];
    if (!isFinite(x) || !isFinite(y)) return null;
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return null;
    return SHARE_COL.charAt(Math.round(x)) + (BOARD_SIZE - Math.round(y));
  }

  /** "h8" -> `[x, y]`. Total: an unparsable token or an off-board number gives null. */
  function shareToCoord(s) {
    var m = String(s == null ? '' : s).match(/^([a-z])(\d+)$/i);
    if (!m) return null;
    var x = m[1].toLowerCase().charCodeAt(0) - 97;
    var y = BOARD_SIZE - parseInt(m[2], 10);
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return null;
    return [x, y];
  }

  function coordStr(p) {
    var t = coordToShare(p);
    return t == null ? '—' : t;
  }

  // ---------- 0.4.3 §1.2/§1.4/§1.5: segments and AI types ----------
  // Both are per-side, both are persisted inside `report`, and both come in an automatic and
  // an operator-edited flavour. The copies below exist so the stored object never aliases a
  // live array an editor may still be mutating (a drag commits a new array, but there is no
  // reason to depend on that), and so a hand-edited storage blob cannot smuggle extra fields
  // into a shape every reader walks.
  function copySegList(list) {
    if (!Array.isArray(list)) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || typeof s !== 'object') continue;
      var from = Number(s.from), to = Number(s.to);
      if (!isFinite(from) || !isFinite(to) || from > to) continue;
      out.push({ from: from, to: to, kind: s.kind === 'low' ? 'low' : 'high' });
    }
    return out.length ? out : null;
  }
  function copySegs(ms) {
    ms = ms || {};
    return { B: copySegList(ms.B), W: copySegList(ms.W) };
  }
  function copyManualType(mt) {
    mt = mt || {};
    return {
      B: (typeof mt.B === 'string' && mt.B) ? mt.B : null,
      W: (typeof mt.W === 'string' && mt.W) ? mt.W : null,
    };
  }
  // 0.4.7 §1.1: the three run counts. Copied field by field rather than passed through, so a
  // hand-edited storage blob cannot smuggle extra keys into a shape the viewer walks — and so
  // the object is never a live alias of the analysis result.
  function copyFourRuns(v) {
    v = v || {};
    return {
      vcf: isFinite(v.vcf) ? v.vcf : 0,
      useless: isFinite(v.useless) ? v.useless : 0,
      defensive: isFinite(v.defensive) ? v.defensive : 0,
    };
  }
  // 0.4.8 §1.3: the four-threes a counter-four answered. Rebuilt entry by entry off known
  // fields only, so the stored list is a plain array of plain objects and a hand-edited value
  // cannot introduce a shape (or a prototype) the viewer's renderer has never seen.
  function copyFourThreeCounters(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var x = v[i];
      if (!x || typeof x !== 'object') continue;
      var blk = Array.isArray(x.block) && x.block.length >= 2 ? [Number(x.block[0]), Number(x.block[1])] : null;
      out.push({
        moveNo: isFinite(x.moveNo) ? x.moveNo : null,
        side: (x.side === 'B' || x.side === 'W') ? x.side : null,
        block: blk,
      });
    }
    return out;
  }
  // The automatic classification, copied field by field so the archive carries a plain object
  // rather than a reference to the analysis result. `auto` is stored explicitly: it is what
  // tells a later reader that nobody has overridden this yet.
  function copyTypes(ts) {    ts = ts || {};
    var out = { B: null, W: null };
    ['B', 'W'].forEach(function (side) {
      var x = ts[side];
      if (!x || !x.type) return;
      out[side] = {
        suspect: x.suspect || null, type: x.type, auto: x.auto !== false,
        lowSteps: isFinite(x.lowSteps) ? x.lowSteps : 0,
        // 0.4.7 §1.3: the shape of the dips, which is what actually decides the label now.
        // Persisted so the viewer can explain a label ("3 dips, longest 2") instead of only
        // asserting it, and so a pre-0.4.7 archive (no such fields) reads as 0/0 rather than
        // as a JSON error.
        lowRuns: isFinite(x.lowRuns) ? x.lowRuns : 0,
        lowMax: isFinite(x.lowMax) ? x.lowMax : 0,
      };
    });
    return out;
  }
  // The type a reader should show for one side: the operator's override when there is one,
  // otherwise the automatic result. Used by buildArchive() to lift the answer onto the entry —
  // the list draws a badge without opening the detail, so it cannot afford to walk the report.
  function resolveType(rep, side) {
    var r = rep || {};
    var mt = copyManualType(r.manualType);
    if (mt[side]) return { type: mt[side], manual: true };
    var t = copyTypes(r.types)[side];
    return t ? { type: t.type, manual: false } : null;
  }

  // 0.4.4 §14. `chatHistory` is capped at 20 entries by content.js and each entry is a handful
  // of short strings, so the pair costs a few hundred bytes at most — well inside the archive
  // budget, and far smaller than the `steps` array beside it.
  function copyChatAdjust(v) {
    if (!v) return null;
    return {
      side: v.side === 'B' || v.side === 'W' ? v.side : null,
      asks: v.asks || 0,
      total: v.total || 0,
      how: typeof v.how === 'string' ? v.how : null,
    };
  }
  function copyChatHistory(v) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 20).map(function (h) {
      return {
        qid: String(h.qid || ''),
        q: String(h.q || '').slice(0, 200),
        answer: String(h.answer || '').slice(0, 200),
        verdict: String(h.verdict || ''),
        delta: h.delta || 0,
        at: h.at || null,
      };
    });
  }

  function slimReport(rep) {
    if (!rep) return null;
    var agg = function (a) {
      if (!a) return null;
      return {
        side: a.side, n: a.n, risk: a.risk, level: a.level,
        top1: a.top1, top3: a.top3, top5: a.top5, meanLoss: a.meanLoss,
        // 0.4.3 §1.1: the graded mean aTop1 reads. Kept beside top1/top3/top5 because it is a
        // different number about the same hands and it is what the score was actually made of.
        topProx: a.topProx,
        sharpHit: a.sharpHit, sharpCount: a.sharpCount, outTop5: a.outTop5,
        desperateCount: a.desperateCount,
        // 0.4.2 §二: how many of this side's hands were evasions, how regular their rhythm was
        // (0..1), and how many were 将胜乱下. Excluded from n/top1/meanLoss above — that
        // exclusion is the point of the signal, so the totals here and the percentages there
        // deliberately count different hands.
        evasionCount: a.evasionCount || 0,
        winBlunderCount: a.winBlunderCount || 0,
        evasionRegularity: a.evasionRegularity || 0,
        // 0.4.7 §1.1: how many of this side's hands carried a useless-four run (one of the
        // terms the risk score was actually made of) and how many runs of each kind there
        // were. Both default to 0 so a pre-0.4.7 archive reports the same figures it always
        // did rather than `undefined` leaking into the detail table.
        uselessFourCount: a.uselessFourCount || 0,
        fourRuns: copyFourRuns(a.fourRuns),
        // 0.4.8 §1.2: the two 唯一手 streak figures. Deliberately NOT defaulted to 0 — an
        // archive written before this build never computed them, and the detail table prints
        // `—` for that case rather than claiming a clean scan that never ran (the same
        // distinction `evasionCount` draws a few lines above).
        sharpStreakMax: a.sharpStreakMax == null ? null : a.sharpStreakMax,
        sharpStreakHits: a.sharpStreakHits == null ? null : a.sharpStreakHits,
        // 0.5.5 §1.4.1: the two 好点 figures the metric table prints. Deliberately NOT defaulted —
        // an archive written before this build has no `goodStreak` at all (the old `goodPoolMax`
        // measured a DIFFERENT quantity, 好点 being Top3 then and Top5 now), so the viewer prints
        // `—` for it rather than re-labelling an old number with the new name. Same distinction
        // `sharpStreakMax` above draws.
        goodRatio: a.goodRatio == null ? null : a.goodRatio,
        goodCount: a.goodCount == null ? null : a.goodCount,
        goodTotal: a.goodTotal == null ? null : a.goodTotal,
        goodStreak: a.goodStreak == null ? null : a.goodStreak,
        // ⚠ 0.5.2 wrote neither pool figure into the archive at all, so the viewer's two pool rows
        // read `—` in the replay detail and real numbers in the live detail — the same archive
        // described itself differently depending on which pane it was open in. 0.5.5 persists
        // both; the row's own formatter still prints `—` for the archives that predate them.
        liveThreeMax: a.liveThreeMax == null ? null : a.liveThreeMax,
        // 0.3.3 C: how many of this side's steps fingerprint-matched a known AI move.
        simCount: a.simCount || 0,
        time: a.time || null,
        contributions: a.contributions || null,
      };
    };
    return {
      createdAt: rep.createdAt || null,
      mode: rep.mode || null,
      // `buildReport` names it `suspect` (singular); this function writes it as `suspects`
      // (plural). Nothing reads the plural form today, but the asymmetry made slimReport
      // non-idempotent — and `normalizeArchive` feeds a report read back from storage
      // straight in here, so a second pass turned the setting into null. Read both, exactly
      // as the two fields below already do.
      suspects: (rep.suspect != null ? rep.suspect : rep.suspects) || null,
      // Already-slimmed input (0.3.3's 存档 → 转为样本 path feeds an archive's stored report
      // straight back in, and normalizeArchive does the same on every read) carries these two
      // under their slimmed names, not inside `opts`. Reading both keeps slimReport idempotent
      // instead of silently dropping them — and the DIRECT name has to be tested FIRST to
      // achieve that: with `rep.opts` in front, a report whose `opts` exists but lacks the key
      // wrote `undefined`, which the next pass turned into `null`.
      optThinkMs: rep.optThinkMs != null ? rep.optThinkMs
                 : (rep.opts && rep.opts.thinkMs != null ? rep.opts.thinkMs : null),
      openingCutoff: rep.openingCutoff != null ? rep.openingCutoff
                 : (rep.opts && rep.opts.openingCutoff != null ? rep.opts.openingCutoff : null),
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
      // 0.4.8 §1.3: the four-threes answered by a counter-four, which is why detection carried
      // on past them. Sanitised on the way in for the same reason the segment lists are: this
      // runs over a stored report on every read, so a hand-edited blob must not be able to
      // smuggle a shape every reader walks.
      fourThreeCounters: copyFourThreeCounters(rep.fourThreeCounters),
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
      // 0.4.3 §4.2/§4.3. `segments` and `types` are always the AUTOMATIC answer; the two
      // `manual*` objects are the operator's overrides and stay null until an edit happens.
      // Both survive a re-slim (this runs on every load, and on the 存档 → 样本 conversion),
      // so an edited archive is not silently reset by a round trip — the same idempotence the
      // `optThinkMs` / `openingCutoff` pair above exists for.
      segments: { B: copySegList((rep.segments || {}).B) || [], W: copySegList((rep.segments || {}).W) || [] },
      manualSegments: copySegs(rep.manualSegments),
      types: copyTypes(rep.types),
      manualType: copyManualType(rep.manualType),
      // 0.4.4 §14 — the chat exchange. Same idempotence requirement as the block above:
      // normalizeArchive feeds a STORED report back through here on every read, so a blind
      // `rep.chatAdjust` would survive only until the first round trip.
      chatAdjust: copyChatAdjust(rep.chatAdjust),
      chatHistory: copyChatHistory(rep.chatHistory),
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
    // 0.4.11 §一.4 — remember that this name was GENERATED, not typed. The old test for
    // "is this name still the default?" was a string comparison against a freshly generated
    // name, and defaultArchiveName embeds T('archive|黑') / T('archive|手') / T('archive|和棋').
    // Comparing a name built in the CREATION language against one built in the language live
    // NOW never matches, so switching the UI language marked every old archive as hand-renamed.
    // Records the fact instead of re-deriving it.
    entry.nameIsDefault = true;
    // 0.4.2 §4.1: see openingFamilyOf. A family-only capture has `opening: null` (the code IS
    // the name of a specific opening, and there is not one) but a known family, so the list
    // badge can say 直止/斜止 and the 大类 filter can find it.
    entry.openingFamily = openingFamilyOf(entry);
    // 0.4.3 §4.3: the per-side AI class, lifted onto the entry. The list draws a badge for a
    // game it never opened, so it cannot walk `entry.report` per card; `resolveType` returns
    // null when the report predates 0.4.3, and the list then shows nothing rather than
    // guessing a class out of a bare risk number.
    entry.types = { B: resolveType(entry.report, 'B'), W: resolveType(entry.report, 'W') };
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

  // =====================================================================
  // 0.5.6 §一 导出自定义数据 / 导入与退回
  // =====================================================================
  // One JSON file carrying the operator's local profile, with a per-category checkbox at BOTH
  // ends. §一.1's two uses — backup, and moving a profile to another machine — set the two rules
  // that shape everything below:
  //
  //   · the SECRET must not leave the machine. §1.2 excludes `llm.apiKey`, and that is enforced
  //     here in stripSecrets() rather than in the panel: a panel is a place a future caller can
  //     forget about, and this is a data function.
  //   · an IMPORTED setting this device cannot honour is REFUSED, not clamped (§1.6.1). Every
  //     other writer in this file clamps — a hand-edited profile should land on something legal —
  //     but an import is different because the operator is watching the result and will believe
  //     it. §1.6.1's own example: import 16 threads onto an 8-thread machine, a clamp stores 8
  //     without a word, and the operator walks away thinking the machine now runs 16.
  //
  // The whole round trip is driven from the STORAGE layer (viewer.js only renders), so the suite
  // can exercise it against the in-memory shim (`__memApi`) with no browser at all.
  var BACKUP_KIND = 'baishen-backup';
  var BACKUP_VERSION = 1;
  var EXPORT_CATEGORIES = ['settings', 'blacklist', 'samples', 'archives',
                           'customQuestions', 'customEngines', 'learnedParams',
                           'backgrounds', 'viewerCols'];
  // The settings key that already HAS its own category. Leaving it inside `settings` as well
  // would make §1.3's 「不勾选自定义问题」 impossible: the unchecked category would ride back in
  // on the checked one.
  var SPLIT_SETTINGS_KEYS = ['customQuestions'];
  // `bg-overlay` / `bg-viewer` are the storage slots; the file names each by the surface it
  // paints (§1.4's `backgrounds.overlay` / `.viewer`).
  var BG_EXPORT_ID = { 'bg-overlay': 'overlay', 'bg-viewer': 'viewer' };

  function appVersion() {
    try {
      if (g.chrome && g.chrome.runtime && g.chrome.runtime.getManifest) {
        return String(g.chrome.runtime.getManifest().version || '');
      }
    } catch (e) {}
    return '';
  }

  // §1.2 — the export-safe projection of `settings`. REBUILT rather than deleted-in-place so the
  // caller's object is never touched, and so a key added to DEFAULTS later is carried by default
  // (safe) rather than dropped by default (silently absent from every backup).
  function stripSecrets(settings) {
    var out = {};
    for (var k in (settings || {})) if (settings.hasOwnProperty(k)) out[k] = settings[k];
    if (out.llm && typeof out.llm === 'object') {
      var llm = {};
      for (var l in out.llm) if (out.llm.hasOwnProperty(l) && l !== 'apiKey') llm[l] = out.llm[l];
      out.llm = llm;
    }
    for (var i = 0; i < SPLIT_SETTINGS_KEYS.length; i++) delete out[SPLIT_SETTINGS_KEYS[i]];
    return out;
  }

  // Absent ⇒ every category. An explicit list is honoured category by category, and an unknown
  // name in it is ignored rather than carried into the output.
  function pickCategories(categories) {
    var want = Array.isArray(categories) ? categories : EXPORT_CATEGORIES;
    var out = {};
    for (var i = 0; i < EXPORT_CATEGORIES.length; i++) {
      out[EXPORT_CATEGORIES[i]] = want.indexOf(EXPORT_CATEGORIES[i]) >= 0;
    }
    return out;
  }

  async function exportCustomData(categories) {
    var cats = pickCategories(categories);
    var data = {};
    if (cats.settings) data.settings = stripSecrets(await loadSettings());
    if (cats.blacklist) data.blacklist = (await loadBlacklist()).players || [];
    if (cats.samples) data.samples = await loadSamples();
    if (cats.archives) data.archives = await loadArchives();
    if (cats.customQuestions) data.customQuestions = await loadCustomQuestions();
    if (cats.customEngines) {
      // Metadata only (§1.2): a weight package is up to 100MB and has no business in a JSON
      // backup. `list()` already strips the blob.
      var CE = g.GMCustomEngines;
      data.customEngines = (CE && CE.list) ? await CE.list() : [];
    }
    if (cats.learnedParams) data.learnedParams = await loadLearnedParams();
    if (cats.backgrounds) {
      var bg = {};
      for (var i = 0; i < BG_SLOTS.length; i++) {
        var row = await loadBackground(BG_SLOTS[i]);
        if (!row || !row.blob) continue;
        // A read failure degrades to "this slot is not in the backup", never to a failed export:
        // the file is still worth writing with the other eight categories in it.
        var url = '';
        try { url = await blobToDataUrl(row.blob); } catch (e) { url = ''; }
        if (!url) continue;
        var cfg = clampBgConfig(row);
        var rec = { blob: url };
        for (var c in cfg) if (cfg.hasOwnProperty(c)) rec[c] = cfg[c];
        bg[BG_EXPORT_ID[BG_SLOTS[i]]] = rec;
      }
      data.backgrounds = bg;
    }
    if (cats.viewerCols) {
      var got = null;
      try { got = await api().get('viewerCols'); } catch (e) { got = null; }
      data.viewerCols = (got && got.viewerCols && typeof got.viewerCols === 'object')
        ? got.viewerCols : {};
    }
    return {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      exportedAt: Date.now(),
      appVersion: appVersion(),
      data: data,
    };
  }

  // The inverse of blobToDataUrl. The header is matched whole (up to the first comma) so a
  // malformed one fails the regex instead of yielding a blob full of header text.
  function dataUrlToBlob(url) {
    var s = String(url == null ? '' : url);
    var m = /^data:([^;,]*)(;base64)?,/.exec(s);
    if (!m) return null;
    var body = s.slice(m[0].length);
    try {
      if (m[2]) {
        var bin = atob(body);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: m[1] || 'application/octet-stream' });
      }
      return new Blob([decodeURIComponent(body)], { type: m[1] || 'text/plain' });
    } catch (e) { return null; }
  }

  // §1.6.2 — every settings key that needs a rule of its own. Pure and synchronous: it takes the
  // imported object and the CURRENT settings and returns the object to save plus the list of
  // refusals, which is what lets the suite drive every branch with a fixture.
  //
  // A refused value leaves `next[key]` at the CURRENT value — not at a clamp, and not at a
  // default. That is §1.6.1's whole point, and it is also why `next` is a deep-enough copy: the
  // three object-valued settings are rebuilt through their own normalisers so a partial edit
  // cannot reach back into `current`.
  function validateImportedSettings(raw, current) {
    var errors = [];
    var applied = 0;
    var bad = function (key, value, reason) { errors.push({ key: key, value: value, reason: reason }); };
    var next = Object.assign({}, current || {});
    next.transparency = normalizeTransparency(current && current.transparency);
    next.archiveFilter = normalizeArchiveFilter(current && current.archiveFilter);
    next.storageFilter = normalizeStorageFilter(current && current.storageFilter);
    next.signalWeights = normalizeSignalWeights(current && current.signalWeights);
    next.llm = Object.assign({}, (current && current.llm) || {});
    if (!raw || typeof raw !== 'object') return { next: next, errors: errors, applied: applied };

    // 1. threadNum — the one that is not a range but a DEVICE CAPABILITY (§1.6.2's first row).
    var cap = detectedThreads();
    if (raw.threadNum != null) {
      if (typeof raw.threadNum !== 'number' || raw.threadNum < 0 || raw.threadNum > cap) {
        bad('threadNum', raw.threadNum, 'exceeds-device');
      } else { next.threadNum = raw.threadNum; applied++; }
    }
    var range = function (key, lo, hi) {
      if (raw[key] == null) return;
      var v = raw[key];
      if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi) bad(key, v, 'out-of-range');
      else { next[key] = v; applied++; }
    };
    range('minArchiveMoves', MIN_MOVES_LO, MIN_MOVES_HI);
    range('openingCutoff', 0, 40);
    range('thinkMs', 500, Infinity);
    if (raw.aiThinkMs != null) {
      var ai = raw.aiThinkMs;
      if (typeof ai !== 'number' || !isFinite(ai) || ai < 0) bad('aiThinkMs', ai, 'out-of-range');
      else { next.aiThinkMs = ai; applied++; }
    }
    // 6. lang — 'auto' or a locale this build actually ships. A language with no table would
    //    render every string in the fallback while the dropdown claimed otherwise.
    var localeList = (g.GMI18n && g.GMI18n.LOCALES) ? g.GMI18n.LOCALES : [];
    if (raw.lang != null) {
      if (raw.lang !== 'auto' && localeList.indexOf(raw.lang) < 0) bad('lang', raw.lang, 'unsupported');
      else { next.lang = raw.lang; applied++; }
    }
    var enumKey = function (key, allowed) {
      if (raw[key] == null) return;
      if (allowed.indexOf(raw[key]) < 0) bad(key, raw[key], 'invalid');
      else { next[key] = raw[key]; applied++; }
    };
    enumKey('mode', ['global', 'stepwise']);
    enumKey('suspect', ['both', 'B', 'W']);
    enumKey('theme', THEMES);
    // 0.4.5 §二.2 — `rule` is null (自动) or one of the three modes. Absent stays absent.
    if (raw.rule !== undefined && raw.rule !== null) {
      if ([0, 1, 2].indexOf(raw.rule) < 0) bad('rule', raw.rule, 'invalid');
      else { next.rule = raw.rule; applied++; }
    }
    // 7. signalWeights — the operator's per-signal pins (0.5.6 补增 §三). Per ENTRY, unlike the
    //    two filter blocks below: thirteen independent numbers have no invariant tying them
    //    together, so one bad pin must not cost the other twelve. A pin outside 0–SIGNAL_WEIGHT_MAX
    //    is the file's problem and that one entry is dropped, leaving whatever this machine already
    //    had (§1.6.1's reading of 退回). The map REPLACES rather than merges — §1.5.3 puts settings
    //    in the 覆盖 column — which is why an empty object here is a meaningful instruction
    //    ("no pins") and not a no-op.
    //
    //    Two whole-map refusals, both of them about the TABLE rather than about one entry, and both
    //    keeping the current value (§1.6.1) rather than repairing the file:
    //      · every surviving entry is zero — a detector with no weights is not a detector, and its
    //        risk score would read 0 for every game rather than being wrong;
    //      · the resolved table sums to more than SIGNAL_WEIGHT_SUM_MAX (130%) — the 补增 §三
    //        ceiling, and the one number in this block that is not per-entry. Scaling the entries
    //        down to fit would import a table the file's author never wrote.
    var sw = raw.signalWeights;
    if (sw && typeof sw === 'object') {
      var clean = {}, valid = 0;
      for (var wk in DEFAULT_WEIGHTS) {
        if (!DEFAULT_WEIGHTS.hasOwnProperty(wk) || sw[wk] == null) continue;
        var wv = sw[wk];
        if (typeof wv !== 'number' || !isFinite(wv) || wv < 0 || wv > SIGNAL_WEIGHT_MAX) {
          bad('signalWeights.' + wk, wv, 'out-of-range');
          continue;
        }
        clean[wk] = wv; valid++;
      }
      var swSum = signalWeightTableSum(clean);
      // A file with NO readable entry is two different instructions depending on which kind of
      // emptiness it is: an empty map is 「no pins」 (§1.5.3 puts settings in the 覆盖 column, so
      // that is a decision), while a map whose every entry was rejected is a file this build
      // cannot read at all — and §1.6.1 keeps the current value for that. Collapsing the two
      // wiped the operator's own pins on a file that merely used a future signal key.
      if (valid === 0 && Object.keys(sw).length) bad('signalWeights', sw, 'unreadable');
      else if (valid > 0 && !(swSum > 0)) bad('signalWeights', sw, 'invalid');
      else if (swSum > SIGNAL_WEIGHT_SUM_MAX + SIGNAL_WEIGHT_EPS) bad('signalWeights', sw, 'over-budget');
      else { next.signalWeights = clean; applied++; }
    }
    // 8. transparency — every numeric field against its OWN ceiling, read from the same table the
    //    clamp uses, so the validator and the clamps can never disagree about a maximum.
    var t = raw.transparency;
    if (t && typeof t === 'object') {
      var parts = ['viewer', 'overlay'];
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        var src = (t[part] && typeof t[part] === 'object') ? t[part] : null;
        if (!src) continue;
        if (src.enabled !== undefined) {
          if (typeof src.enabled !== 'boolean') bad('transparency.' + part + '.enabled', src.enabled, 'invalid');
          else { next.transparency[part].enabled = src.enabled; applied++; }
        }
        var lims = TRANSPARENCY_LIMITS[part];
        for (var nk in lims) {
          if (!lims.hasOwnProperty(nk) || src[nk] == null) continue;
          var nv = src[nk];
          if (typeof nv !== 'number' || !isFinite(nv) || nv < 0 || nv > lims[nk]) {
            bad('transparency.' + part + '.' + nk, nv, 'out-of-range');
          } else { next.transparency[part][nk] = Math.round(nv); applied++; }
        }
      }
    }
    // 9. archiveFilter — both ends in 0–100 AND min ≤ max (§1.6.2). All-or-nothing: a file with
    //    one bad end must not leave the pair half-applied, which would read as a valid range.
    var af = raw.archiveFilter;
    if (af && typeof af === 'object') {
      var afErr = false;
      if (af.enabled !== undefined && typeof af.enabled !== 'boolean') {
        bad('archiveFilter.enabled', af.enabled, 'invalid'); afErr = true;
      }
      var ok100 = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100; };
      var hasLo = af.minRisk != null, hasHi = af.maxRisk != null;
      if ((hasLo && !ok100(af.minRisk)) || (hasHi && !ok100(af.maxRisk)) ||
          (hasLo && hasHi && af.minRisk > af.maxRisk)) {
        bad('archiveFilter', { minRisk: af.minRisk, maxRisk: af.maxRisk }, 'invalid'); afErr = true;
      }
      if (!afErr) {
        if (af.enabled !== undefined) { next.archiveFilter.enabled = af.enabled; applied++; }
        if (hasLo) { next.archiveFilter.minRisk = Math.round(af.minRisk); applied++; }
        if (hasHi) { next.archiveFilter.maxRisk = Math.round(af.maxRisk); applied++; }
      }
    }
    // 10. storageFilter — 0–50 on both ends (same shape as above).
    var sf = raw.storageFilter;
    if (sf && typeof sf === 'object') {
      var sfErr = false;
      if (sf.enabled !== undefined && typeof sf.enabled !== 'boolean') {
        bad('storageFilter.enabled', sf.enabled, 'invalid'); sfErr = true;
      }
      var ok50 = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 50; };
      var sLo = sf.minOrdered != null, sHi = sf.maxUnordered != null;
      if ((sLo && !ok50(sf.minOrdered)) || (sHi && !ok50(sf.maxUnordered))) {
        bad('storageFilter', { minOrdered: sf.minOrdered, maxUnordered: sf.maxUnordered }, 'out-of-range');
        sfErr = true;
      }
      if (!sfErr) {
        if (sf.enabled !== undefined) { next.storageFilter.enabled = sf.enabled; applied++; }
        if (sLo) { next.storageFilter.minOrdered = Math.round(sf.minOrdered); applied++; }
        if (sHi) { next.storageFilter.maxUnordered = Math.round(sf.maxUnordered); applied++; }
      }
    }
    // 11. engineId — must be in the LIVE registry. This is the one rule whose failure has a
    //     defined fallback rather than a rollback: §1.6.2 says fall back to Rapfi, because an
    //     engine id nothing answers to leaves the detector unable to run at all.
    if (raw.engineId != null) {
      var reg = g.GMEngines;
      var known = !!(reg && reg.get && reg.get(raw.engineId));
      if (known) { next.engineId = raw.engineId; applied++; }
      else {
        next.engineId = (reg && reg.DEFAULT_ID) ? reg.DEFAULT_ID : 'rapfi';
        bad('engineId', raw.engineId, 'engine-not-found');
      }
    }
    // The LLM panel travels with `settings` but its KEY never does (§1.2). Everything else in it
    // overwrites; `apiKey` keeps whatever this machine already had, so importing a colleague's
    // backup cannot blank out — or silently adopt — a key.
    if (raw.llm && typeof raw.llm === 'object') {
      var defLlm = DEFAULTS.llm || {};
      for (var lk in raw.llm) {
        if (!raw.llm.hasOwnProperty(lk) || lk === 'apiKey') continue;
        if (!(lk in defLlm)) continue;                       // a key this build does not have
        if (typeof raw.llm[lk] !== typeof defLlm[lk]) continue;
        next.llm[lk] = raw.llm[lk]; applied++;
      }
    }
    // The rest have no range of their own: take them only when the type matches the default's, so
    // a corrupt file cannot put a string where a boolean belongs. Object-valued keys (the arrays
    // and the two objects already handled above) are skipped by construction.
    var handled = { threadNum: 1, minArchiveMoves: 1, openingCutoff: 1, thinkMs: 1, aiThinkMs: 1,
                    lang: 1, mode: 1, suspect: 1, theme: 1, rule: 1, transparency: 1,
                    archiveFilter: 1, storageFilter: 1, engineId: 1, llm: 1 };
    for (var k in raw) {
      if (!raw.hasOwnProperty(k) || handled[k] || !(k in DEFAULTS)) continue;
      var def = DEFAULTS[k], v = raw[k];
      if (typeof def === 'boolean' && typeof v === 'boolean') { next[k] = v; applied++; }
      else if (typeof def === 'string' && typeof v === 'string') { next[k] = v; applied++; }
      else if (typeof def === 'number' && typeof v === 'number' && isFinite(v)) { next[k] = v; applied++; }
    }
    // Each refusal reports the value that was KEPT alongside the one that was rejected, because
    // §1.6.4's report says both ("导入值 16 … 已保持原值 8"). Resolved from `next` after the fact,
    // which is correct precisely because a refused key never writes to `next` — so what is read
    // back is the imported file's value falling through to the current setting.
    var keptAt = function (path) {
      var parts = String(path || '').split('.');
      var cur = next;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null || typeof cur !== 'object') return null;
        cur = cur[parts[i]];
      }
      return cur === undefined ? null : cur;
    };
    for (var e2 = 0; e2 < errors.length; e2++) errors[e2].kept = keptAt(errors[e2].key);
    return { next: next, errors: errors, applied: applied };
  }

  // §1.5 — apply the file category by category and return the REPORT §1.6.4 renders.
  //
  // Merge vs overwrite is §1.5.3's table. The three "append" categories go through the SAME
  // importers the 导入 buttons use (`importBlacklist` / `importSamples` / `importArchives`), so a
  // file and a hand-picked file cannot disagree about id remapping, tagging or pruning.
  async function importCustomData(envelope, categories) {
    if (!envelope || envelope.kind !== BACKUP_KIND) {
      return { ok: false, error: 'bad-kind', report: [] };
    }
    var cats = pickCategories(categories);
    var data = (envelope.data && typeof envelope.data === 'object') ? envelope.data : {};
    var report = [];
    var add = function (cat, o) { var r = o || {}; r.cat = cat; report.push(r); return r; };

    if (cats.settings && data.settings && typeof data.settings === 'object') {
      var current = await loadSettings();
      var res = validateImportedSettings(data.settings, current);
      await saveSettings(res.next);
      add('settings', { applied: true, ok: res.applied, refused: res.errors.length, errors: res.errors });
    }
    if (cats.blacklist) {
      var inc = Array.isArray(data.blacklist) ? data.blacklist : [];
      var cur = (await loadBlacklist()).players || [];
      var have = {};
      cur.forEach(function (e) { if (e && e.id) have[e.id] = true; });
      var fresh = [], invalid = 0, dup = 0;
      for (var i = 0; i < inc.length; i++) {
        var e = sanitizeBlacklistEntry(inc[i]);
        if (!e) { invalid++; continue; }
        // §1.5.3 — 「ID 重复则跳过」, which is NOT the updater `importBlacklist` runs by default:
        // an import adds a stranger's block list, it does not re-edit the entries already here.
        if (have[e.id]) { dup++; continue; }
        have[e.id] = true;
        fresh.push(e);
      }
      var br = fresh.length ? await importBlacklist(fresh, 'append') : { added: 0, total: cur.length };
      add('blacklist', { applied: true, added: br.added, skipped: invalid + dup,
                         invalid: invalid, duplicate: dup });
    }
    if (cats.samples) {
      var sinc = Array.isArray(data.samples) ? data.samples : [];
      var good = [], badS = 0;
      for (var j = 0; j < sinc.length; j++) {
        if (normalizeSample(sinc[j])) good.push(sinc[j]); else badS++;
      }
      var sr = good.length ? await importSamples(good) : { added: 0, remapped: 0 };
      add('samples', { applied: true, added: sr.added, remapped: sr.remapped || 0, skipped: badS });
    }
    if (cats.archives) {
      var ainc = Array.isArray(data.archives) ? data.archives : [];
      var goodA = [], badA = 0;
      for (var ai = 0; ai < ainc.length; ai++) {
        // §1.6.2's last row: the same normaliser the manual 导入棋谱 path uses decides what is a
        // game at all — a row without `record.moves` is not one, and is skipped rather than
        // stored as an unplayable archive.
        if (normalizeArchive(ainc[ai])) goodA.push(ainc[ai]); else badA++;
      }
      var ar = goodA.length ? await importArchives(goodA) : { added: 0, remapped: 0 };
      add('archives', { applied: true, added: ar.added, remapped: ar.remapped || 0, skipped: badA });
    }
    if (cats.customQuestions) {
      var qinc = Array.isArray(data.customQuestions) ? data.customQuestions : [];
      var existing = await loadCustomQuestions();
      var haveQ = {};
      existing.forEach(function (q) { if (q && q.id) haveQ[q.id] = true; });
      var merged = existing.slice(), addedQ = 0, badQ = 0;
      for (var m = 0; m < qinc.length && merged.length < MAX_CUSTOM_QUESTIONS; m++) {
        var q = normalizeQuestion(qinc[m], merged.length);
        if (!q) { badQ++; continue; }
        // §1.5.3 — 「ID 冲突分配新 ID」, exactly like samples.
        while (haveQ[q.id]) q.id = q.id + '-x';
        haveQ[q.id] = true;
        merged.push(q);
        addedQ++;
      }
      if (addedQ) await saveCustomQuestions(merged);
      var over = Math.max(0, qinc.length - addedQ - badQ);
      add('customQuestions', { applied: true, added: addedQ, skipped: badQ + over });
    }
    if (cats.customEngines) {
      // §1.2 keeps the weight packages OUT of the backup (up to 5 × 100MB), so what arrives is a
      // named list with no blob behind it. Registering a row anyway would put an entry in both
      // engine pickers that cannot answer a single search — worse than not importing it, because
      // it looks like it worked. So this category is exported for inventory, and the import says
      // outright that the package has to come across by hand.
      var ceList = Array.isArray(data.customEngines) ? data.customEngines : [];
      add('customEngines', { applied: false, reason: 'binary-not-in-backup', listed: ceList.length });
    }
    if (cats.learnedParams && data.learnedParams && typeof data.learnedParams === 'object') {
      await saveLearnedParams(data.learnedParams);
      add('learnedParams', { applied: true, overridden: true });
    }
    if (cats.backgrounds && data.backgrounds && typeof data.backgrounds === 'object') {
      var n = 0, skippedBg = 0;
      for (var si = 0; si < BG_SLOTS.length; si++) {
        var rec = data.backgrounds[BG_EXPORT_ID[BG_SLOTS[si]]];
        if (!rec || typeof rec !== 'object') continue;
        var blob = dataUrlToBlob(rec.blob);
        // The ceiling is enforced here too: a hand-edited backup must not be able to push a
        // 12MB image past the limit `saveBackground` exists to keep.
        if (!blob || blob.size > BG_MAX_BYTES) { skippedBg++; continue; }
        await saveBackground(BG_SLOTS[si], blob, rec);
        n++;
      }
      add('backgrounds', { applied: true, restored: n, skipped: skippedBg });
    }
    if (cats.viewerCols && data.viewerCols && typeof data.viewerCols === 'object') {
      var put = {}; put.viewerCols = data.viewerCols;
      try { await api().set(put); } catch (e) {}
      add('viewerCols', { applied: true });
    }
    return { ok: true, report: report };
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
    // 0.5.6 补增 §三 — the pin filter and its two ceilings, exported so the settings panel, the
    // analysis path and the suite all go through ONE reading of "which pins can the detector
    // use". The panel writes through it and the suite drives it directly, for the same reason
    // every other pure helper here is exported. `SIGNAL_WEIGHT_SUM_MAX` is also what app.js reads
    // (with a literal fallback for the harnesses that load app.js without storage.js), so the
    // 130% is one number rather than one per file.
    normalizeSignalWeights: normalizeSignalWeights,
    signalWeightTableSum: signalWeightTableSum,
    SIGNAL_WEIGHT_MAX: SIGNAL_WEIGHT_MAX,
    SIGNAL_WEIGHT_SUM_MAX: SIGNAL_WEIGHT_SUM_MAX,
    SIGNAL_WEIGHT_EPS: SIGNAL_WEIGHT_EPS,
    MIN_SAMPLES: MIN_SAMPLES,
    LOW_SAMPLES: LOW_SAMPLES,
    SAMPLE_DRIFT_RATIO: SAMPLE_DRIFT_RATIO,
    sampleDrift: sampleDrift,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    saveSetting: saveSetting,
    // 0.5.2 §4.1 — the custom-question store and its pure selector. Exported so the settings page,
    // the on-page menu and the suite all go through ONE implementation of "which text do we
    // send", rather than three copies of the fallback order.
    MAX_CUSTOM_QUESTIONS: MAX_CUSTOM_QUESTIONS,
    MAX_QUESTION_LEN: MAX_QUESTION_LEN,
    clampCustomQuestions: clampCustomQuestions,
    loadCustomQuestions: loadCustomQuestions,
    saveCustomQuestions: saveCustomQuestions,
    addCustomQuestion: addCustomQuestion,
    updateCustomQuestion: updateCustomQuestion,
    removeCustomQuestion: removeCustomQuestion,
    pickCustomQuestionText: pickCustomQuestionText,
    // 0.5.2 §5.1 — the background store. Only the EXTENSION origin can use these (see the note
    // above BG_DB_NAME): the viewer calls them directly, and content.js reaches them through the
    // worker's `gm-bg-get` message.
    BG_SLOTS: BG_SLOTS,
    BG_MAX_BYTES: BG_MAX_BYTES,
    DEFAULT_BG: DEFAULT_BG,
    clampBgConfig: clampBgConfig,
    loadBackground: loadBackground,
    saveBackground: saveBackground,
    saveBackgroundConfig: saveBackgroundConfig,
    clearBackground: clearBackground,
    blobToDataUrl: blobToDataUrl,
    defaults: defaults,
    clampMinMoves: clampMinMoves,
    MIN_MOVES_LO: MIN_MOVES_LO,
    MIN_MOVES_HI: MIN_MOVES_HI,
    clampThreadNum: clampThreadNum,
    THREADS_HI: THREADS_HI,
    detectedThreads: detectedThreads,
    // 0.4.7 §三: the theme vocabulary and the two sanitisers, exported so the viewer, the
    // overlay and the tests all normalise through ONE function instead of three copies of
    // "which strings are allowed".
    THEMES: THEMES,
    clampTheme: clampTheme,
    // 0.5.1 §2.1.4 — exported so the suite drives the real clamp rather than describing it, the
    // same reason every other clamp above is on this list.
    clampEngineId: clampEngineId,
    clampEngineUrl: clampEngineUrl,
    // 0.5.3 §1.1 — the transparency model that replaces 0.4.7's `opacity`. `cssOpacity` is
    // exported because it is the ONE place the percent→opacity conversion lives: the viewer,
    // the overlay and the suite all read it rather than each writing `1 - t / 100` (this
    // project has been bitten four times by a rule with more than one copy).
    TRANSPARENCY_LIMITS: TRANSPARENCY_LIMITS,
    normalizeTransparency: normalizeTransparency,
    cssOpacity: cssOpacity,
    // 0.5.3 §2.1 — 回放过滤.
    normalizeArchiveFilter: normalizeArchiveFilter,
    shouldSkipArchive: shouldSkipArchive,
    archiveFilterInvalid: archiveFilterInvalid,
    // 0.5.4 §一.3 — 存储过滤. The ceiling table is exported too: the settings page builds its two
    // sliders' `max` from it, and a slider whose max disagreed with the clamp would snap back on
    // release with no visible cause (the reason `TRANSPARENCY_LIMITS` is on this list).
    STORAGE_FILTER_LIMITS: STORAGE_FILTER_LIMITS,
    normalizeStorageFilter: normalizeStorageFilter,
    shouldSkipByCounts: shouldSkipByCounts,
    // 0.5.4 §4.1.2 — the share-string mapping, owned here because this is the only module the
    // viewer, the engine host AND the overlay all load (see the block that defines them).
    BOARD_SIZE: BOARD_SIZE,
    coordToShare: coordToShare,
    shareToCoord: shareToCoord,
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
    // 0.4.3 §1.4/§1.5: the four operator-override writers.
    saveArchiveSegments: saveArchiveSegments,
    saveSampleSegments: saveSampleSegments,
    saveArchiveType: saveArchiveType,
    saveSampleType: saveSampleType,
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
    // ---- 0.4.9 §一.4 local player blacklist ----
    BLACKLIST_KEY: BLACKLIST_KEY,
    MAX_BLACKLIST: MAX_BLACKLIST,
    blacklistId: blacklistId,
    normalizeBlacklist: normalizeBlacklist,
    loadBlacklist: loadBlacklist,
    addToBlacklist: addToBlacklist,
    removeFromBlacklist: removeFromBlacklist,
    setBlacklistNote: setBlacklistNote,
    isBlacklisted: isBlacklisted,
    touchBlacklistEntry: touchBlacklistEntry,
    importBlacklist: importBlacklist,
    // ---- 0.5.6 §一 导出自定义数据 / 导入与退回 ----
    BACKUP_KIND: BACKUP_KIND,
    BACKUP_VERSION: BACKUP_VERSION,
    EXPORT_CATEGORIES: EXPORT_CATEGORIES,
    exportCustomData: exportCustomData,
    importCustomData: importCustomData,
    validateImportedSettings: validateImportedSettings,
    // Pure helpers the settings panel and the suite both use; exported for the same reason the
    // two normalisers above are — one implementation, no second copy at the call site.
    stripSecrets: stripSecrets,
    dataUrlToBlob: dataUrlToBlob,
    __memApi: memApi,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMStorage;
})(typeof globalThis !== 'undefined' ? globalThis : self);
