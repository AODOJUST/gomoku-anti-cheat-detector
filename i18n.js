/* Gomoku Detector — shared i18n core, as a classic script.
 *
 * Loaded by the content script, viewer.html and offscreen.html, so it publishes exactly one
 * global: `GMI18n`. No modules — content scripts cannot use them.
 *
 * ---------------------------------------------------------------------------
 * Why every locale is resident at once
 * ---------------------------------------------------------------------------
 * 0.3.6 §1.8 requires a language change to repaint the panel and the viewer WITHOUT a reload
 * (background.js only writes `settings.lang` and relies on `chrome.storage.onChanged`). A
 * lazy "load the one locale you need" design would therefore need a fetch at switch time and
 * would still need the old table to redraw. Thirteen tables of ~900 short strings is well under
 * 400KB, so all thirteen are registered up front and `setLocale()` is a pointer swap.
 *
 * ---------------------------------------------------------------------------
 * Keys, not strings, in storage
 * ---------------------------------------------------------------------------
 * Tags, annotation labels and risk levels are IDENTITY values, not display text: learn.js
 * matches `'人类样本'` / `'AI步骤'` by literal, storage.js WRITES `'AI步骤'` when migrating a
 * sample, viewer.js uses `PRESET_TAGS.indexOf(t)` to tell a preset tag from a custom one, and
 * archives persist `blackLevel` / `whiteLevel`. If those values followed the UI language, a
 * sample tagged in English would silently stop feeding the learner under a Chinese UI — no
 * error, just quietly wrong.
 *
 * So storage keeps the CANONICAL key (the Chinese source string) and only DISPLAY goes
 * through t(). `t('tag.标准样本')` renders as 「标准样本」 under zh-CN and 「Standard sample」
 * under en, while the stored value is byte-identical either way. That also makes 0.3.6's
 * 「预设标签存储保持现状」 literally true: storage does not change at all.
 *
 * ---------------------------------------------------------------------------
 * Error codes
 * ---------------------------------------------------------------------------
 * app.js runs offscreen, where the UI language is irrelevant, so it throws messages of the
 * form `__i18n:<key>|<k>=<v>|...` and the consumer (content.js / viewer.js) translates them
 * with `trError()`. Console-only diagnostics deliberately stay untranslated (§1.7 例外).
 */
(function (g) {
  'use strict';
  if (g.GMI18n) return;

  var LOCALES = ['zh-CN', 'zh-TW', 'ja', 'ko', 'en', 'ru', 'fr', 'de',
                 'vi', 'es', 'ms', 'ar', 'mn'];
  var DEFAULT = 'zh-CN';

  // 0.4.6 §二.2 — the right-to-left set. Kept as a list rather than a single `ar` test so that a
  // future RTL language (he, fa, ur) is a one-line change here instead of a hunt for `=== 'ar'`.
  var RTL = ['ar'];

  var dict = {};         // { 'zh-CN': { 'key': '...' }, ... }
  var current = DEFAULT;

  function dirFor(locale) { return RTL.indexOf(locale) >= 0 ? 'rtl' : 'ltr'; }

  function register(locale, table) {
    if (!locale || !table) return;
    dict[locale] = Object.assign(dict[locale] || {}, table);
  }

  // The viewer / offscreen documents are ours, so rewriting <html lang> there is free and
  // gives correct CJK font resolution. gomoku.com's document is NOT ours: rewriting its
  // `lang` would change the host page's font resolution and any `:lang()` rule it has, so we
  // only tag our own subtree (content.js sets `lang` on the panel root) and leave the page
  // alone. Exposed for the test harness, which asserts both branches.
  //
  // 0.4.6 §二.2 extends the same reasoning to `dir`, and there it matters far more: setting
  // `dir="rtl"` on the HOST document would mirror gomoku.com's own board and chat around us,
  // which is not our UI to mirror and would look like a bug on the site. So our own documents get
  // `<html dir>`, and the host gets a `data-gm-dir` attribute that content.js copies onto the
  // panel's shadow host. The panel is the only thing we own on that page.
  function ownsDocument() {
    return typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
  }

  function setLocale(locale) {
    current = LOCALES.indexOf(locale) >= 0 ? locale : DEFAULT;
    var dir = dirFor(current);
    if (typeof document !== 'undefined' && document.documentElement) {
      if (ownsDocument()) {
        document.documentElement.lang = current;
        document.documentElement.dir = dir;
      } else {
        document.documentElement.setAttribute('data-gm-lang', current);
        document.documentElement.setAttribute('data-gm-dir', dir);
      }
    }
    return current;
  }

  // ---- key scheme ----
  // Two shapes are in use, on purpose:
  //
  //   semantic keys      — `copy.prefix`, `level.可疑`, `opening.D1`, `tag.标准样本`. 0.3.6
  //                        §2.6 / §1.7 enumerate these by name, so they are used verbatim.
  //   source-text keys   — `panel|查看器`, `viewer|步骤明细`. The bulk of the UI is ~950
  //                        strings; inventing a semantic slug for each one buys nothing (the
  //                        table is keyed the same either way) and costs a whole class of
  //                        bugs where a typo'd key silently renders as itself. With the
  //                        zh-CN text IN the key, a missing entry degrades to the correct
  //                        Chinese string instead of to `panel.ctrl.think`.
  //
  // `t()` strips an `area|` prefix before giving up, which is what makes the fallback
  // readable. A semantic key has no `|`, so it is unaffected.
  function fallback(key) {
    var i = String(key).indexOf('|');
    return i >= 0 ? String(key).slice(i + 1) : key;
  }

  // The lookup itself. `t` and `tIn` are thin wrappers over this so the fallback chain exists
  // in exactly one place — a second copy would drift the moment one of them learned a new rule.
  function tCore(locale, key, vars) {
    var s = (dict[locale] && dict[locale][key]) ||
            (dict[DEFAULT] && dict[DEFAULT][key]) ||
            fallback(key);
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (_, k) {
        return vars[k] != null ? vars[k] : '{' + k + '}';
      });
    }
    return s;
  }

  function t(key, vars) { return tCore(current, key, vars); }

  // 0.4.4: translate in an EXPLICIT locale, leaving `current` untouched. Needed by
  // `GMOpening.label(code, locale)`, which takes a locale argument but used to resolve the
  // opening name against whatever locale happened to be current — so `label('D1','en')` returned
  // the Chinese name unless someone had called `setLocale('en')` first. verify-036 never caught
  // it because its helper did exactly that (`form = (l, code) => { I.setLocale(l); … }`). The
  // chat engine does catch it: `GMChat.openingAnswerNames()` needs all 8 names at once.
  function tIn(locale, key, vars) { return tCore(locale, key, vars); }

  // Translates a stored canonical value. Tags, annotation labels, risk levels, job statuses
  // and end reasons are IDENTITY values that live in storage and are compared by literal in
  // learn.js — so they are stored untranslated and only the display goes through here. A
  // value with no entry (a legacy archive written before a label existed, or a user's custom
  // tag) is returned as-is rather than as a broken key.
  function tOr(ns, value, vars) {
    if (value == null || value === '') return '';
    var k = ns + '.' + value;
    return (has(k) || (dict[DEFAULT] && dict[DEFAULT][k])) ? t(k, vars) : String(value);
  }

  function getLocale() { return current; }
  function locales() { return LOCALES.slice(); }
  function has(key) {
    return !!((dict[current] && dict[current][key]) || (dict[DEFAULT] && dict[DEFAULT][key]));
  }
  function hasIn(locale, key) { return !!(dict[locale] && dict[locale][key]); }

  // Does ANY table define this key? `has()` answers "can I render it right now", which for a
  // zh-CN operator is true of every source-text key by construction. The implicit static-DOM
  // pass needs the other question — "is this text a string we have translations for?" — or it
  // would never tag a node under zh-CN and a later switch to English would find nothing to
  // rewrite.
  function hasAny(key) {
    for (var i = 0; i < LOCALES.length; i++) {
      if (dict[LOCALES[i]] && dict[LOCALES[i]][key]) return true;
    }
    return false;
  }

  // ---- language resolution (§1.3) ----
  // 'auto' follows the browser. `chrome.i18n.getUILanguage()` needs no permission and is
  // available in content scripts, extension pages and the offscreen document alike.
  function browserLang() {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
        return chrome.i18n.getUILanguage();
      }
    } catch (e) { /* fall through to navigator */ }
    return (typeof navigator !== 'undefined' && navigator.language) || DEFAULT;
  }

  function resolveLang(setting) {
    if (setting && setting !== 'auto') {
      return LOCALES.indexOf(setting) >= 0 ? setting : DEFAULT;
    }
    var ui = browserLang() || DEFAULT;
    if (LOCALES.indexOf(ui) >= 0) return ui;
    // Prefix match: zh-HK -> zh-TW, en-US -> en, fr-CA -> fr.
    // zh needs care: zh-HK / zh-MO / zh-Hant are traditional, not simplified.
    var low = String(ui).toLowerCase();
    if (low.indexOf('zh') === 0) {
      if (low.indexOf('tw') >= 0 || low.indexOf('hk') >= 0 ||
          low.indexOf('mo') >= 0 || low.indexOf('hant') >= 0) return 'zh-TW';
      return 'zh-CN';
    }
    var prefix = low.split('-')[0];
    for (var i = 0; i < LOCALES.length; i++) {
      if (LOCALES[i] === prefix || LOCALES[i].indexOf(prefix + '-') === 0) return LOCALES[i];
    }
    return DEFAULT;
  }

  // ---- language names in a picker (0.4.6 §2.3) ----
  // "English（英语）": the language's own name, then what the CURRENT language calls it. The
  // endonym comes from the locale table (`lang.en` = "English"), NOT from Intl — Intl answers
  // 「中文（中国）」 for zh-CN and lower-cases 「русский」 / 「español」 / 「монгол」, whereas the table
  // carries the hand-picked form the picker has always shown (简体中文, Русский, Español, Монгол)
  // and which the existing dropdowns already display. Intl supplies only the LOCAL half — the part
  // that would otherwise need hand-maintaining for 13 languages — and the whole thing degrades to
  // the bare endonym when Intl.DisplayNames is missing (Chrome < 81).
  //
  // Two notes on the format, because §2.3's prose and its code say slightly different things:
  //   · the spec's example table writes the CURRENT language's own entry as 「日本語（日本語）」,
  //     but its own implementation plan returns the bare name when native === local. The code is
  //     followed here — a stutter is not information.
  //   · the parenthetical is also dropped when the local name is already INSIDE the endonym
  //     (「简体中文」+「中文」, 「繁體中文」+「中文」), which in a Chinese UI is the same stutter in a
  //     different shape. This one is a refinement beyond the spec, kept because it can only
  //     suppress a string that is literally a substring of the text already shown.
  function intlLangName(locale, code) {
    try {
      if (typeof Intl === 'undefined' || !Intl.DisplayNames) return null;
      // Look the BASE tag up: Intl renders 'zh-CN' as 「中文（中国）」 / "Chinese (China)", and the
      // region adds nothing a language picker needs — especially when the region is the one the
      // operator is already in.
      var tag = String(code).split('-')[0];
      var n = new Intl.DisplayNames([locale], { type: 'language' }).of(tag);
      return n && n !== tag ? String(n) : null;
    } catch (e) { return null; }
  }

  function langLabel(code, override) {
    var cur = override || current;
    var native = (dict[DEFAULT] && dict[DEFAULT]['lang.' + code]) ||
                 (dict[cur] && dict[cur]['lang.' + code]) || null;
    if (!native) native = intlLangName(code, code) || String(code);
    if (code === cur) return native;
    var local = intlLangName(cur, code);
    if (!local || local === native) return native;
    if (native.indexOf(local) >= 0 || local.indexOf(native) >= 0) return native;
    return native + '（' + local + '）';
  }

  // ---- error codes (§1.7 决策 3) ----
  // Format: __i18n:<key>|<k1>=<v1>|<k2>=<v2>. A message that does not carry the prefix is
  // returned untouched, so a raw engine/worker string still surfaces instead of becoming
  // an empty label.
  var ERR_PREFIX = '__i18n:';

  function isErrCode(msg) {
    return !!msg && String(msg).indexOf(ERR_PREFIX) === 0;
  }

  function trError(msg) {
    if (!isErrCode(msg)) return msg;
    var body = String(msg).slice(ERR_PREFIX.length);
    var parts = body.split('|');
    var key = parts.shift();
    var vars = {};
    parts.forEach(function (p) {
      var eq = p.indexOf('=');
      if (eq > 0) {
        var v = p.slice(eq + 1);
        try { v = decodeURIComponent(v); } catch (e) { /* keep the raw value */ }
        vars[p.slice(0, eq)] = v;
      }
    });
    return t(key, vars);
  }

  // Builds a code. Values are URI-encoded so a `|` or `=` inside a message cannot split it.
  function errCode(key, vars) {
    var s = ERR_PREFIX + key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        if (vars[k] == null) return;
        s += '|' + k + '=' + encodeURIComponent(String(vars[k]));
      });
    }
    return s;
  }

  // ---- DOM helper ----
  // Two ways to translate our own static markup:
  //
  //   explicit — `data-i18n="key"`, plus `data-i18n-title|placeholder|aria-label` for the
  //              attributes. Used where the element holds markup (apply() only sets
  //              textContent) or where a semantic key reads better.
  //   implicit — a text node whose content IS a key: `html|查看器`. viewer.html is 780 lines
  //              of markup carrying ~190 Chinese labels; annotating each one by hand is 190
  //              chances to mistype a key that would then fail silently. Instead the key is
  //              derived from the text, and text with no translation anywhere is left alone.
  //
  // The implicit pass tags a node with `__gmKey` the first time it recognises it, and only
  // ever revisits tagged nodes afterwards. That is what keeps it off dynamically painted
  // content: a node viewer.js writes after boot carries no `__gmKey`, so a later language
  // switch cannot overwrite a player name or a move count with a stale static string.
  var TXT_NS = 'html|';
  var ATTR_NS = {
    title: 'attr.title|',
    placeholder: 'attr.placeholder|',
    'aria-label': 'attr.aria-label|',
  };
  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/;

  function translateNode(node) {
    var key = node.__gmKey;
    if (!key) {
      var raw = node.nodeValue;
      if (!raw) return false;
      var text = raw.trim();
      if (!text || !CJK.test(text)) return false;
      key = TXT_NS + text;
      if (!hasAny(key)) return false;
      node.__gmKey = key;
    }
    var out = t(key);
    if (node.nodeValue !== out) node.nodeValue = out;
    return true;
  }

  function applyText(scope) {
    if (typeof document === 'undefined' || !document.createTreeWalker) return 0;
    var walker = document.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */, null);
    var n = 0;
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (translateNode(node)) n++;
    }
    return n;
  }

  function applyAttrs(scope) {
    if (!scope.querySelectorAll) return 0;
    var n = 0;
    Object.keys(ATTR_NS).forEach(function (attr) {
      var ns = ATTR_NS[attr];
      var list = scope.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var key = el.__gmAttr && el.__gmAttr[attr];
        if (!key) {
          var text = (el.getAttribute(attr) || '').trim();
          if (!text || !CJK.test(text)) continue;
          key = ns + text;
          if (!hasAny(key)) continue;
          if (!el.__gmAttr) el.__gmAttr = {};
          el.__gmAttr[attr] = key;
        }
        el.setAttribute(attr, t(key));
        n++;
      }
    });
    return n;
  }

  function apply(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return 0;
    var n = 0;
    var nodes = scope.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (!key) continue;
      nodes[i].textContent = t(key);
      n++;
    }
    ['title', 'placeholder', 'aria-label'].forEach(function (attr) {
      var sel = '[data-i18n-' + attr + ']';
      var list = scope.querySelectorAll(sel);
      for (var j = 0; j < list.length; j++) {
        var k2 = list[j].getAttribute('data-i18n-' + attr);
        if (k2) { list[j].setAttribute(attr, t(k2)); n++; }
      }
    });
    n += applyAttrs(scope);
    n += applyText(scope);
    return n;
  }

  // Missing-key audit for the test harness: every key the code asks for must exist in all
  // thirteen tables, otherwise a language silently falls back to Chinese. Source-text keys are
  // skipped for zh-CN by construction — their Chinese text IS the key, so there is nothing to
  // define; every other locale must carry an entry or that string will show up in Chinese.
  function audit() {
    var keys = {};
    LOCALES.forEach(function (l) {
      Object.keys(dict[l] || {}).forEach(function (k) { keys[k] = true; });
    });
    var all = Object.keys(keys);
    var missing = {};
    LOCALES.forEach(function (l) {
      var miss = all.filter(function (k) {
        if (dict[l] && dict[l][k]) return false;
        if (l === DEFAULT && k.indexOf('|') >= 0) return false;   // implicit source text
        return true;
      });
      if (miss.length) missing[l] = miss;
    });
    return { keys: all, count: all.length, missing: missing };
  }

  function table(locale) { return dict[locale] || {}; }

  g.GMI18n = {
    LOCALES: LOCALES,
    DEFAULT: DEFAULT,
    RTL: RTL,
    register: register,
    setLocale: setLocale,
    getLocale: getLocale,
    ownsDocument: ownsDocument,
    dirFor: dirFor,
    langLabel: langLabel,
    t: t,
    tIn: tIn,
    has: has,
    hasIn: hasIn,
    hasAny: hasAny,
    tOr: tOr,
    fallback: fallback,
    locales: locales,
    resolveLang: resolveLang,
    browserLang: browserLang,
    trError: trError,
    errCode: errCode,
    isErrCode: isErrCode,
    apply: apply,
    applyText: applyText,
    applyAttrs: applyAttrs,
    TXT_NS: TXT_NS,
    ATTR_NS: ATTR_NS,
    audit: audit,
    table: table,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
