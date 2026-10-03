/* Gomoku Detector — viewer logic.
 *
 * Three panes over one shared store (storage.js):
 *   检测  the old localhost tool, now an extension page (import a record, analyse, inspect)
 *   回放  the archive list: sort / filter / categorise / open a replay
 *   设置  the same settings the in-page panel writes
 *
 * app.js is loaded as a shared library before this file; nothing here redeclares its
 * top-level bindings (SIZE, parseRecord, analyzeGame, ...).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var G = GMStorage;

  // ---- 0.3.6 §1.6: the viewer's translation surface ----
  // Static markup in viewer.html is NOT wrapped here — GMI18n.apply() rewrites it in place
  // (see the implicit pass in i18n.js). What goes through these three is everything the code
  // produces at runtime: alert / confirm / prompt, the status bar, and any text assembled into
  // an HTML string. Stored identity values (risk levels, tags, annotation labels, job
  // statuses) are canonical Chinese and go through TO() so only their DISPLAY moves.
  function T(key, vars) { return GMI18n.t(key, vars); }
  function TO(ns, value, vars) { return GMI18n.tOr(ns, value, vars); }
  function TE(msg) { return GMI18n.trError(msg); }

  // learn.js keys its parameter labels by the parameter's STABLE key (`top1`, `riskHigh`, …)
  // rather than by their Chinese text, so the lookup is `learn.weight.top1`. A key that has no
  // table entry would fall back to the slug itself — worse than the canonical Chinese — so the
  // caller passes the canonical label in as the fallback.
  function paramLabel(key, fallback) {
    var s = T(key);
    return s === key ? fallback : s;
  }

  var LANG = GMI18n.DEFAULT;

  // ---- 0.4.11 §一.2: the viewer's engine bridge ----
  // This page runs NO engine of its own. app.js is still loaded for its pure helpers
  // (parseRecord, summaryTableHtml, the scoring ring…), but its engine entry points —
  // getEngine / analyzeGame / analyzeStepwise / analyzeStep — are deliberately never called
  // from here. Calling them built a SECOND Rapfi inside the extension page: a second worker, a
  // second 40 MB data package, a second pthread pool, and a second queue content.js could not
  // see, with each side resolving `settings.threadNum` on its own. Everything now goes to the
  // offscreen document, which owns the one engine and serialises work through one FIFO.
  var gmJobSeq = 0;
  function gmJobId(kind) { return 'viewer-' + (kind || 'job') + '-' + (++gmJobSeq) + '-' + Date.now(); }

  function ensureOffscreen() {
    return new Promise(function (resolve) {
      try { chrome.runtime.sendMessage({ type: 'gm-ensure-offscreen' }, function () { resolve(); }); }
      catch (e) { resolve(); }
    });
  }

  // Same shape as content.js:askOffscreen minus the retry loop: the viewer reports a failure in
  // its own status line, and silently re-driving a multi-minute analysis would hide it.
  function askOffscreen(message) {
    return ensureOffscreen().then(function () {
      return new Promise(function (resolve, reject) {
        chrome.runtime.sendMessage(message, function (resp) {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        });
      });
    });
  }

  // gm-progress is BROADCAST, so every listener sees every job's progress — this page's, the
  // panel's, another tab's. The sink table routes a job's own updates to the pane that started
  // it, and drops the rest.
  //
  // Guarded, like every other module-scope chrome touch in this file: the storage and i18n layers
  // are deliberately loadable without an extension context (that is how the unit suites drive
  // them), and `verify-047` loads viewer.html straight off the filesystem to read the resolved
  // cascade with no `chrome` at all. An unguarded `chrome.runtime.onMessage` at module scope threw
  // there and killed boot() before the first paint — the page rendered, unstyled and empty.
  var jobSinks = {};
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg.type !== 'gm-progress') return;
      var sink = jobSinks[msg.jobId];
      if (sink) sink(msg.p, msg.msg);
    });
  }

  // 黑 / 白 as a one-character side label, and 黑方 / 白方 as the two-character form used in
  // headings and detail rows. Both pairs recur a dozen times; one function each beats twelve
  // keys that could drift apart.
  function sideTag(side) { return side === 'B' ? T('viewer|黑') : T('viewer|白'); }
  function sideName(side) { return side === 'B' ? T('viewer|黑方') : T('viewer|白方'); }
  // 0.4.7 §5.4 — which contribution keys the panel spells out rather than showing as a slug.
  // The VALUE is the model's stable key and the LOOKUP is `T('learn.weight.' + k)`, i.e. exactly
  // the same runtime key `learn.js` renders its own weight table with (see _tools/i18n-extra.js).
  // A second label map here would be the "same answer in two places" failure this project has
  // already paid for twice, so this set is deliberately only a MEMBERSHIP list, not a label table.
  // 0.5.5 §1.4.2 — every term that reaches this map is printed by its label instead of its slug.
  // `goodPool`/`liveThree` (0.5.2) and `sharpStreak`/`sharpTotal` (0.4.8) were missing from it, so
  // the breakdown printed 「好点池」's four neighbours as `goodPool 12.3` / `liveThree 0.4` — the
  // exact camelCase Slug the comment below says it exists to avoid. Member: 1 is a marker, the
  // wording itself comes from i18n (`learn.weight.<key>`).
  var CONTRIB_TXT = {
    top1: 1, acpl: 1, sharp: 1, out: 1, desperate: 1, time: 1,
    evasion: 1, winBlunder: 1, uselessFour: 1,
    sharpStreak: 1, sharpTotal: 1, goodPool: 1, liveThree: 1,
  };
  // 被怀疑方 is three-valued and the same ternary was spelled out four times.
  function suspectName(v) {
    return v === 'B' ? T('viewer|黑方') : (v === 'W' ? T('viewer|白方') : T('viewer|双方'));
  }
  // 0.4.1 §三.4: a record's trustworthiness in one word — see content.js's toRecord() for how
  // it is derived. Only 0.4.1+ records carry it, so everything older falls back to the same
  // verdict computed from the fields it does have; that also keeps the list badge and the
  // detail row from disagreeing about a game. Kept in step with viewer's other mirrors of
  // app-side rules: `quality` is display-only, nothing here feeds a score.
  // =====================================================================
  // 0.4.3 §1.5: the AI class
  // =====================================================================
  // The codes app.js's classifySide() produces and stores. The value persisted is the CODE and
  // only the display goes through TO('type', code) — the same arrangement `idLabel.registered`
  // uses, and the one that lets app.js (which runs offscreen, with no dictionary) name a class
  // at all. `type.*` therefore needs an entry in locale/zh-CN.js and in _tools/i18n-extra.js;
  // see the note there.
  // 0.5.7 §1.5 adds `lowEndAi` — the 低端AI downgrade. It is a code like the other seven: persisted
  // in report.types, displayed through TO('type', code), so it needs its row in locale/zh-CN.js and
  // in _tools/i18n-extra.js exactly as the comment above says.
  var TYPE_CODES = ['lowAi', 'evasiveAi', 'strongEvasiveAi', 'lowEndAi', 'suspectAi', 'pro', 'expert', 'normal'];
  // Code -> CSS class. Kept as a map rather than string surgery (`lowAi` -> `low-ai`) because
  // a generated class name is exactly the kind of thing that silently produces an unstyled
  // badge when one code is renamed.
  var TYPE_CLASS = {
    lowAi: 'low-ai', evasiveAi: 'evasive-ai', strongEvasiveAi: 'strong-evasive-ai',
    // 低端AI is an AI class, so it takes the AI badge's own colour — see the `.tbadge` rules.
    lowEndAi: 'suspect-ai',
    suspectAi: 'suspect-ai', pro: 'pro', expert: 'expert', normal: 'normal',
  };
  // What a reader should show for one side: the operator's override wins, then the report's
  // automatic result, then the archive's lifted copy (storage.js's resolveType writes that so
  // the list can badge a card it never opened). Returns null when neither exists — a
  // pre-0.4.3 archive — which every caller must render as "nothing", not as 普通玩家: claiming
  // a clean verdict we never computed is the one thing this must not do.
  function typeOf(obj, side) {
    var rep = (obj && obj.report) || {};
    var mt = rep.manualType;
    if (mt && typeof mt[side] === 'string' && mt[side]) return { type: mt[side], manual: true };
    var t = rep.types && rep.types[side];
    if (t && t.type) return { type: t.type, manual: false };
    var e = obj && obj.types && obj.types[side];
    if (e && e.type) return { type: e.type, manual: !!e.manual };
    return null;
  }
  function typeBadge(obj, side, withSide) {
    var r = typeOf(obj, side);
    if (!r) return '';
    return '<span class="tbadge ' + (TYPE_CLASS[r.type] || 'normal') + '">' +
      (withSide ? sideTag(side) + ' ' : '') + esc(TO('type', r.type)) +
      (r.manual ? '<span class="man" title="' + esc(T('viewer|人工指定')) + '">*</span>' : '') +
      '</span>';
  }
  // 0.4.3 §1.5: the badge line under a list card's metadata. §1.5 asks for the suspected side
  // only — a game checked against one player must not show a class it never computed for the
  // other — and for nothing at all when neither side has a class (a pre-0.4.3 archive), rather
  // than a row of dashes on every old card.
  function typeLine(obj, suspect) {
    var h = '';
    ['B', 'W'].forEach(function (side) {
      if (suspect === 'B' || suspect === 'W') { if (suspect !== side) return; }
      var b = typeBadge(obj, side, true);
      if (b) h += b + ' ';
    });
    h = h.trim();
    return h ? '<span class="ty" title="' + esc(T('viewer|类型徽章')) + '">' + h + '</span>' : '';
  }
  // 0.4.3 §1.5: 「AI 分类：黑 × 白 ×」 plus the dropdown that overrides it. One renderer for
  // the archive detail and the sample detail so the two cannot drift; `save` is the caller's
  // storage writer and `after` the caller's repaint.
  function renderTypeRow(el, obj, save, after) {
    if (!el) return;
    var rep = (obj && obj.report) || {};
    if (!rep.black && !rep.white) { el.innerHTML = ''; return; }
    var h = '<span>' + T('viewer|AI 分类') + '：</span>';
    // NOTE the aggregate keys are `black` / `white`, while the side codes are 'B' / 'W'. Indexing
    // `rep[side]` here reads `rep['B']`, which no report has — the guard above passes (the report
    // DOES have a black and a white aggregate) and then both iterations bail, leaving nothing but
    // the label. A wrong-index that looks like "the feature is missing" rather than throwing.
    ['B', 'W'].forEach(function (side) {
      if (!rep[side === 'B' ? 'black' : 'white']) return;
      var cur = (rep.manualType && rep.manualType[side]) || '';
      h += '<span class="tside">' + typeBadge(obj, side, true) +
        '<select data-type-side="' + side + '">' +
          '<option value=""' + (cur ? '' : ' selected') + '>' + T('viewer|自动') + '</option>' +
          TYPE_CODES.map(function (c) {
            return '<option value="' + c + '"' + (cur === c ? ' selected' : '') + '>' +
              esc(TO('type', c)) + '</option>';
          }).join('') +
        '</select></span>';
    });
    el.innerHTML = h;
    el.querySelectorAll('select[data-type-side]').forEach(function (sel) {
      sel.onchange = function () {
        save(sel.dataset.typeSide, sel.value || null).then(function () {
          if (after) after();
        });
      };
    });
  }

  function qualityOf(explicit, orderIssues, unordered, dropped) {
    if (explicit === 'good' || explicit === 'partial' || explicit === 'suspect') return explicit;
    if (orderIssues) return 'suspect';
    return (unordered || dropped) ? 'partial' : 'good';
  }

  function applyLang(setting) {
    LANG = GMI18n.resolveLang(setting);
    GMI18n.setLocale(LANG);
    // <html lang> is ours on this page (i18n.js checks the protocol), so setLocale already
    // rewrote it — nothing else to do here.
  }

  // ---- 0.4.7 §三.1 主题 ----
  // We are the page's document, so the attribute goes on <html> — unlike content.js, which
  // has to put it on a Shadow Host because the host page's <html> is the game's, not ours.
  //
  // `auto` is written to the DOM verbatim and left to CSS. `<html>` is the only element that
  // exists before the stylesheet is parsed, so resolving `auto` in JS would mean the very
  // first paint has the wrong palette (the attribute would not be there yet) and the operator
  // sees a flash of light on a dark machine — or the reverse. The media query has no such gap.
  function applyTheme(setting) {
    var t = G.clampTheme(setting);
    document.documentElement.setAttribute('data-theme', t);
    return t;
  }

  // ---- §1.1 透明度与模糊 / 0.5.4 §2.1 作用范围收缩 ----
  // The stored number is a TRANSPARENCY PERCENTAGE, not a CSS opacity: 0% = 完全不透明,
  // 100% = 全透明. The conversion — `cssOpacity = 1 - t/100` — lives in storage.js's
  // `cssOpacity()` so this page and content.js cannot end up disagreeing about it.
  //
  // ⚠ 0.4.7 had the direction inverted: its `level: 100` meant FULLY OPAQUE, so its slider ran
  // backwards against its own label and the CSS had to hand out two different alphas to hide
  // the contradiction. §1.1 replaces the model instead of reinterpreting the number.
  //
  // ⚠ 0.5.4 §2.1 replaces the MECHANISM. 0.5.3 wrote the result into `--viewer-elem-opacity` and
  // the stylesheet applied `opacity:` to the container — which fades the container's text, its
  // inputs and its progress bars along with its fill. The variable is a BACKGROUND ALPHA now
  // (`--viewer-elem-bg-alpha`), consumed as `rgba(var(--panel-rgb), …)`, so the type inside is
  // untouched by construction. The conversion is unchanged: it is still `cssOpacity(percent)`,
  // just written into an alpha channel instead of into `opacity`.
  //
  // Five independently capped parts; two are the viewer's, three belong to the overlay and are
  // applied there by content.js. The ceilings (95 / 80 / 95 / 90 / 80) are enforced by
  // `normalizeTransparency`, not by the sliders' `max` attributes: the slider's max is an
  // affordance, while the stored profile is an input this page never validates, and a value
  // past the ceiling would be written straight into `rgba()` and silently discarded at
  // computed-value time — leaving the element fully opaque with the readout claiming otherwise.
  //
  // Every variable is written even when the part is switched OFF, as 1 / 0px. The stylesheet
  // reads all three unconditionally, so skipping the write would leave the previous profile's
  // values behind and the UI would stay faded with the switch off.
  //
  // 按钮模糊度 is GONE (§2.1.2) and with it `--viewer-btn-blur`: there is no button-blur half of
  // this function any more. A stale variable would be harmless (nothing reads it) which is
  // exactly why it must not be left behind — the next person would wire it up again.
  function applyTransparency(setting) {
    var t = G.normalizeTransparency(setting);
    var root = document.documentElement;
    var v = t.viewer.enabled ? t.viewer : null;
    root.style.setProperty('--viewer-elem-bg-alpha', String(G.cssOpacity(v ? v.element : 0)));
    root.style.setProperty('--viewer-elem-blur', (v ? v.elementBlur : 0) + 'px');
    root.style.setProperty('--viewer-btn-bg-alpha', String(G.cssOpacity(v ? v.button : 0)));
    return t;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function setStatus(t) { $('status').textContent = t; }
  function setProgress(p, msg) { $('bar').style.width = p + '%'; if (msg) $('pmsg').textContent = msg; }
  function download(name, content, type) {
    var bl = new Blob([content], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(bl);
    a.download = name;
    a.click();
  }
  function pct(x) { return (x * 100).toFixed(0) + '%'; }
  function num(v, d) { return v == null ? d : v; }

  var RULE_NAME = { 0: 'freestyle', 1: 'standard', 2: 'renju' };
  var RULE_LABEL = { freestyle: 'Freestyle', standard: 'Standard', renju: 'Renju' };
  // Session kind recorded by content.js (meta.identity). 'registered' is the ordinary case;
  // the other two are exactly the ones (0.3.0 §2) that used to be indistinguishable from a
  // broken capture, so they are worth naming out loud in the detail view.
  var ID_LABEL = { registered: '注册账号', guest: '游客账号', spectator: '观战' };

  // =====================================================================
  // 0.3.5 §3.2 步骤明细列：折叠 / 展开
  // =====================================================================
  // One preference shared by ALL FOUR step tables (检测 / 回放详情 / 样本详情 / 样本编辑),
  // because they are the same 17 columns in the same order and a per-table setting would mean
  // four places to keep in sync for no benefit.
  //
  // Default: the eight columns that describe a hand (方 / 实际 / T1 / T3 / T5 / 好点池 / 标记 /
  // 人工标记) stay; the engine's working (最佳 / 前5候选 / 胜率差 / 妙手 / 将败 / 被迫防守 / 耗时ms)
  // folds away. `#` is fixed — it is the row's identity, not a column to read, and hiding it would
  // leave the table with no way to say which hand a row is.
  // 0.4.1 §五.3: a FUNCTION, not a module-level array. `T()` is called once per column on
  // every rebuild now, because a frozen `label` kept whatever language was selected when the
  // page loaded: switching to English mid-session left the column menu and the fold glyphs'
  // tooltips in the old language until a reload. The table headers themselves were fine (they
  // are static HTML and GMI18n.apply() rewrites them), which is exactly what made this one
  // hard to notice — the menu under the header disagreed with the header.
  function stepCols() {
    return [
      { key: 'moveNo',    label: '#',          hide: false, fixed: true },
      { key: 'side',      label: T('viewer|方'),         hide: false },
      { key: 'actual',    label: T('viewer|实际'),       hide: false },
      { key: 'best',      label: T('viewer|最佳'),       hide: true  },
      { key: 'cands',     label: T('viewer|候选（前5/8）'), hide: true  },
      { key: 'top1',      label: 'T1',         hide: false },
      { key: 'top3',      label: 'T3',         hide: false },
      { key: 'top5',      label: 'T5',         hide: false },
      // 0.5.5 §1.4.3 — the 好点池 column. It sits immediately after T5 because that is the tier it
      // is read from: ✓ when the hand landed inside the engine's top five (or, on a hand the engine
      // was given eight candidates for, inside the top eight), plus the RUNNING count once the run
      // is worth printing. `goodPool`/`isGood` are stamped on the step by app.js — this is a read.
      { key: 'good',      label: T('viewer|好点池'), hide: false },
      { key: 'loss',      label: T('viewer|胜率差'),     hide: true  },
      { key: 'sharp',     label: T('viewer|妙手'),       hide: true  },
      { key: 'desperate', label: T('viewer|将败'),       hide: true  },
      // 0.4.2 §2.5: 回避 sits next to 将败 because the two are easy to confuse and mean
      // opposite things — 将败 is a run of hopeless hands in a LOST position, 回避 is one bad
      // hand between two perfect ones in any position. Their badges are deliberately different
      // colours for the same reason.
      { key: 'evasion',   label: T('viewer|回避'),       hide: true  },
      { key: 'forced',    label: T('viewer|被迫防守'),   hide: true  },
      { key: 'thinkMs',   label: T('viewer|耗时ms'),     hide: true  },
      { key: 'badge',     label: T('viewer|标记'),       hide: false },
      { key: 'ann',       label: T('viewer|人工标记'),   hide: false },
    ];
  }
  var STEP_TABLES = ['tbl', 'dTbl', 'sTbl', 'seTbl'];
  var colPrefs = null;      // { key: bool } — persisted, see loadColPrefs

  function colDefaults() {
    var d = {};
    stepCols().forEach(function (c) { d[c.key] = !c.hide; });
    return d;
  }
  // Callback form on purpose: the rest of this file only ever uses chrome.storage's callback
  // API, and the promise form is not guaranteed on every Chrome the operator may be running.
  function loadColPrefs() {
    return new Promise(function (resolve) {
      var def = colDefaults();
      function done(saved) {
        var out = Object.assign({}, def, (saved && typeof saved === 'object') ? saved : {});
        // A stored preference must never be able to hide `#`.
        stepCols().forEach(function (c) { if (c.fixed) out[c.key] = true; });
        colPrefs = out;
        resolve(out);
      }
      try {
        chrome.storage.local.get('viewerCols', function (r) {
          done(r && r.viewerCols);
        });
      } catch (e) { done(null); }
    });
  }
  function saveColPrefs() {
    try { chrome.storage.local.set({ viewerCols: colPrefs }); } catch (e) {}
  }

  // Hiding is done with one injected stylesheet rather than a class on 15 cells × N rows: the
  // tables are rebuilt constantly (every analysis step, every annotation click), and a rule
  // that targets the nth cell survives that without any renderer having to know about it.
  // `tr:not(.step-note)` keeps the per-step note row — a single wide cell — out of the blast.
  function applyColPrefs() {
    if (!colPrefs) return;
    var el = document.getElementById('gmColStyle');
    if (!el) {
      el = document.createElement('style');
      el.id = 'gmColStyle';
      document.head.appendChild(el);
    }
    var css = '';
    stepCols().forEach(function (c, i) {
      if (c.fixed || colPrefs[c.key] !== false) return;
      var n = i + 1;
      STEP_TABLES.forEach(function (t) {
        css += '#' + t + ' tr:not(.step-note)>th:nth-child(' + n + '),' +
               '#' + t + ' tr:not(.step-note)>td:nth-child(' + n + '){display:none}';
      });
    });
    el.textContent = css;
    renderColMenu();
  }

  function toggleCol(key) {
    var c = null;
    stepCols().forEach(function (x) { if (x.key === key) c = x; });
    if (!c || c.fixed) return;
    colPrefs[key] = colPrefs[key] === false;   // hidden -> show, shown -> hide
    saveColPrefs();
    applyColPrefs();
  }

  // A ▼ on every foldable header. Clicking the glyph is the ONLY thing that toggles: a click
  // anywhere else in the row is already a jump-to-hand gesture in 检测, and making the whole
  // header a hide button would fold a column away every time someone meant to look at a row.
  function buildColToggles() {
    var cols = stepCols();
    STEP_TABLES.forEach(function (t) {
      var table = $(t);
      if (!table) return;
      table.querySelectorAll('thead th').forEach(function (th, i) {
        var c = cols[i];
        if (!c || c.fixed) return;
        var sp = th.querySelector('.col-toggle');
        if (!sp) {
          sp = document.createElement('span');
          sp.className = 'col-toggle';
          sp.dataset.col = c.key;
          sp.textContent = '▼';
          // Bound once and keyed by `c.key`, which is language-independent — so the handler
          // never has to be re-registered when the language changes (0.4.1 §五.3).
          sp.addEventListener('click', function (ev) {
            ev.stopPropagation();
            toggleCol(c.key);
          });
          th.insertBefore(sp, th.firstChild);
        }
        // Re-stamped on every call, not only on creation: this is what makes 语言与显示 →
        // English retitle the fold glyphs without a reload.
        sp.title = T('viewer|折叠 / 展开「{col}」列', { col: c.label });
      });
    });
  }

  // The header ▼ can hide a column but cannot bring it back — the header goes with it. This
  // menu is the way back, and it is the only place that lists all seventeen at once.
  function renderColMenu() {
    var el = $('colMenu');
    if (!el || !colPrefs) return;
    var h = '<div class="cmh">' + T('viewer|步骤明细列（四张表共用）') + '</div>';
    stepCols().forEach(function (c) {
      var on = c.fixed || colPrefs[c.key] !== false;
      h += '<label class="cmrow' + (c.fixed ? ' fixed' : '') + '">' +
        '<input type="checkbox" data-col="' + c.key + '"' + (on ? ' checked' : '') +
        (c.fixed ? ' disabled' : '') + '>' + esc(c.label) + '</label>';
    });
    h += '<div class="cmft">' +
      '<button class="sec" data-cm="all">' + T('viewer|展开全部') + '</button>' +
      '<button class="sec" data-cm="none">' + T('viewer|折叠全部') + '</button>' +
      '<button class="sec" data-cm="reset">' + T('viewer|恢复默认') + '</button></div>';
    el.innerHTML = h;
  }

  function setAllCols(show) {
    stepCols().forEach(function (c) {
      colPrefs[c.key] = c.fixed ? true : show;
    });
    saveColPrefs();
    applyColPrefs();
  }

  function wireColMenu() {
    var btn = $('colBtn'), el = $('colMenu');
    if (!btn || !el) return;
    btn.onclick = function () {
      var nowHidden = el.classList.toggle('hidden');
      if (nowHidden) return;
      // Placed against the button every time: the header wraps at narrow widths, so its
      // position is not knowable at boot.
      var r = btn.getBoundingClientRect();
      el.style.top = (r.bottom + 6) + 'px';
      var left = Math.min(r.left, window.innerWidth - el.offsetWidth - 8);
      el.style.left = Math.max(8, left) + 'px';
    };
    el.addEventListener('change', function (ev) {
      var box = ev.target && ev.target.dataset ? ev.target : null;
      if (!box || !box.dataset.col) return;
      colPrefs[box.dataset.col] = !!box.checked;
      saveColPrefs();
      applyColPrefs();
    });
    el.addEventListener('click', function (ev) {
      // Stop here, always. Every click inside the menu re-renders it (renderColMenu runs from
      // applyColPrefs), which DETACHES the element that was clicked — and the outside-click
      // handler below then sees a target that is no longer inside `el`, decides the click was
      // outside, and closes the menu after its first use. Swallowing the event is the only
      // version of this that survives the re-render.
      ev.stopPropagation();
      var b = ev.target && ev.target.closest ? ev.target.closest('button[data-cm]') : null;
      if (!b) return;
      var what = b.dataset.cm;
      if (what === 'all') setAllCols(true);
      else if (what === 'none') setAllCols(false);
      else { colPrefs = colDefaults(); saveColPrefs(); applyColPrefs(); }
    });
    document.addEventListener('click', function (ev) {
      if (el.classList.contains('hidden')) return;
      if (el.contains(ev.target) || ev.target === btn) return;
      el.classList.add('hidden');
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') el.classList.add('hidden');
    });
  }

  // =====================================================================
  // nav
  // =====================================================================
  // 1.0.1 §1.3 — the views §1.1 marks ❌ for an unactivated operator. `profile`/`account` are in the
  // list because they belong to an ACCOUNT (§3.3), not because a nav button leads to them: §3.1
  // removes 我的's tab and reaches both through the drawer, so the drawer is the only door — and a
  // door into a room the operator may not enter is exactly what this list closes.
  // 1.0.2 二.1 adds `community`: §2.1 「未激活用户：不显示「社区」按钮」, and it is in the list for the
  // same reason as the three above — hiding the button is §2.1's visible half, and the router is
  // where the invisible half lives.
  var GATED_VIEWS = ['replay', 'samples', 'blacklist', 'profile', 'account', 'community'];

  /** The gate, in the one form this file asks it in. Sync, because `GMAuth.gateOpen()` is. */
  function activationOpen() { return !!(GMAuth.gateOpen && GMAuth.gateOpen()); }

  /** Whether the nav is allowed to route to `name` right now. */
  function viewAllowed(name) {
    // §6.3's 管理员 needs the activation gate AND the admin flag — two conditions, and the second is
    // the only one §6.1 lets the client evaluate (for VISIBILITY, never for authorisation).
    if (name === 'admin') return activationOpen() && !!(GMAdmin.isAdmin && GMAdmin.isAdmin());
    if (GATED_VIEWS.indexOf(name) !== -1) return activationOpen();
    return true;
  }

  function showView(name, opts) {
    // 1.0.1 §1.3 — 「用户点击被隐藏的功能入口（如「回放」）→ 弹出激活引导」. The refusal lives HERE,
    // at the single door, rather than on each of the three nav buttons: a button that is hidden is
    // not the only way in (the drawer, a stale handler, a restored scroll position and any future
    // deep link all land in this function), and per-button guards would be three copies of one rule.
    if (!viewAllowed(name)) {
      if (GATED_VIEWS.indexOf(name) !== -1) openActivationGuide();
      return;
    }
    // ⚠ BEFORE the `.active` class moves. `activeView()` answers from `.view.active`, so asking it
    // after the toggle would answer with the view we are going TO and 「was the community view on
    // screen?」 would be a question about the destination — the teardown below would never run.
    var was = activeView();
    var btns = document.querySelectorAll('.navbtn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].dataset.view === name);
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    var view = $('view-' + name);
    if (view) view.classList.add('active');
    // 0.2.6: the shell/detail scale lives on :root, so every tab is sized the same and
    // switching views no longer has to toggle a body class. Only the in-page panel keeps
    // its own compact sizing, and that is a different document anyway.
    if (name === 'replay') refreshArchives();
    if (name === 'samples') refreshSamples();
    // 0.4.9 §一.7 — the blacklist is read fresh on every visit rather than cached at boot: the
    // panel's 🚫 button can have added a player since this page was opened, and a stale list
    // here would show 「不在黑名单」 for someone the operator just blocked.
    if (name === 'blacklist') refreshBlacklist();
    // 0.5.1 — `opts.repaint` is the language switch re-entering this function with the view it is
    // already on. The three readers above are pure reads and should re-run; the settings pane's
    // engine-status query is NOT, because `askOffscreen()` calls `ensureOffscreen()` first, which
    // CREATES the offscreen document and loads a 40 MB engine. A repaint re-paints from the answer
    // already in hand instead of asking again.
    if (name === 'settings') renderSettings(opts && opts.repaint);
    // 1.0.0 §5/§6 — the account-aware tabs. 主页 is repainted from the memoised session (a pure
    // function of state), so it costs nothing to redraw on every visit; 账号设置 draws from the same
    // state but rebuilds a form, and 管理员's list is a network read, so it is fetched only until it
    // has arrived once — `opts.repaint` (a language switch) must not fire another request, for the
    // same reason the settings pane does not re-ask the offscreen document.
    if (name === 'profile') { renderProfile(); }
    if (name === 'account') { buildAccountPanel(); }
    if (name === 'admin') { renderAdmin(); if (!ADC.loaded) adminLoadUsers(1); }
    // 1.0.2 二 — the community view. `was === name` is what distinguishes a REPAINT (a language
    // switch re-entering the view it is already on) from an ENTRY, and `was` is asked rather than
    // `opts.repaint` because mistaking the two has opposite costs: an entry taken for a repaint is a
    // room that never loads and never says why, while a repaint taken for an entry is a socket that
    // reconnects because someone changed the language.
    if (name === 'community') refreshCommunity(was === 'community');
    if (was === 'community' && name !== 'community') cmLeave();
  }
  document.querySelectorAll('.navbtn').forEach(function (b) {
    b.onclick = function () { showView(b.dataset.view); };
  });
  // 1.0.1 §3.5 — the account area opens the drawer, anchored under the button it was clicked on.
  //
  // ⚠ `stopPropagation()` is REQUIRED here, and it is the same trap `showUserMenu` documents for its
  // `.it` handlers. The drawer is built on `showCtx`, whose document-level 「clicked outside?」
  // listener (`if (!ctx.contains(e.target)) closeCtx()`) runs on the SAME click that opened it: the
  // chip is not inside `#ctx`, so without this guard the menu is populated and then wiped before the
  // frame is even painted — the drawer opens and closes so fast that the panel looks like a button
  // that does nothing. `openCardMenu` never hit this because it is opened from `contextmenu`, which
  // the document `click` listener does not see.
  if ($('navUser')) {
    $('navUser').onclick = function (e) {
      e.stopPropagation();
      var r = e.currentTarget.getBoundingClientRect();
      showUserMenu(r.left, r.bottom + 4);
    };
  }
  // §3.4 — 「点击「激活」→ 打开激活界面」.
  if ($('navActivate')) $('navActivate').onclick = function () { openActivationGuide(); };

  // ---- 0.3.6 §1.8: repaint on a language switch, without a reload ----
  // Three groups have to be redrawn: the static markup the implicit pass tagged, the detect
  // pane (always in the DOM), and whichever list or report the active view owns. The
  // `<select>` in 设置 is refilled by fillSettingsForm, so the switch itself stays visible.
  function repaintForLang() {
    GMI18n.apply(document);
    fillLangSelect();
    fillThreadSelect();
    // 0.4.11 §一.3 — the 主题 options are JS-built labels, so they carry no `__gmKey` and the
    // static pass above cannot reach them. Without this the dropdown kept the previous language
    // until a reload, which is acceptance #2 of §一.3. `fillSettingsForm()` below restores the
    // selection (rebuilding innerHTML drops it back to the first option).
    fillThemeSelect();
    // 0.5.3 §1.1.6 — same reason as the theme options directly above: the transparency panel's
    // ten labels are built in JS, so the static pass cannot reach them. The rebuild resets the
    // sliders, which is why it has to come before `fillSettingsForm()` restores their values.
    buildTransparencyPanel();
    // 0.5.4 §1.5 — same reason again: these four labels are set from JS, and rebuilding the
    // controls resets their values, so this must come before `fillSettingsForm()` restores them.
    buildStorageFilter();
    // 0.5.6 补增 §三 — same reason once more. The thirteen labels are semantic keys resolved at
    // render time and the thirteen boxes are rebuilt with them, so the build has to come before
    // `fillSettingsForm()` repaints the values.
    buildSignalWeightsPanel();
    // 0.5.6 §1.3 — 导入与导出. Every label in the panel (and both category grids) is written by
    // JS, so the static pass above cannot reach them. Rebuilt rather than re-initialised: the
    // operator's export ticks survive, because buildIoPanel reads `ioChecked` instead of
    // resetting it.
    buildIoPanel();
    // 1.0.0 §7.1 — the same rule again for the account/sync panel, and for the account pages: every
    // word in them is written by JS. 1.0.1's gate is here as well as in the renderers because a
    // language switch must not be able to leave a gated tab looking available, and the drawer's
    // label is built by JS too.
    buildCloudPanel();
    buildAccountPanel();
    applyActivationGate();
    renderProfile();
    renderAdmin();
    renderPrivacyLink();
    // §一.4: the banner and the settings page's status line are built in JS, so they carry no
    // `__gmKey` and the static pass above cannot reach them.
    fillVersionRow();
    paintUpdStatus();
    refreshUpdateBanner();
    syncDetectControls();
    fillSettingsForm();
    fillOpeningFilter();
    fillCategoryFilter();
    fillSampleTagFilter();
    renderLearnStatus();
    setPauseLabel();
    // 0.4.1 §五.3: the step columns are a JS-built table of contents, so the static
    // pass above cannot reach them. `buildColToggles` re-stamps the fold glyphs' titles and
    // `renderColMenu` rebuilds the ▾ menu from scratch — between them the whole column UI
    // follows the language, which it did not before (the menu kept the load-time language).
    buildColToggles();
    renderColMenu();
    // A finished report is re-rendered rather than cleared: switching language mid-review must
    // not cost the operator the analysis they were reading.
    if (report) renderReport(); else resetReport();
    var active = document.querySelector('.navbtn.active');
    // `{ repaint: true }` — the settings pane must re-paint its engine status from the answer it
    // already has, not ask the offscreen document again (§2.1.4: a language switch must not be
    // what loads a 40 MB engine).
    showView(active ? active.dataset.view : 'detect', { repaint: true });
    // 0.4.2 §2.5: the two detail panes are built entirely in JS — 指标汇总's rows, the step
    // table's <tbody>, the contribution list — so `apply(document)` above cannot reach them,
    // and `showView` only refreshes the LIST (`refreshArchives()`). The result was a
    // half-translated view: the ▾ column menu switched to "Evasion" while 回避手 / 将胜乱下
    // two inches away stayed in the load-time language. Exactly the 0.4.1 §五.3 defect, in the
    // other pane. `renderDetail` dereferences `curArchive` unguarded (unlike
    // `renderSampleDetail`, which returns early), so the test has to be here.
    if (curArchive) renderDetail();
    if (curSample) renderSampleDetail();
    // 0.4.3 §1.3/§1.5: the four segment legends, the two AI-class rows and the sample editor's
    // score cards are built entirely in JS, so `apply(document)` cannot reach them — the same
    // defect the two comments above describe, in three more panes. The type rows are rebuilt by
    // `renderDetail` / `renderSampleDetail` just above; the legends and the editor's scores are
    // owned by no renderer, so they are repainted here.
    renderSegLegends();
    if (editing) renderSeScores(seReport);
  }

  // =====================================================================
  // settings
  // =====================================================================
  var S = G.defaults();
  // Writing a setting makes chrome.storage fire onChanged, and the handler used to
  // re-fill every field from storage. That round-trip lands *after* the user has moved
  // to the next field, so touching two settings in quick succession would snap the one
  // being edited back to its previous value. Two defences: never overwrite a focused
  // field, and skip the re-fill entirely for our own writes.
  var lastSelfWrite = 0;

  function setField(el, v) {
    if (!el) return;
    if (document.activeElement === el) return;   // the user owns this box right now
    el.value = v;
  }

  function fillSettingsForm() {
    setField($('setSuspect'), S.suspect);
    setField($('setMode'), S.mode);
    setField($('setThinkMs'), S.thinkMs);
    setField($('setAiThinkMs'), (S.aiThinkMs == null ? '' : S.aiThinkMs));
    setField($('setOpening'), S.openingCutoff);
    setField($('setThread'), S.threadNum);
    setField($('setMinMoves'), S.minArchiveMoves);
    setField($('setLang'), S.lang || 'auto');
    // 0.4.11 §一.3 (found by behave-051, not by the spec) — the 主题 dropdown has to restore its
    // SELECTION here and not only its labels. `fillThemeSelect()` rebuilds the <select> by
    // assigning innerHTML, and a rebuilt select falls back to its first option — `G.THEMES` is
    // ['light','dark','auto'], so an operator on 深色 who switched the UI language watched the
    // settings page snap to 浅色 while <html data-theme> stayed "dark". The dropdown was lying
    // about the live theme, which is a smaller version of the same class of defect as the frozen
    // label §一.3 is about: the control showing something other than the value in force.
    setField($('setTheme'), S.theme);
    $('setAuto').checked = !!S.autoAnalyze;      // a checkbox has no half-edited state
    $('setChatAuto').checked = !!S.chatAuto;     // 0.4.4 §七/§八 master switch, default off
    // 0.4.10 §2.2 — the narrower switch, default ON (see storage.js DEFAULTS for why).
    $('setAutoAnnounce').checked = !!S.autoSendAnnouncement;
    fillTransparencyForm();
    fillArchiveFilterForm();
    fillStorageFilterForm();
    // 0.5.6 补增 §三 — the thirteen weight boxes. Filled from the RESOLVED table (app.js's
    // `effectiveSignalWeights`), so a set storage refused shows up here as the numbers that are
    // actually in force rather than as the ones that were typed.
    fillSignalWeightsForm();
    fillLlmForm();
    // 0.5.1 §2.1.4/§2.2 — labels, dropdown contents, the address field and the status line. The
    // custom-model LIST is filled from whatever the registry holds right now; boot() and every
    // entry point refresh that registry from IndexedDB and repaint (see afterEngineChange).
    fillEngineForm();
    fillCustomPanel();
    // 0.5.2 §5.1 / §4.1 — the two panels whose state does not live in `settings`: the background
    // record is in IndexedDB and the question list is its own storage key. Both fill from their
    // own loader rather than from `S`, which is what keeps this function from needing a second
    // source of truth for them.
    fillBgPanel();
    fillCqPanel();
  }

  // ---- 0.4.7 §三.1: the theme dropdown ----
  // Built from GMStorage.THEMES, same reasoning as the language and thread lists: the option
  // set and the value clamp are two halves of one fact, and writing the options out in
  // viewer.html would be the second copy that drifts.
  //
  // 0.4.11 §一.3 — the labels are resolved by a FUNCTION, not baked into a module-level object.
  // The old `THEME_LABEL` table ran its three T() calls while the module was being evaluated —
  // i.e. BEFORE boot()'s applyLang() — so on an English UI the 主题 dropdown
  // therefore stayed 「浅色 / 深色 / 跟随系统」 for the life of the page — precisely the rule
  // i18n.js keeps repeating: any T() evaluated before applyLang() freezes on the default
  // language. Reading the dictionary inside themeLabel() means the label follows whatever locale
  // is live when the select is built, and `repaintForLang()` rebuilds it on a switch.
  //
  // The three keys stay LITERAL `T()` calls rather than `T('viewer|' + …)`. A concatenated key is
  // invisible to `_tools/keys.cjs` (it sees only the SHAPE), so it would have to be declared a
  // second time in i18n-extra.js — and a key that exists in exactly one of the two places is how
  // a language ends up printing a raw slug. Switching on the code keeps every argument literal.
  function themeLabel(t) {
    if (t === 'light') return T('viewer|浅色');
    if (t === 'dark') return T('viewer|深色');
    if (t === 'auto') return T('viewer|跟随系统');
    return t;
  }

  function fillThemeSelect() {
    var sel = $('setTheme');
    if (!sel) return;
    sel.innerHTML = G.THEMES.map(function (t) {
      return '<option value="' + esc(t) + '">' + esc(themeLabel(t)) + '</option>';
    }).join('');
    // These nodes are built in viewer.html, so the static i18n pass would normally tag them —
    // but they are `id`-bearing labels the JS already knows by name, and tagging them here keeps
    // the 主题 block self-contained rather than split across two files.
    setTxt('setThemeLabel', T('viewer|主题'));
    setTxt('setThemeHint', T('viewer|跟随系统时由浏览器/操作系统决定；浅色与深色为强制覆盖。'));
  }

  function setTxt(id, v) {
    var el = $(id);
    if (el) el.textContent = v;
  }

  // ---- 0.5.3 §3.1: 棋谱代码的复制 / 粘贴 / 清空 ----
  // One delegated listener per `.code-box` rather than one per button, and it reads the target's
  // `data-act` — the same shape the step tables use for their buttons, so adding a fourth action
  // later is a matter of writing the button and one more branch.
  //
  // ⚠ 粘贴 is the one that cannot be guaranteed. `navigator.clipboard.readText()` needs both a
  // user gesture (we have one — this is a click) and, in some builds, an explicit permission;
  // a chrome-extension:// page has the gesture but may still be refused. §3.1.3 says to fall
  // back to asking the operator to paste by hand, so a rejection produces a warning that says
  // exactly that rather than an error that leaves them guessing. The textarea is focused in that
  // case, so Ctrl+V lands where they expect.
  function bindCodeBoxes() {
    var boxes = document.querySelectorAll('.code-box');
    for (var i = 0; i < boxes.length; i++) {
      (function (box) {
        var ta = box.querySelector('textarea');
        if (!ta) return;
        box.addEventListener('click', async function (e) {
          var btn = e.target && e.target.closest ? e.target.closest('.code-btn') : null;
          if (!btn) return;
          var act = btn.getAttribute('data-act');
          if (act === 'copy') {
            try {
              await navigator.clipboard.writeText(ta.value);
              GmToast.show(T('toast|已复制到剪贴板'), 'success');
            } catch (err) {
              GmToast.show(T('toast|复制失败：{err}', { err: TE(err.message) }), 'error');
            }
            return;
          }
          if (act === 'paste') {
            var got = '';
            try {
              got = await navigator.clipboard.readText();
            } catch (err) {
              ta.focus();
              GmToast.show(T('toast|无法读取剪贴板，请手动粘贴（Ctrl+V）'), 'warn');
              return;
            }
            if (!got) { GmToast.show(T('toast|剪贴板是空的'), 'warn'); return; }
            ta.value = got;
            // The `input` event is what every consumer of these boxes listens on (`oninput`),
            // so writing `.value` alone would leave the draft, the board and the parse all
            // showing the previous record.
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            GmToast.show(T('toast|已粘贴'), 'success');
            return;
          }
          if (act === 'clear') {
            if (!ta.value) { ta.focus(); return; }
            if (!confirm(T('viewer|清空棋谱代码？'))) return;
            ta.value = '';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            GmToast.show(T('toast|已清空'), 'info');
          }
        });
      })(boxes[i]);
    }
  }

  // ---- 0.5.3 §2.2.4: 回放过滤 ----
  // Three controls and one warning. The warning is the point: §2.2.5 says `minRisk > maxRisk` is
  // an INVALID configuration, and the honest reading of "invalid" is "the filter does nothing"
  // rather than "the filter blocks everything" — an inverted interval matches no score, so
  // leaving it armed would quietly disable archiving entirely. `shouldSkipArchive` returns false
  // for it, and this function says so out loud instead of leaving the operator to notice that
  // their archives stopped appearing.
  function fillArchiveFilterForm() {
    var f = G.normalizeArchiveFilter(S.archiveFilter);
    var en = $('afEnabled'), lo = $('afMin'), hi = $('afMax');
    if (en) en.checked = !!f.enabled;
    // Never rewrite a box the operator is typing into. The commit is debounced by 400ms and
    // `fillArchiveFilterForm()` runs when it resolves, so without this guard a save that landed
    // between two keystrokes would move the caret and eat the rest of the number — the same
    // "operator is typing" rule content.js applies before its full repaint.
    var typing = (typeof document !== 'undefined') ? document.activeElement : null;
    if (lo && lo !== typing) lo.value = String(f.minRisk);
    if (hi && hi !== typing) hi.value = String(f.maxRisk);
    var bad = G.archiveFilterInvalid(f);
    if (lo) lo.disabled = !f.enabled;
    if (hi) hi.disabled = !f.enabled;
    setTxt('afTitle', T('viewer|回放过滤'));
    setTxt('afEnabledLabel', T('viewer|启用'));
    setTxt('afEnabledHint', T('viewer|开启后，AI 率落在下面范围内的对局不自动保存回放。'));
    setTxt('afRangeLabel', T('viewer|AI 率范围'));
    setTxt('afHint', bad
      ? T('viewer|范围无效：下限大于上限，过滤已停用。请把下限调到不大于上限。')
      : T('viewer|该范围内的对局不保存回放；双方同时检测时以较高的一侧为基准。手动「存为存档」不受此过滤影响。'));
  }

  // ---- 0.5.4 §1.5: 存储过滤的双段滑条 ----
  // Two thresholds over the SHAPE of a capture, drawn as one bar with a decorative gap. The left
  // segment is a LOWER bound (bigger = stricter ⇒ it grows rightwards); the right is an UPPER
  // bound (bigger = more permissive ⇒ it grows leftwards, into the gap). §1.5.1 gives that
  // reasoning, and it is the whole reason the right slider is mirrored.
  //
  // ⚠ The mirror is NOT a static `dir="rtl"` on the element. This page is laid out with `dir` on
  // <html> for the Arabic locale (i18n.js sets it), and a `dir="rtl"` range input inside an RTL
  // document reads as LTR — the two mirrors cancel and both sliders grow the same way. The right
  // track therefore takes the OPPOSITE of the document's direction, recomputed on every paint by
  // `syncStorageFilterDir()`.
  //
  // Slider, number box and the two arrows are three views of ONE value (§1.5.4), so they are
  // described once in this table and wired once by the loop rather than three times by hand.
  var SF_ROWS = [
    { key: 'minOrdered', range: 'slMinOrdered', num: 'setMinOrdered' },
    { key: 'maxUnordered', range: 'slMaxUnordered', num: 'setMaxUnordered' },
  ];

  function sfRangeEl(row) { return $(row.range); }
  function sfNumEl(row) { return $(row.num); }

  function syncStorageFilterDir() {
    var el = $('slMaxUnordered');
    if (!el) return;
    var docDir = String(document.documentElement.getAttribute('dir') || 'ltr').toLowerCase();
    el.setAttribute('dir', docDir === 'rtl' ? 'ltr' : 'rtl');
  }

  // The RANGE is what the design fixes (0–50, §1.1); the ceilings come from
  // `STORAGE_FILTER_LIMITS` so the slider and the clamp can never disagree — the same rule the
  // transparency panel follows, and for the same reason (a max that disagrees with the clamp
  // snaps back on release with no visible cause).
  //
  // 0.5.5 §1.5.1 — the two captions are the sketch's own labels, one per segment. The combined
  // `sfRangeLabel` names the PAIR and stays as the group heading; without a name on each bar the
  // operator could not tell the floor from the ceiling, which is what the shipped panel looked
  // like. Both are literals so `keys.cjs` sees them (a computed key never reaches the tables).
  function buildStorageFilter() {
    var lim = (G.STORAGE_FILTER_LIMITS || {});
    setTxt('sfTitle', T('viewer|存储过滤'));
    setTxt('sfEnabledLabel', T('viewer|启用'));
    setTxt('sfEnabledHint', T('viewer|开启后，下面两个条件任一命中的对局不自动保存回放。'));
    setTxt('sfRangeLabel', T('viewer|有序手下限 / 无序手上限'));
    setTxt('sfMinCap', T('viewer|有序手下限'));
    setTxt('sfMaxCap', T('viewer|无序手上限'));
    setTxt('sfHint', T('viewer|有序手低于下限、无序手高于上限的对局不会被自动存档。手动「存为存档」不受此过滤影响。'));
    SF_ROWS.forEach(function (row) {
      var hi = typeof lim[row.key] === 'number' ? lim[row.key] : 50;
      var r = sfRangeEl(row), n = sfNumEl(row);
      if (r) r.setAttribute('max', String(hi));
      if (n) n.setAttribute('max', String(hi));
    });
    syncStorageFilterDir();
  }

  // Paints every control from `S.storageFilter`. Same "never rewrite a box the operator is
  // typing into" guard as `fillArchiveFilterForm`: the commit is debounced, and a save that
  // landed between two keystrokes would otherwise move the caret and eat the rest of the number.
  function fillStorageFilterForm() {
    var f = G.normalizeStorageFilter(S.storageFilter);
    var en = $('sfEnabled');
    if (en) en.checked = !!f.enabled;
    var typing = (typeof document !== 'undefined') ? document.activeElement : null;
    SF_ROWS.forEach(function (row) {
      var r = sfRangeEl(row), n = sfNumEl(row);
      if (r) r.disabled = !f.enabled;
      if (n) n.disabled = !f.enabled;
      var v = String(f[row.key]);
      if (r) r.value = v;
      if (n && n !== typing) n.value = v;
    });
    var arrows = document.querySelectorAll('#sfSlider .ds-arrow');
    for (var i = 0; i < arrows.length; i++) arrows[i].disabled = !f.enabled;
  }

  // ---- 0.5.6 补增 §三: 检测信号权重 ----
  //
  // Sixteen numbers that are ONE table (thirteen before 0.5.7 §1). The requirement is 「每种检测
  // 信号都可以由操作者在设置中进行权重自定义」 with the custom total capped at 150%, and the two
  // halves are inseparable: the risk score is Σ weight × sub-score, so the TOTAL decides how
  // easily a game crosses the 70/40 cuts, not any single term. Sixteen anonymous boxes would let
  // an operator raise one weight five-fold and never learn why every game now reads 高风险 —
  // hence the running total above the grid, and the refusal below it.
  //
  // Three things this panel deliberately does NOT own, each of which would otherwise be a second
  // copy of one answer:
  //   · the KEY LIST and the two families come from learn.js (BASE_KEYS / WEIGHT_KEYS), which
  //     already owns that split for its two budgets;
  //   · the NUMBERS come from app.js's `effectiveSignalWeights` — the same function the score is
  //     built with, and the one that REFUSES a set which would take the total over the ceiling, so
  //     a box can only ever show what the detector will actually use;
  //   · the two CEILINGS come from GMStorage (SIGNAL_WEIGHT_MAX / SIGNAL_WEIGHT_SUM_MAX).
  //
  // Percent is the unit throughout: the requirement states the ceiling as 150%, the boxes are
  // percentages, and the stored weight is that over 100.
  function swKeys() {
    if (typeof GMLearn !== 'undefined' && GMLearn && GMLearn.WEIGHT_KEYS && GMLearn.WEIGHT_KEYS.length) {
      return GMLearn.WEIGHT_KEYS.slice();
    }
    // No learn.js (a stripped harness): the table itself still names every signal, so the grid is
    // complete — only the two family headings are lost, which is why the builder asks for them
    // separately instead of assuming they exist.
    return Object.keys(G.DEFAULT_WEIGHTS);
  }
  function swBaseKeys() {
    return (typeof GMLearn !== 'undefined' && GMLearn && GMLearn.BASE_KEYS) ? GMLearn.BASE_KEYS : null;
  }
  // 0.5.7 §1.3/§1.4 — the third 类别. Read from learn.js for the same reason as the two lists above:
  // the panel must not keep a second copy of "which keys are the new ones", or the day the learner's
  // group moves the panel keeps drawing a heading that no longer matches it.
  function swLowKeys() {
    return (typeof GMLearn !== 'undefined' && GMLearn && GMLearn.LOWEND_KEYS) ? GMLearn.LOWEND_KEYS : null;
  }
  function swId(key) { return 'sw-' + key; }
  function swMaxPct() { return Math.round(G.SIGNAL_WEIGHT_MAX * 100); }
  function swCapPct() { return Math.round(G.SIGNAL_WEIGHT_SUM_MAX * 100); }
  // What the SHIPPED table totals, read from the table rather than typed into the sentence: the
  // hint has to state it (an operator is entitled to know what the factory default is before they
  // change anything) and a literal would go stale the first time a release rebalances — which is
  // exactly what happened here, one increment after the hint was written.
  function swShippedPct() {
    var def = G.DEFAULT_WEIGHTS || {}, sum = 0;
    for (var k in def) if (def.hasOwnProperty(k)) sum += def[k];
    return Math.round(sum * 1000) / 10;
  }
  // 0.21 -> 21, 0.5231 -> 52.3. One decimal is what the boxes carry, so every number on this
  // screen — a box, the total, the 留空 reference — is rounded the same way and they add up.
  function swPct(w) { return Math.round((Number(w) || 0) * 1000) / 10; }
  function swFmt(n) { return String(Math.round(Number(n) * 10) / 10); }

  // The table a signal falls back to when the operator has NOT pinned it: the SHIPPED default.
  //
  // ⚠ 补增 §三·补 — it used to be `effectiveSignalWeights(curLearned, null)`, i.e. the learner's
  // table whenever 重新学习 had run, which is why this panel kept printing 10.5% / 3.4% / 16.6% (a
  // 0.5.5-era training run) as the 留空 figure no matter what the release shipped. The operator's
  // instruction was that 留空 must be the shipped table, and app.js's resolver now uses that as its
  // baseline — so `effectiveSignalWeights(null)` and `G.DEFAULT_WEIGHTS` are the same table, and
  // reading either one is correct. The resolver is preferred for the same reason as everywhere
  // else: one implementation, never a copy.
  function swInherited() {
    try {
      if (typeof effectiveSignalWeights === 'function') return effectiveSignalWeights(null);
    } catch (e) { /* app.js absent — the shipped table is the answer either way */ }
    return G.DEFAULT_WEIGHTS;
  }
  // What the detector will actually run with: the shipped table ⊕ the operator's pins. Reading it
  // from app.js rather than rebuilding the merge here is what makes a REFUSED set visible on this
  // screen — a set storage or the resolver would not honour renders as the inherited numbers, not
  // as the numbers that were typed.
  function swResolved() {
    try {
      if (typeof effectiveSignalWeights === 'function') return effectiveSignalWeights(S.signalWeights);
    } catch (e) { /* same */ }
    return G.DEFAULT_WEIGHTS;
  }

  // What the boxes say right now, in percent, plus the total the ceiling is compared against.
  // ONE reading: the total, the refusal and the write all come from here, so the number printed on
  // screen is the number that is checked.
  function swReadForm() {
    var inh = swInherited(), pct = {}, sum = 0;
    swKeys().forEach(function (key) {
      var el = $(swId(key));
      var v = (el && String(el.value).trim() !== '') ? parseFloat(el.value) : NaN;
      // An empty box means "not pinned" — the 留空 hint names the number that will be used — and
      // so does anything unparsable. A `type=number` box reports junk as '', not as letters.
      var p = isFinite(v) ? v : swPct(inh[key]);
      pct[key] = p;
      sum += p;
    });
    return { pct: pct, sum: sum };
  }

  function swPaintTotal(sum) {
    var el = $('swTotal');
    if (!el) return;
    el.textContent = T('viewer|合计 {p}% · 上限 {c}%', { p: swFmt(sum), c: swCapPct() });
    // Painting the over-limit state BEFORE the edit is committed is the point: the operator sees
    // the ceiling coming while they type rather than after a box snaps back.
    el.className = 'sw-total' + (sum > swCapPct() + 1e-9 ? ' over' : '');
  }

  function swStatus(msg, warn) {
    var el = $('swStatus');
    if (!el) return;
    if (swStatus._t) { clearTimeout(swStatus._t); swStatus._t = null; }
    el.textContent = msg || '';
    el.className = 'hint' + (warn ? ' sw-warn' : '');
    if (msg && !warn) swStatus._t = setTimeout(function () { el.textContent = ''; }, 2400);
  }

  function buildSignalWeightsPanel() {
    var grid = $('swGrid');
    if (!grid) return;
    setTxt('swHint', T('viewer|每项都是风险分的百分比权重：0 = 该项不参与评分，100 = 该项独占满分。十六项合计不得超过 150%，而出厂表已正好是 {d}%——想抬高某一项，得先降低另一项（合计栏会实时显示）。合计越高，同一局的分越高，也就越容易越过 70 / 40 两条线（这是把检测调得更严，不是分数能到 150）；合计越低则相反。只记录你改动过的项，其余仍跟随出厂默认（清空某一项即为恢复默认）。',
      { d: swShippedPct() }));
    setTxt('swReset', T('viewer|重置为默认'));
    var base = swBaseKeys(), low = swLowKeys(), group = null, html = '';
    swKeys().forEach(function (key) {
      // Three families since 0.5.7 §1.4. The test order is the list order (WEIGHT_KEYS is
      // BASE_KEYS ++ EVASION_KEYS ++ LOWEND_KEYS), so the headings come out 基础统计 / 行为信号 /
      // 低端AI 检测 without the builder sorting anything.
      var g = base ? (base.indexOf(key) >= 0 ? 'stat'
                   : (low && low.indexOf(key) >= 0 ? 'low' : 'behav')) : null;
      if (g && g !== group) {
        group = g;
        html += '<div class="set-sub set-wide">' +
          esc(g === 'stat' ? T('viewer|基础统计')
            : (g === 'low' ? T('viewer|低端AI 检测') : T('viewer|行为信号'))) + '</div>';
      }
      // The label is a semantic key (`learn.weight.*`) — the same one the learner's table and
      // 标签百科 print — so the thirteen names cost no new translation and cannot drift from the
      // other two surfaces that show them.
      html += '<div class="set-item"><label for="' + swId(key) + '">' +
        esc(TO('learn.weight', key)) + '</label><div class="fx">' +
        '<input type="number" class="sw-in" id="' + swId(key) + '" min="0" max="' + swMaxPct() +
        '" step="1"><span class="hint">%</span>' +
        '<span class="hint" id="' + swId(key) + '-inh"></span></div></div>';
    });
    grid.innerHTML = html;
  }

  // Paints every box from the table in force. The active element is left alone (the same guard
  // `setField` and `fillStorageFilterForm` use): a save that landed between two keystrokes would
  // otherwise move the caret and eat the rest of the number.
  function fillSignalWeightsForm() {
    var res = swResolved(), inh = swInherited();
    var typing = (typeof document !== 'undefined') ? document.activeElement : null;
    swKeys().forEach(function (key) {
      if (typeof inh[key] !== 'number') return;      // a key the live table does not carry
      var el = $(swId(key)), hint = $(swId(key) + '-inh');
      if (el && el !== typing) el.value = swFmt(swPct(res[key]));
      if (hint) hint.textContent = T('viewer|留空 = {p}%', { p: swFmt(swPct(inh[key])) });
    });
    swPaintTotal(swReadForm().sum);
  }

  function bindSignalWeights() {
    var grid = $('swGrid');
    if (grid) {
      var timer = null;
      // ONE delegated pair of listeners for all thirteen boxes: the grid's innerHTML is REPLACED on
      // every language switch (buildSignalWeightsPanel), so per-input handlers would have to be
      // rebound there — and the one that is forgotten is the one that stops working.
      function keyOf(ev) {
        var t = ev.target;
        if (!t || !t.id || t.id.indexOf('sw-') !== 0) return null;
        var key = t.id.slice(3);
        return swKeys().indexOf(key) >= 0 ? key : null;
      }
      // `force` is the difference between typing and deciding. While the operator is still typing
      // an over-limit table the total goes red and NOTHING is written and nothing is taken away —
      // snapping the box back at the first digit of a larger number would fight the keystroke that
      // was about to make it legal. On `change` (blur / Enter) the edit is a decision, so an
      // over-limit one is refused out loud and the boxes go back to what the detector is running.
      function commit(force) {
        if (timer) { clearTimeout(timer); timer = null; }
        var st = swReadForm();
        var cap = swCapPct();
        if (st.sum > cap + 1e-9) {
          swPaintTotal(st.sum);
          if (!force) return;
          swStatus(T('viewer|未保存：合计将变成 {p}%，超过上限 {c}%', { p: swFmt(st.sum), c: cap }), true);
          fillSignalWeightsForm();
          return;
        }
        // SPARSE: only the terms that differ from what they INHERIT are written, so a later
        // release's rebalance still reaches every signal the operator did not touch. The
        // comparison is against `inh`, never against `res`: against the resolved table, retyping
        // the value a signal already had would read as "unchanged" and silently drop its pin.
        var inh = swInherited(), pins = {};
        swKeys().forEach(function (key) {
          if (Math.abs(st.pct[key] - swPct(inh[key])) > 1e-9) pins[key] = st.pct[key] / 100;
        });
        lastSelfWrite = Date.now();
        G.saveSetting('signalWeights', pins).then(function (s) {
          S = s;
          // Read back from what storage ACCEPTED — it refuses a set it cannot honour as a whole,
          // so a refusal one layer down still lands on this screen instead of vanishing.
          fillSignalWeightsForm();
          swStatus(T('viewer|已保存。'), false);
        });
      }
      grid.addEventListener('input', function (ev) {
        if (!keyOf(ev)) return;
        swPaintTotal(swReadForm().sum);
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { commit(false); }, 400);
      });
      grid.addEventListener('change', function (ev) { if (keyOf(ev)) commit(true); });
    }
    var btn = $('swReset');
    if (btn) btn.onclick = function () {
      if (!confirm(T('viewer|重置全部检测信号权重为出厂默认？'))) return;
      lastSelfWrite = Date.now();
      G.saveSetting('signalWeights', {}).then(function (s) {
        S = s;
        fillSignalWeightsForm();
        swStatus(T('viewer|已重置为默认权重'), false);
      });
    };
  }
  bindSignalWeights();

  // 0.5.6 补增 §三 — 标签百科 prints each signal's weight by reading the LIVE table, so it has to
  // be handed the resolved one before it renders: an operator who set 好点池 to 40% and then read
  // 「权重 0.21」 in the wiki would be looking at a number the detector is not using. The override
  // carries numbers; the wiki's ENTRIES still carry only keys (see tagWiki.js's header).
  function syncTagWeightTable() {
    try {
      if (typeof GM_TAG_WIKI !== 'undefined' && GM_TAG_WIKI && GM_TAG_WIKI.setWeightTable) {
        GM_TAG_WIKI.setWeightTable(swResolved());
      }
    } catch (e) { /* no wiki in this document */ }
  }

  // ---- 0.5.3 §1.1.6: 透明度与模糊 ----
  //
  // The panel is BUILT, not written into viewer.html, from the same table storage clamps
  // against. Two things have to agree for a slider to be usable — its `max` and the ceiling
  // `normalizeTransparency` applies — and a hand-written slider whose max disagreed would snap
  // back on release with no visible cause. Ten of them is ten chances to make that mistake.
  //
  // The readout spells the direction out rather than printing a bare percentage: 「透明度 60%」
  // is read as "60% see-through" by half the operators and "60% opaque" by the other half, and
  // 0.4.7 shipped the wrong one of those. Saying 「透明 60% · 不透明 40%」 leaves no room.
  var TP_GROUPS = [
    {
      part: 'viewer',
      // Only the parts that have a ceiling of their own are listed; `TRANSPARENCY_LIMITS` is
      // the authority and the loop below reads every max straight out of it.
      // 0.5.4 §2.1.2 — `buttonBlur` is gone from the table AND from here: a blurred backdrop
      // behind a button is not a look. A row with no ceiling is skipped by the loop below, so
      // leaving the name in would have been silently harmless — which is why it is removed from
      // the list rather than left to be skipped.
      rows: ['element', 'elementBlur', 'button'],
    },
    {
      part: 'overlay',
      rows: ['background', 'backgroundBlur', 'element', 'elementBlur', 'button'],
    },
  ];

  // Every label is a LITERAL `T()` call in a switch, never `T(TP_LABEL[key])` and never
  // `T('viewer|' + key)`. A computed key is invisible to `_tools/keys.cjs` (it sees the SHAPE,
  // not the key), so the generated tables would carry no entry for it and every non-Chinese
  // locale would print the raw Chinese text — the same trap `themeLabel()` above documents.
  function tpLabel(key) {
    if (key === 'element') return T('viewer|元素透明度');
    if (key === 'elementBlur') return T('viewer|元素模糊度');
    if (key === 'button') return T('viewer|按钮透明度');
    if (key === 'background') return T('viewer|背景透明度');
    if (key === 'backgroundBlur') return T('viewer|背景模糊度');
    return key;
  }
  function tpGroupLabel(part) {
    if (part === 'viewer') return T('viewer|查看器');
    if (part === 'overlay') return T('viewer|浮层');
    return part;
  }
  function tpIsBlur(key) { return key.indexOf('Blur') > 0; }
  function tpId(part, key) { return 'tp-' + part + '-' + key; }

  /**
   * The readout next to one slider. ONE implementation, because it is printed from two places —
   * the full repaint and the live drag — and this project has been bitten four times by a rule
   * with two copies: the two would have drifted the moment the wording changed, and the drift
   * would show up as "the number is right while dragging but wrong after a reload".
   *
   * `背景不透明` and not `不透明` since 0.5.4 §2.1.1: the number is the alpha on the container's
   * own FILL, while the text inside stays fully opaque, so the shorter wording would now claim
   * something about the type that is not true.
   */
  function tpReadout(key, n) {
    return tpIsBlur(key) ? (n + 'px')
                         : T('viewer|透明 {t}% · 背景不透明 {o}', { t: n, o: G.cssOpacity(n) });
  }

  function buildTransparencyPanel() {
    var grid = $('tpGrid');
    if (!grid) return;
    setTxt('tpTitle', T('viewer|自定义UI与背景'));
    setTxt('tpHint', T('viewer|透明度只作用于容器背景，文字、输入框与进度条不受影响。模糊度为毛玻璃效果——它只模糊元素背后的内容，需要透明度大于 0 才看得见；查看器窗口无法真正透出桌面，这里的「透明」是相对浏览器底色而言，有背景图时越透明背景图越明显。'));
    var html = '';
    TP_GROUPS.forEach(function (grp) {
      var lim = (G.TRANSPARENCY_LIMITS || {})[grp.part] || {};
      // A GROUP is a full-width row: the header (`tp-head`, with the switch) then a nested grid
      // of that group's parts. Emitting the header as one more `.set-item` — which is what the
      // first cut did — makes it a peer of the sliders, so it flows into the same row and
      // 「浮层」 ends up sitting beside 元素模糊度. `.tp-group{grid-column:1/-1}` in the stylesheet
      // is what gives the header its own line.
      html += '<div class="tp-group" data-tp-part="' + grp.part + '">' +
        '<label class="tp-head"><input type="checkbox" id="' + tpId(grp.part, 'enabled') + '">' +
        '<span>' + esc(tpGroupLabel(grp.part)) + '</span>' +
        '<span class="hint">' + esc(T('viewer|启用')) + '</span></label>' +
        '<div class="tp-parts">';
      grp.rows.forEach(function (key) {
        var max = lim[key];
        if (typeof max !== 'number') return;   // no ceiling => not configurable, see the table
        var blur = tpIsBlur(key);
        html += '<div class="set-item"><label for="' + tpId(grp.part, key) + '">' +
          esc(tpLabel(key)) + '</label><div class="fx">' +
          '<input type="range" id="' + tpId(grp.part, key) + '" min="0" max="' + max + '" step="1">' +
          '<span class="hint" id="' + tpId(grp.part, key) + '-val"></span>' +
          // §1.1.5 — the two are independent, and a blur with nothing to blur through does
          // nothing visible. Saying so next to the control is cheaper than a support question.
          (blur ? '<span class="hint">' + esc(T('viewer|需透明度 > 0 才可见')) + '</span>' : '') +
          '</div></div>';
      });
      html += '</div></div>';
    });
    grid.innerHTML = html;
  }

  // Paints every control from `S.transparency`. The slider's `disabled` follows its group's
  // switch, but the VALUE is left alone: switching a group off is a temporary mute, and an
  // operator who flips it back expects their tuned numbers, not zeros.
  function fillTransparencyForm() {
    var t = G.normalizeTransparency(S.transparency);
    TP_GROUPS.forEach(function (grp) {
      var en = $(tpId(grp.part, 'enabled'));
      var on = !!t[grp.part].enabled;
      if (en) en.checked = on;
      grp.rows.forEach(function (key) {
        var el = $(tpId(grp.part, key)), val = $(tpId(grp.part, key) + '-val');
        if (!el) return;
        el.value = String(t[grp.part][key]);
        el.disabled = !on;
        if (!val) return;
        val.textContent = tpReadout(key, t[grp.part][key]);
      });
    });
  }

  // ---- 0.4.4 §十六: the LLM API panel ----
  // The field defaults come from `GMLLM.DEFAULTS`, never from a literal here: the request code
  // reads the same object, and two copies of "what does an unset timeout mean" is exactly the
  // kind of drift this project has been bitten by before.
  function llmCfg() { return Object.assign({}, GMLLM.DEFAULTS, S.llm || {}); }

  var LLM_FIELDS = [
    ['setLlmEnabled', 'enabled', function (e) { return !!e.checked; }],
    ['setLlmEndpoint', 'endpoint', function (e) { return String(e.value).trim(); }],
    ['setLlmKey', 'apiKey', function (e) { return String(e.value).trim(); }],
    ['setLlmModel', 'model', function (e) { return String(e.value).trim(); }],
    ['setLlmTimeout', 'timeout', function (e) { return Math.max(1000, parseInt(e.value, 10) || GMLLM.DEFAULTS.timeout); }],
    ['setLlmLimit', 'monthlyLimit', function (e) { return Math.max(1, parseInt(e.value, 10) || GMLLM.DEFAULTS.monthlyLimit); }],
  ];

  function fillLlmForm() {
    var cfg = llmCfg();
    if ($('setLlmEnabled')) $('setLlmEnabled').checked = !!cfg.enabled;
    setField($('setLlmEndpoint'), cfg.endpoint);
    setField($('setLlmKey'), cfg.apiKey);
    setField($('setLlmModel'), cfg.model);
    setField($('setLlmTimeout'), cfg.timeout);
    setField($('setLlmLimit'), cfg.monthlyLimit);
    refreshLlmUsage();
  }

  function refreshLlmUsage() {
    var el = $('setLlmUsage');
    if (!el) return;
    GMLLM.loadUsage().then(function (u) {
      var parts = [T('viewer|本月已用 {u} / {n} 次', { u: u.used, n: llmCfg().monthlyLimit })];
      if (u.fails) parts.push(T('viewer|连续失败 {n} 次', { n: u.fails }));
      if (u.disabledUntil > Date.now()) {
        parts.push(T('viewer|已自动禁用至 {t}', { t: new Date(u.disabledUntil).toLocaleTimeString() }));
      }
      el.textContent = parts.join(' · ');
    });
  }

  function bindLlmFields() {
    LLM_FIELDS.forEach(function (f) {
      var el = $(f[0]);
      if (!el) return;
      var field = f[1], read = f[2], timer = null;
      // Not `bindSetting(el, 'llm', …)`: that helper dedupes on `v === last`, and every call here
      // hands it a freshly-built object, so the dedupe could never fire. The write still goes
      // through `G.saveSetting('llm', …)` so it rides GMStorage's serialised chain like every
      // other setting rather than racing it.
      function commit() {
        if (timer) { clearTimeout(timer); timer = null; }
        var cur = llmCfg();
        cur[field] = read(el);
        lastSelfWrite = Date.now();
        G.saveSetting('llm', cur).then(function (s) {
          S = s;
          refreshLlmUsage();
          flashSaved();
        });
      }
      el.addEventListener('input', function () { if (timer) clearTimeout(timer); timer = setTimeout(commit, 250); });
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
    });
  }

  // ---- 0.4.8 §3: the model picker ----
  // A searchable drawer beside the Model field. The list is a CONVENIENCE, never a constraint:
  // the field itself stays a plain text input, so a model an operator's endpoint accepts can
  // still be typed by hand. An allow-list would be wrong the day a vendor ships a new name.
  //
  // The Chinese aliases exist because the operator types 「智谱」 and 「深度求索」, not
  // `glm-4-plus` and `deepseek-chat`. Matching only the English id would filter those to
  // nothing — the drawer would look broken exactly when it was being used.
  var LLM_MODELS = [
    // OpenAI
    { id: 'gpt-4o', name: 'GPT-4o', vendor: 'OpenAI', tags: ['gpt', '4o', 'openai'] },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', vendor: 'OpenAI', tags: ['gpt', '4o', 'mini', 'openai'] },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', vendor: 'OpenAI', tags: ['gpt', '4', 'turbo', 'openai'] },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', vendor: 'OpenAI', tags: ['gpt', '3.5', 'openai'] },
    { id: 'o1-preview', name: 'o1-preview', vendor: 'OpenAI', tags: ['o1', 'openai'] },
    { id: 'o1-mini', name: 'o1-mini', vendor: 'OpenAI', tags: ['o1', 'mini', 'openai'] },
    // Anthropic
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', vendor: 'Anthropic', tags: ['claude', 'sonnet', 'anthropic'] },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', vendor: 'Anthropic', tags: ['claude', 'haiku', 'anthropic'] },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', vendor: 'Anthropic', tags: ['claude', 'opus', 'anthropic'] },
    // DeepSeek
    { id: 'deepseek-chat', name: 'DeepSeek Chat', vendor: 'DeepSeek', tags: ['deepseek', 'chat'] },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', vendor: 'DeepSeek', tags: ['deepseek', 'reasoner', 'r1'] },
    // 智谱
    { id: 'glm-4-plus', name: 'GLM-4 Plus', vendor: 'Zhipu', tags: ['glm', 'zhipu', '智谱'] },
    { id: 'glm-4-flash', name: 'GLM-4 Flash', vendor: 'Zhipu', tags: ['glm', 'flash', 'zhipu', '智谱'] },
    // 阿里
    { id: 'qwen-max', name: 'Qwen Max', vendor: 'Alibaba', tags: ['qwen', 'max', '通义千问'] },
    { id: 'qwen-plus', name: 'Qwen Plus', vendor: 'Alibaba', tags: ['qwen', 'plus', '通义千问'] },
    // Google
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', vendor: 'Google', tags: ['gemini', 'google'] },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', vendor: 'Google', tags: ['gemini', 'flash', 'google'] },
    // Moonshot / 月之暗面
    { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K (Kimi)', vendor: 'Moonshot', tags: ['moonshot', 'kimi', '月之暗面'] },
    // 字节 / 豆包
    { id: 'doubao-pro-32k', name: 'Doubao Pro 32K', vendor: 'ByteDance', tags: ['doubao', '豆包', 'bytedance'] },
    // 本地
    { id: 'llama3.1:8b', name: 'Llama 3.1 8B (Ollama)', vendor: 'Local', tags: ['llama', 'ollama', 'local'] },
    { id: 'mistral:7b', name: 'Mistral 7B (Ollama)', vendor: 'Local', tags: ['mistral', 'ollama', 'local'] },
  ];
  // Keyed by model id, by the vendor's name, and by the vendor's model-name PREFIX ('glm',
  // 'qwen', 'claude', …) — a vendor's models all share the Chinese name for the vendor, so a
  // lookup that only tried the full id would leave 「智谱」 reaching nothing at all.
  var MODEL_ZH_ALIAS = {
    'openai': ['欧朋', '开放AI'], 'anthropic': ['安思罗匹克'],
    'deepseek': ['深度求索', '深度搜索'], 'zhipu': ['智谱', '智谱清言'],
    'alibaba': ['通义', '通义千问', '千问'], 'google': ['双子座', '谷歌双子', '谷歌'],
    'moonshot': ['月之暗面', '基米', 'Kimi'], 'bytedance': ['豆包', '字节跳动'],
    'local': ['本地', '本地模型'],
    'gpt-4o': ['吉皮提4', 'GPT4', '4o'], 'gpt-4o-mini': ['吉皮提4mini', '小型'],
    'gpt-4-turbo': ['GPT4', '涡轮'],
    'claude': ['克劳德', '哥伦比亚'], 'claude-3-5-sonnet': ['克劳德十四行诗', '十四行'],
    'claude-3-5-haiku': ['克劳德俳句', '俳句'],
    'deepseek-chat': ['深度求索对话'], 'deepseek-reasoner': ['深度求索推理', 'R1'],
    'glm': ['智谱', '智谱清言'], 'qwen': ['通义', '通义千问', '千问'],
    'gemini': ['双子座', '谷歌双子'], 'llama': ['拉玛', '羊驼'], 'mistral': ['米斯特拉尔'],
    'ollama': ['欧拉玛', '本地'],
  };

  // Does this query mean "this exact model" rather than "search for this"? An input holding a
  // recognised id is a made choice, and opening the drawer should show the whole list; anything
  // else is a search and should filter.
  function isExactModelId(v) {
    if (!v) return true;
    for (var i = 0; i < LLM_MODELS.length; i++) if (LLM_MODELS[i].id === v) return true;
    return false;
  }

  function modelAliasesFor(m) {
    var out = (MODEL_ZH_ALIAS[m.id] || []).slice();
    var vk = String(m.vendor || '').toLowerCase();
    if (MODEL_ZH_ALIAS[vk]) out = out.concat(MODEL_ZH_ALIAS[vk]);
    // Vendor-prefix keys: 'glm' for glm-4-plus, 'qwen' for qwen-max, …
    var id = String(m.id || '');
    for (var k in MODEL_ZH_ALIAS) {
      if (k === id) continue;
      if (id.indexOf(k) === 0 && out.indexOf(k) < 0) out = out.concat(MODEL_ZH_ALIAS[k]);
    }
    return out;
  }

  function filterModels(query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return LLM_MODELS;
    return LLM_MODELS.filter(function (m) {
      if (m.id.toLowerCase().indexOf(q) >= 0) return true;
      if (m.name.toLowerCase().indexOf(q) >= 0) return true;
      if (m.tags && m.tags.some(function (t) { return t.toLowerCase().indexOf(q) >= 0; })) return true;
      return modelAliasesFor(m).some(function (a) { return a.toLowerCase().indexOf(q) >= 0; });
    });
  }

  function bindModelPicker() {
    var input = $('setLlmModel');
    var toggle = $('modelToggle');
    var dd = $('modelDropdown');
    if (!input || !dd) return;

    function isOpen() { return !dd.classList.contains('hidden'); }
    function close() { dd.classList.add('hidden'); }

    function render(q) {
      var list = filterModels(q);
      if (!list.length) {
        // The drawer must never be a dead end: a query nothing matches says so and points at
        // the field, which is still a free-text input.
        dd.innerHTML = '<div class="model-empty">' +
          esc(T('viewer|未找到匹配的模型，可直接输入自定义模型名')) + '</div>';
        return;
      }
      var h = '';
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        h += '<div class="model-item" role="option" data-id="' + esc(m.id) + '">' +
             '<span class="mi-name">' + esc(m.name) + '</span>' +
             '<span class="vendor">' + esc(m.vendor) + '</span></div>';
      }
      dd.innerHTML = h;
    }
    function open() {
      var v = String(input.value || '').trim();
      render(isExactModelId(v) ? '' : v);
      dd.classList.remove('hidden');
    }

    input.addEventListener('focus', open);
    input.addEventListener('input', function () {
      render(String(input.value || '').trim());
      dd.classList.remove('hidden');
    });
    if (toggle) toggle.addEventListener('click', function (e) {
      e.preventDefault();
      if (isOpen()) close(); else { input.focus(); open(); }
    });
    dd.addEventListener('mousedown', function (e) {
      var t = e.target;
      var it = (t && t.closest) ? t.closest('.model-item') : null;
      if (!it) return;
      e.preventDefault();               // keep focus, do not let the input blur mid-pick
      input.value = it.getAttribute('data-id') || '';
      close();
      // Setting `.value` does not fire `input`, so dispatch one: the LLM panel's own debounced
      // commit then saves the pick through GMStorage, exactly as a hand-typed model would.
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    document.addEventListener('mousedown', function (e) {
      if (!isOpen()) return;
      var t = e.target;
      if (t === input || t === toggle || (dd.contains && dd.contains(t))) return;
      close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) close();
    });
  }

  // ---- 0.3.6 §1.2: the language dropdown ----
  // Built from GMI18n.LOCALES instead of being written into viewer.html, so a fourteenth language
  // costs one entry in i18n.js plus one table and cannot leave this list behind.
  //
  // 0.4.6 §2.4: the labels go through `GMI18n.langLabel()` — 「English（英语）」, the endonym plus
  // what the current language calls it. The endonym-only list was fine at eight entries; at
  // thirteen it asks the operator to recognise 「Монгол」 and 「Bahasa Melayu」 unaided.
  function fillLangSelect() {
    var sel = $('setLang');
    if (!sel) return;
    var html = '<option value="auto">' + esc(T('set|跟随浏览器')) + '</option>';
    GMI18n.LOCALES.forEach(function (code) {
      html += '<option value="' + code + '">' + esc(GMI18n.langLabel(code)) + '</option>';
    });
    sel.innerHTML = html;
  }

  // ---- 0.3.7 §二.1: the thread dropdown ----
  // Built in JS rather than hard-coded in viewer.html, for the same reason as the language
  // list: the option set and the automatic hint must not drift from what GMStorage/app.js
  // actually accept. The automatic entry names the count this machine will get, so 「自动」
  // stops being an opaque promise on a 32-thread host (it reads 「自动（16 线程）」).
  function fillThreadSelect() {
    var sel = $('setThread');
    if (!sel) return;
    var auto = (G.detectedThreads ? G.detectedThreads() : 0) || '?';
    var html = '<option value="0">' + esc(T('viewer|自动（{n} 线程）', { n: auto })) + '</option>';
    [1, 2, 3, 4, 6, 8, 12, 16].forEach(function (v) {
      html += '<option value="' + v + '">' + v + '</option>';
    });
    sel.innerHTML = html;
  }

  // =====================================================================
  // 0.5.1 §2.1.4 / §2.2 — 检测模型 pickers and the 自定义检测模型 panel
  // =====================================================================
  //
  // Three dropdowns (设置 / 检测 / 回放详情) plus the panel in the page all read and write the
  // SAME `settings.engineId`, and the option set has to equal what app.js resolves an id
  // against. One list builder serves them all: a second copy of "which engines exist" is the
  // failure this project has already paid for four times.
  var engineReg = function () { return (typeof GMEngines !== 'undefined') ? GMEngines : null; };

  // The registry is an in-memory map, so every context that wants to NAME a custom model has to
  // fill it. An extension page can read IndexedDB directly — this page loads custom-engine.js for
  // exactly that reason. (A content script cannot: its `indexedDB` is the HOST PAGE's, which is
  // why content.js learns the list over a message instead.)
  function refreshCustomRegistry() {
    var reg = engineReg();
    var C = (typeof GMCustomEngines !== 'undefined') ? GMCustomEngines : null;
    if (!reg || !C || !C.available || !C.available()) return Promise.resolve([]);
    return C.list().then(function (rows) {
      reg.sync(rows.map(function (r) {
        return { id: r.id, name: r.name, dataId: r.id, fileName: r.fileName, size: r.size, addedAt: r.addedAt };
      }));
      return rows;
    }, function () { return []; });
  }

  function currentEngineId() {
    var reg = engineReg();
    return S.engineId || (reg ? reg.DEFAULT_ID : 'rapfi');
  }

  // A disabled option is the same structural device the panel's engine menu uses (the greyed row
  // carries no `data-v`): an http engine with no address cannot answer, and offering it would
  // produce a failure the operator has no way to explain.
  function engineOptionsHtml() {
    var reg = engineReg();
    var cur = currentEngineId();
    if (!reg) return '<option value="' + esc(cur) + '">' + esc(cur) + '</option>';
    return reg.list().map(function (e) {
      if (!e.id) return '';
      var ok = reg.usable(e.id);
      // The suffix is appended only when it says something the name does not: an http engine with
      // no address cannot answer, and a custom model is not from the package. One dictionary text
      // each, shared with the settings list below, so the picker and the list agree on the words.
      var label = e.name || e.id;
      if (!ok) label += ' · ' + T('viewer|未配置服务地址');
      else if (e.custom) label += ' · ' + T('viewer|自定义');
      return '<option value="' + esc(e.id) + '"' + (e.id === cur ? ' selected' : '') +
        (ok ? '' : ' disabled') + '>' + esc(label) + '</option>';
    }).join('');
  }

  // Rebuilding a <select>'s innerHTML DROPS its selection, so every rebuild puts the stored id
  // back before returning. Without that line, switching the UI language silently moved the
  // operator's engine back to Rapfi while `settings.engineId` still said otherwise — the same
  // defect 0.4.11 §一.3 found in the 主题 dropdown.
  function fillEngineSelects() {
    var cur = currentEngineId();
    ['setEngine', 'engineSel', 'engineSelD'].forEach(function (id) {
      var sel = $(id);
      if (!sel) return;
      sel.innerHTML = engineOptionsHtml();
      if (sel.value !== cur) sel.value = cur;
    });
    setTxt('engineSelLabel', T('viewer|检测模型'));
    setTxt('engineSelDLabel', T('viewer|检测模型'));
  }

  // The status line, kept as the last ANSWER rather than as rendered text: a language switch has
  // to repaint it, and re-asking the offscreen document on every repaint would spawn it (and its
  // 40 MB engine) just because the operator changed the UI language.
  var lastEngineInfo;              // undefined = never asked; null = asked, nothing loaded

  // The one place that turns an engine record into a sentence. Both the settings status line and
  // the report's 分析引擎 row read it, so a KataGomo run cannot be described as 「多线程 16 线程」
  // on one page and 「服务端 · http://…」 on the other.
  //
  // It also has to survive a 0.5.0 archive, whose `engine` object has no `id` / `name` / `kind`:
  // the name is simply omitted rather than leaving a dangling separator.
  function engineSummary(info) {
    if (!info) return '';
    var name = info.name || info.id || '';
    if (info.custom && name) name += ' · ' + T('viewer|自定义');
    // A recovery outranks everything else here: if a different engine answered, every number the
    // operator is about to read belongs to a program they did not pick. Stored in the report too,
    // because the archive is where that claim has to survive.
    if (info.fallback && info.fallback.to && info.fallback.from !== info.fallback.to) {
      return T('viewer|{from} 不可用，已回退到 {to}',
        { from: info.fallback.from, to: info.fallback.name || info.fallback.to });
    }
    var parts = [];
    if (name) parts.push(name);
    // An http engine has no build file and no thread count OF OURS to report — the threads belong
    // to somebody else's machine, so naming the server is the honest substitute (and the only way
    // to notice a game was analysed by the wrong server).
    if (info.kind === 'http') parts.push(info.url || T('viewer|未配置服务地址'));
    else if (info.degraded) {
      parts.push(T('viewer|单线程（降级：{reason}）',
        { reason: TE(info.reason) || T('viewer|环境不支持多线程') }));
    } else parts.push(T('viewer|多线程 {n} 线程', { n: info.threadNum || 1 }));
    return parts.join(' · ');
  }

  function engineStatusText(info) {
    if (!info) return T('viewer|未记录');
    // `=== false` rather than falsy: a stored report's engine object carries no `loaded` field at
    // all, and treating that as "not loaded" would label every archive 「引擎尚未加载」.
    if (info.loaded === false) return T('viewer|引擎尚未加载（首次分析或切换模型后生效）');
    return engineSummary(info);
  }

  function paintEngineStatus() {
    var el = $('setEngineStatus');
    if (!el) return;
    el.textContent = (lastEngineInfo === undefined) ? '—' : engineStatusText(lastEngineInfo);
  }

  // Asked of the OFFSCREEN document, never of app.js in this page: the viewer holds no engine
  // (0.4.11 §一.2), so the only true answer is the one from the context that does.
  function refreshEngineStatus() {
    var el = $('setEngineStatus');
    if (!el) return;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      el.textContent = '—';
      return;
    }
    el.textContent = T('viewer|查询中…');
    askOffscreen({ type: 'gm-engine-info' }).then(function (resp) {
      lastEngineInfo = (resp && resp.info) || null;
      paintEngineStatus();
    }, function () {
      lastEngineInfo = null;
      paintEngineStatus();
    });
  }

  function afterEngineChange() {
    fillEngineSelects();
    renderCustomList();
    refreshEngineStatus();
  }

  function fillEngineForm() {
    setTxt('setEngineLabel', T('viewer|检测模型'));
    setTxt('setEngineHint', T('viewer|分析当前对局与逐步检测所用引擎；此处、检测页、回放详情与页面浮层共用同一项设置。'));
    setTxt('setEngineUrlLabel', T('viewer|KataGomo 服务地址'));
    setTxt('setEngineUrlHint',
      T('viewer|填服务器根地址即可（自动补 /api/v1/analysis），也可直接填完整端点。首次使用需点右侧按钮授权访问。'));
    setTxt('setEnginePerm', T('viewer|授权访问'));
    setTxt('setEngineStatusLabel', T('viewer|引擎状态'));
    fillEngineSelects();
    setField($('setEngineUrl'), S.engineUrl || '');
    paintEngineStatus();
  }

  // The address is committed on blur / Enter like every other field, but it also has to reach the
  // registry in THIS context: the pickers above decide "usable" from it, so a stale address would
  // leave KataGomo greyed out after the operator had just typed one in.
  function commitEngineUrl() {
    var v = String($('setEngineUrl').value || '').trim();
    lastSelfWrite = Date.now();
    G.saveSetting('engineUrl', v).then(function (s) {
      S = s;
      var reg = engineReg();
      if (reg) reg.setHttpBase(S.engineUrl);
      afterEngineChange();
      flashSaved();
    });
  }

  // ---- §2.2: 自定义检测模型 ----
  //
  // §2.2.3's steps, in the order the operator experiences them:
  //   1. pick a file                     (cstFile)
  //   2. size / count check              (GMCustomEngines.add — everything knowable from the file)
  //   3. store the package               (IndexedDB; extension origin only, never uploaded)
  //   4. run ONE real search on it       (through the offscreen document — the only honest test)
  //   5. failure → a message that names the cause, and the model is dropped again
  //   6. success → §2.2.4's naming prompt, then §2.2.5's 「设为首选」
  //
  // Step 4 has no cheaper equivalent: a Rapfi `.data` package is emscripten's file table plus NNUE
  // weights, so nothing short of loading it distinguishes a good package from a stray zip. That is
  // also why the file is called a 权重包 everywhere — what is stored is a weight package for the
  // packaged build, not a new engine (see custom-engine.js for why that narrowing is forced).
  var VERIFY_THINK_MS = 1200;
  var lastCustomError = '';

  function modelCard(id, name, meta, preferred, editable) {
    return '<div class="cst-card" data-id="' + esc(id) + '">' +
      '<div class="cst-main"><div class="cst-name">' + esc(name) +
        (preferred ? '<span class="cst-tag">' + esc(T('viewer|首选')) + '</span>' : '') +
      '</div><div class="hint">' + esc(meta) + '</div></div>' +
      '<div class="cst-acts">' +
        (editable
          ? (preferred ? '' : '<button class="sec" data-cst="prefer">' + esc(T('viewer|设为首选')) + '</button>') +
            '<button class="sec" data-cst="rename">' + esc(T('viewer|重命名')) + '</button>' +
            '<button class="sec" data-cst="remove">' + esc(T('viewer|删除')) + '</button>'
          : '<span class="hint">' + esc(T('viewer|内置')) + '</span>') +
      '</div></div>';
  }

  function fmtBytes(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // 官方模型与自定义模型分开存放 (§2.2.6 #6). The official ones are files inside the package and
  // are listed read-only; only a custom model has a stored package to rename or delete.
  function renderCustomList() {
    var host = $('cstList');
    if (!host) return;
    var reg = engineReg();
    var cur = currentEngineId();
    if (!reg) { host.innerHTML = ''; return; }
    var html = reg.list().filter(function (e) { return !e.custom; }).map(function (e) {
      var meta = (e.kind === 'http')
        ? T('viewer|服务端 · {url}', { url: reg.httpUrl() || T('viewer|未配置服务地址') })
        : (e.builds || []).join('');
      return modelCard(e.id, e.name, meta, e.id === cur, false);
    }).join('');
    var mine = reg.list().filter(function (e) { return e.custom; });
    html += mine.map(function (e) {
      return modelCard(e.id, e.name, fmtBytes(e.size), e.id === cur, true);
    }).join('');
    if (!mine.length) {
      html += '<div class="hint">' + esc(T('viewer|还没有自定义模型。')) + '</div>';
    }
    host.innerHTML = html;
  }

  function fillCustomPanel() {
    var C = (typeof GMCustomEngines !== 'undefined') ? GMCustomEngines : null;
    setTxt('cstTitle', T('viewer|自定义检测模型'));
    setTxt('cstPickLabel', T('viewer|选择权重包文件'));
    setTxt('cstHint', T('viewer|支持 Rapfi 的 .data 权重包；文件名只作提示，命名在验证通过后进行。'));
    setTxt('cstLimitLabel', T('viewer|限制'));
    setTxt('cstLimit', C
      ? T('viewer|单个不超过 {mb} MB，最多 {n} 个；只保存在本机浏览器内，不会上传。',
          { mb: Math.round(C.MAX_BYTES / 1048576), n: C.MAX_COUNT })
      : T('viewer|此环境不支持自定义模型（IndexedDB 不可用）。'));
    setTxt('cstAdd', T('viewer|验证并添加'));
    renderCustomList();
  }

  function setCstStatus(text) {
    var el = $('cstStatus');
    if (el) el.textContent = text;
  }

  // =====================================================================
  // 0.5.2 §5.1 — 自定义背景
  // =====================================================================
  // Two independent slots (§5.1.5), one panel. `bgCur` is the record for the slot the panel is
  // currently showing; `bgOff` is the drag state, kept OUT of the DOM on purpose — a
  // `pointermove` fires dozens of times a second, and reading the offsets back off a
  // `background-position` string would mean parsing percentages mid-drag. The live repaint is
  // immediate and the WRITE is debounced, the same split `bindTransparencyControls` uses for its
  // slider and for the same reason: one storage round-trip per pixel of travel.
  var BG_SAVE_DELAY = 250;
  var bgCur = null;                    // { blob, opacity, blur, offsetX, offsetY, scale } | null
  var bgOff = { x: 50, y: 50 };
  var bgTimer = null;
  var bgUrl = '';                      // object URL for the PREVIEW, revoked on replacement
  var bgViewUrl = '';                  // object URL for the live page's own backdrop

  function bgSlot() {
    var sel = $('bgSlot');
    return (sel && sel.value) || 'bg-viewer';
  }

  // The four custom properties are written in ONE place so the preview and the live page cannot
  // disagree about what "80% / 5px / dragged a bit left" looks like.
  //
  // `--gm-bg-dim` is the SCRIM alpha, i.e. 1 − 透明度. A `background-image` carries no alpha of
  // its own, so the only honest way to dim one is to paint something over it — which is what the
  // `::before` layer in the CSS does (see viewer.html §5.1). Naming the variable after what it
  // paints rather than after the slider is deliberate: the slider is 透明度 and this is its
  // complement, and a variable called `--gm-bg-opacity` that has to be fed `1 − opacity` is how
  // the two get crossed one day.
  function bgVars(el, cfg, url) {
    if (!el || !el.style) return;
    el.style.setProperty('--gm-bg-image', url ? 'url("' + url + '")' : 'none');
    el.style.setProperty('--gm-bg-pos', cfg.offsetX + '% ' + cfg.offsetY + '%');
    el.style.setProperty('--gm-bg-dim', String(Math.max(0, Math.min(1, 1 - cfg.opacity / 100))));
    el.style.setProperty('--gm-bg-blur', cfg.blur + 'px');
  }

  // Reads the two sliders and the drag state, and clamps the lot through the storage layer —
  // the same `clampBgConfig` the write path uses, so a value the panel can display is a value
  // the store will accept.
  function bgCfg() {
    var op = $('bgOpacity'), bl = $('bgBlur');
    return G.clampBgConfig({
      opacity: op ? parseInt(op.value, 10) : null,
      blur: bl ? parseInt(bl.value, 10) : null,
      offsetX: bgOff.x, offsetY: bgOff.y, scale: 100,
    });
  }

  function setBgStatus(text) {
    var el = $('bgStatus');
    if (el) el.textContent = text;
  }

  // The settings page is the only writer of the background store, so it is also the only thing
  // that can tell the open game tabs to re-read it: IndexedDB fires no `storage.onChanged`, and
  // a content script cannot open this store at all (its `indexedDB` is the host page's). The
  // worker relays this to every tab; content.js then does its own `gm-bg-get`.
  //
  // Only the 浮层 slot is announced. The viewer's own backdrop is applied locally by
  // `applyViewerBg()`, and waking every game tab for it would be noise.
  function notifyBgChanged(slot) {
    if (slot !== 'bg-overlay') return;
    try {
      chrome.runtime.sendMessage({ type: 'gm-bg-changed', slot: slot }, function () {
        void chrome.runtime.lastError;   // no listener is a normal state, not an error
      });
    } catch (e) { /* extension context gone */ }
  }

  function paintBgPanel() {
    var cfg = G.clampBgConfig(bgCur || null);
    var op = $('bgOpacity'), bl = $('bgBlur');
    if (op) op.value = String(cfg.opacity);
    if (bl) bl.value = String(cfg.blur);
    setTxt('bgOpacityVal', cfg.opacity + '%');
    setTxt('bgBlurVal', cfg.blur + 'px');
    setTxt('bgPreviewEmpty', T('viewer|还没有背景图'));
    var prev = $('bgPreview');
    if (prev) {
      prev.classList.toggle('has-bg', !!bgUrl);
      bgVars(prev, cfg, bgUrl);
    }
    setBgStatus(bgCur
      ? T('viewer|已设置（{kb} KB）', { kb: Math.max(1, Math.round(((bgCur.blob && bgCur.blob.size) || 0) / 1024)) })
      : T('viewer|未设置背景图'));
  }

  // Loads the slot the dropdown names into the panel. Revokes the previous preview URL: a
  // 4MB blob held by a live object URL is 4MB the page can never free, and re-importing is
  // exactly the operation an operator repeats while hunting for a picture they like.
  function loadBgSlot() {
    var slot = bgSlot();
    return G.loadBackground(slot).then(function (rec) {
      bgCur = rec || null;
      bgOff = { x: bgCur ? bgCur.offsetX : 50, y: bgCur ? bgCur.offsetY : 50 };
      if (bgUrl) { try { URL.revokeObjectURL(bgUrl); } catch (e) {} bgUrl = ''; }
      if (bgCur && bgCur.blob) {
        try { bgUrl = URL.createObjectURL(bgCur.blob); } catch (e) { bgUrl = ''; }
      }
      paintBgPanel();
      return bgCur;
    });
  }

  // The live page reads the `bg-viewer` slot ONLY, whatever the panel is showing. An operator
  // tuning the overlay's picture while the viewer's own backdrop changed underneath them would
  // have no way to tell which of the two they were looking at.
  function applyViewerBg() {
    return G.loadBackground('bg-viewer').then(function (rec) {
      var root = document.documentElement;
      if (!rec || !rec.blob) {
        root.classList.remove('has-bg');
        root.style.setProperty('--gm-bg-image', 'none');
        if (bgViewUrl) { try { URL.revokeObjectURL(bgViewUrl); } catch (e) {} bgViewUrl = ''; }
        return false;
      }
      if (bgViewUrl) { try { URL.revokeObjectURL(bgViewUrl); } catch (e) {} bgViewUrl = ''; }
      try { bgViewUrl = URL.createObjectURL(rec.blob); } catch (e) { bgViewUrl = ''; }
      bgVars(root, G.clampBgConfig(rec), bgViewUrl);
      root.classList.add('has-bg');
      return true;
    }, function () { return false; });
  }

  function pickBgFile() {
    var input = $('bgFile');
    var file = input && input.files && input.files[0];
    if (!file) return;
    if (input) input.value = '';   // the input is cleared in every branch, so re-picking the
                                   // SAME file after a failure still fires `change`
    if (!/^image\//.test(file.type || '')) {
      setBgStatus(T('viewer|请选择图片文件。'));
      return;
    }
    if (file.size > G.BG_MAX_BYTES) {
      setBgStatus(T('viewer|图片过大，上限 {mb} MB。', { mb: Math.round(G.BG_MAX_BYTES / 1048576) }));
      return;
    }
    // A NEW picture starts centred, whatever the previous one was dragged to. Carrying the old
    // offsets over would show a corner of the new image and read as a broken import.
    bgOff = { x: 50, y: 50 };
    setBgStatus(T('viewer|正在保存…'));
    var slot = bgSlot();
    G.saveBackground(slot, file, bgCfg()).then(function () {
      return loadBgSlot();
    }).then(function () {
      if (slot === 'bg-viewer') applyViewerBg();
      notifyBgChanged(slot);
      setBgStatus(T('viewer|已保存。'));
    }, function (e) {
      setBgStatus(TE(String((e && e.message) || e)) || T('viewer|保存失败。'));
    });
  }

  function clearBg() {
    var slot = bgSlot();
    G.clearBackground(slot).then(function () {
      return loadBgSlot();
    }).then(function () {
      if (slot === 'bg-viewer') applyViewerBg();
      notifyBgChanged(slot);
      setBgStatus(T('viewer|已清除，恢复默认。'));
    }, function (e) {
      setBgStatus(TE(String((e && e.message) || e)) || T('viewer|清除失败。'));
    });
  }

  // Commits the sliders and the drag offsets. A no-op when the slot holds no picture: there is
  // nothing to save and, more to the point, `saveBackgroundConfig` would return false anyway —
  // but the panel must not report 「已保存」 for a write that never happened.
  function commitBgCfg() {
    if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
    var cfg = bgCfg();
    setTxt('bgOpacityVal', cfg.opacity + '%');
    setTxt('bgBlurVal', cfg.blur + 'px');
    var prev = $('bgPreview');
    if (prev) bgVars(prev, cfg, bgUrl);
    if (!bgCur) return;
    var slot = bgSlot();
    G.saveBackgroundConfig(slot, cfg).then(function (ok) {
      if (!ok) return;
      if (slot === 'bg-viewer') applyViewerBg();
      notifyBgChanged(slot);
      setBgStatus(T('viewer|已保存。'));
    }, function (e) {
      setBgStatus(TE(String((e && e.message) || e)) || T('viewer|保存失败。'));
    });
  }

  // §5.1.3 — 拖动图片调整位置. The pointer's delta maps to `background-position` percentages and
  // the sign is INVERTED: dragging right has to carry the PICTURE right, and a larger
  // `background-position-x` moves it LEFT (100% aligns the image's right edge with the box's).
  // So the operator grabs the image, not the window onto it — which is what the preview's
  // `cursor:grab` promises.
  function bindBgDrag() {
    var prev = $('bgPreview');
    if (!prev) return;
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    prev.addEventListener('pointerdown', function (ev) {
      if (!bgUrl) return;
      dragging = true;
      sx = ev.clientX; sy = ev.clientY; ox = bgOff.x; oy = bgOff.y;
      prev.classList.add('dragging');
      if (prev.setPointerCapture) { try { prev.setPointerCapture(ev.pointerId); } catch (e) {} }
      ev.preventDefault();
    });
    prev.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      var r = prev.getBoundingClientRect();
      var w = r.width || 1, h = r.height || 1;
      bgOff.x = Math.max(0, Math.min(100, ox - (ev.clientX - sx) / w * 100));
      bgOff.y = Math.max(0, Math.min(100, oy - (ev.clientY - sy) / h * 100));
      bgVars(prev, bgCfg(), bgUrl);
      if (bgTimer) clearTimeout(bgTimer);
      bgTimer = setTimeout(commitBgCfg, BG_SAVE_DELAY);
    });
    function stop() {
      if (!dragging) return;
      dragging = false;
      prev.classList.remove('dragging');
      commitBgCfg();
    }
    prev.addEventListener('pointerup', stop);
    prev.addEventListener('pointercancel', stop);
  }

  function fillBgPanel() {
    // The slot dropdown's own options are static markup, so the implicit i18n pass handles
    // their labels; the panel only has to put the SELECTION back, because a language switch
    // rebuilds nothing here and a reload would otherwise drop it to 查看器.
    return loadBgSlot();
  }

  // =====================================================================
  // 0.5.2 §4.1 — 自定义问题（编辑）
  // =====================================================================
  // The editor is a form (原文 + 英文 + a translation list) plus the list of what is stored.
  // `cqDraft` is the in-progress row: `{ id: null, translations: {…} }` — `id` is null for a
  // row being created and the existing id when 编辑 re-opened one. Keeping the draft here
  // rather than in the DOM is what lets 编辑 load a row's translations into a form that has
  // one visible text box.
  var cqDraft = { id: null, translations: {} };
  var cqList = [];

  function setCqStatus(text) {
    var el = $('cqStatus');
    if (el) el.textContent = text;
  }

  function fillCqLangSelect() {
    var sel = $('cqLang');
    if (!sel) return;
    var cur = sel.value;
    // English is excluded: it has its own required field, and offering it here as well would
    // give the operator two boxes for one string — the classic way a required field ends up
    // half-filled from one and half from the other.
    var html = '';
    GMI18n.LOCALES.forEach(function (code) {
      if (code === 'en' || code === 'zh-CN') return;
      html += '<option value="' + esc(code) + '">' + esc(GMI18n.langLabel(code)) + '</option>';
    });
    sel.innerHTML = html;
    if (cur) sel.value = cur;
  }

  function renderCqTransList() {
    var el = $('cqTransList');
    if (!el) return;
    var keys = Object.keys(cqDraft.translations).filter(function (k) { return k !== 'en'; });
    if (!keys.length) { el.textContent = T('viewer|还没有添加其他语言的翻译。'); return; }
    el.textContent = keys.map(function (k) {
      return GMI18n.langLabel(k) + '：' + cqDraft.translations[k];
    }).join('　·　');
  }

  function renderCqList() {
    var host = $('cqList');
    if (!host) return;
    if (!cqList.length) {
      host.innerHTML = '<div class="cq-empty">' + esc(T('viewer|还没有自定义问题。')) + '</div>';
      return;
    }
    host.innerHTML = cqList.map(function (q) {
      var trs = Object.keys(q.translations || {})
        .filter(function (k) { return k !== 'en' && k !== 'zh-CN'; })
        .map(function (k) { return GMI18n.langLabel(k) + '：' + q.translations[k]; });
      return '<div class="cq-row" data-id="' + esc(q.id) + '">' +
        '<div class="cq-main">' +
          '<div class="cq-text">' + esc(q.text) + '</div>' +
          '<div class="cq-tr">' + esc(T('viewer|英文') + '：' + (q.translations.en || '')) +
            (trs.length ? esc('　·　' + trs.join('　·　')) : '') + '</div>' +
        '</div>' +
        '<div class="cq-act">' +
          '<span class="lk" data-cq="edit">' + esc(T('viewer|编辑')) + '</span>' +
          '<span class="lk" data-cq="remove">' + esc(T('viewer|删除')) + '</span>' +
        '</div></div>';
    }).join('');
  }

  function fillCqPanel() {
    fillCqLangSelect();
    setTxt('cqSave', T('viewer|保存'));
    setTxt('cqReset', T('viewer|清空表单'));
    setTxt('cqAddTrans', T('viewer|＋ 添加'));
    renderCqTransList();
    renderCqList();
    return G.loadCustomQuestions().then(function (list) {
      cqList = list;
      renderCqList();
      return list;
    }, function () { return []; });
  }

  function cqResetForm() {
    cqDraft = { id: null, translations: {} };
    setField($('cqText'), '');
    setField($('cqEn'), '');
    setField($('cqTrans'), '');
    renderCqTransList();
    setCqStatus(T('viewer|已清空表单。'));
  }

  function cqAddTranslation() {
    var sel = $('cqLang'), box = $('cqTrans');
    if (!sel || !box) return;
    var lang = sel.value;
    var text = String(box.value || '').trim();
    if (!lang || !text) return;
    cqDraft.translations[lang] = text;
    box.value = '';
    renderCqTransList();
  }

  // §4.1.2 — English is mandatory, and the original text is too. The check lives here rather
  // than only in storage.js so the operator gets told WHICH field is missing; the storage layer
  // keeps its own copy because it is the thing that decides what a usable row is.
  function cqFormToQuestion() {
    var text = String(($('cqText') || {}).value || '').trim();
    var en = String(($('cqEn') || {}).value || '').trim();
    if (!text) { setCqStatus(T('viewer|请填写原文。')); return null; }
    if (!en) { setCqStatus(T('viewer|请填写英文（英文是回退版本，必填）。')); return null; }
    var tr = Object.assign({}, cqDraft.translations, { en: en });
    return { text: text, translations: tr };
  }

  function cqSave() {
    var q = cqFormToQuestion();
    if (!q) return;
    var id = cqDraft.id;
    var op = id ? G.updateCustomQuestion(id, q) : G.addCustomQuestion(q);
    op.then(function (res) {
      if (!res || !res.ok) {
        // §4.1.2 — the limit is a real state, not a failure: eight is what the ask menu can
        // show without scrolling, and the message has to say so.
        setCqStatus(res && res.error === 'limit'
          ? T('viewer|最多 {n} 个自定义问题。', { n: G.MAX_CUSTOM_QUESTIONS })
          : T('viewer|保存失败：内容不完整。'));
        return;
      }
      cqList = res.list;
      renderCqList();
      cqResetForm();
      setCqStatus(T('viewer|已保存。'));
    }, function (e) {
      setCqStatus(TE(String((e && e.message) || e)) || T('viewer|保存失败。'));
    });
  }

  function cqEdit(id) {
    var q = null;
    for (var i = 0; i < cqList.length; i++) if (cqList[i].id === id) { q = cqList[i]; break; }
    if (!q) return;
    cqDraft = { id: q.id, translations: Object.assign({}, q.translations) };
    setField($('cqText'), q.text);
    setField($('cqEn'), (q.translations && q.translations.en) || '');
    setField($('cqTrans'), '');
    renderCqTransList();
    setCqStatus(T('viewer|正在编辑已有问题，保存后覆盖。'));
  }

  function cqRemove(id) {
    G.removeCustomQuestion(id).then(function (res) {
      cqList = (res && res.list) || [];
      renderCqList();
      if (cqDraft.id === id) cqResetForm();
      setCqStatus(T('viewer|已删除。'));
    }, function () { setCqStatus(T('viewer|删除失败。')); });
  }

  // §2.2.3 step 4. Goes through `gm-ai-think` rather than a dedicated "verify" message because
  // that is the SAME path a real analysis takes to reach the engine: an engine that answers here
  // is an engine that will answer in a game. nbest 1 and a short budget — this is a smoke test,
  // not a measurement.
  async function verifyCustomModel(id) {
    lastCustomError = '';
    try {
      var resp = await askOffscreen({
        type: 'gm-ai-think',
        jobId: gmJobId('verify'),
        engineId: id,
        prefix: [],
        nbest: 1,
        thinkMs: VERIFY_THINK_MS,
        rule: 0,
        threadNum: 0,
      });
      if (!resp || !resp.ok) { lastCustomError = (resp && resp.error) || ''; return false; }
      return true;
    } catch (e) {
      lastCustomError = String((e && e.message) || e);
      return false;
    }
  }

  async function addCustomModel() {
    var C = (typeof GMCustomEngines !== 'undefined') ? GMCustomEngines : null;
    var btn = $('cstAdd');
    var input = $('cstFile');
    var file = input && input.files && input.files[0];
    if (!C) { setCstStatus(T('viewer|此环境不支持自定义模型（IndexedDB 不可用）。')); return; }
    if (!file) { setCstStatus(T('viewer|请先选择文件。')); return; }
    if (btn) btn.disabled = true;
    var rec = null;
    try {
      setCstStatus(T('viewer|正在保存权重包…'));
      rec = await C.add(file);
      var reg = engineReg();
      if (reg) {
        reg.register({ id: rec.id, name: rec.name, dataId: rec.id, fileName: rec.fileName, size: rec.size, addedAt: rec.addedAt });
      }
      renderCustomList();
      setCstStatus(T('viewer|正在验证（用该权重包跑一次搜索）…'));
      if (!(await verifyCustomModel(rec.id))) {
        await C.remove(rec.id);
        if (reg) reg.unregister(rec.id);
        renderCustomList();
        // §2.2.3 step 5 — the message has to say what failed. `TE` resolves an `__i18n:` code and
        // passes a plain engine message through, so an emscripten abort is shown as it arrived.
        setCstStatus(T('viewer|验证失败，已丢弃该权重包：{err}',
          { err: TE(lastCustomError) || T('viewer|引擎无法加载该权重包') }));
        return;
      }
      // §2.2.4 — verified, so now it may be named. Cancel keeps whatever default the label had.
      var typed = prompt(T('viewer|验证通过。给这个模型起个名字（留空 = 用默认名）：'), rec.fileName || '');
      if (typed != null && String(typed).trim()) await C.rename(rec.id, String(typed).trim());
      await refreshCustomRegistry();
      await afterEngineChange();
      setCstStatus(T('viewer|验证通过，已添加。'));
    } catch (e) {
      // `C.add` rejects with `__i18n:custom.tooBig` / `tooMany` / `noFile`; a half-added record is
      // the one outcome that must not survive, so it is rolled back here.
      if (rec) {
        try { await C.remove(rec.id); } catch (e2) { /* nothing to roll back */ }
        var reg2 = engineReg();
        if (reg2) reg2.unregister(rec.id);
        renderCustomList();
      }
      setCstStatus(TE(e && e.message) || String(e));
    } finally {
      if (btn) btn.disabled = false;
      if (input) input.value = '';
    }
  }

  async function renameCustomModel(id) {
    var C = (typeof GMCustomEngines !== 'undefined') ? GMCustomEngines : null;
    if (!C) return;
    var reg = engineReg();
    var cfg = reg ? reg.get(id) : null;
    if (!cfg) return;
    var v = prompt(T('viewer|新名称（只改显示名，不改 id）'), cfg.name || '');
    if (v == null) return;
    await C.rename(id, String(v).trim());
    await refreshCustomRegistry();
    // The name is what the three dropdowns print, so a rename travels the same road as every other
    // engine change. `renderCustomList()` alone rebuilt this panel and left all three <select>s
    // showing the PREVIOUS name until the page was left and re-entered — the operator renames a
    // model, then picks it from a dropdown still labelled with the name they just replaced.
    afterEngineChange();
  }

  async function removeCustomModel(id) {
    var C = (typeof GMCustomEngines !== 'undefined') ? GMCustomEngines : null;
    if (!C) return;
    var reg = engineReg();
    var cfg = reg ? reg.get(id) : null;
    if (!cfg) return;
    if (!confirm(T('viewer|删除自定义模型「{name}」？其权重包会一并删除。', { name: cfg.name }))) return;
    await C.remove(id);
    if (reg) reg.unregister(id);
    // Deleting the model that is currently selected has to move the selection too, otherwise the
    // settings page would name an engine that no longer exists.
    if (currentEngineId() === id) await G.saveSetting('engineId', (engineReg() ? engineReg().DEFAULT_ID : 'rapfi'));
    await refreshCustomRegistry();
    await afterEngineChange();
    setCstStatus(T('viewer|已删除。'));
  }

  // §2.2.5 — 首选 is not a second setting: it IS `settings.engineId`, so the panel, the three
  // dropdowns and the report all follow from it with no extra sync.
  function setPreferredEngine(id) {
    G.saveSetting('engineId', id).then(function (s) {
      S = s;
      afterEngineChange();
      flashSaved();
      setCstStatus(T('viewer|已设为首选。'));
    });
  }

  function syncDetectControls() {
    setField($('suspect'), S.suspect);
    setField($('thinkMs'), S.thinkMs);
    setField($('openCut'), S.openingCutoff);
    setField($('aiThinkMs'), (S.aiThinkMs == null ? S.thinkMs : S.aiThinkMs));
    aiThinkDirty = (S.aiThinkMs != null);
  }

  // 0.4.0 §2.3: one figure per card. `big` may be a number, a formatted figure or a date —
  // the `sm` modifier keeps a date from being shouted at 22px inside a 160px card.
  function statCard(big, label, small) {
    return '<div class="stat-card"><div class="big' + (small ? ' sm' : '') + '">' +
      esc(String(big)) + '</div><div class="k">' + esc(label) + '</div></div>';
  }

  async function renderSettings(repaint) {
    fillSettingsForm();
    fillVersionRow();
    // 0.5.1 §2.1.4 — the engine's live status is asked for on ENTERING the settings page, not from
    // fillSettingsForm(): that runs on every language switch too, and spawning the offscreen
    // document (and with it a 40 MB engine) because someone changed the UI language would be a
    // side effect nobody asked for. The custom-model list is re-read here for the same reason the
    // blacklist is (§一.7): the panel in the page can have added one since this page was opened.
    //
    // Two corrections to the first cut of this, both found by `behave-052`:
    //   · `afterEngineChange()` re-asks the offscreen document, and this function asks on the very
    //     next line — so ONE entry to 设置 asked TWICE. Only the two list refills belong here.
    //   · `repaintForLang()` reaches this function through `showView()`, so the language switch the
    //     paragraph above promises not to query for was querying anyway. A repaint now re-paints the
    //     answer already in hand (`lastEngineInfo`) instead of asking for it again.
    refreshCustomRegistry().then(function () { fillEngineSelects(); renderCustomList(); });
    if (repaint) paintEngineStatus(); else refreshEngineStatus();
    var list = await G.loadArchives();
    var bytes = 0;
    try { bytes = JSON.stringify(list).length; } catch (e) {}
    $('setArch').innerHTML =
      statCard(list.length, T('viewer|存档局数')) +
      statCard(G.MAX_ARCHIVES, T('viewer|上限')) +
      statCard((bytes / 1024).toFixed(1) + ' KB', T('viewer|占用')) +
      statCard(list.length ? G.beijingTime(list[list.length - 1].createdAt) : '—',
               T('viewer|最早存档'), true);
    // 0.3.3 §3.6: the learned parameters are reported here as well as in the sample library,
    // because this is the tab an operator opens to ask "what is the detector actually using".
    var smp = await G.loadSamples();
    var lp = await G.loadLearnedParams();
    $('setLearn').innerHTML =
      statCard(smp.length, T('viewer|样本数')) +
      statCard(lp ? (lp.sampleCount || 0) : '—', T('viewer|学习样本')) +
      statCard(lp ? (lp.featureCount || 0) : '—', T('viewer|特征库')) +
      statCard(lp ? G.beijingTime(lp.trainedAt) : T('viewer|未学习'), T('viewer|学习时间'), true);
    // The one thing the figures above cannot show: whether that learned set is trustworthy.
    var note = $('setLearnNote');
    var drift = lp ? G.sampleDrift(lp.sampleCount, smp.length) : { grown: false };
    var warn = (lp && lp.reliable === false
      ? '<span style="color:var(--yellow)">' + T('viewer|（样本量不足，结果不可靠）') + '</span>' : '') +
      // 0.4.1 §一.5 — same rule as the 学习 panel; both go through GMStorage.sampleDrift so
      // they can never disagree about whether a refresh is due.
      (drift.grown
        ? (lp && lp.reliable === false ? ' ' : '') +
          '<span style="color:var(--yellow)">' +
          T('viewer|样本已从 {was} 增至 {now}（+{pct}%），建议重新学习。',
            { was: drift.was, now: drift.now, pct: drift.pct }) + '</span>'
        : '');
    note.innerHTML = warn;
    note.style.display = warn ? '' : 'none';
    $('setResetLearn').disabled = !lp;
  }

  // =====================================================================
  // 0.4.0 §一: self-update — the banner and the manual check
  // =====================================================================
  // The CHECK itself lives entirely in background.js (see storage.js for why
  // `chrome.runtime.requestUpdateCheck()` cannot be used, and for the version comparison).
  // This page only reads the stored result and, for the button, asks the worker to re-run it.
  var updInfo = null;     // the update the banner is currently showing (null = none)
  // The manual check's outcome, kept as a KEY rather than as rendered text: a language switch
  // has to be able to repaint it, and re-rendering a stale sentence would be worse than '—'.
  var updStatus = null;

  function localVersion() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return ''; }
  }

  function fillVersionRow() {
    var el = $('setVer');
    if (el) el.textContent = 'v' + localVersion();
    var btn = $('setCheckUpd');
    if (btn) btn.textContent = T('update.check');
  }

  function paintUpdStatus() {
    var el = $('setUpdHint');
    if (el) el.textContent = updStatus ? T(updStatus.key, updStatus.vars) : '—';
  }
  function setUpdStatus(key, vars) {
    updStatus = key ? { key: key, vars: vars || null } : null;
    paintUpdStatus();
  }

  function renderUpdateBanner(info) {
    updInfo = info || null;
    var el = $('updBan');
    if (!el) return;
    if (!updInfo) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.innerHTML =
      '<span class="bt">' + esc(T('update.available', { v: updInfo.latestVersion })) + '</span>' +
      '<span class="sp"></span>' +
      // 0.5.2 §2.1.3 — [一键更新] [查看详情] [暂不更新], same order as the on-page panel's
      // banner. Routed through the worker rather than called here even though this page IS an
      // extension page and could reach `chrome.downloads` directly: one implementation of the
      // download, and the notification it raises is identical whichever surface started it.
      '<span class="blk bnow" data-upd="now">' + esc(T('update.oneClick')) + '</span>' +
      '<span class="blk" data-upd="open">' + esc(T('update.view')) + '</span>' +
      '<span class="blk" data-upd="dismiss">' + esc(T('update.dismiss')) + '</span>';
    el.classList.remove('hidden');
  }

  var updNowBusy = false;
  function setUpdNow(label, busy) {
    var btn = $('updBan') && $('updBan').querySelector('[data-upd=now]');
    if (!btn) return;
    btn.textContent = label;
    btn.classList.toggle('busy', !!busy);
  }

  function oneClickUpdate() {
    if (updNowBusy) return;
    updNowBusy = true;
    setUpdNow(T('update.downloading'), true);
    var done = function (resp) {
      updNowBusy = false;
      setUpdNow(T('update.oneClick'), false);
      if (resp && resp.ok) alert(T('update.downloaded', { file: (resp && resp.filename) || 'baishen-update.zip' }));
      // `update.dlFailed` — NOT `update.failed`, which means the CHECK could not reach the
      // repository. Same distinction as the panel's banner makes.
      else alert(T('update.dlFailed', { err: (resp && resp.error) || '?' }));
    };
    try {
      chrome.runtime.sendMessage({ type: 'gm-download-update' }, function (resp) {
        if (chrome.runtime.lastError) { done({ ok: false, error: chrome.runtime.lastError.message }); return; }
        done(resp);
      });
    } catch (e) { done({ ok: false, error: String((e && e.message) || e) }); }
  }

  // The automatic path: honours the 7-day「暂不更新」. The manual button deliberately does
  // not — asking for the check is itself a decision to be told the answer.
  function refreshUpdateBanner() {
    return G.pendingUpdate().then(
      function (info) { renderUpdateBanner(info); },
      function () { renderUpdateBanner(null); });
  }

  // ---- 0.5.3 §1.3: the one-time notice that goes WITH the banner, not instead of it ----
  // §1.3.1 puts this in boot() and nowhere else, and the flag makes that explicit rather than
  // incidental: `refreshUpdateBanner()` above also runs on every settings broadcast, so a toast
  // fired from there would reappear each time the operator touched any control on the page.
  //
  // The banner stays permanent and carries the 一键更新 button; this is the 8-second nudge for
  // an operator who opened the viewer to look at a game and would never scroll to the top.
  var updToastShown = false;
  function notifyUpdateOnce() {
    if (updToastShown) return Promise.resolve(null);
    return G.pendingUpdate().then(function (info) {
      if (!info || !info.available) return null;
      updToastShown = true;
      GmToast.show(T('toast|发现新版本 {v}', { v: info.latestVersion }), 'warn', {
        link: info.releaseUrl || info.downloadUrl || G.UPDATE_RELEASES,
        linkText: T('toast|前往下载'),
        // §1.3.1 asks for 8s rather than the 3s default: this one carries a link the operator
        // has to notice, aim at and click.
        duration: 8000,
      });
      return info;
    }, function () { return null; });
  }

  function openUpdatePage() {
    var url = (updInfo && (updInfo.releaseUrl || updInfo.downloadUrl)) || G.UPDATE_RELEASES;
    try { window.open(url, '_blank', 'noopener'); } catch (e) { /* popup blocked */ }
  }

  function dismissUpdateBanner() {
    if (!updInfo) return;
    var v = updInfo.latestVersion;
    // Hide first, persist after: the click has to feel instant.
    renderUpdateBanner(null);
    G.dismissUpdate(v).catch(function () {});
  }

  if ($('updBan')) {
    $('updBan').addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-upd]') : null;
      if (!b) return;
      var what = b.getAttribute('data-upd');
      if (what === 'now') oneClickUpdate();
      else if (what === 'open') openUpdatePage();
      else if (what === 'dismiss') dismissUpdateBanner();
    });
  }

  if ($('setCheckUpd')) {
    $('setCheckUpd').onclick = function () {
      var btn = $('setCheckUpd');
      btn.disabled = true;
      setUpdStatus('update.checking');
      chrome.runtime.sendMessage({ type: 'gm-check-update' }, function (res) {
        btn.disabled = false;
        if (chrome.runtime.lastError || !res || !res.ok) { setUpdStatus('update.failed'); return; }
        var info = res.info || null;
        if (info && info.available) {
          setUpdStatus('update.found', { v: info.latestVersion });
          renderUpdateBanner(info);
        } else {
          setUpdStatus('update.upToDate', { v: (info && info.currentVersion) || localVersion() });
        }
      });
    };
  }

  // §二.2: 列折叠偏好 is a second DOOR to the header's 「列 ▾」 popup, not a second copy of it
  // — the popup positions itself from the real button's rect, which only exists in the header.
  if ($('setColPref')) {
    $('setColPref').onclick = function () { var b = $('colBtn'); if (b) b.click(); };
  }

  // 改动即写: a `change` event only fires on blur/Enter, so a user who types a number
  // and closes the tab would lose it. Commit on `input` too, debounced, and dedupe so a
  // trailing `change` does not write the same value twice.
  //
  // `after` is for the bindings whose value is READ by another control on this page: the engine
  // pickers exist four times (three dropdowns + the panel in the page), and the one that was just
  // changed has to push the new value into the other three.
  function bindSetting(el, key, read, after) {
    if (!el) return;
    var timer = null, last = null;

    function commit() {
      if (timer) { clearTimeout(timer); timer = null; }
      var v = read(el);
      if (v === last) return;
      last = v;
      lastSelfWrite = Date.now();
      G.saveSetting(key, v).then(function (s) {
        S = s;
        syncDetectControls();
        if (after) after(s);
        flashSaved();
      });
    }

    el.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(commit, 250);
    });
    el.addEventListener('change', commit);
    el.addEventListener('blur', commit);
  }

  function flashSaved() {
    var h = $('setHint');
    h.textContent = T('viewer|已保存（改动即写入，无保存按钮）');
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(function () {
      h.textContent = T('viewer|规则由 URL 判断（/renju/），不参与记忆。');
    }, 1800);
  }

  // ---- 0.5.3 §1.1.6 ----
  // Same reason as bindLlmFields: the value written is a freshly-built object, so
  // `bindSetting`'s `v === last` dedupe could never fire and two controls would race each
  // other's writes. The commit is unconditional and rides `G.saveSetting` so it is still on
  // GMStorage's serialised chain.
  //
  // ⚠ The commit reads EVERY control, not just the one that fired. `saveSetting` replaces the
  // whole `transparency` value, so a partial object would silently reset the nine controls that
  // did not move — and the damage would only show on the next reload.
  function bindTransparencyControls() {
    var grid = $('tpGrid');
    if (!grid) return;
    var timer = null;

    function readAll() {
      var out = {};
      TP_GROUPS.forEach(function (grp) {
        var en = $(tpId(grp.part, 'enabled'));
        out[grp.part] = { enabled: !!(en && en.checked) };
        grp.rows.forEach(function (key) {
          var el = $(tpId(grp.part, key));
          if (el) out[grp.part][key] = parseInt(el.value, 10);
        });
      });
      return out;
    }

    function commit() {
      if (timer) { clearTimeout(timer); timer = null; }
      var next = G.normalizeTransparency(readAll());
      lastSelfWrite = Date.now();
      applyTransparency(next);
      G.saveSetting('transparency', next).then(function (s) {
        S = s;
        fillTransparencyForm();
        flashSaved();
      });
    }

    // `input` while dragging repaints immediately so the operator can SEE the value they are
    // choosing (§1.1.6 实时预览), but the write waits 250 ms — a range drag fires this event
    // dozens of times and every one of them would otherwise be a storage round-trip.
    //
    // The live repaint goes through `applyTransparency` on a NORMALISED copy, so a value the
    // slider cannot yet produce (a profile restored from elsewhere) still previews as what will
    // actually be stored.
    function preview() {
      var next = G.normalizeTransparency(readAll());
      applyTransparency(next);
      // The readouts and the enabled/disabled state follow the drag, not just the commit.
      TP_GROUPS.forEach(function (grp) {
        grp.rows.forEach(function (key) {
          var val = $(tpId(grp.part, key) + '-val');
          if (!val) return;
          var n = next[grp.part][key];
          val.textContent = tpReadout(key, n);
          var el = $(tpId(grp.part, key));
          if (el) el.disabled = !next[grp.part].enabled;
        });
      });
    }

    grid.addEventListener('change', function (e) {
      var t = e.target;
      if (!t) return;
      // A checkbox commit is immediate (nothing to debounce), and so is the `change` that ends
      // a drag — a drag that ends without a further `input` would otherwise leave the 250ms
      // debounce as the only write, and `commit` clears that timer itself.
      if (t.type === 'checkbox' || t.type === 'range') commit();
    });
    grid.addEventListener('input', function (e) {
      if (!e.target || e.target.type !== 'range') return;
      preview();
      if (timer) clearTimeout(timer);
      timer = setTimeout(commit, 250);
    });
  }

  // ---- 0.5.3 §2.2.4 ----
  // Same shape as the transparency binder and for the same reason: `archiveFilter` is an object,
  // so `bindSetting`'s scalar dedupe cannot apply, and a partial write would reset the other two
  // fields. An empty box is read as the field's default rather than as 0 — clearing the input
  // while retyping must not silently arm a filter that excludes every game.
  function bindArchiveFilter() {
    var en = $('afEnabled'), lo = $('afMin'), hi = $('afMax');
    if (!en || !lo || !hi) return;
    var timer = null;

    function commit() {
      if (timer) { clearTimeout(timer); timer = null; }
      var next = G.normalizeArchiveFilter({
        enabled: !!en.checked,
        minRisk: lo.value === '' ? 0 : parseInt(lo.value, 10),
        maxRisk: hi.value === '' ? 54 : parseInt(hi.value, 10),
      });
      lastSelfWrite = Date.now();
      // Rewrite the boxes from the CLAMPED result, so the control can never display a number
      // storage did not accept — the same rule `setMinMoves` follows above.
      G.saveSetting('archiveFilter', next).then(function (s) {
        S = s;
        fillArchiveFilterForm();
        flashSaved();
      });
    }

    en.addEventListener('change', commit);
    [lo, hi].forEach(function (el) {
      el.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(commit, 400);
      });
      el.addEventListener('change', commit);
    });
  }

  // ---- 0.5.4 §1.5.4 ----
  // Slider ↔ number ↔ arrows, all three writing ONE value; the two segments are independent
  // (§1.5.4's last bullet — `minOrdered + maxUnordered > 50` is NOT an error, the two thresholds
  // describe different things and clamping one against the other would silently forbid settings
  // the operator is allowed to make).
  //
  // The commit is debounced like `bindArchiveFilter`'s, and for the same reason: a drag fires
  // `input` on every pixel. Only the COMMIT writes, and the repaint afterwards comes from the
  // clamped result, so a box can never display a number storage did not accept.
  function bindStorageFilter() {
    var slider = $('sfSlider');
    if (!slider) return;
    var timer = null;

    function readRow(row) {
      var n = sfNumEl(row);
      var v = n && n.value !== '' ? parseInt(n.value, 10) : NaN;
      return isFinite(v) ? v : null;
    }
    function commit() {
      if (timer) { clearTimeout(timer); timer = null; }
      var raw = { enabled: !!($('sfEnabled') && $('sfEnabled').checked) };
      SF_ROWS.forEach(function (row) { raw[row.key] = readRow(row); });
      var next = G.normalizeStorageFilter(raw);
      lastSelfWrite = Date.now();
      G.saveSetting('storageFilter', next).then(function (s) {
        S = s;
        fillStorageFilterForm();
        flashSaved();
      });
    }
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(commit, 400);
    }
    // The range is the authority for the number, and vice versa — §1.5.4 asks for both directions
    // and they are genuinely different edits (a drag vs a typed digit), so each one updates the
    // OTHER control immediately and only the commit goes to storage.
    SF_ROWS.forEach(function (row) {
      var r = sfRangeEl(row), n = sfNumEl(row);
      if (r && n) {
        r.addEventListener('input', function () {
          n.value = r.value;
          schedule();
        });
        // `change` fires on release/commit and skips the debounce: a drag that ends is a decision.
        r.addEventListener('change', commit);
        n.addEventListener('input', function () {
          var v = parseInt(n.value, 10);
          if (isFinite(v)) r.value = String(Math.max(0, Math.min(Number(r.max) || 50, v)));
          schedule();
        });
        n.addEventListener('change', commit);
      }
    });
    // ±1 on the arrows. §1.5.4's third bullet. They write the NUMBER and let the number's own
    // handler move the slider, so there is one path from a value to the two controls.
    // ONE delegated listener for all four arrows: they share a container, and the row is chosen
    // by `data-target` rather than by which closure happened to be attached.
    slider.addEventListener('click', function (e) {
      var hit = e.target && e.target.closest ? e.target.closest('.ds-arrow') : null;
      if (!hit || hit.disabled) return;
      var row = null;
      for (var k = 0; k < SF_ROWS.length; k++) {
        if (SF_ROWS[k].key === hit.getAttribute('data-target')) { row = SF_ROWS[k]; break; }
      }
      if (!row) return;
      var n = sfNumEl(row), r = sfRangeEl(row);
      if (!n || !r) return;
      var step = hit.getAttribute('data-act') === 'dec' ? -1 : 1;
      var hi = Number(r.max) || 50;
      var v = parseInt(n.value, 10);
      if (!isFinite(v)) v = 0;
      n.value = String(Math.max(0, Math.min(hi, v + step)));
      r.value = n.value;
      commit();
    });
    var en = $('sfEnabled');
    if (en) en.addEventListener('change', commit);
  }
  bindStorageFilter();
  bindSetting($('setSuspect'), 'suspect', function (e) { return e.value; });
  bindSetting($('setMode'), 'mode', function (e) { return e.value; });
  bindSetting($('setThinkMs'), 'thinkMs', function (e) { return Math.max(500, parseInt(e.value, 10) || 2000); });
  bindSetting($('setAiThinkMs'), 'aiThinkMs', function (e) {
    var raw = String(e.value).trim();
    return raw === '' ? null : (parseInt(raw, 10) || null);
  });
  bindSetting($('setOpening'), 'openingCutoff', function (e) {
    var n = parseInt(e.value, 10); return isNaN(n) ? 8 : Math.max(0, Math.min(40, n));
  });
  bindSetting($('setThread'), 'threadNum', function (e) { return G.clampThreadNum(e.value); });
  // Clamped by the storage layer (5–30), and the box is rewritten from what was actually
  // stored so it can never display a value the archive gate does not use.
  bindSetting($('setMinMoves'), 'minArchiveMoves', function (e) { return G.clampMinMoves(e.value); });
  bindSetting($('setAuto'), 'autoAnalyze', function (e) { return !!e.checked; });
  // 0.4.4 §七/§八 — the master switch for automatic outbound chat. Without this binding the
  // flag existed in storage, was read by content.js three times, and could never be turned on:
  // the §7 announcement and the §8 replies were unreachable dead code. Default stays false.
  bindSetting($('setChatAuto'), 'chatAuto', function (e) { return !!e.checked; });
  // 0.4.10 §2.2 — 开局声明. Its own key so the operator can keep the automated REPLY (chatAuto)
  // without the extension speaking first on their behalf, or the other way round.
  bindSetting($('setAutoAnnounce'), 'autoSendAnnouncement', function (e) { return !!e.checked; });
  // 0.4.10 §三 — the tutorial button. Guarded: `openTutorial` lives with the modal helpers far
  // below, and a viewer.html without the button (a trimmed build) must not throw here.
  if ($('tutorialBtn')) $('tutorialBtn').onclick = openTutorial;
  // 0.5.3 §1.4.3 — 标签百科, same guard and same reason.
  if ($('tagWikiBtn')) $('tagWikiBtn').onclick = openTagWiki;
  // A language change is written like any other setting; the repaint comes from the
  // storage.onChanged broadcast (§1.8), which is also what keeps the toolbar menu's checkmark
  // and this dropdown from disagreeing when the change was made on the other entry point.
  bindSetting($('setLang'), 'lang', function (e) { return e.value; });
  // 0.4.7 §三.1 — the theme is applied IN THE SAME TURN as it is written, not only from the
  // storage.onChanged broadcast. The broadcast does arrive (the write goes through GMStorage),
  // but it is a round-trip through the settings area, and a theme that lands a frame late is a
  // visible flash of the old palette on every dropdown change.
  //
  // `applyTheme` reads the value back off the storage layer's own clamp rather than trusting
  // `e.value`: the dropdown is built from GMStorage.THEMES, but the storage layer is what
  // decides, and an attribute that matches no CSS rule renders the LIGHT palette with no error
  // anywhere — a failure mode this project has hit and does not want twice.
  bindSetting($('setTheme'), 'theme', function (e) { return applyTheme(e.value); });
  // §三.2 — the checkbox and the slider are two fields of ONE object, so neither can ride
  // `bindSetting` (which dedupes a scalar). Both commit the whole `transparency` object.
  bindTransparencyControls();
  bindArchiveFilter();
  // 0.5.3 §3.1 — one delegated listener per code box. The boxes are static markup, so this runs
  // once at module evaluation, like every other binding on this line.
  bindCodeBoxes();
  bindLlmFields();
  // 0.4.8 §3 — the searchable model drawer rides on top of the plain Model field.
  bindModelPicker();
  // 0.5.1 §2.1.4 — the engine, from all three dropdowns. They write one key; `afterEngineChange`
  // is what keeps the other two (`fillEngineSelects`), the custom list's 首选 tag and the status
  // line in step with the change, without a reload and without a second source of truth.
  bindSetting($('setEngine'), 'engineId', function (e) { return e.value; }, afterEngineChange);
  bindSetting($('engineSel'), 'engineId', function (e) { return e.value; }, afterEngineChange);
  bindSetting($('engineSelD'), 'engineId', function (e) { return e.value; }, afterEngineChange);

  // The address is a plain text field, so it commits on the same schedule as the others — but it
  // also feeds the registry, which is what decides whether KataGomo is selectable at all.
  if ($('setEngineUrl')) {
    var urlTimer = null;
    var commitUrl = function () {
      if (urlTimer) { clearTimeout(urlTimer); urlTimer = null; }
      commitEngineUrl();
    };
    $('setEngineUrl').addEventListener('input', function () {
      if (urlTimer) clearTimeout(urlTimer);
      urlTimer = setTimeout(commitUrl, 400);
    });
    $('setEngineUrl').addEventListener('change', commitUrl);
    $('setEngineUrl').addEventListener('blur', commitUrl);
  }
  // §2.1.3 — an optional host permission can only be requested from a user gesture. Without this
  // the fetch fails as a bare network error, with nothing in the UI to explain why. Same shape as
  // the LLM panel's 测试 button below.
  if ($('setEnginePerm')) {
    $('setEnginePerm').onclick = async function () {
      var btn = $('setEnginePerm');
      var url = String($('setEngineUrl').value || '').trim();
      if (!url) { alert(T('viewer|请先填写服务地址。')); return; }
      btn.disabled = true;
      try {
        var granted = await GMLLM.hasHostPermission(url);
        if (!granted) granted = await GMLLM.requestHostPermission(url);
        if (!granted) { alert(T('viewer|未授予访问该地址的权限，无法调用。')); return; }
        await commitEngineUrl();
        await refreshEngineStatus();
      } catch (e) {
        alert(T('viewer|授权失败：{t}', { t: TE(String((e && e.message) || e)) }));
      } finally {
        btn.disabled = false;
      }
    };
  }
  // §2.2 — 自定义检测模型. The list is delegated: `renderCustomList` replaces its whole innerHTML
  // on every repaint, so per-row handlers would be attached to nodes that no longer exist.
  if ($('cstList')) {
    $('cstList').onclick = function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button[data-cst]') : null;
      if (!b) return;
      var card = b.closest ? b.closest('.cst-card') : null;
      var id = card ? card.getAttribute('data-id') : '';
      if (!id) return;
      var what = b.getAttribute('data-cst');
      if (what === 'prefer') setPreferredEngine(id);
      else if (what === 'rename') renameCustomModel(id);
      else if (what === 'remove') removeCustomModel(id);
    };
  }
  if ($('cstAdd')) $('cstAdd').onclick = addCustomModel;

  // §5.1 — 自定义背景. The slot dropdown is a READER, not a setting: it decides which of the two
  // stored records the panel is editing, and nothing about it is persisted (the panel opens on
  // 查看器, which is the one the operator sees while they are here).
  if ($('bgSlot')) $('bgSlot').addEventListener('change', function () { loadBgSlot(); });
  if ($('bgFile')) $('bgFile').addEventListener('change', pickBgFile);
  if ($('bgClear')) $('bgClear').onclick = clearBg;
  ['bgOpacity', 'bgBlur'].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    // `input` repaints at once so the operator SEES the value they are choosing; the write
    // waits BG_SAVE_DELAY, because a range drag fires this event dozens of times.
    el.addEventListener('input', function () {
      var cfg = bgCfg();
      setTxt(id === 'bgOpacity' ? 'bgOpacityVal' : 'bgBlurVal',
             id === 'bgOpacity' ? cfg.opacity + '%' : cfg.blur + 'px');
      var prev = $('bgPreview');
      if (prev) bgVars(prev, cfg, bgUrl);
      if (bgTimer) clearTimeout(bgTimer);
      bgTimer = setTimeout(commitBgCfg, BG_SAVE_DELAY);
    });
    el.addEventListener('change', commitBgCfg);
  });
  bindBgDrag();

  // §4.1 — 自定义问题. The list is delegated for the same reason as the custom-model list:
  // `renderCqList` replaces its whole innerHTML on every repaint.
  if ($('cqList')) {
    $('cqList').onclick = function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-cq]') : null;
      if (!el) return;
      var row = el.closest ? el.closest('.cq-row') : null;
      var id = row ? row.getAttribute('data-id') : '';
      if (!id) return;
      if (el.getAttribute('data-cq') === 'edit') cqEdit(id);
      else cqRemove(id);
    };
  }
  if ($('cqAddTrans')) $('cqAddTrans').onclick = cqAddTranslation;
  if ($('cqSave')) $('cqSave').onclick = cqSave;
  if ($('cqReset')) $('cqReset').onclick = cqResetForm;
  // The 英文 field is filled from 原文 when the original IS English — the one case where asking
  // for the same string twice is pure friction. It only ever ADDS a value: a field the operator
  // has already typed into is never overwritten.
  if ($('cqText') && $('cqEn')) {
    $('cqText').addEventListener('input', function () {
      var t = String($('cqText').value || '').trim();
      var en = $('cqEn');
      if (!en.value && t && !/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) {
        en.value = t;
      }
    });
  }

  // §十八 — the host permission is `optional_host_permissions`, so it must be requested from a
  // user gesture. This click is that gesture; without it the fetch fails as a bare network error
  // with nothing in the UI to explain why.
  if ($('setLlmTest')) {
    $('setLlmTest').onclick = async function () {
      var btn = $('setLlmTest');
      btn.disabled = true;
      try {
        var cfg = llmCfg();
        if (!cfg.apiKey) { alert(T('viewer|请先填写 API Key。')); return; }
        var granted = await GMLLM.hasHostPermission(cfg.endpoint);
        if (!granted) granted = await GMLLM.requestHostPermission(cfg.endpoint);
        if (!granted) { alert(T('viewer|未授予访问该 Endpoint 的权限，无法调用。')); return; }
        var out = await GMLLM.call('Reply with the single word: ok', { maxTokens: 8 });
        alert(T('viewer|连接成功：{t}', { t: String(out).trim().slice(0, 80) || '（空）' }));
      } catch (e) {
        alert(T('viewer|连接失败：{t}', { t: GMI18n.trError(String((e && e.message) || e)) }));
      } finally {
        btn.disabled = false;
        refreshLlmUsage();
      }
    };
  }
  if ($('setLlmReset')) {
    $('setLlmReset').onclick = function () {
      GMLLM.resetUsage().then(function () { refreshLlmUsage(); flashSaved(); });
    };
  }

  $('setClearArchives').onclick = async function () {
    var list = await G.loadArchives();
    if (!list.length) { alert(T('viewer|没有存档。')); return; }
    if (!confirm(T('viewer|将删除全部 {n} 条存档（设置不受影响），确定吗？', { n: list.length }))) return;
    for (var i = 0; i < list.length; i++) await G.deleteArchive(list[i].id);
    await renderSettings();
    setStatus(T('viewer|存档已清空'));
  };

  // =====================================================================
  // 0.5.6 §一 导入与导出
  // =====================================================================
  // Nine categories, two directions. The list lives in ONE place (ioCats()) and both the export
  // grid and the import dialog are built from it; a second copy is exactly how the two grids
  // would start to disagree about which categories exist.
  //
  // ⚠ §1.3's ASCII sketch ticks only the first four boxes, while §1.3's own interaction rule says
  // 「默认全选除『背景图片』以外的类别」. A sketch is a layout drawing and the rule is an explicit
  // requirement, so the RULE is implemented and this is the note. The rule is also the safer
  // default: a backup that silently omits 学习参数 or 列折叠偏好 looks complete and is not.
  function ioCats() {
    return [
      { key: 'settings',        label: T('viewer|设置（不含 API Key）') },
      { key: 'blacklist',       label: T('viewer|黑名单') },
      { key: 'samples',         label: T('viewer|样本库') },
      { key: 'archives',        label: T('viewer|回放存档') },
      { key: 'customQuestions', label: T('viewer|自定义问题') },
      { key: 'customEngines',   label: T('viewer|自定义引擎（不含模型文件）') },
      { key: 'learnedParams',   label: T('viewer|学习参数') },
      { key: 'backgrounds',     label: T('viewer|背景图片') },
      { key: 'viewerCols',      label: T('viewer|列折叠偏好') },
    ];
  }
  // The one category that starts UNCHECKED (§1.3.1): it is the only one whose file can be
  // megabytes (the images ride as base64), and an operator who wants it will say so.
  var IO_OFF_BY_DEFAULT = 'backgrounds';

  var ioChecked = null;
  function ioDefaultChecked() {
    var d = {};
    ioCats().forEach(function (c) { d[c.key] = c.key !== IO_OFF_BY_DEFAULT; });
    return d;
  }
  function ioEnsureChecked() {
    if (!ioChecked) ioChecked = ioDefaultChecked();
    return ioChecked;
  }
  function ioSelected() {
    ioEnsureChecked();
    return ioCats().filter(function (c) { return ioChecked[c.key]; })
      .map(function (c) { return c.key; });
  }
  function setIoStatus(id, text) {
    var el = $(id);
    if (el) el.textContent = text || '';
  }

  // Every label is written here rather than in viewer.html, so the whole panel follows a
  // language switch through one function — the same rule 透明度 and 存储过滤 follow. Rebuilt,
  // never re-initialised: the operator's ticks survive a repaint.
  function buildIoPanel() {
    var boxes = ioEnsureChecked();
    setTxt('ioTitle', T('viewer|导入与导出'));
    setTxt('ioExportTitle', T('viewer|导出自定义数据'));
    setTxt('ioImportTitle', T('viewer|导入自定义数据'));
    setTxt('ioAll', T('viewer|全选'));
    setTxt('ioNone', T('viewer|全不选'));
    setTxt('ioExport', T('viewer|导出为 JSON'));
    setTxt('ioPick', T('viewer|选择文件'));
    var host = $('ioCats');
    if (!host) return;
    host.innerHTML = ioCats().map(function (c) {
      return '<label><input type="checkbox" data-io-cat="' + esc(c.key) + '"' +
        (boxes[c.key] ? ' checked' : '') + '><span>' + esc(c.label) + '</span></label>';
    }).join('');
  }

  // ---- 导出 ----
  // Beijing wall-clock stamp for the filename (§1.3.3). Built with the UTC getters on a +8h
  // shifted timestamp, so it is the operator's own clock whatever the machine's zone is — the
  // same reasoning `storage.beijingTime` follows for display, and the reason `toISOString()`
  // cannot be used here (it would answer in UTC and disagree with every time in the archive list).
  function ioStamp(ts) {
    var d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
      '-' + p(d.getUTCHours()) + p(d.getUTCMinutes());
  }

  async function ioExport() {
    var cats = ioSelected();
    if (!cats.length) { setIoStatus('ioExportStatus', T('viewer|请至少选择一个类别')); return; }
    setIoStatus('ioExportStatus', T('viewer|正在导出…'));
    try {
      var env = await G.exportCustomData(cats);
      var name = 'baishen-backup-' + ioStamp(env.exportedAt) + '.json';
      download(name, JSON.stringify(env, null, 2), 'application/json');
      setIoStatus('ioExportStatus', T('viewer|已导出：{name}', { name: name }));
    } catch (e) {
      setIoStatus('ioExportStatus',
        T('viewer|导出失败：{err}', { err: GMI18n.trError(String((e && e.message) || e)) }));
    }
  }

  // ---- 导入 ----
  // Step 1 of §1.5: read the file, check its kind, then ASK. Nothing is written until 导入 is
  // pressed, and the checkbox list is the FILE's own contents (§1.5.2) rather than the export
  // grid's defaults — importing is not the reverse of exporting, it is a decision.
  function ioPickFile() {
    var el = $('ioFile');
    // Cleared first: without this, picking the SAME file twice fires no `change` event and the
    // second attempt looks like a dead control.
    if (el) { el.value = ''; el.click(); }
  }

  async function ioHandleFile(file) {
    if (!file) return;
    setIoStatus('ioImportStatus', T('viewer|正在读取文件…'));
    var env = null;
    try {
      // `Blob.text()` is on every Chromium this extension supports (min 109) — no FileReader
      // needed here. The one FileReader left in the product is inside storage.js, converting the
      // other direction (Blob → data URL) for the background images.
      env = JSON.parse(await file.text());
    } catch (e) {
      setIoStatus('ioImportStatus', T('viewer|导入失败：{err}', { err: T('viewer|文件不是有效的 JSON') }));
      return;
    }
    if (!env || env.kind !== G.BACKUP_KIND) {
      setIoStatus('ioImportStatus', T('viewer|这个文件不是白身备份（缺少 kind 标记）'));
      return;
    }
    setIoStatus('ioImportStatus', '');
    ioShowImportDialog(env);
  }

  // §1.4 — a file from a NEWER build may carry settings this one has never heard of. That is a
  // warning, not a refusal: the categories it does understand still import.
  function ioVersionWarn(env) {
    var mine = localVersion();
    var theirs = String((env && env.appVersion) || '');
    if (!theirs || !mine) return '';
    // Numeric-part comparison, not a string one: '0.10.0' > '0.9.0' numerically and the reverse
    // lexically, which is the one way this could warn in the wrong direction.
    var num = function (v) {
      return String(v).split('.').map(function (x) { return parseInt(x, 10) || 0; });
    };
    var a = num(theirs), b = num(mine);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) > (b[i] || 0)) {
        return T('viewer|此备份来自更高版本 {v}，可能无法完整恢复', { v: theirs });
      }
      if ((a[i] || 0) < (b[i] || 0)) return '';
    }
    return '';
  }

  // The import dialog's label for each MERGING category is a complete sentence with its unit
  // inside it rather than a number glued to a unit word. Two reasons: 条 / 个 / 局 are not the
  // same word everywhere, and a separate `（{n} 局）` row already exists for the archive list
  // whose English is " ({n} games)" — reusing it here would print "Saved games (42 games)".
  function ioDialogLabel(cat, n) {
    switch (cat) {
      case 'blacklist': return T('viewer|黑名单（{n} 条）', { n: n });
      case 'customQuestions': return T('viewer|自定义问题（{n} 条）', { n: n });
      case 'samples': return T('viewer|样本库（{n} 个）', { n: n });
      case 'customEngines': return T('viewer|自定义引擎（{n} 个）', { n: n });
      case 'archives': return T('viewer|回放存档（{n} 局）', { n: n });
    }
    return '';
  }
  function ioCountOf(cat, data) {
    var v = data && data[cat];
    return Array.isArray(v) ? v.length : null;
  }
  // Only the categories the FILE carries, in the panel's order. One the file omits is not
  // offered: a checkbox for a category that is not in the file could only ever be a no-op.
  function ioPresentCats(env) {
    var data = (env && env.data) || {};
    return ioCats().filter(function (c) {
      return Object.prototype.hasOwnProperty.call(data, c.key);
    });
  }
  function ioCatTitle(cat) {
    var hit = ioCats().filter(function (c) { return c.key === cat; })[0];
    return hit ? hit.label : cat;
  }

  function ioShowImportDialog(env) {
    var cats = ioPresentCats(env);
    var data = env.data || {};
    var warn = ioVersionWarn(env);
    var html = '';
    if (warn) html += '<div class="r warn">⚠ ' + esc(warn) + '</div>';
    if (!cats.length) {
      html += '<div class="r warn">⚠ ' + esc(T('viewer|这个备份里没有任何可导入的类别')) + '</div>';
    } else {
      html += '<ul class="io-sel" id="ioSelList">';
      cats.forEach(function (c) {
        var n = ioCountOf(c.key, data);
        // The count is only shown where the file carries a countable list; a label with a
        // fabricated "（0）" for an object-valued category would be a number nobody asked for.
        var text = (n == null) ? c.label : ioDialogLabel(c.key, n);
        html += '<li><label><input type="checkbox" data-io-cat="' + esc(c.key) + '" checked>' +
          '<span>' + esc(text) + '</span></label></li>';
      });
      html += '</ul>';
      html += '<div class="hint" style="margin-top:10px">' +
        esc(T('viewer|每项右侧括号内是文件中的数量；合并类（黑名单、样本、回放）为追加导入，不覆盖现有数据。')) +
        '</div>';
      html += '<div class="btn-row" style="margin-top:12px">' +
        '<button class="sec p" id="ioDoImport">' + esc(T('viewer|确认导入')) + '</button></div>';
    }
    openModal(T('viewer|选择要导入的类别'), html, function (bd) {
      var btn = bd.querySelector('#ioDoImport');
      if (btn) btn.onclick = function () { ioRunImport(env, bd, cats); };
    });
  }

  async function ioRunImport(env, bd, cats) {
    var chosen = [];
    cats.forEach(function (c) {
      var box = bd.querySelector('input[data-io-cat="' + c.key + '"]');
      if (box && box.checked) chosen.push(c.key);
    });
    if (!chosen.length) {
      // The dialog stays open: unchecking everything is a question, not a cancellation.
      var note = bd.querySelector('.io-pick-none');
      if (!note) {
        note = document.createElement('div');
        note.className = 'r warn io-pick-none';
        var btn0 = bd.querySelector('#ioDoImport');
        if (btn0 && btn0.parentNode) btn0.parentNode.insertBefore(note, btn0);
      }
      note.textContent = '⚠ ' + T('viewer|请至少选择一个类别');
      return;
    }
    var btn = bd.querySelector('#ioDoImport');
    if (btn) btn.disabled = true;
    try {
      var res = await G.importCustomData(env, chosen);
      if (!res.ok) {
        bd.innerHTML = '<div class="r warn">⚠ ' +
          esc(T('viewer|导入失败：{err}', { err: String(res.error || '') })) + '</div>';
        return;
      }
      // Everything a category can change is re-read and the page repainted BEFORE the report is
      // written, because the repaint replaces the panels the report would otherwise sit under —
      // and because "the settings page now shows what was imported" is the thing being checked.
      await syncAfterImport();
      // The report replaces the dialog's body rather than closing it: §1.5 step 7 is the outcome
      // of the action the operator just took, and it belongs where they are standing.
      bd.innerHTML = ioReportHtml(res.report);
    } catch (e) {
      bd.innerHTML = '<div class="r warn">⚠ ' +
        esc(T('viewer|导入失败：{err}', { err: GMI18n.trError(String((e && e.message) || e)) })) + '</div>';
    }
  }

  // A category's line in the report, in that category's own unit. A category with no line has
  // nothing to say (there is no zero to print for something that was never attempted).
  function ioAddedText(cat, r) {
    switch (cat) {
      case 'blacklist':
      case 'customQuestions':
        return T('viewer|{n} 条新增，{m} 条跳过', { n: r.added || 0, m: r.skipped || 0 });
      case 'samples':
        return T('viewer|{n} 个新增，{m} 个跳过', { n: r.added || 0, m: r.skipped || 0 });
      case 'archives':
        return T('viewer|{n} 局新增，{m} 局跳过', { n: r.added || 0, m: r.skipped || 0 });
    }
    return '';
  }
  function ioQuote(v) {
    if (v == null) return '—';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }
  // §1.6.4 — every refusal says both numbers: what the file asked for and what is still in
  // force. The sentence is chosen by the REASON code the validator produced, so the wording and
  // the rule can never drift apart.
  function ioReasonText(err) {
    var v = ioQuote(err.value), kept = ioQuote(err.kept);
    switch (err.reason) {
      case 'exceeds-device':
        return T('viewer|导入值 {v} 超过本机支持的 {cap} 线程，已保持原值 {kept}',
          { v: v, cap: G.detectedThreads(), kept: kept });
      case 'out-of-range':
        return T('viewer|导入值 {v} 超出允许范围，已保持原值 {kept}', { v: v, kept: kept });
      // 0.5.6 补增 §三 — the one refusal that is about a TABLE rather than about a value, so it
      // gets a sentence that names the ceiling instead of the generic 「不是有效取值」.
      case 'over-budget':
        return T('viewer|导入的权重合计超过 {cap}% 上限，已保持原值 {kept}',
          { cap: Math.round(G.SIGNAL_WEIGHT_SUM_MAX * 100), kept: kept });
      case 'unsupported':
        return T('viewer|导入值 {v} 不是支持的语言，已保持原值 {kept}', { v: v, kept: kept });
      case 'engine-not-found':
        return T('viewer|导入的引擎 {v} 不存在，已回退到 {kept}', { v: v, kept: kept });
      default:
        return T('viewer|导入值 {v} 不是有效取值，已保持原值 {kept}', { v: v, kept: kept });
    }
  }
  function ioReportHtml(report) {
    var h = '<h4>' + esc(T('viewer|导入完成')) + '</h4>';
    (report || []).forEach(function (r) {
      var line = '';
      switch (r.cat) {
        case 'settings':
          line = T('viewer|设置：{ok} 项成功，{refused} 项退回', { ok: r.ok || 0, refused: r.refused || 0 });
          break;
        case 'blacklist': case 'samples': case 'archives': case 'customQuestions':
          line = ioAddedText(r.cat, r);
          break;
        case 'learnedParams': case 'viewerCols':
          line = T('viewer|已覆盖');
          break;
        case 'backgrounds':
          line = T('viewer|已导入 {n} 张背景图片', { n: r.restored || 0 });
          break;
        case 'customEngines':
          line = T('viewer|自定义引擎的模型文件不包含在备份中，请在新设备上重新上传（备份中记录了 {n} 个模型）',
            { n: r.listed || 0 });
          break;
      }
      if (!line) return;
      h += '<span class="r">' + esc(ioCatTitle(r.cat)) + '：' + esc(line) + '</span>';
      if (r.cat === 'settings' && r.errors && r.errors.length) {
        r.errors.forEach(function (e) {
          h += '<span class="sub warn">⚠ ' + esc(ioReasonText(e)) + '</span>';
        });
      }
    });
    if (h === '<h4>' + esc(T('viewer|导入完成')) + '</h4>') {
      h += '<span class="r">' + esc(T('viewer|没有导入任何内容')) + '</span>';
    }
    return h;
  }

  // Everything an imported category can change, re-read and repainted in one place. `repaintForLang`
  // is the right hammer here even though the language may not have changed: it is this file's
  // "rebuild every JS-built panel" path, and going through it means an import cannot leave one
  // panel showing a stale value that the next language switch would then fix.
  async function syncAfterImport() {
    S = await G.loadSettings();
    applyLang(S.lang);
    applyTheme(S.theme);
    applyTransparency(S.transparency);
    // 0.5.3 §3.2 — colPrefs is a second reader of chrome.storage that does not go through
    // settings at all, so an imported `viewerCols` is invisible until it is reloaded.
    await loadColPrefs();
    applyColPrefs();
    await refreshCustomRegistry();
    repaintForLang();
    await applyViewerBg();
  }

  if ($('ioAll')) $('ioAll').onclick = function () { ioEnsureChecked(); ioCats().forEach(function (c) { ioChecked[c.key] = true; }); buildIoPanel(); };
  if ($('ioNone')) $('ioNone').onclick = function () { ioEnsureChecked(); ioCats().forEach(function (c) { ioChecked[c.key] = false; }); buildIoPanel(); };
  if ($('ioExport')) $('ioExport').onclick = ioExport;
  if ($('ioPick')) $('ioPick').onclick = ioPickFile;
  if ($('ioFile')) {
    $('ioFile').addEventListener('change', function (ev) {
      var f = (ev.target && ev.target.files) ? ev.target.files[0] : null;
      ioHandleFile(f);
    });
  }
  // Delegated: buildIoPanel replaces the grid's whole innerHTML on every repaint (and on every
  // language switch), so a per-box handler would be attached to nodes that no longer exist — the
  // same reason the custom-model and custom-question lists delegate.
  if ($('ioCats')) {
    $('ioCats').addEventListener('change', function (ev) {
      var box = ev.target && ev.target.closest ? ev.target.closest('input[data-io-cat]') : null;
      if (!box) return;
      ioEnsureChecked();
      ioChecked[box.getAttribute('data-io-cat')] = !!box.checked;
    });
  }

  // =====================================================================
  // 1.0.0 云账户、我的、管理员 (§一–§九)
  // =====================================================================
  // The client half of §十四's 「云账号 + 激活码 + 管理员」. Everything here is written to be
  // correct in the SHIPPED state — no backend (`GMCloud.isConfigured() === false`) — because that
  // is what §1.2 promises a 0.5.x operator: 「不破坏已有用户的本地使用」. Nothing in this block can
  // stop the detector from working, and nothing in it paints a broken control.
  //
  // One rule shapes the whole block: `GMAuth.status()` is SYNCHRONOUS (it reads the memoised
  // session), so every renderer here is a pure function of the state in hand and can be called
  // from `repaintForLang()` — which is synchronous by contract. Only the two network readers
  // (`adminLoadUsers`, `profileLoad`) are async, and they paint when their answer arrives.

  // §9.3 — the hosted policy page. The default is this repository's own GitHub Pages address
  // (Settings → Pages → branch `main`, folder `/docs` → `https://<user>.github.io/<repo>/privacy.html`),
  // which is the one hosting option that needs no third party. An operator who prefers their own
  // domain changes this one string; if they clear it, the 关于 panel prints 「尚未提供」 instead of
  // drawing a dead link, which is the honest render while the address is still unknown (§十三).
  var PRIVACY_URL = 'https://aodojust.github.io/gomoku-anti-cheat-detector/privacy.html';

  // §7.2's rows, labelled. The SET of categories comes from `GMSync.CATS` — the sync engine's own
  // table — and this function only supplies words, so a category can never exist in one list and
  // not the other. It is a literal SWITCH rather than `T('viewer|' + nameMap[k])` on purpose: the
  // dictionary toolchain only sees literal keys (`keys.cjs` scans source text), so a concatenated
  // lookup is invisible to it and the labels would silently stay Chinese in every other language —
  // the exact trap `_tools/i18n-extra.js` was created for. Reading each key out literally keeps the
  // eight auto-extractable and needs no second registration. An unknown key falls through to the
  // raw category name, which is a visible degradation rather than a wrong translation.
  function cloudCatLabel(k) {
    switch (k) {
      case 'samples': return T('viewer|样本库');
      case 'archives': return T('viewer|回放存档');
      case 'blacklist': return T('viewer|黑名单');
      case 'settings': return T('viewer|设置');
      case 'customQuestions': return T('viewer|自定义问题');
      case 'learnedParams': return T('viewer|学习参数');
      case 'customEngines': return T('viewer|自定义引擎');
      case 'backgrounds': return T('viewer|背景图片');
    }
    return k;
  }

  // =====================================================================
  // 社区 (1.0.2 二)
  // =====================================================================
  // §2.2's page: 聊天室 / 新闻 / Bug与建议 behind a three-item secondary nav. Everything that talks
  // to the server lives in community.js and returns FACTS; every word lives here, because
  // `_tools/keys.cjs` inventories `T('…')` literals in THIS file and not in that one — see the
  // header of community.js for why that split is the i18n rule and not just tidiness.

  /** Which secondary tab is open. `'chat'` because §2.2 lists it first. */
  var CM_TAB = 'chat';
  /** The room's rows, ascending by `created_at`, and the one de-duplicator that fills them. */
  var cmRows = [];
  var cmSeen = {};
  var cmNews = null;          // null = never arrived; [] = arrived and empty
  var cmNewsFilter = '';      // '' = §2.4.4's 「全部」
  var cmNewsOpen = {};        // id -> true, the cards showing their full text
  var cmFb = null;
  var cmNewsMsg = null;
  var cmFbMsg = null;
  var cmChatMsg = null;
  var cmFbBusy = false;
  var cmBooted = false;

  /** §2.4.4's preview cut. ONE number, used both to decide whether 「阅读全文」 is offered and to
   *  cut the text it reveals — two literals here would be a button that opens a card showing
   *  exactly what was already on screen. */
  var CM_PREVIEW = 120;

  /**
   * A database code as a label.
   *
   * §2.4.2 / §2.5.2's `category` / `status` columns hold VALUES, not display text, so the label is
   * a semantic key (`cm.cat.bug`) rather than a source-text key. Those keys are registered in
   * `locale/zh-CN.js` AND `_tools/i18n-extra.js`: `keys.cjs` learns the KEY from the first and the
   * Chinese text it translates FROM the second, and registering only one of the two is how a table
   * ends up without a row for a key that is on screen the whole time.
   *
   * ⚠ A code the tables do not know prints AS ITSELF. `t()` answers an unknown key with the key, so
   * without this guard a status added to the database later would render 「cm.st.foo」 — a string no
   * operator can act on. The raw value at least names the thing.
   */
  function cmNamed(prefix, code) {
    var raw = String(code == null ? '' : code);
    var k = prefix + raw;
    var s = T(k);
    return s === k ? raw : s;
  }
  function cmCat(code) { return cmNamed('cm.cat.', code); }
  function cmStatus(code) { return cmNamed('cm.st.', code); }
  function cmNewsCatLabel(code) { return cmNamed('cm.newscat.', code); }

  /**
   * §2.3.5's connection state, as words.
   *
   * A `switch` of literal `T('…')` calls rather than a lookup table, and it has to be: `keys.cjs`
   * only sees an argument that is a quoted literal, so four keys held in a table would be four keys
   * that never reach the twelve generated tables — and the room's own status line would stay
   * Chinese in every language while looking perfectly fine in this file.
   */
  function cmStateText(s) {
    switch (s) {
      case 'connecting': return T('community|连接中…');
      case 'live': return T('community|实时');
      case 'polling': return T('community|轮询刷新');
    }
    return T('community|未连接');
  }

  /**
   * A status line, held as a DESCRIPTOR (`{code, err, tone, …}`) rather than as prose.
   *
   * Two reasons, and the second is the one that has already cost this project: a language switch
   * has to re-word every line on screen (0.3.6 §1.8), and an ERROR is only a CODE until the moment
   * it is printed — resolving it at paint time through `cloudErrText` keeps the one error vocabulary
   * in charge instead of freezing today's wording into a stored string.
   *
   * ⚠ `code` is a short name and NOT the i18n key, and that is deliberate. `_tools/keys.cjs`
   * inventories a translation by finding a quoted literal inside a `T('…')` call — so a key stored
   * in a descriptor (`{key: 'community|加载中…'}`) is invisible to it, gets no row in any of the
   * twelve generated tables, and prints CHINESE in all of them while nothing anywhere reports it.
   * A `switch` of literal `T('…')` calls is the shape this file already uses for `cloudErrText`,
   * `cmStateText` and `stopReason`, for exactly this reason.
   */
  function cmMsgText(m) {
    if (!m) return '';
    var err = m.err ? cloudErrText(m.err) : '';
    switch (m.code) {
      case 'loading': return T('community|加载中…');
      case 'loadFailed': return T('community|加载失败（{err}）', { err: err });
      case 'sendFailed': return T('community|发送失败（{err}）', { err: err });
      case 'submitFailed': return T('community|提交失败（{err}）', { err: err });
      case 'submitted': return T('community|已提交，管理员会尽快处理。');
      case 'tooLong': return T('community|单条最多 {n} 个字符。', { n: m.n });
      case 'tooLongForm': return T('community|超出长度上限，请精简后重试。');
      case 'censorChat': return T('community|内容包含敏感词：{word}', { word: m.word });
      case 'censorForm': return T('community|提交内容包含敏感词：{word}', { word: m.word });
      case 'rateChat': return T('community|发送太频繁，请稍后再试（每分钟最多 {n} 条）', { n: m.n });
      case 'pickCat': return T('community|请选择类型。');
      case 'needTitleBody': return T('community|标题和内容都不能为空。');
    }
    return '';
  }

  function cmSetMsg(el, m) {
    if (!el) return;
    el.textContent = cmMsgText(m);
    el.style.color = m && m.tone === 'err' ? 'var(--red)'
      : (m && m.tone === 'ok' ? 'var(--green)' : '');
  }

  function cmPaintChatMsg() { cmSetMsg($('cmChatNote'), cmChatMsg); }
  function cmPaintNewsMsg() { cmSetMsg($('cmNewsState'), cmNewsMsg); }
  function cmPaintFbMsg() { cmSetMsg($('cmFbState'), cmFbMsg); }

  function cmPaintContactHint() {
    var el = $('cmFbContactHint');
    if (el) el.textContent = T('community|这里填的只是备注；回复会发到你的账号邮箱。');
  }

  function cmPaintState(s) {
    var el = $('cmChatState');
    if (el) el.textContent = cmStateText(s || (GMCommunity.chat && GMCommunity.chat.state()));
  }

  function cmPaintLen() {
    var i = $('cmChatInput'), el = $('cmChatLen');
    if (!i || !el) return;
    var S = GMCommunity.shared() || {};
    var max = S.CHAT_MAX_LEN || 0;
    var n = String(i.value || '').length;
    el.textContent = n + '/' + max;
    el.style.color = n > max ? 'var(--red)' : '';
  }

  function cmPaintHint() {
    var el = $('cmChatHint');
    if (!el) return;
    var S = GMCommunity.shared() || {};
    el.textContent = T('community|全部已激活用户共用一个公共聊天室；消息保留 {days} 天，每分钟最多 {rate} 条，单条不超过 {len} 字符。',
      { days: S.CHAT_RETENTION_DAYS, rate: S.CHAT_RATE_MAX, len: S.CHAT_MAX_LEN });
  }

  function cmUid() {
    var s = GMAuth.session && GMAuth.session();
    return (s && s.user && s.user.id) || '';
  }

  // 0.5.1 asked for the same fallback in `renderNavUser`: a broken `<img>` is worse than a letter.
  // ⚠ The scheme test is the point, not the `img` tag — `data:text/html` and `javascript:` are
  // refused by SCHEME rather than by hoping the browser treats them as a broken picture.
  var CM_IMG_RE = /^(data:image\/(png|jpe?g|webp|gif);base64,|https?:\/\/)/i;

  function cmAvatarHtml(url, name) {
    if (typeof url === 'string' && CM_IMG_RE.test(url)) {
      return '<img src="' + esc(url) + '" alt="">';
    }
    return esc(String(name || '—').slice(0, 1).toUpperCase());
  }

  function cmMsgHtml(row) {
    var S = GMCommunity.shared() || {};
    var name = row.username || '—';
    var when = S.chatClock ? S.chatClock(row.created_at) : '';
    return '<div class="cm-msg' + (row.user_id && row.user_id === cmUid() ? ' me' : '') + '">' +
      '<div class="cm-av">' + cmAvatarHtml(row.avatar_url, name) + '</div>' +
      '<div class="cm-txt">' +
        '<div class="cm-who">' + esc(name) + (when ? ' · ' + esc(when) : '') + '</div>' +
        '<div class="cm-bub">' + esc(row.content) + '</div>' +
      '</div></div>';
  }

  function cmPaintChat() {
    var log = $('cmChatLog');
    if (!log) return;
    // Stick to the bottom only when the reader was already there. A room that jumps to its newest
    // line while someone is scrolling back is a room whose history cannot be read.
    var stick = (log.scrollTop + log.clientHeight) >= (log.scrollHeight - 24);
    log.innerHTML = cmRows.length
      ? cmRows.map(cmMsgHtml).join('')
      : '<div class="cm-empty">' + esc(T('community|还没有消息，来说第一句吧。')) + '</div>';
    if (stick) log.scrollTop = log.scrollHeight;
    var c = $('cmChatCount');
    if (c) c.textContent = T('community|{n} 条消息', { n: cmRows.length });
  }

  /**
   * One row in, from wherever it came.
   *
   * De-duplication by `id` is not decoration: the socket is opened BEFORE the scrollback is asked
   * for (an insert during the load would otherwise be missed by both halves), our own send is drawn
   * immediately AND pushed back, and a reconnect re-delivers the page. Three ordinary paths, one
   * message each.
   */
  function cmPush(row) {
    if (!row || typeof row.id !== 'string' || cmSeen[row.id]) return;
    cmSeen[row.id] = true;
    cmRows.push(row);
    // Sorted on insert rather than trusting arrival order: the live socket and the scrollback
    // interleave, and a message drawn above the one it answered is a conversation that reads wrong.
    cmRows.sort(function (a, b) {
      var x = String(a.created_at || ''), y = String(b.created_at || '');
      return x < y ? -1 : (x > y ? 1 : 0);
    });
    cmPaintChat();
  }

  /**
   * §2.3's send, behind §2.3.5's CLIENT half of the filter.
   *
   * Not decoration either: §2.3.5 says 「客户端 + 服务端双重」, and the client half is what turns a
   * refusal into a sentence about the operator's own text instead of a 400 they waited for. The
   * server half is what actually holds — this is a plain script in an extension directory and
   * anyone can edit it.
   */
  function cmSend() {
    var i = $('cmChatInput');
    if (!i) return;
    var text = String(i.value || '');
    if (!text.trim()) return;
    var S = GMCommunity.shared() || {};
    if (text.length > (S.CHAT_MAX_LEN || 0)) {
      cmChatMsg = { code: 'tooLong', n: S.CHAT_MAX_LEN, tone: 'err' };
      cmPaintChatMsg();
      return;
    }
    var hit = S.censorHit ? S.censorHit(text) : null;
    if (hit) {
      cmChatMsg = { code: 'censorChat', word: hit, tone: 'err' };
      cmPaintChatMsg();
      return;
    }

    var btn = $('cmChatSend');
    if (btn) btn.disabled = true;
    cmChatMsg = null;
    cmPaintChatMsg();
    GMCommunity.chat.send(text).then(function (r) {
      if (btn) btn.disabled = false;
      if (!r || !r.ok) {
        // ⚠ RATE_LIMITED is NOT handed to `cloudErrText`. That shared vocabulary words this code as
        // 「发送过于频繁，请 60 秒后再试」 — the EMAIL-VERIFICATION window, which is a different
        // answer to a different question. §2.3.5's window is 「每分钟最多 10 条」, and a chat room
        // that tells the operator to wait a minute when the wait is seconds is worse than no
        // sentence at all. One code, two windows, so the sentence is chosen by the caller.
        cmChatMsg = (r && r.error === 'RATE_LIMITED')
          ? { code: 'rateChat', n: S.CHAT_RATE_MAX, tone: 'err' }
          : { code: 'sendFailed', err: (r && r.error) || 'INTERNAL', tone: 'err' };
        cmPaintChatMsg();
        return;
      }
      i.value = '';
      cmPaintLen();
      // Drawn from the reply rather than waiting for the push: this operator's own message is the
      // one they are watching for, and a room that needs a Realtime round trip to show it looks
      // broken on a slow socket. The push for the same row arrives later and `cmPush` drops it.
      if (r.row) cmPush(r.row);
    });
  }

  function cmPaintNews() {
    var box = $('cmNewsList');
    if (!box) return;
    var rows = (cmNews || []).filter(function (r) {
      return !cmNewsFilter || r.category === cmNewsFilter;
    });
    if (!rows.length) {
      box.innerHTML = '<div class="cm-empty">' + esc(T('community|暂无新闻。')) + '</div>';
      return;
    }
    box.innerHTML = rows.map(cmNewsHtml).join('');
  }

  function cmNewsHtml(row) {
    var S = GMCommunity.shared() || {};
    var pick = S.newsText ? S.newsText(row, LANG)
      : { title: row.title, content: row.content, lang: row.lang, translated: false };
    var open = !!cmNewsOpen[row.id];
    var long = String(pick.content || '').replace(/\s+/g, ' ').trim().length > CM_PREVIEW;
    var body = (open || !long) ? pick.content : S.previewLine(pick.content, CM_PREVIEW);

    var meta = [String(row.published_at || '').slice(0, 10), cmNewsCatLabel(row.category)];
    // §2.4.4 「无对应翻译时显示原文」 — and SAYS so. A card labelled with the language it asked for
    // but did not get is worse than one labelled plainly, which is why `newsText` reports which of
    // the two it returned rather than only the text.
    if (!pick.translated && pick.lang && pick.lang !== LANG) {
      meta.push(T('community|原文（{lang}）', { lang: pick.lang }));
    }
    // Two separate literal calls, not `T(open ? 'a' : 'b')`: `keys.cjs` only inventories a quoted
    // literal inside the call, so a conditional would drop both keys from all twelve tables.
    var btn = open ? T('community|收起') : T('community|阅读全文');

    return '<div class="cm-item">' +
      '<div class="cm-head">' +
        (row.is_pinned ? '<span class="cm-chip">📌</span>' : '') +
        '<span class="cm-title">' + esc(pick.title) + '</span>' +
        '<span class="cm-meta">' + esc(meta.join(' · ')) + '</span>' +
      '</div>' +
      '<div class="cm-body-txt">' + esc(body) + '</div>' +
      (long ? '<div class="btn-row" style="margin-top:8px">' +
        '<button class="sec" data-cm-open="' + esc(row.id) + '">' + esc(btn) + '</button></div>' : '') +
      '</div>';
  }

  function cmPaintFeedback() {
    var box = $('cmFbList');
    if (!box) return;
    var rows = cmFb || [];
    if (!rows.length) {
      box.innerHTML = '<div class="cm-empty">' + esc(T('community|还没有提交记录。')) + '</div>';
      return;
    }
    box.innerHTML = rows.map(cmFbHtml).join('');
  }

  function cmFbHtml(row) {
    var S = GMCommunity.shared() || {};
    return '<div class="cm-item">' +
      '<div class="cm-head">' +
        '<span class="cm-chip">' + esc(cmCat(row.category)) + '</span>' +
        '<span class="cm-title">' + esc(row.title) + '</span>' +
        '<span class="cm-meta">' + esc(String(row.created_at || '').slice(0, 10)) + '</span>' +
        '<span class="cm-chip">' + esc(cmStatus(row.status)) + '</span>' +
      '</div>' +
      '<div class="cm-body-txt">' +
        esc(S.previewLine ? S.previewLine(row.content, 200) : row.content) + '</div>' +
      // §2.5.1's 「管理员可回复」 has to end somewhere the submitter can see, and §2.5.5's list is
      // the only page they own — so the reply is drawn WITH the report rather than only mailed.
      (row.admin_reply
        ? '<div class="cm-reply"><div class="cm-who">' + esc(T('community|管理员回复')) +
          '</div>' + esc(row.admin_reply) + '</div>'
        : '') +
      '</div>';
  }

  function cmPaintNewsFilter() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-cmcat]'), function (b) {
      b.classList.toggle('on', (b.getAttribute('data-cmcat') || '') === cmNewsFilter);
    });
  }

  function cmShowTab(name) {
    if (name !== 'chat' && name !== 'news' && name !== 'feedback') return;
    CM_TAB = name;
    Array.prototype.forEach.call(document.querySelectorAll('#cmNav .cm-tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-cm') === name);
    });
    // Scoped to this view: `.cm-pane` alone would also collect anything a future page happens to
    // name the same way, which is the shape of the 1.0.0 defect where `syncCats.backgrounds` (a
    // category) was mistaken for a field of the same name.
    Array.prototype.forEach.call(document.querySelectorAll('#view-community .cm-pane'), function (p) {
      p.classList.toggle('active', p.id === 'cmPane-' + name);
    });
  }

  /** §2.5.4's type options, from `FEEDBACK_CATEGORIES` rather than from markup: the server accepts
   *  exactly that set, and a hand-written <select> is a fourth list that can drift from it. */
  function buildFeedbackCats() {
    var sel = $('cmFbCat');
    if (!sel) return;
    var S = GMCommunity.shared() || {};
    var keep = sel.value || (S.FEEDBACK_CATEGORIES || [])[0] || '';
    sel.innerHTML = (S.FEEDBACK_CATEGORIES || []).map(function (c) {
      return '<option value="' + esc(c) + '">' + esc(cmCat(c)) + '</option>';
    }).join('');
    sel.value = keep;
  }

  function cmLoadNews() {
    if (!cmNews) {
      cmNewsMsg = { code: 'loading' };
      cmPaintNewsMsg();
    }
    GMCommunity.news.load().then(function (r) {
      if (!r || !r.ok) {
        cmNewsMsg = { code: 'loadFailed', err: (r && r.error) || 'INTERNAL', tone: 'err' };
        cmPaintNewsMsg();
        return;
      }
      cmNews = r.rows || [];
      cmNewsMsg = null;
      cmPaintNewsMsg();
      cmPaintNews();
    });
  }

  function cmLoadFeedback() {
    GMCommunity.feedback.mine().then(function (r) {
      if (!r || !r.ok) {
        cmFbMsg = { code: 'loadFailed', err: (r && r.error) || 'INTERNAL', tone: 'err' };
        cmPaintFbMsg();
        return;
      }
      // A successful read retires the READ's own message and nothing else. 「已提交」 is a verdict
      // about what the operator just did, and `cmFbSubmit` re-reads the list immediately after
      // setting it — clearing the line here would wipe the confirmation a millisecond after it
      // appeared.
      if (cmFbMsg && (cmFbMsg.code === 'loadFailed' || cmFbMsg.code === 'loading')) cmFbMsg = null;
      cmFb = r.rows || [];
      cmPaintFbMsg();
      cmPaintFeedback();
    });
  }

  function cmFbSubmit() {
    if (cmFbBusy) return;
    var S = GMCommunity.shared() || {};
    var cat = $('cmFbCat') ? $('cmFbCat').value : '';
    var title = String(($('cmFbTitle') || {}).value || '').trim();
    var body = String(($('cmFbBody') || {}).value || '').trim();
    var contact = String(($('cmFbContact') || {}).value || '').trim();

    // The three ceiling checks are the same numbers the `maxlength` attributes carry, so they can
    // only fire on a control that was edited in a console. They are here because the SERVER's answer
    // to an over-long field is a code, and a code rendered as a sentence about the operator's own
    // typing is a better first line than a round trip.
    if (!cat || (S.FEEDBACK_CATEGORIES || []).indexOf(cat) < 0) {
      cmFbMsg = { code: 'pickCat', tone: 'err' }; cmPaintFbMsg(); return;
    }
    if (!title || !body) {
      cmFbMsg = { code: 'needTitleBody', tone: 'err' }; cmPaintFbMsg(); return;
    }
    if (title.length > (S.FEEDBACK_TITLE_MAX || 0) || body.length > (S.FEEDBACK_CONTENT_MAX || 0)) {
      cmFbMsg = { code: 'tooLongForm', tone: 'err' }; cmPaintFbMsg(); return;
    }
    var hit = S.censorHit ? (S.censorHit(title) || S.censorHit(body)) : null;
    if (hit) {
      cmFbMsg = { code: 'censorForm', word: hit, tone: 'err' };
      cmPaintFbMsg();
      return;
    }

    cmFbBusy = true;
    var btn = $('cmFbSend');
    if (btn) btn.disabled = true;
    cmFbMsg = null;
    cmPaintFbMsg();
    GMCommunity.feedback.submit({ category: cat, title: title, content: body, contact: contact })
      .then(function (r) {
        cmFbBusy = false;
        if (btn) btn.disabled = false;
        if (!r || !r.ok) {
          cmFbMsg = { code: 'submitFailed', err: (r && r.error) || 'INTERNAL', tone: 'err' };
          cmPaintFbMsg();
          return;
        }
        cmFbMsg = { code: 'submitted', tone: 'ok' };
        cmPaintFbMsg();
        // The form is cleared and the list re-read rather than the returned row being appended: the
        // server's projection is deliberately not the row shape a LIST read returns (§2.5.5's
        // columns come from `feedback`, the reply's from `publicFeedback`), and building the list
        // from two shapes is how the two start disagreeing.
        if ($('cmFbTitle')) $('cmFbTitle').value = '';
        if ($('cmFbBody')) $('cmFbBody').value = '';
        if ($('cmFbContact')) $('cmFbContact').value = '';
        cmLoadFeedback();
      });
  }

  function cmPaintAll() {
    buildFeedbackCats();
    cmPaintHint();
    cmPaintLen();
    cmPaintState();
    cmPaintContactHint();
    cmPaintChatMsg();
    cmPaintNewsMsg();
    cmPaintFbMsg();
    cmPaintNewsFilter();
    cmPaintChat();
    cmPaintNews();
    cmPaintFeedback();
  }

  function cmBoot() {
    if (cmBooted) return;
    cmBooted = true;
    var S = GMCommunity.shared() || {};

    // §2.3.5's limits onto the controls, from the one definition. `maxlength` counts UTF-16 code
    // units, which is what the Edge Function counts — see the note in `_shared/community.ts`. A
    // `maxlength` typed here would be a ceiling that disagrees with the server's, i.e. a control
    // that lets through text it then refuses.
    [[$('cmChatInput'), S.CHAT_MAX_LEN],
     [$('cmFbTitle'), S.FEEDBACK_TITLE_MAX],
     [$('cmFbBody'), S.FEEDBACK_CONTENT_MAX],
     [$('cmFbContact'), S.FEEDBACK_CONTACT_MAX]
    ].forEach(function (c) { if (c[0] && c[1]) c[0].maxLength = c[1]; });

    // §2.2 — the three secondary tabs. `.cm-tab` is not `.navbtn`, so the top-level router's
    // `querySelectorAll('.navbtn')` never sees them and their `data-cm` can never be mistaken for a
    // view name.
    Array.prototype.forEach.call(document.querySelectorAll('#cmNav .cm-tab'), function (b) {
      b.onclick = function () { cmShowTab(b.getAttribute('data-cm')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-cmcat]'), function (b) {
      b.onclick = function () {
        cmNewsFilter = b.getAttribute('data-cmcat') || '';
        cmPaintNewsFilter();
        cmPaintNews();
      };
    });
    // Delegated, not per-button: §2.4.4's 「阅读全文」 is created with the card it belongs to, and
    // every card is rebuilt on a language switch — so a handler installed per button would have to
    // be reinstalled on every repaint, and the one repaint that forgot would be an inert button.
    var nl = $('cmNewsList');
    if (nl) nl.onclick = function (e) {
      var t = (e.target && e.target.closest) ? e.target.closest('[data-cm-open]') : null;
      if (!t) return;
      var id = t.getAttribute('data-cm-open');
      if (cmNewsOpen[id]) delete cmNewsOpen[id]; else cmNewsOpen[id] = true;
      cmPaintNews();
    };
    var send = $('cmChatSend');
    if (send) send.onclick = cmSend;
    var input = $('cmChatInput');
    if (input) {
      input.oninput = cmPaintLen;
      // Enter sends, Shift+Enter breaks the line. §2.3.6 draws a box one line tall with a 发送
      // button beside it; if Enter inserted a newline there would be no keyboard way to send.
      input.onkeydown = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cmSend(); }
      };
    }
    if ($('cmFbSend')) $('cmFbSend').onclick = cmFbSubmit;
    if ($('cmFbReload')) $('cmFbReload').onclick = cmLoadFeedback;
    cmShowTab(CM_TAB);
  }

  /**
   * The community view's entry point, in the shape the other views use.
   *
   * `repaint` (0.5.1's convention — see `showView`) means 「the operator changed the language」: the
   * rows already in hand are re-worded and NOTHING is asked of the network. Without it the view is
   * being ENTERED, so the room's socket reopens and both lists are re-fetched — a chat room that
   * only reconnected when the page did would be a room you cannot rejoin after a glance at 回放.
   */
  function refreshCommunity(repaint) {
    cmBoot();
    cmPaintAll();
    if (repaint) return;
    GMCommunity.chat.subscribe({ onRow: cmPush, onState: cmPaintState });
    cmLoadNews();
    cmLoadFeedback();
  }

  /** Leaving closes the socket. The rows stay in `cmRows`, so coming back paints the conversation
   *  immediately and the fresh page is de-duplicated into it rather than replacing it. */
  function cmLeave() {
    if (GMCommunity && GMCommunity.chat) GMCommunity.chat.unsubscribe();
  }

  /**
   * Which view is ON SCREEN, as a name. Read from the `.view` element that is marked `active`
   * rather than from `.navbtn.active`.
   *
   * ⚠ 1.0.1 is why this matters. 主页 and 账号设置 are reached through §3.2's drawer and have NO nav
   * button at all, so a nav-button answer is not "the current view" once the operator has opened
   * one: after `showView('profile')` every nav button is un-highlighted, and a nav-derived answer
   * collapses to the 'detect' default. `applyActivationGate` uses this to decide whether the current
   * view is still reachable, so a 'detect' answer there meant 「log out while reading 主页」 left the
   * page rendering 主页 — the previous operator's name and sample count, from a session that had
   * just been discarded — with no tab highlighted. Found by `behave-062-cloud` B8, which logs out
   * from the drawer-only view for exactly this reason.
   *
   * ⚠ 1.0.2 adds the SECOND caller, `showView`, which asks it 「which view am I leaving?」 before it
   * moves the `.active` class. Both callers must therefore ask BEFORE that class changes; see the
   * warning at the call site. The claim in this paragraph used to read 「the one caller」, which is
   * the kind of sentence that turns a two-caller contract into a one-caller assumption.
   */
  function activeView() {
    var v = document.querySelector('.view.active');
    return v && v.id.indexOf('view-') === 0 ? v.id.slice('view-'.length) : 'detect';
  }

  /**
   * 1.0.1 §1.3 — the viewer's half of the activation gate, and the ONLY place the viewer applies it.
   *
   * Five surfaces, one predicate. §1.1's matrix and §1.3's sketch between them say:
   *   · 回放 / 样本库 / 黑名单 tabs — 「不显示」 for an unactivated operator
   *   · 设置页 — only 云账号与同步 / 语言与显示 / 新手教程 / 关于 (declared as `data-gate` in the markup)
   *   · 管理员 — still needs BOTH §6.3's is_admin and the gate
   *   · the header's right edge — the account area and the 「激活」 button are mutually exclusive
   *   · 1.0.2 二.1: 社区 — §2.1 「未激活用户：不显示「社区」按钮」, the fifth surface
   *
   * Plus the job the 1.0.0 version of this function already had and the easy one to forget: when
   * the view we are STANDING on stops being reachable (登出, 注销, or a revoked code the boot-time
   * renewal noticed), leaving it on screen produces a page no nav button points at. Moving to 检测 is
   * the destination the nav itself would offer, so the two never disagree about where 「not here」
   * goes.
   *
   * `viewAllowed()` is asked for every one of those decisions rather than `activationOpen()` being
   * re-evaluated per surface, because `admin` is the one view with two conditions and writing them
   * twice is how a tab ends up visible to a non-admin.
   */
  function applyActivationGate() {
    // ⚠ Bare globals, NOT `g.GMCloud`/`g.GMAuth`. `viewer.js` is a plain IIFE with no `g`
    // parameter (unlike the modules, which all start `(function (g) {`), so `g.GMAuth` is a
    // ReferenceError — and it is one that does not surface as a page error, because `boot()` ends
    // with an awaited `cloudBoot()` whose rejection nobody catches: the cloud half simply never
    // painted and the page looked fine. Found by behave-062-cloud, which asserts on
    // `unhandledrejection` precisely so this class of failure cannot hide as "the panel is empty".
    if ($('navReplay')) $('navReplay').classList.toggle('hidden', !viewAllowed('replay'));
    if ($('navSamples')) $('navSamples').classList.toggle('hidden', !viewAllowed('samples'));
    if ($('navBlacklist')) $('navBlacklist').classList.toggle('hidden', !viewAllowed('blacklist'));
    // §1.3 — 「其他设置面板（检测、引擎、透明度、导入导出、回放过滤、存储过滤、背景）全部隐藏」.
    // Read off the markup so the two lists cannot drift; see viewer.html for why the flag lives there.
    Array.prototype.forEach.call(document.querySelectorAll('.set-panel[data-gate]'), function (p) {
      p.classList.toggle('hidden', !activationOpen());
    });
    if ($('navAdmin')) $('navAdmin').classList.toggle('hidden', !viewAllowed('admin'));
    // 1.0.2 二.1 — 社区. Same predicate as the three tabs above rather than a second reading of
    // `activationOpen()`: `viewAllowed` is where 「admin needs two conditions」 lives, and a surface
    // that asks the gate directly is a surface that will disagree with the router one day.
    if ($('navCommunity')) $('navCommunity').classList.toggle('hidden', !viewAllowed('community'));
    // §3.1 vs §3.4 — one of the two is shown, never both, and never neither…
    //
    // …EXCEPT on a build with no backend, where it is neither. §3.4's 「激活」 button is an offer to
    // open a door that a configured server has bolted shut; with no server there is no bolt and no
    // key issuer, so the offer cannot be honoured, and the alternative — an account chip reading
    // 「—」 for an account that cannot exist — is a worse lie. `GMCloud.isConfigured()` is the same
    // predicate `GMAuth.gateOpen()` uses, which is why 「没有门的房间」 shows no door furniture at all.
    var configured = !!(window.GMCloud && window.GMCloud.isConfigured && window.GMCloud.isConfigured());
    if ($('navUser')) $('navUser').classList.toggle('hidden', !(configured && activationOpen()));
    if ($('navActivate')) $('navActivate').classList.toggle('hidden', !(configured && !activationOpen()));
    renderNavUser();

    var v = activeView();
    if (!viewAllowed(v)) showView('detect');
  }

  /**
   * §3.5's `renderNavUser()`. The avatar falls back to the name's initial rather than to a
   * `default-avatar.svg` asset: 1.0.0 has no such file, and a broken `<img>` in the sticky header is
   * worse than a letter. Same fallback, same reason, as `renderProfile`'s `#pfAvatar`.
   */
  function renderNavUser() {
    var st = GMAuth.status();
    var u = st.user || {};
    var name = u.username || u.email || '—';
    if ($('navName')) $('navName').textContent = name;
    var av = $('navAvatar');
    if (av) {
      if (u.avatar_url) av.innerHTML = '<img alt="" src="' + esc(u.avatar_url) + '">';
      else av.textContent = name.slice(0, 1).toUpperCase();
    }
    if ($('navActivate')) $('navActivate').textContent = T('viewer|激活');
  }

  /**
   * §3.2's drawer. Built with `showCtx` — the same popup the replay list's right-click menu uses —
   * because it is the same control: a transient panel anchored to the click that opened it, with
   * the same outside-click / Escape / blur dismissal. A second popup implementation would be the
   * sixth time this project paid for one answer living in two places.
   *
   * ⚠ Every `.it` handler must `stopPropagation()`. `ctx.innerHTML` is replaced by the handler, so
   * by the time the document-level 「clicked outside?」 listener runs, `ctx.contains(target)` is
   * already false and the menu would be wiped the instant it appeared — the same trap
   * `openCardMenu` documents.
   */
  function showUserMenu(x, y) {
    var u = (GMAuth.status().user) || {};
    var name = u.username || u.email || '—';
    var avHtml = u.avatar_url
      ? '<img alt="" src="' + esc(u.avatar_url) + '">'
      : esc(name.slice(0, 1).toUpperCase());
    showCtx(
      '<div class="user-card">' +
        '<span class="user-avatar-lg">' + avHtml + '</span>' +
        '<span style="min-width:0">' +
          '<span class="user-name" style="display:block">' + esc(name) + '</span>' +
          '<span class="user-email" style="display:block">' + esc(u.email || '') + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="sep"></div>' +
      '<div class="it" data-u="profile">' + T('viewer|主页') + '</div>' +
      '<div class="it" data-u="account">' + T('viewer|账号设置') + '</div>' +
      '<div class="sep"></div>' +
      '<div class="it danger" data-u="logout">' + T('viewer|退出登录') + '</div>',
      x, y);
    ctx.querySelectorAll('[data-u]').forEach(function (it) {
      it.onclick = function (e) {
        e.stopPropagation();               // we are about to replace ctx.innerHTML
        var a = it.dataset.u;
        closeCtx();
        if (a === 'profile') showView('profile');
        else if (a === 'account') showView('account');
        else if (a === 'logout') doLogout();
      };
    });
  }


  // §3.4's four states plus 「no backend at all」, as words. The unconfigured case is first because
  // it is not a state of the ACCOUNT — it is the absence of a server, and saying 「未激活」 would
  // send the operator looking for a code they were never issued.
  function cloudStateText(st) {
    if (!st.configured) return T('viewer|云端未配置（纯本地模式）');
    if (st.state === 'active') return T('viewer|已激活');
    if (st.state === 'grace') return T('viewer|离线宽限');
    if (st.state === 'locked') return T('viewer|已锁定');
    if (st.state === 'banned') return T('viewer|已封禁');
    return T('viewer|本地使用（未激活）');
  }

  // §3.2's error vocabulary, as sentences. The codes are the Edge Functions' own and are stable;
  // the words are what the operator acts on. 1.0.1 adds the registration/login set (§2.3/§2.6) —
  // kept in THIS one function so the two steps of one flow cannot word the same failure differently.
  //
  // ⚠ A FALLBACK IS CHOSEN BY ELIMINATION, so a fallback that names a CAUSE turns every unlisted
  // failure into a false diagnosis of that cause. 1.0.1's fallback was 「网络错误，请稍后重试」, and
  // during the 2026-10-03 bring-up that one sentence covered three unrelated situations: eight Edge
  // Functions that had never been deployed, a Resend key that had never been set, and — in the only
  // case it was right about — a genuine network failure. Two of the three sent the operator to
  // inspect their own network. The sentence itself was never wrong; it was in the wrong place.
  // It has now MOVED to the one branch where it is true (`NETWORK`), everything else is named, and
  // the fallback carries the raw code instead of asserting a cause.
  function cloudErrText(err) {
    if (err === 'BAD_FORMAT') return T('viewer|激活码格式形如 BS-XXXX-XXXX-XXXX-XXXX');
    if (err === 'INVALID_CODE') return T('viewer|激活码无效');
    if (err === 'CODE_REVOKED') return T('viewer|激活码已被撤销');
    if (err === 'CODE_ALREADY_USED') return T('viewer|激活码已被其他账户使用');
    if (err === 'BANNED') return T('viewer|本账户已被封禁');
    if (err === 'DEVICE_LIMIT') return T('viewer|已达设备数上限（{n} 台）', { n: GMAuth.DEVICE_LIMIT });
    // ---- 1.0.1 §2.3 的字段与唯一性 ----
    if (err === 'BAD_USERNAME') return T('reg|用户名需 2–20 个字符且不含空格');
    if (err === 'BAD_EMAIL') return T('reg|邮箱格式不正确');
    if (err === 'WEAK_PASSWORD') return T('reg|密码至少 8 位，且需同时包含字母和数字');
    if (err === 'PASSWORD_MISMATCH') return T('reg|两次输入的密码不一致');
    if (err === 'BAD_EMAIL_CODE') return T('reg|验证码为 6 位数字');
    if (err === 'INVALID_EMAIL_CODE') return T('reg|验证码错误或已过期');
    if (err === 'EMAIL_TAKEN') return T('reg|该邮箱已被注册');
    if (err === 'USERNAME_TAKEN') return T('reg|该用户名已被占用');
    if (err === 'RATE_LIMITED') return T('reg|发送过于频繁，请 60 秒后再试');
    // ---- 1.0.1 §2.6 登录 ----
    if (err === 'BAD_CREDENTIALS') return T('reg|邮箱或密码不正确');
    if (err === 'NOT_FOUND') return T('viewer|激活码无效');
    // ---- 传输层：`GMCloud` 自己的码，不是服务端的错误词表 ----
    // `NETWORK` is the ONLY code that means the network. `cloud.js` returns it for a failed fetch —
    // offline, DNS, TLS, timeout, abort — and for nothing else, which is what earns it the sentence.
    if (err === 'NETWORK') return T('viewer|网络错误，请稍后重试');
    if (err === 'NOT_CONFIGURED') return T('viewer|云端未配置（纯本地模式）');
    if (err === 'UNAUTHORIZED') return T('viewer|登录状态已失效，请重新登录');
    if (err === 'FORBIDDEN') return T('viewer|没有权限执行此操作');
    if (err === 'BAD_REQUEST') return T('viewer|请求无效，请重试');
    // ---- 平台层：没有 `error` 键的失败，见 `cloud.js` 的 `wireCode` ----
    // `INTERNAL` is the functions' own catch-all (`_shared/errors.ts`); `HTTP_5xx` is a platform
    // answer. To the operator they are one fact — the server side gave up — so they share one
    // sentence rather than growing a distinction nothing acts on.
    if (err === 'INTERNAL') return T('viewer|服务端暂时出错，请稍后重试');
    if (/^HTTP_5\d\d$/.test(err)) return T('viewer|服务端暂时出错，请稍后重试');
    // EMAIL_FAILED is `_shared/email.ts`: Resend is unconfigured, refused, or out of quota. That is
    // a DEPLOYMENT problem and the end user cannot fix it, so the sentence says who can.
    if (err === 'EMAIL_FAILED') return T('reg|验证码邮件发送失败，请稍后重试或联系管理员');
    // ---- 1.0.2 §2 社区互动的三个判词 ----
    // Added because the four community Edge Functions can answer them and `behave-064` found one of
    // them reaching the operator as 「未知错误（NOT_ACTIVATED）」 — the catalogue tries hard not to
    // repeat itself, but a screen with no matching sentence would evolve into one half-quiet failure
    // per screen.
    if (err === 'NOT_ACTIVATED') return T('viewer|此功能需要已激活的账户');
    if (err === 'CONTENT_TOO_LONG') return T('viewer|内容超出长度上限');
    if (err === 'CONTENT_REJECTED') return T('viewer|内容包含不当词汇，未能提交');
    // ⚠ A 404 with no `error` key is the platform saying the function slug does not exist. This is
    // the sentence the bring-up needed and did not have: it used to reach the operator as
    // 「网络错误」 while their network was demonstrably fine.
    if (err === 'HTTP_404') return T('viewer|服务端接口不存在，后端可能尚未部署');
    // Any other status the platform answered with. `HTTP_404` is handled above, so this is the
    // 400/401/403/405/429/… set — name the status rather than invent a cause.
    if (/^HTTP_\d+$/.test(err)) return T('viewer|请求被服务端拒绝（{code}）', { code: err });
    // Last resort. It NAMES the code rather than asserting a cause, so the operator has something
    // to search for — which 「网络错误，请稍后重试」 never gave them.
    return T('viewer|未知错误（{code}）', { code: String(err == null ? '' : err) });
  }


  function fmtDateTime(ms) {
    if (!ms) return '—';
    var d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '—';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // ---------------------------------------------------------------------
  // 设置页：云账户与同步 (§7.1)
  // ---------------------------------------------------------------------
  async function buildCloudPanel() {
    var body = $('clBody');
    if (!body || !GMCloud) return;
    var st = GMAuth.status();
    if ($('clTitle')) $('clTitle').textContent = T('viewer|云账户与同步');
    if ($('clHint')) $('clHint').textContent = T('viewer|激活码解锁云功能，核心检测仍然免费');

    var h = '';
    if (!st.configured) {
      // The shipped state. One line saying so, and nothing else — a form that cannot possibly
      // succeed is worse than no form.
      h += '<div class="hint">' + esc(T('viewer|云端未配置（纯本地模式）')) + '</div>';
    } else if (!st.user) {
      // 1.0.1 §二 — 「激活」 opens the TWO-STEP flow (§1.3's modal) instead of calling
      // `auth-activate` directly. The code must first be VALIDATED and only then exchanged for a
      // registration (§2.1), so an inline box that did both in one press would be a second
      // implementation of the flow — and the one that skips §2.2's reason vocabulary.
      h += '<div class="hint" style="margin-top:10px">' +
        esc(T('viewer|输入激活码解锁完整功能。如果你还没有激活码，请联系管理员。')) + '</div>' +
        '<div class="btn-row" style="margin-top:10px;line-height:2.2">' +
        '<button id="clActivate">' + esc(T('viewer|激活')) + '</button>' +
        '<button class="sec" id="clLogin">' + esc(T('reg|已有账户？点此登录')) + '</button>' +
        '</div>' +
        '<div class="hint" id="clMsg" style="margin-top:6px"></div>';
    } else {
      h += '<div class="rowline" style="margin-top:10px">' +
        '<span class="em">' + esc(st.user.username || st.user.email || '—') + ' · ' +
        esc(cloudStateText(st)) + '</span>' +
        '<button class="sec" id="clAccount">' + esc(T('viewer|账号设置')) + '</button></div>';
    }

    // The sync half is only meaningful once there is an account to sync (§7.1: 「用户主动开启」).
    if (st.user) {
      var prefs = S.cloud;
      h += '<div class="btn-row" style="margin-top:14px">' +
        '<label class="hint" style="display:flex;align-items:center;gap:8px">' +
        '<input type="checkbox" id="clSyncOn" style="flex:0 0 auto;width:auto;min-width:0;margin:0"' +
        (prefs.syncEnabled ? ' checked' : '') + '><span>' + esc(T('viewer|云同步')) + '</span></label>' +
        '<span class="hint">' + esc(T('viewer|开启后本机数据会与云端双向同步')) + '</span></div>';

      // Reuses `.io-cats` — the same labelled-checkbox grid the export panel uses, including its
      // `flex:0 0 auto` guard (0.5.6 补增). A new class here would be a second copy of that fix.
      h += '<div class="io-cats" id="clCats">';
      GMSync.CATS.forEach(function (c) {
        var on = !!prefs.syncCats[c.key];
        // The two §7.2 ❌ rows are drawn DISABLED rather than omitted: the operator has read that
        // 自定义引擎 and 背景图片 are excluded, and hiding them would read as a missing feature.
        var dis = c.hard ? ' disabled' : '';
        h += '<label' + (c.hard ? ' class="hint"' : '') + '>' +
          '<input type="checkbox" data-cl-cat="' + c.key + '"' + (on ? ' checked' : '') + dis + '>' +
          '<span>' + esc(cloudCatLabel(c.key)) +
          (c.hard ? ' · ' + esc(T('viewer|体积过大，不参与同步')) : '') + '</span></label>';
      });
      h += '</div>';

      h += '<div class="btn-row" style="margin-top:12px;line-height:2.2">' +
        '<label class="hint">' + esc(T('viewer|冲突处理')) + ' ' +
        '<select id="clConflict">' +
        '<option value="auto"' + (prefs.conflict === 'auto' ? ' selected' : '') + '>' +
        esc(T('viewer|保留较新者（自动）')) + '</option>' +
        '<option value="ask"' + (prefs.conflict === 'ask' ? ' selected' : '') + '>' +
        esc(T('viewer|冲突时询问我')) + '</option>' +
        '</select></label>' +
        '<button class="sec" id="clSyncNow">' + esc(T('viewer|立即同步')) + '</button>' +
        '<span class="hint" id="clSyncState">' + esc(syncStateText(prefs)) + '</span>' +
        '</div>';
    }
    body.innerHTML = h;
    wireCloudPanel();
  }

  /**
   * The settings panel's own controls.
   *
   * ⚠ WHY THIS FUNCTION EXISTS, AND WHY IT IS NOTICEABLE THAT IT HAS A COMMENT SAYING SO.
   * The first version of `buildCloudPanel` drew `#clActivate`, `#clAgree`, `#clSyncOn`, the eight
   * category ticks, `#clConflict` and `#clSyncNow` — and wired NONE of them. Nothing static caught
   * it: every id was present, every label translated, every disabled state in place, and the panel
   * looked finished. The buttons simply did nothing when clicked, which is the one failure mode a
   * source scan cannot see (the same shape 0.5.5 found in 「链接与按钮共用一个 handler」). It was
   * found by `behave-062-cloud` clicking its way down the panel, and that harness now clicks every
   * control below — so the rule this comment is really recording is: **a panel that is BUILT by a
   * function has to be WIRED by one, and the wiring goes in the same place as the markup.**
   */
  function wireCloudPanel() {
    // 1.0.1 §二 — both doors lead into the flow, not into a bare `GMAuth.activate()`.
    if ($('clActivate')) $('clActivate').onclick = function () { openActivationGuide(); };
    if ($('clLogin')) $('clLogin').onclick = function () { openLoginFlow(); };
    if ($('clAccount')) $('clAccount').onclick = function () { showView('account'); };
    // §7.1's switch. Retoggling rebuilds the panel because the eight category rows and the
    // 「立即同步」 row only exist while sync is on — drawing them disabled would be a second
    // rendering of the same rule.
    var syncOn = $('clSyncOn');
    if (syncOn) {
      syncOn.onchange = async function () {
        await GMSync.setEnabled(syncOn.checked);
        S = await G.loadSettings();
        await buildCloudPanel();
      };
    }
    // §7.2's per-category ticks. The two hard rows are drawn `disabled`, so no change event can
    // arrive from them; `setCategory` refuses an unknown key on its own as well.
    Array.prototype.forEach.call(
      document.querySelectorAll('#clCats input[data-cl-cat]'),
      function (b) {
        b.onchange = async function () {
          await GMSync.setCategory(b.getAttribute('data-cl-cat'), b.checked);
          S = await G.loadSettings();
        };
      });
    var conf = $('clConflict');
    if (conf) {
      conf.onchange = async function () {
        // §7.3's policy. Saved rather than acted on: it decides what the NEXT sync does with a pair
        // of timestamps that are both recent, and re-reading it per sync is what keeps two tabs
        // honest.
        await GMSync.setPrefs({ conflict: conf.value });
        S = await G.loadSettings();
      };
    }
    var now = $('clSyncNow');
    if (now) now.onclick = function () { cloudSyncNow(); };
  }

  function syncStateText(prefs) {
    if (!prefs.syncEnabled) return T('viewer|从未同步');
    if (!prefs.lastSyncAt) return T('viewer|从未同步');
    return T('viewer|上次同步') + ' ' + fmtDateTime(prefs.lastSyncAt);
  }

  async function cloudSyncNow() {
    var el = $('clSyncState');
    if (el) el.textContent = T('viewer|正在同步…');
    var res = await GMSync.syncNow();
    S = await G.loadSettings();
    await buildCloudPanel();
    var el2 = $('clSyncState');
    if (!el2) return;
    // ⚠ 1.0.1 spelled this mapping out a SECOND time here, and the two copies disagreed. This one
    // knew only NOT_CONFIGURED and UNAUTHORIZED, so every other failure — an undeployed table, a
    // policy refusing the token, a 5xx — was reported as 「网络错误，请稍后重试」. A sync error is
    // exactly where a PostgREST code shows up, so this copy was the one most likely to lie. One
    // answer gets one copy, and `cloudErrText` is it.
    el2.textContent = res.ok ? syncStateText(S.cloud) : cloudErrText(res.error);
  }

  // ---------------------------------------------------------------------
  // 主页 (§3.3, READ-ONLY)
  // ---------------------------------------------------------------------
  // §3.3's table gives 主页 exactly four things (头像 / 用户名 / 加入时间 / 样本库总数) plus the
  // 预留接口 block, and marks the page **只读**. That is why there is no button anywhere in this
  // function: everything an operator can change about themselves lives one page over, in 账号设置,
  // and a second editable copy of a field is how two pages start disagreeing about it.
  function renderProfile() {
    var st = GMAuth.status();
    var u = st.user || {};
    var name = u.username || u.email || '—';
    if ($('pfName')) $('pfName').textContent = name;
    // §4.4 stores a URL, but the shipped state has none, so the letter is the fallback that keeps
    // the header from collapsing to a hole. `renderNavUser` uses the same fallback for the same
    // reason — there is no `default-avatar.svg` asset to point at.
    var av = $('pfAvatar');
    if (av) {
      if (u.avatar_url) av.innerHTML = '<img alt="" src="' + esc(u.avatar_url) + '">';
      else av.textContent = name.slice(0, 1).toUpperCase();
    }
    if ($('pfMeta')) {
      var bits = [];
      if (u.created_at || u.activated_at) {
        bits.push(T('viewer|加入时间') + ' ' + fmtDateTime(Date.parse(u.activated_at || u.created_at)));
      }
      bits.push(T('viewer|样本库 {n} 个', { n: PFC.sampleCount }));
      $('pfMeta').textContent = bits.join(' · ');
    }
    if ($('pfState')) $('pfState').textContent = cloudStateText(st);

    // §5.1's 「─── 预留接口 ───」 block, drawn from §5.2's four accessors. They resolve to empty
    // today and the panel says so, which is the whole point: 「未来实现时只需替换数据源」.
    if ($('pfResvTitle')) $('pfResvTitle').textContent = T('viewer|即将推出');
    var resv = $('pfResv');
    if (resv) {
      var items = [T('viewer|徽章'), T('viewer|成就'), T('viewer|判断正确率'), T('viewer|好友')];
      resv.innerHTML = items.map(function (t) {
        return '<span class="resv-item">' + esc(t) + '</span>';
      }).join('');
    }
  }

  // The 我的 page's async half. `§5.3`: 「全部通过 Edge Function `profile-get` 一次拉取」.
  var PFC = { sampleCount: 0, devices: [{ current: true, label: '' }], loaded: false };

  async function profileLoad() {
    var st = GMAuth.status();
    PFC.devices = [{ current: true, label: T('viewer|本机') }];
    if (!st.user) { renderProfile(); return; }
    var res = await GMProfile.getProfile();
    if (res.ok) {
      PFC.sampleCount = res.sampleCount;
      PFC.loaded = true;
    }
    renderProfile();
  }

  // ---------------------------------------------------------------------
  // 账号设置 (§3.3 EDITABLE / §3.7 / §3.8)
  // ---------------------------------------------------------------------
  // §3.3's other half: everything about the account that CAN be changed. Built by a function and
  // wired by the function right after it — the rule 1.0.0 paid for when `buildCloudPanel` drew a
  // complete-looking form and connected none of it.
  function acMsg(text) {
    var el = $('acMsg');
    if (el) el.textContent = text || '';
  }

  function buildAccountPanel() {
    var body = $('acBody');
    if (!body) return;
    if ($('acTitle')) $('acTitle').textContent = T('viewer|账号设置');
    var u = (GMAuth.status().user) || {};
    var name = u.username || u.email || '—';
    var av = u.avatar_url
      ? '<img alt="" src="' + esc(u.avatar_url) + '">'
      : esc(name.slice(0, 1).toUpperCase());

    var h = '';
    // ---- 资料 (§3.3「用户名、简介、头像」) ----
    h += '<div class="rowline"><span>' + esc(T('viewer|用户名')) + '</span>' +
      '<input type="text" id="acName" style="flex:1" value="' + esc(u.username || '') + '">' +
      '<button class="sec" id="acNameSave">' + esc(T('viewer|保存')) + '</button></div>';
    h += '<div class="rowline"><span>' + esc(T('viewer|简介')) + '</span>' +
      '<input type="text" id="acBio" style="flex:1" value="' + esc(u.bio || '') + '">' +
      '<button class="sec" id="acBioSave">' + esc(T('viewer|保存')) + '</button></div>';
    // The file input stays in the DOM and is `display:none`; a file input that is not in the
    // document cannot be clicked on some builds (same note as 导入与导出's `#ioFile`).
    h += '<div class="rowline"><span>' + esc(T('viewer|头像')) + '</span>' +
      '<span class="acct-av" style="width:40px;height:40px;font-size:14px">' + av + '</span>' +
      '<input type="file" id="acAvatar" accept="image/jpeg,image/png,image/webp" style="display:none">' +
      '<button class="sec" id="acAvatarPick">' + esc(T('viewer|更换')) + '</button>' +
      '<span class="hint" id="acAvatarHint"></span></div>';

    // ---- 邮箱与密码 (§3.7 / §3.8) ----
    h += '<h3 class="set-sub">' + esc(T('viewer|邮箱与密码')) + '</h3>';
    h += '<div class="rowline"><span>' + esc(T('viewer|邮箱')) + '</span>' +
      '<span class="em">' + esc(u.email || '—') + '</span>' +
      '<button class="sec" id="acEmail">' + esc(T('viewer|更换')) + '</button></div>';
    h += '<div class="rowline"><span>' + esc(T('viewer|密码')) + '</span><span class="em"></span>' +
      '<button class="sec" id="acPw">' + esc(T('viewer|修改密码')) + '</button></div>';

    // ---- 设备 ----
    // 1.0.0 §7.5 puts the device list 「在用户主页」 and adds 「可手动登出某台设备」. 1.0.1 §3.3 makes
    // 主页 只读, and an action is not read-only — so the list moved here, next to the other things an
    // operator can change, rather than being dropped or left on a page that may not offer buttons.
    h += '<h3 class="set-sub">' + esc(T('viewer|设备')) + '</h3><div id="acDev"></div>';

    // ---- 危险操作 (§4.2) ----
    h += '<h3 class="set-sub">' + esc(T('viewer|危险操作')) + '</h3>' +
      '<div class="hint">' + esc(T('viewer|注销后 30 天内数据仍可恢复，30 天后彻底删除')) +
      '<br>' + esc(T('viewer|本地数据保留，云端数据将删除')) + '</div>' +
      '<div class="btn-row" style="margin-top:10px"><button class="sec danger" id="acDelete">' +
      esc(T('viewer|注销账户')) + '</button></div>';
    h += '<div class="hint" id="acMsg" style="margin-top:12px"></div>';

    body.innerHTML = h;

    var dev = $('acDev');
    if (dev) {
      // §7.5 「一个用户最多 3 台活跃设备」. The list itself comes from the server; until a profile
      // load has run there is one row — this machine — which is the only device the client can name
      // for certain.
      dev.innerHTML = PFC.devices.map(function (d) {
        return '<div class="rowline"><span class="em">' + esc(d.label || d.device_id || '—') + '</span>' +
          (d.current ? '<span class="hint">' + esc(T('viewer|本机')) + '</span>' : '') + '</div>';
      }).join('') + '<div class="hint" style="margin-top:8px">' +
        esc(T('viewer|已达设备数上限（{n} 台）', { n: GMAuth.DEVICE_LIMIT })) + '</div>';
    }
    wireAccountPanel();
  }

  function wireAccountPanel() {
    if ($('acNameSave')) $('acNameSave').onclick = async function () {
      var v = String(($('acName') || {}).value || '').trim();
      // §2.3's username rule is the same one registration enforces; asking it here is what keeps a
      // rename from being the one door that accepts a 21-character name.
      if (!GMAuth.isValidUsername(v)) { acMsg(cloudErrText('BAD_USERNAME')); return; }
      var r = await GMProfile.updateProfile({ username: v });
      if (!r.ok) { acMsg(cloudErrText(r.error)); return; }
      acMsg(T('viewer|已保存'));
      renderNavUser();
      renderProfile();
      // The cached session now carries the new name, so the field is rebuilt from the truth rather
      // than left showing what was typed.
      $('acName').value = v;
    };
    if ($('acBioSave')) $('acBioSave').onclick = async function () {
      var v = String(($('acBio') || {}).value || '');
      var r = await GMProfile.updateProfile({ bio: v });
      acMsg(r.ok ? T('viewer|已保存') : cloudErrText(r.error));
      if (r.ok) renderProfile();
    };
    var pick = $('acAvatarPick');
    var file = $('acAvatar');
    if (pick && file) {
      pick.onclick = function () { file.click(); };
      file.onchange = async function () {
        var f = file.files && file.files[0];
        if (!f) return;
        // §4.4's client-side gate runs BEFORE the file is read: 2MB / jpg-png-webp, then 256×256.
        var v = GMProfile.validateAvatar(f);
        if (!v.ok) { if ($('acAvatarHint')) $('acAvatarHint').textContent = cloudErrText(v.error); return; }
        if ($('acAvatarHint')) $('acAvatarHint').textContent = T('viewer|正在上传…');
        var r = await GMProfile.uploadAvatar(f);
        if (!r.ok) {
          if ($('acAvatarHint')) $('acAvatarHint').textContent = cloudErrText(r.error);
          return;
        }
        buildAccountPanel();
        renderNavUser();
        renderProfile();
        acMsg(T('viewer|已保存'));
      };
    }
    if ($('acEmail')) $('acEmail').onclick = openChangeEmail;
    if ($('acPw')) $('acPw').onclick = openChangePassword;
    if ($('acDelete')) $('acDelete').onclick = openDeleteAccount;
  }

  // §3.7 修改密码
  function openChangePassword() {
    var h = '<div class="rowline"><span>' + esc(T('viewer|当前密码')) + '</span>' +
      '<input type="password" id="cpNow" style="flex:1"></div>' +
      '<div class="rowline"><span>' + esc(T('viewer|新密码')) + '</span>' +
      '<input type="password" id="cpNew" style="flex:1">' +
      '<span class="pwbar" id="cpBar"></span></div>' +
      '<div class="rowline"><span>' + esc(T('viewer|确认新密码')) + '</span>' +
      '<input type="password" id="cpNew2" style="flex:1"></div>' +
      '<div class="hint" id="cpErr" style="margin-top:8px"></div>';
    openModal(T('viewer|修改密码'), h, function (bd) {
      // §2.3's strength bar, the same predicate registration uses — a password strong enough to
      // register with must not be rejected here.
      var bar = bd.querySelector('#cpBar');
      var paint = function () { paintStrengthBar(bar, GMAuth.passwordStrength(bd.querySelector('#cpNew').value)); };
      bd.querySelector('#cpNew').addEventListener('input', paint);
      paint();
      var go = document.createElement('button');
      go.textContent = T('viewer|修改密码');
      go.onclick = async function () {
        var p1 = bd.querySelector('#cpNew').value;
        var p2 = bd.querySelector('#cpNew2').value;
        var err = bd.querySelector('#cpErr');
        if (p1 !== p2) { err.textContent = cloudErrText('PASSWORD_MISMATCH'); return; }
        go.disabled = true;
        var r = await GMProfile.changePassword(bd.querySelector('#cpNow').value, p1);
        go.disabled = false;
        if (!r.ok) { err.textContent = cloudErrText(r.error); return; }
        // §3.7 「提示『密码已修改，请重新登录』」. The server revokes every device's token, so the
        // session this page holds is already dead — saying so and taking them to the login screen is
        // the only honest ending.
        closeAllModals();
        afterAuthChange();
        openLoginFlow(T('viewer|密码已修改，请重新登录'));
      };
      var ft = bd.closest('.modal').querySelector('.ft');
      ft.insertBefore(go, ft.querySelector('[data-close]'));
    });
  }

  // §3.8 修改邮箱
  function openChangeEmail() {
    var u = (GMAuth.status().user) || {};
    var h = '<div class="rowline"><span>' + esc(T('viewer|新邮箱')) + '</span>' +
      '<input type="text" id="ceEmail" style="flex:1"></div>' +
      '<div class="rowline"><span>' + esc(T('viewer|验证码')) + '</span>' +
      '<input type="text" id="ceCode" style="flex:1" maxlength="6">' +
      '<button class="sec" id="ceSend">' + esc(T('viewer|发送验证码')) + '</button></div>' +
      '<div class="rowline"><span>' + esc(T('viewer|当前密码')) + '</span>' +
      '<input type="password" id="cePw" style="flex:1"></div>' +
      '<div class="hint" id="ceErr" style="margin-top:8px"></div>';
    openModal(T('viewer|更换邮箱'), h, function (bd) {
      wireSendCode(bd, bd.querySelector('#ceEmail'), bd.querySelector('#ceSend'), bd.querySelector('#ceErr'));
      var go = document.createElement('button');
      go.textContent = T('viewer|更换邮箱');
      go.onclick = async function () {
        var err = bd.querySelector('#ceErr');
        go.disabled = true;
        var r = await GMProfile.changeEmail(
          bd.querySelector('#ceEmail').value, bd.querySelector('#ceCode').value, bd.querySelector('#cePw').value);
        go.disabled = false;
        if (!r.ok) { err.textContent = cloudErrText(r.error); return; }
        closeAllModals();
        afterAuthChange();
        GmToast.show(T('viewer|邮箱已修改'), 'info');
      };
      var ft = bd.closest('.modal').querySelector('.ft');
      ft.insertBefore(go, ft.querySelector('[data-close]'));
    });
  }

  /** §4.2's 注销账户. The modal itself is the 「二次确认」; the code box is 「输入激活码或邮箱验证」. */
  function openDeleteAccount() {
    var h = '<div class="hint">' + esc(T('viewer|注销后 30 天内数据仍可恢复，30 天后彻底删除')) + '</div>' +
      '<div class="hint" style="margin-top:6px">' + esc(T('viewer|本地数据保留，云端数据将删除')) + '</div>' +
      '<div class="rowline" style="margin-top:10px"><span>' + esc(T('viewer|激活码')) + '</span>' +
      '<input type="text" id="daCode" style="flex:1" placeholder="' + esc(T('viewer|输入激活码')) + '"></div>' +
      '<div class="hint" id="daErr" style="margin-top:8px"></div>';
    openModal(T('viewer|注销账户'), h, function (bd) {
      var btn = document.createElement('button');
      btn.className = 'sec';
      btn.textContent = T('viewer|注销账户');
      btn.onclick = async function () {
        var code = (bd.querySelector('#daCode') || {}).value || '';
        var res = await GMProfile.deleteAccount(code);
        if (!res.ok) { bd.querySelector('#daErr').textContent = cloudErrText(res.error); return; }
        closeAllModals();
        afterAuthChange();
        // §4.2 「本地数据不删除」 — said out loud, because the operator who just pressed this is
        // entitled to worry about their archives.
        GmToast.show(T('viewer|本地数据保留，云端数据将删除'), 'info');
      };
      // `openModal`'s onMount hands back `.bd` (the body); the footer is its SIBLING inside
      // `.modal`, so the extra step through `closest` is required — `bd.querySelector('.ft')` is
      // null and the insert would throw.
      var daFt = bd.closest('.modal').querySelector('.ft');
      daFt.insertBefore(btn, daFt.querySelector('[data-close]'));
    });
  }

  /** The drawer's 退出登录. One function so the drawer and the account page cannot diverge. */
  async function doLogout() {
    await GMAuth.logout();
    afterAuthChange();
  }

  // ---------------------------------------------------------------------
  // 管理员 (§6.3)
  // ---------------------------------------------------------------------
  var ADC = { page: 1, limit: 50, total: 0, query: '', loaded: false };

  function renderAdmin() {
    if ($('adGenTitle')) $('adGenTitle').textContent = T('viewer|生成激活码');
    if ($('adCountLabel')) $('adCountLabel').textContent = T('viewer|数量');
    if ($('adNoteLabel')) $('adNoteLabel').textContent = T('viewer|备注');
    if ($('adGen')) $('adGen').textContent = T('viewer|生成');
    if ($('adListTitle')) $('adListTitle').textContent = T('viewer|用户列表');
    if ($('adQueryLabel')) $('adQueryLabel').textContent = T('viewer|搜索');
    if ($('adSearch')) $('adSearch').textContent = T('viewer|搜索');
    if ($('adPrev')) $('adPrev').textContent = '‹';
    if ($('adNext')) $('adNext').textContent = '›';
    wireAdmin();
  }

  function wireAdmin() {
    if ($('adGen') && !$('adGen').onclick) $('adGen').onclick = adminGenerate;
    if ($('adSearch') && !$('adSearch').onclick) $('adSearch').onclick = function () {
      ADC.query = ($('adQuery') || {}).value || '';
      adminLoadUsers(1);
    };
    if ($('adPrev') && !$('adPrev').onclick) $('adPrev').onclick = function () {
      if (ADC.page > 1) adminLoadUsers(ADC.page - 1);
    };
    if ($('adNext') && !$('adNext').onclick) $('adNext').onclick = function () {
      if (ADC.page * ADC.limit < ADC.total) adminLoadUsers(ADC.page + 1);
    };
  }

  async function adminGenerate() {
    var out = $('adGenOut');
    if (out) out.innerHTML = '<div class="hint">' + esc(T('viewer|正在激活…')) + '</div>';
    var n = ($('adCount') || {}).value;
    var note = ($('adNote') || {}).value || '';
    var res = await GMAdmin.generateCodes(n, note);
    if (!out) return;
    if (!res.ok) {
      out.innerHTML = '<div class="hint">' + esc(cloudErrText(res.error)) + '</div>';
      return;
    }
    // §6.3 「生成激活码（一键复制）」. The copy button is built here rather than in the markup
    // because the codes only exist after the call; the codes themselves are escaped into a
    // <pre>-like box so a stray character cannot become markup.
    out.innerHTML = '<div class="codebox" id="adCodes">' + esc(res.codes.join('\n')) + '</div>' +
      '<div class="btn-row" style="margin-top:8px"><button class="sec" id="adCopy">' +
      esc(T('viewer|复制')) + '</button></div>';
    var copy = $('adCopy');
    if (copy) copy.onclick = function () {
      var text = res.codes.join('\n');
      var done = function () { copy.textContent = T('viewer|已复制'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    };
  }

  async function adminLoadUsers(page) {
    ADC.page = page || 1;
    var rows = $('adRows');
    if (rows) rows.innerHTML = '<div class="hint">' + esc(T('viewer|正在同步…')) + '</div>';
    var res = await GMAdmin.listUsers({ page: ADC.page, limit: ADC.limit, filter: ADC.query ? { query: ADC.query } : null });
    if (!rows) return;
    if (!res.ok) {
      rows.innerHTML = '<div class="hint">' + esc(cloudErrText(res.error)) + '</div>';
      return;
    }
    ADC.total = res.total;
    ADC.loaded = true;
    if ($('adTotal')) $('adTotal').textContent = res.total + ' / ' + ADC.limit;
    if (!res.users.length) { rows.innerHTML = '<div class="hint">—</div>'; return; }
    var h = '';
    res.users.forEach(function (u) {
      var banned = !!u.is_banned;
      h += '<div class="rowline">' +
        '<span class="em">' + esc(u.email || u.id) + '</span>' +
        '<span class="hint">' + esc(u.username || '—') + '</span>' +
        '<span class="hint">' + esc(banned ? T('viewer|已封禁') : T('viewer|正常')) + '</span>' +
        '<button class="sec" data-ad-ban="' + esc(u.id) + '" data-ad-to="' + (banned ? '0' : '1') + '">' +
        esc(banned ? T('viewer|解封') : T('viewer|封禁')) + '</button>' +
        '</div>';
    });
    rows.innerHTML = h;
  }

  // Delegated, for the same reason the io panel's grid is: `adminLoadUsers` replaces the whole
  // innerHTML on every page, so a per-button handler would be attached to detached nodes.
  if ($('adRows')) {
    $('adRows').addEventListener('click', async function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-ad-ban]') : null;
      if (!b) return;
      var id = b.getAttribute('data-ad-ban');
      var want = b.getAttribute('data-ad-to') === '1';
      var res = want ? await GMAdmin.banUser(id, '') : await GMAdmin.unbanUser(id);
      if (res.ok) adminLoadUsers(ADC.page);
    });
  }

  // ---------------------------------------------------------------------
  // 激活 / 注册 / 登录 (§1.3, §2.2, §2.3, §2.6)
  // ---------------------------------------------------------------------
  // ONE flow, three doors: the header's 「激活」 button, the 云账户与同步 panel's button, and
  // `showView`'s refusal when a gated entry is clicked. All three land in `openActivationGuide`.

  /** §2.3's 强度条 — three segments, filled by band. A BAR rather than coloured text, so the
   *  indicator reads the same in the light and dark themes. */
  function paintStrengthBar(el, strength) {
    if (!el) return;
    var n = strength === 'strong' ? 3 : strength === 'medium' ? 2 : 1;
    el.className = 'pwbar s' + n;
    el.innerHTML = '<i></i><i></i><i></i>';
    el.title = n === 3 ? T('reg|强') : n === 2 ? T('reg|中') : T('reg|弱');
  }

  /** Trailing-edge debounce. §2.3's 「实时检查唯一」 means 「while typing」, not 「per keystroke」. */
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /**
   * §2.4's 发送验证码, ONE implementation shared by 注册 / 更换邮箱 / 忘记密码.
   *
   * The 60-second countdown is §2.4's server-side 「同一邮箱 60 秒内只能发一次」 mirrored onto the
   * button: the server is still the authority, and this only stops the operator spending the next
   * minute discovering that.
   */
  function wireSendCode(emailInput, btn, msgEl) {
    if (!btn) return;
    var left = 0, timer = null;
    var tick = function () {
      if (left <= 0) {
        if (timer) { clearInterval(timer); timer = null; }
        btn.disabled = false;
        btn.textContent = T('reg|发送验证码');
        return;
      }
      btn.textContent = T('reg|发送验证码') + ' · ' + left;
      left--;
    };
    btn.onclick = async function () {
      var email = emailInput ? emailInput.value : '';
      if (!GMAuth.isValidEmail(email)) {
        if (msgEl) msgEl.textContent = cloudErrText('BAD_EMAIL');
        return;
      }
      btn.disabled = true;
      btn.textContent = T('reg|正在发送…');
      var r = await GMAuth.sendCode(email);
      if (!r.ok) {
        btn.disabled = false;
        btn.textContent = T('reg|发送验证码');
        if (msgEl) msgEl.textContent = cloudErrText(r.error);
        return;
      }
      if (msgEl) msgEl.textContent = T('reg|验证码已发送，10 分钟内有效');
      left = 60;
      tick();
      timer = setInterval(tick, 1000);
    };
  }

  /** §1.3's 「此功能需要激活」 modal — 第一步 by another name. */
  function openActivationGuide() {
    var h = '<div class="hint">' +
      esc(T('viewer|输入激活码解锁完整功能。如果你还没有激活码，请联系管理员。')) + '</div>' +
      // 1.0.0 answered 「暂不激活」 with a button labelled 「暂不激活，继续本地使用」. 1.0.1 §1.3's
      // mock has a shorter 「暂不」, and ONE modal serves both the boot guide and the locked-entry
      // guide — so the reassurance moves into the body, where it is also visible to somebody who
      // arrived here by clicking a locked tab and never saw the boot version. Same promise, said
      // once, in the place both audiences read.
      '<div class="hint" style="margin-top:4px">' +
      esc(T('viewer|不激活也可以继续使用本地检测与存档。')) + '</div>' +
      '<div class="rowline" style="margin-top:12px"><span>' + esc(T('viewer|激活码')) + '</span>' +
      '<input type="text" id="agCode" style="flex:1" placeholder="' + esc(T('viewer|输入激活码')) + '"></div>' +
      '<div class="hint" style="margin-top:6px">' + esc(T('viewer|激活码格式形如 BS-XXXX-XXXX-XXXX-XXXX')) + '</div>' +
      '<div class="hint" id="agErr" style="margin-top:6px"></div>' +
      '<div class="hint" style="margin-top:10px">' +
      '<a href="#" id="agLogin">' + esc(T('reg|已有账户？点此登录')) + '</a></div>';
    openModal(T('viewer|此功能需要激活'), h, function (bd) {
      var err = bd.querySelector('#agErr');
      var codeIn = bd.querySelector('#agCode');
      var go = document.createElement('button');
      go.textContent = T('viewer|验证');
      go.onclick = async function () {
        go.disabled = true;
        err.textContent = T('viewer|正在验证…');
        // §2.2 第一步. A query — the guide stays open on failure so the operator can fix a typo
        // without retyping the whole code.
        var r = await GMAuth.validateCode(codeIn.value);
        go.disabled = false;
        if (!r.ok) { err.textContent = cloudErrText(r.error); return; }
        closeAllModals();
        openRegisterFlow(r.code);
      };
      var later = document.createElement('button');
      later.className = 'sec';
      later.textContent = T('viewer|暂不');
      later.onclick = function () { closeAllModals(); };
      var ft = bd.closest('.modal').querySelector('.ft');
      ft.insertBefore(later, ft.querySelector('[data-close]'));
      ft.insertBefore(go, ft.querySelector('[data-close]'));
      bd.querySelector('#agLogin').onclick = function (e) {
        e.preventDefault();
        closeAllModals();
        openLoginFlow();
      };
      codeIn.onkeydown = function (e) { if (e.key === 'Enter') go.click(); };
      codeIn.focus();
    });
  }

  /** §2.3 第二步：注册窗口. Five fields, a live strength bar, a live uniqueness check and a
   *  resend countdown — every one of them §2.3's own table. */
  function openRegisterFlow(code) {
    var h =
      '<div class="rowline"><span>' + esc(T('reg|用户名')) + '</span>' +
      '<input type="text" id="rgName" style="flex:1"><span class="hint mark" id="rgNameMark"></span></div>' +
      '<div class="rowline"><span>' + esc(T('reg|邮箱')) + '</span>' +
      '<input type="text" id="rgEmail" style="flex:1"><span class="hint mark" id="rgEmailMark"></span></div>' +
      '<div class="rowline"><span>' + esc(T('reg|密码')) + '</span>' +
      '<input type="password" id="rgPw" style="flex:1"><span class="pwbar" id="rgBar"></span></div>' +
      '<div class="rowline"><span>' + esc(T('reg|确认密码')) + '</span>' +
      '<input type="password" id="rgPw2" style="flex:1"><span class="hint mark" id="rgPw2Mark"></span></div>' +
      '<div class="rowline"><span>' + esc(T('reg|验证码')) + '</span>' +
      '<input type="text" id="rgCode" style="flex:1" maxlength="6">' +
      '<button class="sec" id="rgSend">' + esc(T('reg|发送验证码')) + '</button></div>' +
      // §9.2's 「明确同意：首次激活时勾选『我同意隐私政策』」. 1.0.1 moved the consent from the settings
      // panel to THIS step, because this is the step that actually creates the account — consenting
      // in front of a form that only validates a code would consent to nothing.
      '<label class="hint" style="display:flex;align-items:center;gap:8px;margin-top:12px">' +
      '<input type="checkbox" id="rgAgree" style="flex:0 0 auto;width:auto;min-width:0;margin:0">' +
      '<span>' + esc(T('viewer|我同意隐私政策')) + '</span></label>' +
      '<div class="hint" id="rgErr" style="margin-top:8px"></div>';

    openModal(T('reg|完成注册'), h, function (bd) {
      var err = bd.querySelector('#rgErr');
      var nameIn = bd.querySelector('#rgName');
      var mailIn = bd.querySelector('#rgEmail');
      var pwIn = bd.querySelector('#rgPw');
      var pw2In = bd.querySelector('#rgPw2');

      // §2.3's 「实时检查唯一」. The mark is a SYMBOL, not a sentence: a row that re-wraps while the
      // operator types is worse than no mark at all. The sentence goes in `title`.
      var checkName = debounce(async function () {
        var el = bd.querySelector('#rgNameMark'), v = nameIn.value.trim();
        if (!v) { el.textContent = ''; return; }
        if (!GMAuth.isValidUsername(v)) { el.textContent = '✕'; el.title = cloudErrText('BAD_USERNAME'); return; }
        el.textContent = '…';
        var r = await GMAuth.checkAvailable('username', v);
        var good = r.ok && r.available;
        el.textContent = good ? '✓' : '✕';
        el.title = good ? T('reg|用户名可用') : cloudErrText(r.ok ? 'USERNAME_TAKEN' : r.error);
      }, 400);
      nameIn.addEventListener('input', checkName);

      var checkMail = debounce(async function () {
        var el = bd.querySelector('#rgEmailMark'), v = mailIn.value.trim();
        if (!v) { el.textContent = ''; return; }
        if (!GMAuth.isValidEmail(v)) { el.textContent = '✕'; el.title = cloudErrText('BAD_EMAIL'); return; }
        el.textContent = '…';
        var r = await GMAuth.checkAvailable('email', v);
        var good = r.ok && r.available;
        el.textContent = good ? '✓' : '✕';
        el.title = good ? T('reg|邮箱可用') : cloudErrText(r.ok ? 'EMAIL_TAKEN' : r.error);
      }, 400);
      mailIn.addEventListener('input', checkMail);

      // The bar and the confirm mark repaint together: they are the same question (「is this
      // password usable, and did you type it twice?」) asked of two fields.
      var paintPw = function () {
        paintStrengthBar(bd.querySelector('#rgBar'), GMAuth.passwordStrength(pwIn.value));
        var el = bd.querySelector('#rgPw2Mark');
        el.textContent = pw2In.value ? (pw2In.value === pwIn.value ? '✓' : '✕') : '';
        el.title = el.textContent === '✕' ? cloudErrText('PASSWORD_MISMATCH') : '';
      };
      pwIn.addEventListener('input', paintPw);
      pw2In.addEventListener('input', paintPw);
      paintPw();

      wireSendCode(mailIn, bd.querySelector('#rgSend'), err);

      var go = document.createElement('button');
      go.textContent = T('reg|完成注册');
      go.onclick = async function () {
        err.textContent = '';
        if (!bd.querySelector('#rgAgree').checked) { err.textContent = T('viewer|请先勾选同意隐私政策'); return; }
        go.disabled = true;
        err.textContent = T('viewer|正在注册…');
        var r = await GMAuth.register({
          code: code,
          username: nameIn.value,
          email: mailIn.value,
          password: pwIn.value,
          confirm: pw2In.value,
          emailCode: bd.querySelector('#rgCode').value,
        });
        go.disabled = false;
        if (!r.ok) { err.textContent = cloudErrText(r.error); return; }
        closeAllModals();
        afterAuthChange();
        GmToast.show(T('viewer|激活成功'), 'info');
      };
      var ft = bd.closest('.modal').querySelector('.ft');
      ft.insertBefore(go, ft.querySelector('[data-close]'));
      nameIn.focus();
    });
  }

  /** §2.6 已有账户的登录. `reason` is the sentence the caller wants said first (e.g. the one
   *  §3.7 demands after a password change). */
  function openLoginFlow(reason) {
    var h = (reason ? '<div class="hint">' + esc(reason) + '</div>' : '') +
      '<div class="rowline"' + (reason ? ' style="margin-top:10px"' : '') + '>' +
      '<span>' + esc(T('reg|邮箱')) + '</span>' +
      '<input type="text" id="lgEmail" style="flex:1"></div>' +
      '<div class="rowline"><span>' + esc(T('reg|密码')) + '</span>' +
      '<input type="password" id="lgPw" style="flex:1"></div>' +
      '<div class="hint" id="lgErr" style="margin-top:8px"></div>';
    openModal(T('reg|登录白身'), h, function (bd) {
      var err = bd.querySelector('#lgErr');
      var go = document.createElement('button');
      go.textContent = T('reg|登录');
      go.onclick = async function () {
        go.disabled = true;
        err.textContent = T('viewer|正在登录…');
        var r = await GMAuth.login(bd.querySelector('#lgEmail').value, bd.querySelector('#lgPw').value);
        go.disabled = false;
        if (!r.ok) { err.textContent = cloudErrText(r.error); return; }
        closeAllModals();
        afterAuthChange();
      };
      var forgot = document.createElement('button');
      forgot.className = 'sec';
      forgot.textContent = T('reg|忘记密码？');
      forgot.onclick = function () { closeAllModals(); openForgotFlow(); };
      var ft = bd.closest('.modal').querySelector('.ft');
      ft.insertBefore(forgot, ft.querySelector('[data-close]'));
      ft.insertBefore(go, ft.querySelector('[data-close]'));
      bd.querySelector('#lgEmail').focus();
    });
  }

  /** §2.6 忘记密码 — the same email-code mechanism as registration, then back to the login door. */
  function openForgotFlow() {
    var h = '<div class="hint">' + esc(T('reg|通过邮箱验证码重置密码')) + '</div>' +
      '<div class="rowline" style="margin-top:10px"><span>' + esc(T('reg|邮箱')) + '</span>' +
      '<input type="text" id="fpEmail" style="flex:1">' +
      '<button class="sec" id="fpSend">' + esc(T('reg|发送验证码')) + '</button></div>' +
      '<div class="rowline"><span>' + esc(T('reg|验证码')) + '</span>' +
      '<input type="text" id="fpCode" style="flex:1" maxlength="6"></div>' +
      '<div class="rowline"><span>' + esc(T('reg|新密码')) + '</span>' +
      '<input type="password" id="fpPw" style="flex:1"><span class="pwbar" id="fpBar"></span></div>' +
      '<div class="rowline"><span>' + esc(T('reg|确认密码')) + '</span>' +
      '<input type="password" id="fpPw2" style="flex:1"></div>' +
      '<div class="hint" id="fpErr" style="margin-top:8px"></div>';
    openModal(T('reg|重置密码'), h, function (bd) {
      var err = bd.querySelector('#fpErr');
      wireSendCode(bd.querySelector('#fpEmail'), bd.querySelector('#fpSend'), err);
      var bar = bd.querySelector('#fpBar');
      var paint = function () { paintStrengthBar(bar, GMAuth.passwordStrength(bd.querySelector('#fpPw').value)); };
      bd.querySelector('#fpPw').addEventListener('input', paint);
      paint();
      var go = document.createElement('button');
      go.textContent = T('reg|重置密码');
      go.onclick = async function () {
        go.disabled = true;
        var r = await GMAuth.resetPassword({
          email: bd.querySelector('#fpEmail').value,
          emailCode: bd.querySelector('#fpCode').value,
          password: bd.querySelector('#fpPw').value,
          confirm: bd.querySelector('#fpPw2').value,
        });
        go.disabled = false;
        if (!r.ok) { err.textContent = cloudErrText(r.error); return; }
        closeAllModals();
        openLoginFlow(T('reg|密码已重置，请使用新密码登录'));
      };
      var ft = bd.closest('.modal').querySelector('.ft');
      ft.insertBefore(go, ft.querySelector('[data-close]'));
    });
  }

  // One entry point for 「the account state changed」, whether from 激活 / 注册 / 登录 / 登出 / 注销 or
  // from a boot-time renewal that discovered a revoked code. Repainting from a single place is what
  // keeps the nav, the gate, the settings panel and the two account pages from disagreeing.
  async function afterAuthChange() {
    S = await G.loadSettings();
    applyActivationGate();
    await buildCloudPanel();
    // `profileLoad` first: it sets `PFC.devices`, which `buildAccountPanel` reads.
    await profileLoad();
    buildAccountPanel();
    renderAdmin();
    renderPrivacyLink();
  }

  function renderPrivacyLink() {
    if ($('privacyLabel')) $('privacyLabel').textContent = T('viewer|隐私政策');
    var el = $('privacyLink');
    if (!el) return;
    // §9.3 wants a link. With no address supplied the honest render is the placeholder text rather
    // than an anchor that 404s — and the anchor is built with the DOM API, not `innerHTML`, because
    // the address is a variable and this project does not paste variables into markup.
    if (!PRIVACY_URL) { el.textContent = T('viewer|尚未提供'); return; }
    el.textContent = '';
    var a = document.createElement('a');
    a.href = PRIVACY_URL;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // The full URL is long and wraps badly in a settings row; the host+path is unambiguous and fits.
    a.textContent = PRIVACY_URL.replace(/^https?:\/\//, '');
    a.title = PRIVACY_URL;
    el.appendChild(a);
  }

  /**
   * The boot half of the cloud feature. Called once, at the very end of `boot()`.
   *
   * Order matters twice here:
   *   · `GMAuth.boot()` runs BEFORE the first render — it is what performs §3.4's 「每次启动尝试续期」
   *     and it can also CLEAR the session (a revoked code answers 401). Painting first and then
   *     discovering there is no account would flash an activated UI at somebody who is not.
   *   · `onChange` is subscribed AFTER that, so the renewal's own `emit()` does not re-enter the
   *     render path we are already in. From then on the listener is the single funnel for 「the
   *     account changed」, whether the change came from this page or from a token that turned out to
   *     be dead.
   */
  async function cloudBoot() {
    renderPrivacyLink();
    try { await GMAuth.boot(); } catch (e) { /* a dead network is an expected outcome, not a failure */ }
    applyActivationGate();
    await buildCloudPanel();
    await profileLoad();
    buildAccountPanel();
    renderAdmin();
    GMAuth.onChange(function () { afterAuthChange(); });

    // §1.2's 升级引导: 「0.5.x 用户升级到 1.0.0 后，首次启动弹出引导」. Two conditions now, and both
    // are load-bearing — an operator who can already use everything has answered the question, and
    // `guideSeen` is what stops 「暂不」 from being asked again on every single boot.
    // 1.0.1 — the test is the GATE rather than `status().configured && !isActivated()`, so the modal
    // and the nav cannot disagree about whether this operator is locked out. It also means the
    // shipped unconfigured build never opens it, which is 1.0.0's 「没有后端就没有什么可激活」.
    if (!GMAuth.gateOpen() && !S.cloud.guideSeen) {
      var next = Object.assign({}, S.cloud, { guideSeen: true });
      S.cloud = next;
      await G.saveSetting('cloud', next);
      openActivationGuide();
    }
  }

  // =====================================================================
  // 检测（原 localhost 版）
  // =====================================================================
  var SAMPLES = {
    s1: 'h8i9i8h7g10g8f10h10g11h9h12i13g9e11f9f7i7j6e6i10j11h11d9c9d10i12i11g12d8e9d7d11d6',
    s2: 'h8i9i8j8h10h9g9i7f8e7g8e8g10g7f10e10e11d12g11g12i11j12f11h11f9f7f12',
    s3: 'h8g7i7g9i6g6g5i5h5h6f8i8f5j7h9j6j5k7h4l8m9g8g10k8j8k9k10k6k5l7m7l5m4l6l4l9',
  };

  var report = null;
  // 0.3.4: curStep is a CURSOR into the draft record (0..draftMoves.length), not a window onto
  // the report. It says how many draft slots are "played" — stones at index >= curStep are
  // drawn ghosted as a variant preview. Two consequences the old code did not have:
  //   · the board always draws the WHOLE draft, so a report that stopped early can no longer
  //     make the record look like it lost its later moves;
  //   · navigation works with or without a report, which is what makes 回溯-then-edit possible.
  var curStep = 0;
  var draftMoves = [];              // [{c:[x,y], s:'player'|'ai-suggest'}]
  // 0.3.4: a stack of whole-draft SNAPSHOTS taken before every structural edit (落子/分支/悔一手/
  // 截断/清空/AI 参考手). A misclick on the board used to destroy the rest of the game
  // irreversibly. Storing the snapshot rather than just the dropped tail is deliberate — see
  // snapshot() below.
  var undoStack = [];
  var engineBusy = false;
  // 0.4.11 §一.2 — `pauseCtrl._resume` still serves the LIVE 逐步检测 queue, which runs here (it
  // just stops asking for the next step). `jobId` is the other half: a one-shot 全局分析 / AI
  // 分析 runs INSIDE the offscreen document, and the only way to reach its pauseCtrl is
  // gm-pause / gm-resume.
  var pauseCtrl = { paused: false, _resume: null, jobId: null };
  var detectMode = 'global';
  var stepQueue = [];
  // The offscreen live-session id for the current 逐步检测 run (0.4.11 §一.2). One session
  // accumulates one step per played move and answers gm-step-finish with the full report.
  var liveStepJobId = null;
  var stepwiseRunning = false;
  var lastMoveTime = 0;
  var aiThinkDirty = false;
  var lastDetectRecord = null;
  // 0.3.3: the learnedParams blob this session detected with (null = 0.3.1 defaults). Read
  // once at boot and after every 重新学习, so the whole page agrees on one parameter set.
  var curLearned = null;

  document.querySelectorAll('.tab[data-panel]').forEach(function (t) {
    t.onclick = function () {
      document.querySelectorAll('.tab[data-panel]').forEach(function (x) { x.classList.remove('active'); });
      document.querySelectorAll('.tabpane').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      $('pane-' + t.dataset.panel).classList.add('active');
    };
  });
  document.querySelectorAll('.tab[data-mode]').forEach(function (t) {
    t.onclick = function () { switchMode(t.dataset.mode); };
  });

  function switchMode(mode) {
    if (mode === detectMode) return;
    if (engineBusy || stepQueue.length) {
      if (!confirm(T('viewer|当前有未完成的检测任务，切换模式将清空报告和队列。继续？'))) return;
    }
    detectMode = mode;
    document.querySelectorAll('.tab[data-mode]').forEach(function (x) {
      x.classList.toggle('active', x.dataset.mode === mode);
    });
    $('run').style.display = (mode === 'global') ? '' : 'none';
    setStatus(mode === 'stepwise' ? T('viewer|逐步检测中…（落子即分析）') : T('viewer|就绪'));
    resetReport();
  }

  $('thinkMs').oninput = function () {
    if (!aiThinkDirty) $('aiThinkMs').value = $('thinkMs').value;
  };
  $('aiThinkMs').oninput = function () { aiThinkDirty = true; };

  // The inline detect controls edit the same settings the panel and 设置 tab do.
  $('suspect').onchange = function () { G.saveSetting('suspect', $('suspect').value).then(function (v) { S = v; }); };
  $('thinkMs').onchange = function () {
    G.saveSetting('thinkMs', Math.max(500, parseInt($('thinkMs').value, 10) || 2000)).then(function (v) { S = v; });
  };
  $('openCut').onchange = function () {
    var n = parseInt($('openCut').value, 10);
    G.saveSetting('openingCutoff', isNaN(n) ? 8 : Math.max(0, Math.min(40, n))).then(function (v) { S = v; });
  };
  $('aiThinkMs').onchange = function () {
    var raw = String($('aiThinkMs').value).trim();
    G.saveSetting('aiThinkMs', raw === '' ? null : (parseInt(raw, 10) || null)).then(function (v) { S = v; });
  };
  $('applySettings').onclick = function () {
    syncDetectControls();
    setStatus(T('viewer|已套用存储中的设置'));
  };

  $('s1').onclick = function () { $('input').value = SAMPLES.s1; syncDraftFromText(); };
  $('s2').onclick = function () { $('input').value = SAMPLES.s2; syncDraftFromText(); };
  $('s3').onclick = function () { $('input').value = SAMPLES.s3; syncDraftFromText(); };

  function syncDraftFromText() {
    try {
      var rec = parseRecord($('input').value);
      draftMoves = rec.moves.map(function (c) { return { c: c, s: 'player' }; });
    } catch (e) { draftMoves = []; }
    curStep = draftMoves.length;
    undoStack = [];
    resetReport();
    drawDetectBoard();
  }
  $('input').oninput = syncDraftFromText;

  function draftOccupied(gx, gy) { return draftMoves.some(function (m) { return m.c[0] === gx && m.c[1] === gy; }); }
  function draftString() { return draftMoves.map(function (m) { return coordToShare(m.c); }).join(''); }

  // ---- 0.3.4 editing primitives (all cursor-relative) -------------------
  // Everything the operator does on the board now happens AT THE CURSOR instead of only at the
  // end of the record, and every structural edit first pushes a SNAPSHOT of the whole draft.
  //
  // A snapshot (not just the dropped tail) is the only correct undo here: restoring by
  // re-appending the dropped tail gave 27 moves for a 26-move record, because the branching
  // move itself is still on the board. Copying a ≤40-entry array is free, and "the state before
  // the last change" is exactly what an operator means by 撤销.
  var UNDO_MAX = 32;
  function snapshot(why) {
    undoStack.push({ moves: draftMoves.slice(), at: curStep, why: why || '' });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  function dropTail(from, why) {
    if (from >= draftMoves.length) return 0;
    var n = draftMoves.length - from;
    draftMoves = draftMoves.slice(0, from);
    $('input').value = draftString();
    if (why) setStatus(T('viewer|已在第 {from} 手分支：原后续 {n} 手转为变体预览（可「撤销改动」找回）', { from: from, n: n }));
    return n;
  }

  function undoOne() {                     // 悔一手 — undo the move the cursor sits on
    if (!draftMoves.length) { setStatus(T('viewer|棋盘已空')); return; }
    var at = Math.max(1, Math.min(curStep, draftMoves.length));
    snapshot(T('viewer|悔一手'));
    dropTail(at - 1, null);
    curStep = draftMoves.length;
    resetReport();
    renderBoardView();
  }

  function undoChange() {                  // 撤销改动 — restore the state before the last edit
    if (!undoStack.length) { setStatus(T('viewer|没有可撤销的改动')); return; }
    var snap = undoStack.pop();
    draftMoves = snap.moves;
    $('input').value = draftString();
    curStep = draftMoves.length;
    resetReport();
    renderBoardView();
    setStatus(T('viewer|已撤销{what}，棋谱回到 {n} 手', {
      what: snap.why ? T('viewer|「{why}」', { why: snap.why }) : T('viewer|上一步改动'),
      n: draftMoves.length,
    }));
  }
  $('undoChange').onclick = undoChange;

  function truncateToCursor() {            // 截断到光标 — drop everything after the cursor
    if (curStep >= draftMoves.length) { setStatus(T('viewer|光标已在末手，无需截断')); return; }
    var at = curStep;
    snapshot(T('viewer|截断到光标'));
    var n = dropTail(at, null);
    resetReport();
    renderBoardView();
    setStatus(T('viewer|已截断到第 {at} 手，移除 {n} 手（可「撤销改动」找回）', { at: at, n: n }));
  }
  $('truncateHere').onclick = truncateToCursor;

  function boardPoint(e) {
    var cv = $('board');
    var rect = cv.getBoundingClientRect();
    var px = (e.clientX - rect.left) * (cv.width / rect.width);
    var py = (e.clientY - rect.top) * (cv.height / rect.height);
    var pad = cv.width / (SIZE + 1);
    var gx = Math.round((px - pad) / pad);
    var gy = Math.round((py - pad) / pad);
    if (gx < 0 || gx >= SIZE || gy < 0 || gy >= SIZE) return null;
    return [gx, gy];
  }

  $('board').addEventListener('click', function (e) {
    // 0.3.4: no more `if (report) return`. Editing stays live after detection — that is the
    // whole point of 三.2. The only time the board is read-only is while the engine is busy.
    if (engineBusy || stepwiseRunning) { setStatus(T('viewer|检测进行中，暂不能改盘（可先暂停）')); return; }
    var pt = boardPoint(e);
    if (!pt) return;
    var gx = pt[0], gy = pt[1];
    var idx = draftMoves.findIndex(function (m) { return m.c[0] === gx && m.c[1] === gy; });
    if (idx >= 0) {
      if (draftMoves[idx].s === 'ai-suggest') {
        // Promote the AI reference stone into a real move and put the cursor just after it.
        snapshot(T('viewer|AI 参考手转实际手'));
        draftMoves[idx].s = 'player';
        $('input').value = draftString();
        curStep = idx + 1;
        resetReport();
        onPlayerMove();
      } else {
        // 0.3.4: clicking a played stone now MOVES THE CURSOR there instead of truncating.
        // Truncating on a single click was the reason 回溯 felt like it could only be looked
        // at: one stray click silently deleted the rest of the game. To branch, click an
        // empty point while the cursor sits before the end.
        curStep = idx + 1;
        drawDetectBoard();
        renderBoardView();
        setStatus(T('viewer|光标移到第 {n} 手', { n: idx + 1 }) +
          (curStep < draftMoves.length ? T('viewer|，点空点即可在此打出变体') : ''));
        return;
      }
    } else {
      // Play at the cursor. If the cursor is not at the end this is a BRANCH: the old
      // continuation is dropped and drawn as a ghost preview until re-analysed.
      snapshot(curStep < draftMoves.length ? T('viewer|分支') : T('viewer|落子'));
      if (curStep < draftMoves.length) dropTail(curStep, true);
      draftMoves = draftMoves.slice(0, curStep);
      draftMoves.push({ c: [gx, gy], s: 'player' });
      $('input').value = draftString();
      curStep = draftMoves.length;
      resetReport();
      onPlayerMove();
    }
    renderBoardView();
  });
  $('board').addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (engineBusy || stepwiseRunning) return;
    undoOne();
  });
  $('undoBoard').onclick = function () { if (!engineBusy && !stepwiseRunning) undoOne(); };
  $('clearAll').onclick = function () {
    if (engineBusy || stepwiseRunning) return;
    if (!draftMoves.length) { setStatus(T('viewer|棋盘已空')); return; }
    snapshot(T('viewer|清空'));
    $('input').value = ''; draftMoves = []; curStep = 0;
    resetReport(); renderBoardView();
    setStatus(T('viewer|已清空棋盘（可「撤销改动」找回）'));
  };

  function onPlayerMove() { if (detectMode === 'stepwise') enqueueStep(); }

  function resetReport() {
    report = null; stepQueue = []; lastDetectRecord = null;
    // 0.4.11 §一.2 — a 逐步检测 run's engine-side session lives in the offscreen document, keyed
    // by jobId, and it remembers every coordinate it has already scored. Dropping the local
    // report without closing it would leave a session that answers a REPLAYED coordinate with
    // the OLD verdict (doStep de-duplicates on x,y). Close it; the next move opens a fresh one.
    if (liveStepJobId) {
      askOffscreen({ type: 'gm-step-finish', jobId: liveStepJobId }).catch(function () {});
      liveStepJobId = null;
    }
    $('scores').innerHTML = '<div class="hint">' + T('viewer|分析后显示') + '</div>';
    $('contrib').innerHTML = '';
    $('summary').innerHTML = '—';
    document.querySelector('#tbl tbody').innerHTML = '';
    setProgress(0, '');
    // 0.3.4: the slider range belongs to the DRAFT, not to the report — clearing the report
    // must not strand the operator with a dead step bar. renderBoardView() re-syncs it.
    renderBoardView();
  }

  function setPauseLabel() {
    var b = $('pauseBtn');
    if (engineBusy || stepwiseRunning) {
      b.disabled = false;
      b.textContent = pauseCtrl.paused ? T('viewer|▶ 继续') : T('viewer|⏸ 暂停检测');
    } else {
      b.disabled = true;
      b.textContent = T('viewer|⏸ 暂停');
      pauseCtrl.paused = false;
    }
  }
  $('pauseBtn').onclick = function () {
    if (!engineBusy && !stepwiseRunning) return;
    pauseCtrl.paused = !pauseCtrl.paused;
    if (pauseCtrl.jobId) {
      // 0.4.11 §一.2: the job is inside the offscreen document. `pauseCtrl` there holds the
      // `_resume` function that no message can carry, so pausing is a request, not a flag flip.
      askOffscreen({ type: pauseCtrl.paused ? 'gm-pause' : 'gm-resume', jobId: pauseCtrl.jobId })
        .catch(function () {});
    } else if (!pauseCtrl.paused && pauseCtrl._resume) {
      var r = pauseCtrl._resume; pauseCtrl._resume = null; r();
    }
    setPauseLabel();
  };
  $('jumpStep').onchange = function () {
    // 0.3.4: navigating no longer requires a report — the record itself is what you scrub.
    curStep = clamp(parseInt($('jumpStep').value, 10) || 0, 0, draftMoves.length);
    renderBoardView();
  };

  $('aiThink').onclick = async function () {
    if (engineBusy || stepwiseRunning) { alert(T('viewer|检测正在进行中，请先暂停或等待。')); return; }
    engineBusy = true; setPauseLabel();
    setStatus(T('viewer|AI 思考中...'));
    try {
      var thinkMs = parseInt($('aiThinkMs').value, 10) || 2000;
      var nbest = clamp(parseInt($('aiNbest').value, 10) || 1, 1, 32);
      // 0.4.11 §一.2 — one analyzePosition on the SHARED engine. It is queued behind any running
      // analysis, which is not a courtesy: analyzePosition swaps `worker.onmessage`, so two
      // overlapping calls would hand each other's output to the wrong resolver.
      var resp = await askOffscreen({
        type: 'gm-ai-think',
        jobId: gmJobId('think'),
        // 0.5.1 §2.1.4 — the operator's model, the same key the panel and the analysis jobs read.
        engineId: S.engineId,
        prefix: draftMoves.map(function (m) { return m.c; }),
        nbest: nbest,
        thinkMs: thinkMs,
        rule: parseInt($('rule').value, 10),
        threadNum: S.threadNum,
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || T('viewer|offscreen 文档没有响应（检查扩展是否已重新加载）'));
      var res = { best: resp.best, candidates: resp.candidates || [] };
      if (!draftOccupied(res.best[0], res.best[1])) {
        snapshot(T('viewer|AI 参考手'));
        draftMoves.push({ c: res.best.slice(), s: 'ai-suggest' });
        curStep = draftMoves.length;
        $('input').value = draftString();
        resetReport();
      }
      setStatus(T('viewer|AI 建议: {move}', { move: coordToShare(res.best) }) +
        (res.candidates[0] && res.candidates[0].winrate != null
          ? T('viewer|  胜率{p}', { p: pct(res.candidates[0].winrate) }) : ''));
    } catch (e) {
      setStatus(T('viewer|AI 思考失败: {err}', { err: TE(e.message) }));
    } finally {
      engineBusy = false; setPauseLabel();
      renderBoardView();
    }
  };

  function currentRecord() {
    // The colour of every board slot, derived the same way the board renderer does
    // (alternation over PLAYED moves). Carrying it lets the analysis verify the order and
    // lets the replay board repaint from the recorded colour instead of re-deriving it.
    var stones = [], playedBefore = 0;
    draftMoves.forEach(function (m) {
      stones.push(playedBefore % 2 === 0 ? 1 : 2);
      if (m.s !== 'ai-suggest') playedBefore++;
    });
    return {
      moves: draftMoves.map(function (m) { return m.c; }),
      stones: stones,
      sources: draftMoves.map(function (m) { return m.s; }),
      times: draftMoves.map(function () { return null; }),
      meta: { source: 'manual', rule: RULE_NAME[parseInt($('rule').value, 10)] || 'freestyle' },
    };
  }

  // A side's risk score as a notice prints it. An integer, because the score is a percentage
  // and the archive stores one; a missing side reads 0, the same default `shouldSkipArchive`
  // and the archive grid's `Math.max` both use.
  function riskText(side) {
    return String(Math.round(side && isFinite(side.risk) ? side.risk : 0));
  }

  $('run').onclick = async function () {
    var text = $('input').value.trim();
    if (!text) { alert(T('viewer|请先粘贴或选择棋谱')); return; }
    var rec;
    try { rec = parseRecord(text); } catch (e) { alert(T('viewer|解析失败: {err}', { err: TE(e.message) })); return; }
    rec.sources = draftMoves.map(function (m) { return m.s; });
    rec.moves = draftMoves.map(function (m) { return m.c; });
    // Re-derive the colours against the DRAFT (which may interleave AI reference stones)
    // rather than the plain parse, so `stones` always lines up with `moves`.
    rec.stones = currentRecord().stones;
    if (rec.moves.length < 5) { alert(T('viewer|有效手数过少: {n}', { n: rec.moves.length })); return; }
    $('run').disabled = true; engineBusy = true; setPauseLabel();
    // 0.5.3 §1.2.3 — the run can take a minute and the operator is usually looking at the step
    // table, not at the status line at the top of the page. A toast is the only notice that
    // neither blocks them nor goes unseen. The three ALERTS above stay as they are: an empty
    // textarea is something the operator must fix before anything can proceed, and that wants an
    // acknowledgement, whereas a failed engine run wants to be told and then got on with.
    GmToast.show(T('toast|分析开始'), 'info');
    var jid = gmJobId('global');
    pauseCtrl.jobId = jid; pauseCtrl.paused = false;
    jobSinks[jid] = setProgress;
    try {
      // 0.4.11 §一.2 — the analysis runs in the offscreen document, on the one engine. The
      // learned parameters go with the request for the same reason as before: the run and the
      // incremental recompute must not drift apart mid-analysis.
      var resp = await askOffscreen({
        type: 'gm-analyze',
        jobId: jid,
        record: rec,
        opts: {
          rule: parseInt($('rule').value, 10),
          thinkMs: parseInt($('thinkMs').value, 10),
          openingCutoff: parseInt($('openCut').value, 10),
          suspect: $('suspect').value,
          threadNum: S.threadNum,
          learned: curLearned,
          // 0.5.1 §2.1.4 — the model the operator picked. The offscreen document owns the engine,
          // so the choice has to travel with the job; it also means switching models mid-session
          // rebuilds the engine exactly once, on the next job.
          engineId: S.engineId,
        },
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || T('viewer|offscreen 文档没有响应（检查扩展是否已重新加载）'));
      report = resp.report;
      renderReport();
      await archiveCurrent('global');
      // §1.2.3 — both scores in the notice, because "分析完成" alone would send the operator
      // hunting for the two numbers it just computed.
      GmToast.show(T('toast|分析完成 · 黑 {b} 白 {w}', {
        b: riskText(report && report.black), w: riskText(report && report.white),
      }), 'success');
    } catch (e) {
      setStatus(T('viewer|引擎错误: {err}', { err: TE(e.message) }));
      GmToast.show(T('toast|分析失败：{err}', { err: TE(e.message) }), 'error');
    } finally {
      delete jobSinks[jid];
      pauseCtrl.jobId = null;
      $('run').disabled = false; engineBusy = false; setPauseLabel();
    }
  };

  // 存档：detect tab analyses are archived too, so the replay list is the single
  // history for both the page panel and this page.
  // 0.5.3 §2.2.3 — `opts.manual` is the whole distinction §2.2.5 draws: the AUTOMATIC archives
  // (the one that follows an analysis, and the one that ends a stepwise session) honour the
  // operator's filter, while the 「存为存档」 button deliberately ignores it. An explicit action
  // must never be silently swallowed by a rule the operator set for automatic behaviour.
  async function archiveCurrent(mode, opts) {
    if (!report) return null;
    var manual = !!(opts && opts.manual);
    // A null aggregate is a legitimate outcome (nothing survived the filters), not a
    // reason to throw the game away — the record and the per-move verdicts are still
    // worth replaying. Only a report with no verdicts at all is refused.
    if (!anyAggregate(report) && !(report.steps || []).length) return null;
    // Read BEFORE the two gates rather than after them: §一.4's count filter is a question about
    // the RECORD (how much of it has a move order), and it is asked first, so the record has to
    // exist before the first early return. It used to be built at the bottom because nothing
    // above it needed it.
    var rec = currentRecord();
    // 0.5.4 §一.4 — 存储过滤, judged BEFORE the AI-rate filter, exactly as the overlay does it:
    // a game we barely captured says nothing about either player whatever its score came out as.
    // `manual` exempts it for the same reason the risk filter is exempt (§2.2.5) — 「存为存档」
    // is an explicit action and silently discarding it is worse than a prompt.
    if (!manual) {
      var countSkip = G.shouldSkipByCounts(rec, report, S.storageFilter);
      if (countSkip) {
        setStatus(countSkip.reason === 'ordered-too-few'
          ? T('viewer|有序手仅 {n} 手（低于 {min} 手），未存档。',
              { n: countSkip.ordered, min: countSkip.min })
          : T('viewer|无序手 {n} 手（高于 {max} 手），未存档。',
              { n: countSkip.unordered, max: countSkip.max }));
        return null;
      }
    }
    // §2.2.2 — the filter is judged on the HIGHER of the two sides, so a game where only one
    // side is suspicious is filtered on that side rather than on the average.
    if (!manual && G.shouldSkipArchive(report, S.archiveFilter)) {
      var f = G.normalizeArchiveFilter(S.archiveFilter);
      var skipRisk = Math.round(Math.max(
        report.black ? (report.black.risk || 0) : 0,
        report.white ? (report.white.risk || 0) : 0));
      // A status line rather than a toast: this is the ordinary outcome of a setting the
      // operator chose, not an event that needs to interrupt them. §2.2.3's own snippet writes
      // it into the job's note for the same reason, and the wording is IDENTICAL to the
      // overlay's (`panel|…`) on purpose — the dictionary is keyed by text, so one row
      // translates both and the two surfaces cannot drift apart.
      setStatus(T('viewer|AI 率 {r}% 在过滤范围内（{min}%–{max}%），未存档。',
        { r: skipRisk, min: f.minRisk, max: f.maxRisk }));
      return null;
    }
    var minMoves = G.clampMinMoves(S.minArchiveMoves);
    // 0.3.4: this test must use the length of the RECORD, not the number of hands that happened
    // to get scored. app.js is explicit that `totalMoves` is "only the hands we actually scored"
    // when a live four cut detection short — so a legitimate 26-hand game stopped at move 3 was
    // announced as 「这一局只有 3 手」, which is the 棋谱落子数过少 prompt in the bug report.
    // originalTotalMoves is the true game length and is what a "too short" test actually means.
    var scored = report.totalMoves || 0;
    var total = report.originalTotalMoves || rec.moves.length || scored || 0;
    // The short-game threshold exists to keep an aborted 6-move game out of the history.
    // Here the operator entered the record and pressed 存为存档 on purpose, so it asks
    // instead of refusing — silently discarding an explicit action is worse than a prompt.
    if (total < minMoves &&
        !confirm(T('viewer|对局过短：这一局只有 {total} 手（少于设定的 {min} 手）。\n\n仍然存档吗？',
                  { total: total, min: minMoves }))) {
      setStatus(T('viewer|未存档（对局过短：{total} / {min} 手）', { total: total, min: minMoves }));
      return null;
    }
    var entry = G.buildArchive({
      report: report,
      record: rec,
      players: { black: null, white: null, self: null, opponent: null },
      mode: mode,
      rule: rec.meta.rule,
      suspect: $('suspect').value,
    });
    await G.saveArchive(entry);
    setStatus(T('viewer|已存档：{name}', { name: entry.name }));
    return entry;
  }
  $('saveArchive').onclick = async function () {
    if (!report) { alert(T('viewer|先完成一次分析。')); return; }
    await archiveCurrent(detectMode === 'stepwise' ? 'stepwise' : 'global', { manual: true });
  };

  // ---- stepwise ----
  function enqueueStep() {
    var prefixMoves = draftMoves.map(function (m) { return m.c; });
    var playerIdx = draftMoves.filter(function (m) { return m.s === 'player'; }).length - 1;
    var interval = lastMoveTime ? (performance.now() - lastMoveTime) : 2000;
    lastMoveTime = performance.now();
    var cap = parseInt($('thinkMs').value, 10);
    var thinkMs = Math.min(cap, Math.max(2000, interval));
    // 0.3.4: colours for the live-four shape test. Same rule as detectView — an AI reference
    // stone occupies a slot without consuming a turn, so it belongs to the side about to move.
    var playedBefore = 0;
    var board = draftMoves.map(function (m) {
      var side = (playedBefore % 2 === 0) ? 'B' : 'W';
      if (m.s !== 'ai-suggest') playedBefore++;
      return { x: m.c[0], y: m.c[1], side: side };
    });
    stepQueue.push({
      prefixMoves: prefixMoves, playerIdx: playerIdx, thinkMs: thinkMs,
      actual: draftMoves[draftMoves.length - 1].c, board: board,
    });
    if (!stepwiseRunning) runStepQueue();
  }

  async function runStepQueue() {
    stepwiseRunning = true; setPauseLabel();
    var started = false;
    try {
      while (stepQueue.length) {
        // The live queue runs HERE, so its pause is simply "do not ask for the next step" — the
        // shared engine is left free for everything else (0.4.11 §一.2).
        if (pauseCtrl.paused) await new Promise(function (r) { pauseCtrl._resume = r; });
        var task = stepQueue.shift();
        setStatus(T('viewer|逐步检测中… 队列剩余 {n}（本手 {ms}ms）', { n: stepQueue.length + 1, ms: task.thinkMs }));
        if (!liveStepJobId) liveStepJobId = gmJobId('step');
        var boardSides = task.board.map(function (b) { return b.side; });
        var resp = await askOffscreen({
          type: 'gm-step',
          jobId: liveStepJobId,
          reset: !started,
          prefix: task.prefixMoves.slice(0, -1),
          // Whole-board colours (0.4.11 §一.1), so the shape test sees real sides instead of
          // index parity — an AI reference stone occupies a slot without consuming a turn.
          boardSides: boardSides,
          actual: task.actual,
          playerIdx: task.playerIdx,
          side: boardSides[boardSides.length - 1],
          // The draft carries NO timing data, so `recorded` stays null and the report keeps
          // saying 固定预算. The per-hand budget rides in opts.thinkMs, which is exactly what
          // stepBudget() falls back to when recordedMs is null — the minimum(interval, cap) the
          // old local loop computed is therefore preserved without lying about having timings.
          recorded: null,
          prejoinCount: 0,
          opts: {
            rule: parseInt($('rule').value, 10),
            thinkMs: task.thinkMs,
            openingCutoff: parseInt($('openCut').value, 10),
            threadNum: S.threadNum,
            learned: curLearned,
            engineId: S.engineId,
          },
        });
        started = true;
        if (resp && !resp.ok && resp.ended) {
          // 活四停止 reached the offscreen live session: the analysis is over, the game is not.
          // Same terminal semantics as the panel — stop asking, keep what was scored.
          stepQueue.length = 0;
          break;
        }
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || T('viewer|offscreen 文档没有响应（检查扩展是否已重新加载）'));
        if (!report) report = { steps: [], hasTime: false, suspect: $('suspect').value, totalMoves: 0, opts: {}, black: null, white: null, forcedCount: 0 };
        report.steps.push(resp.step);
        report.totalMoves = report.steps.length;
        renderReportIncremental();
      }
      if (report && liveStepJobId) {
        // The session — not this page — is the authority on the finished report: it has run
        // markEvasion / markFourRuns / recordPrevBestWR over the whole step array, which the
        // incremental renderer deliberately does not. Rendering that report also fixes the one
        // place the two used to disagree (the rows above were scored without those passes).
        var fin = await askOffscreen({ type: 'gm-step-finish', jobId: liveStepJobId });
        liveStepJobId = null;
        if (fin && fin.ok && fin.report) { report = fin.report; renderReport(); }
        await archiveCurrent('stepwise');
      }
    } catch (e) {
      setStatus(T('viewer|逐步检测错误: {err}', { err: TE(e.message) }));
    } finally {
      stepwiseRunning = false; setPauseLabel();
      setStatus(T('viewer|逐步检测空闲'));
    }
  }

  // ---- board drawing ----
  // One painter for every board on this page. `view`:
  //   stones: [{x, y, side:'B'|'W', moveNo:number|null, ref:bool}]
  //   marks:  [{x, y, color, r}]   rings drawn over the stones (flag / desperate)
  //   last:   [x, y] | null
  function drawBoard(cv, view) {
    var ctx = cv.getContext('2d');
    var W = cv.width, pad = W / (SIZE + 1), cell = pad;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#c9a227'; ctx.fillRect(0, 0, W, W);
    ctx.strokeStyle = '#5a4410'; ctx.lineWidth = 1;
    for (var i = 0; i < SIZE; i++) {
      ctx.beginPath(); ctx.moveTo(pad, pad + i * cell); ctx.lineTo(pad + (SIZE - 1) * cell, pad + i * cell); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad + i * cell, pad); ctx.lineTo(pad + i * cell, pad + (SIZE - 1) * cell); ctx.stroke();
    }
    ctx.fillStyle = '#5a4410';
    [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]].forEach(function (p) {
      ctx.beginPath(); ctx.arc(pad + p[0] * cell, pad + p[1] * cell, 3, 0, 7); ctx.fill();
    });

    (view.stones || []).forEach(function (s) {
      var px = pad + s.x * cell, py = pad + s.y * cell;
      var black = s.side === 'B';
      ctx.beginPath(); ctx.arc(px, py, cell * 0.42, 0, 7);
      ctx.fillStyle = black ? '#111' : '#f5f5f5';
      // 0.3.4: a ghost stone lies BEYOND the cursor — it is part of the record but not part of
      // the position being shown, so it is drawn faint and unnumbered. This is what lets the
      // board show the whole game while still making 回溯 legible.
      if (s.ref) ctx.globalAlpha = 0.45;
      else if (s.ghost) ctx.globalAlpha = 0.22;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = black ? '#000' : '#999'; ctx.lineWidth = 1; ctx.stroke();
      if (s.ghost) {
        ctx.beginPath(); ctx.arc(px, py, cell * 0.42, 0, 7);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#7f8c8d'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.setLineDash([]);
      } else if (s.ref) {
        ctx.beginPath(); ctx.arc(px, py, cell * 0.55, 0, 7);
        ctx.strokeStyle = '#3c5ee7'; ctx.lineWidth = 2.5; ctx.stroke();
      } else if (s.unordered) {
        // Order-unknown stone (recovered from a board render when we joined mid-game). The
        // number stays — it is the board label the step table uses — but it is greyed and
        // ringed with a dashed grey circle, because this stone has no real place in the
        // move order and must not read like one. Hovering it says so in words.
        ctx.fillStyle = black ? '#b9c2cc' : '#6b7a8c';
        ctx.font = (cell * 0.32) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(s.moveNo, px, py);
        ctx.beginPath(); ctx.arc(px, py, cell * 0.52, 0, 7);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#8b98a5'; ctx.lineWidth = 2.5; ctx.stroke();
        ctx.setLineDash([]);
      } else if (s.moveNo != null) {
        ctx.fillStyle = black ? '#fff' : '#000';
        ctx.font = (cell * 0.32) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(s.moveNo, px, py);
      }
      // 0.3.4: the cursor — the stone the step bar is parked on. Green so it cannot be confused
      // with a red 可疑 flag, an orange 将败 ring or a blue AI-reference ring.
      if (s.cursor) {
        ctx.beginPath(); ctx.arc(px, py, cell * 0.56, 0, 7);
        ctx.strokeStyle = '#1f9d55'; ctx.lineWidth = 3; ctx.stroke();
      }
    });

    (view.marks || []).forEach(function (m) {
      var px = pad + m.x * cell, py = pad + m.y * cell;
      ctx.beginPath(); ctx.arc(px, py, cell * (m.r || 0.5), 0, 7);
      ctx.setLineDash(m.dash ? [4, 3] : []);
      ctx.strokeStyle = m.color; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.setLineDash([]);
    });

    if (view.last) {
      var lx = pad + view.last[0] * cell, ly = pad + view.last[1] * cell;
      ctx.beginPath(); ctx.arc(lx, ly, cell * 0.12, 0, 7);
      ctx.fillStyle = '#e74c3c'; ctx.fill();
    }
  }

  // 0.3.4 — the board view is now built from the DRAFT ONLY, and always at full length.
  //
  // The old version clipped the loop to `curStep` and only while a report existed
  // (`showCount = (report && detectMode === 'global') ? curStep : draftMoves.length`). Combined
  // with `renderReport()` setting curStep = report.steps.length, a report that stopped at move 3
  // made a 26-move record render as 3 stones — the operator's 「棋子只剩下最开始的 3 手」. It also
  // meant the board could not be navigated or edited without a report.
  //
  // Now: every draft slot is drawn, always. Slots at index >= curStep are ghosted (see drawBoard)
  // so 回溯 stays readable, and the cursor stone gets a ring. Marks follow the cursor by SLOT
  // INDEX rather than by moveNo, because report.steps[k] lines up with draftMoves[k] in global
  // mode — the two only diverge once AI reference stones are interleaved.
  function detectView() {
    var stones = [];
    var playedBefore = 0;
    for (var i = 0; i < draftMoves.length; i++) {
      // The side of slot i is decided by how many PLAYED moves precede it — an AI
      // reference stone occupies a board slot without consuming a turn, so it belongs to
      // the side that is about to move. This is the same rule app.js uses, so the board
      // and the analysis can no longer disagree about a reference stone's colour.
      var isRef = draftMoves[i].s === 'ai-suggest';
      stones.push({
        x: draftMoves[i].c[0], y: draftMoves[i].c[1],
        side: (playedBefore % 2 === 0 ? 'B' : 'W'),
        moveNo: isRef ? null : playedBefore + 1,
        ref: isRef,
        ghost: i >= curStep,
        cursor: i === curStep - 1,
      });
      if (!isRef) playedBefore++;
    }
    var marks = [];
    if (report) {
      for (var k = 0; k < report.steps.length && k < curStep; k++) {
        var s = report.steps[k];
        if (!s.actual) continue;
        if (s.desperate) marks.push({ x: s.actual[0], y: s.actual[1], color: '#e67e22', r: 0.6 });
        if (isFlagged(s)) marks.push({ x: s.actual[0], y: s.actual[1], color: '#e74c3c', r: 0.5 });
      }
    }
    // The red dot marks the last PLAYED stone, i.e. the cursor — not the last stone on screen,
    // which may be a ghost from the branch tail.
    var last = null;
    for (var m = stones.length - 1; m >= 0; m--) if (!stones[m].ghost && !stones[m].ref) { last = [stones[m].x, stones[m].y]; break; }
    return { stones: stones, marks: marks, last: last };
  }

  function drawDetectBoard() { drawBoard($('board'), detectView()); }

  // The hint under the board. With no report it still has to say where the cursor is and what a
  // click will do, otherwise the cursor model is invisible to the operator.
  function boardHint() {
    var total = draftMoves.length;
    if (!total) return T('viewer|棋盘（点空点落子；右键悔一手）');
    if (curStep >= total) {
      return T('viewer|第 {n} / {n} 手 · 末手。点空点继续打谱；点已有子把光标移过去', { n: total });
    }
    return T('viewer|第 {cur} / {total} 手 · 光标停在第 {cur} 手，其后 {rest} 手为变体预览（虚线半透明）。点空点在此打出变体',
             { cur: curStep, total: total, rest: total - curStep });
  }

  function renderBoardView() {
    var total = draftMoves.length;
    curStep = clamp(curStep, 0, total);
    // 0.3.4: the step bar scrubs the RECORD, so it is live with or without a report. It used to
    // be a no-op until an analysis existed, which is exactly why 回溯 could not be followed by
    // an edit — there was no cursor to edit at.
    $('slider').max = total;
    $('slider').value = curStep;
    $('jumpStep').max = total;
    $('jumpStep').value = curStep;
    drawDetectBoard();
    var s = report && report.steps[curStep - 1];
    $('boardInfo').textContent = s
      ? T('viewer|第{m}手  {side}  走 {move} · 引擎最佳 {best} · {wr}', {
          m: s.moveNo, side: sideTag(s.side), move: s.actualStr, best: s.bestStr,
          wr: s.bestWR != null ? T('viewer|胜率{p}', { p: pct(s.bestWR) }) : T('viewer|未分析'),
        }) +
        ' · ' + (!s.analyzed ? T('viewer|(跳过)') : (s.top1 ? 'Top1' : (s.top3 ? 'Top3' : (s.top5 ? 'Top5' : T('viewer|Top5外'))))) +
        (s.isSharp ? ' · ' + T('viewer|唯一手') : '') + (s.desperate ? ' · ' + T('viewer|将败') : '') + (s.evasion ? ' · ' + T('viewer|回避') : '')
      : boardHint();
    document.querySelectorAll('#tbl tbody tr').forEach(function (tr, i) {
      tr.classList.toggle('cur', i === curStep - 1);
    });
    // 撤销分支 is only meaningful while there is a parked tail; greying it out is the cheapest
    // way to teach the operator that a branch happened and can still be taken back.
    if ($('undoChange')) $('undoChange').disabled = !undoStack.length;
    if ($('truncateHere')) $('truncateHere').disabled = curStep >= total;
  }
  $('slider').oninput = function (e) { curStep = clamp(+e.target.value, 0, draftMoves.length); renderBoardView(); };
  $('prev').onclick = function () { curStep = Math.max(0, curStep - 1); renderBoardView(); };
  $('next').onclick = function () { curStep = Math.min(draftMoves.length, curStep + 1); renderBoardView(); };
  $('startBtn').onclick = function () { curStep = 0; renderBoardView(); };
  $('endBtn').onclick = function () { curStep = draftMoves.length; renderBoardView(); };

  function isFlagged(s) {
    return !!s.analyzed && s.orderKnown !== false && !s.isOpening && !s.forcedDefense &&
      (s.outsideTop5 || (s.isSharp && !s.top1) || (s.loss != null && s.loss > 0.12) || s.desperate);
  }

  // The operator's own verdict on a step, distinct from the engine's "可疑" badge: red when
  // set, faint when not. Clicking the cell (handled by makeMAHandler below) toggles it.
  function maCell(on) {
    return on ? '<span class="ma-on">' + T('viewer|● 人工') + '</span>'
              : '<span class="ma-off">' + T('viewer|○ 标记') + '</span>';
  }

  // Everything between the leading "#" cell and the trailing mark/annotation cell. Split out
  // in 0.3.3 because the sample step table shows the same columns with a multi-label
  // annotation cell instead of the archive's binary mark — the two tables must never drift.
  // =====================================================================
  // 0.4.3 §1.2–§1.4: segments
  // =====================================================================
  // The rail's geometry comes from `report.segments` (automatic) or `report.manualSegments`
  // (the operator's, which wins when present). SEGMAP is a render-time index rebuilt once per
  // render and read by the four row builders — the step tables are rebuilt on every annotation
  // click, and a linear scan of the segment list per row would be O(rows × segments) for no
  // reason.
  var SEGMAP = { B: {}, W: {} };

  // Accepts either a report or a wrapper carrying one (`curArchive`, `curSample`, the editor's
  // `{report: seReport}` stand-in) — the four renderers hold different things and a tri-state
  // argument would be a bug waiting to happen.
  function asReport(x) {
    if (!x) return {};
    return (x.report && typeof x.report === 'object') ? x.report : x;
  }
  // The population a segment is computed over, mirrored from app.js segmentSide(). Evasion
  // hands stay IN, for the reason documented there: the rail is a picture of the game as it
  // was played, and the operator sees every hand as a row.
  function ownIdxOf(rep, side) {
    var out = [];
    ((asReport(rep).steps) || []).forEach(function (s, i) {
      if (s.side === side && s.analyzed && !s.isOpening && !s.forcedDefense) out.push(i);
    });
    return out;
  }
  // The override wins when it exists, otherwise the automatic result. `Array.isArray` rather
  // than a truthiness test so an explicitly empty manual list is honoured instead of silently
  // falling back to the automatic rail.
  function segsOf(obj, side) {
    var rep = asReport(obj);
    var ms = rep.manualSegments;
    if (ms && Array.isArray(ms[side])) return ms[side];
    var a = rep.segments;
    return (a && Array.isArray(a[side])) ? a[side] : [];
  }
  function buildSegMap(obj) {
    var map = { B: {}, W: {} };
    ['B', 'W'].forEach(function (side) {
      segsOf(obj, side).forEach(function (sg, k) {
        for (var i = sg.from; i <= sg.to; i++) {
          map[side][i] = { kind: sg.kind === 'low' ? 'low' : 'high', seg: k, first: i === sg.from, last: i === sg.to };
        }
      });
    });
    SEGMAP = map;
    return map;
  }
  // The 4px rail class, plus the boundary rule. A boundary only shows where a segment STARTS,
  // and never on the very first row — a 2px line above everything is just noise.
  function markSeg(tr, side, i) {
    var m = (SEGMAP[side] || {})[i];
    if (!m) return tr;
    tr.classList.add(m.kind === 'low' ? 'seg-low' : 'seg-high');
    if (m.first && m.seg > 0) tr.classList.add('seg-start');
    return tr;
  }
  function handleHtml(side, i, seg, edge) {
    return '<span class="segh" data-side="' + side + '" data-i="' + i + '" data-seg="' + seg +
      '" data-edge="' + edge + '" title="' + esc(T('viewer|拖动调整分段边界')) + '"></span>';
  }
  // §1.4's drag handles, drawn inside the row they move so the operator never has to translate
  // between a handle and the hand it belongs to. Only a table whose report can be PERSISTED
  // gets them: 回放详情 and 样本详情 save at once, 样本编辑器 carries the edit into
  // `editing.report` where 保存 writes it. 检测's report is a throwaway draft, so it shows the
  // rail (which is informative) and no handle — a handle that silently discards its edit is
  // worse than no handle.
  function handlesFor(side, i, table) {
    if (side !== 'B' && side !== 'W') return '';
    if (!table || !segContext(table)) return '';
    var m = (SEGMAP[side] || {})[i];
    if (!m) return '';
    var h = '';
    if (m.first) h += handleHtml(side, i, m.seg, 'from');
    if (m.last) h += handleHtml(side, i, m.seg, 'to');
    return h;
  }
  // One legend builder for the four step tables, so a fifth can never be added without one —
  // and so the two strings are reached as the `viewer|` keys §4.5 names.
  function renderSegLegends() {
    var html = '<span class="seg-key seg-high"></span>' + T('viewer|段：全程 Top5 内') +
               '<span class="seg-key seg-low"></span>' + T('viewer|段：含出 Top5') +
               // 0.4.7 §1.4 — the candidate columns hold 8 entries once a search was given more
               // than 6 s, and a reader who does not know that will read a missing Top6-8 as
               // "the engine found nothing there" rather than "this run did not ask".
               ' · ' + T('viewer|TOP8 扩展（思考 > 6s）');
    ['segLegDetect', 'segLegDetail', 'segLegSample', 'segLegEditor'].forEach(function (id) {
      var el = $(id);
      if (el) el.innerHTML = html;
    });
  }

  // A manual edit is written through GMStorage, which mutates the STORED copy — not the object
  // the detail pane is currently rendering. So the order is always "reload, re-point, re-render":
  // skip the middle step and the list (built from the freshly loaded array) shows the new value
  // while the detail pane, two inches away and rendering the stale object, still shows the old
  // one. That is exactly the badge/detail disagreement `saveArchiveType` refreshes the lifted
  // `types` copy to prevent, arriving by another door.
  // `refreshArchives` is async, so both halves have to be awaited before `archives` is current.
  async function refetchArchive() {
    if (!curArchive) return;
    await refreshArchives();
    var hit = archives.filter(function (a) { return a.id === curArchive.id; })[0];
    if (hit) curArchive = hit;
    if (curArchive) renderDetail();
  }
  async function refetchSample() {
    if (!curSample) return;
    await refreshSamples();
    var hit = samples.filter(function (s) { return s.id === curSample.id; })[0];
    if (hit) curSample = hit;
    if (curSample) renderSampleDetail();
  }

  // Where a manual edit belongs, and how it is written. Returns null for the 检测 tab,
  // which is what disables the handles and the context menu there.
  function segContext(table) {
    if (table === 'dTbl' && curArchive) {
      return {
        obj: curArchive,
        persist: function (side, segs) { return G.saveArchiveSegments(curArchive.id, side, segs); },
        repaint: function () { return refetchArchive(); },
      };
    }
    if (table === 'sTbl' && curSample) {
      return {
        obj: curSample,
        persist: function (side, segs) { return G.saveSampleSegments(curSample.id, side, segs); },
        repaint: function () { return refetchSample(); },
      };
    }
    if (table === 'seTbl' && seReport) {
      return {
        obj: { report: seReport },
        persist: function (side, segs) {
          if (!seReport.manualSegments) seReport.manualSegments = { B: null, W: null };
          seReport.manualSegments[side] = segs;
          if (editing) editing.report = seReport;    // 保存 writes it from here
          return Promise.resolve(seReport);
        },
        repaint: function () { renderSeTable(); },
      };
    }
    return null;
  }

  function posMapOf(own) {
    var m = {};
    own.forEach(function (g, p) { m[g] = p; });
    return m;
  }
  // The list an edit starts from: the manual one when it exists, otherwise a COPY of the
  // automatic segmentation — so the first drag of an automatic rail does not mutate the
  // automatic result the report and the learner still describe.
  function materialiseSegs(obj, side) {
    return segsOf(obj, side).map(function (s) { return { from: s.from, to: s.to, kind: s.kind }; });
  }
  // Positions (index into this side's own hands) back to global step indices. Everything the
  // operator manipulates is positional — "the fifth of my hands" — because a raw step index
  // counts the opponent's moves too and would make the handles land in the wrong place.
  function psegsToGlobal(psegs, own) {
    return psegs.map(function (s) { return { from: own[s.from], to: own[s.to], kind: s.kind }; });
  }
  // The colour of a piece is derived from the hands it actually contains, never inherited: a
  // hand-picked range can span both classes, and the rail has to keep meaning something. Ties
  // go to `high`, matching app.js.
  function rangeSeg(rep, own, fromP, toP) {
    var high = 0, n = 0;
    for (var p = fromP; p <= toP; p++) {
      var st = ((rep && rep.steps) || [])[own[p]];
      if (!st) continue;
      n++;
      if (st.top5) high++;
    }
    return { from: fromP, to: toP, kind: (n && high * 2 >= n) ? 'high' : 'low' };
  }

  // ---- drag ----
  var segDrag = null;
  // Capture phase at document level on purpose: all four step tables already have bubble-phase
  // click handlers that would read a handle press as a row jump (检测) or a note toggle
  // (样本详情 / 编辑器), and a capture listener on the row's own tbody would still let that
  // tbody's own bubble listener run. Document capture is the one place that beats them.
  document.addEventListener('mousedown', function (e) {
    var h = e.target && e.target.closest ? e.target.closest('.segh') : null;
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    segDragBegin(h);
  }, true);
  document.addEventListener('click', function (e) {
    if (!(e.target && e.target.closest && e.target.closest('.segh'))) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  function segDragBegin(h) {
    var tbl = h.closest('table');
    var c = segContext(tbl && tbl.id);
    if (!c) return;
    var side = h.dataset.side;
    var seg = parseInt(h.dataset.seg, 10);
    var own = ownIdxOf(c.obj.report, side);
    var pmap = posMapOf(own);
    var segs = materialiseSegs(c.obj, side);
    var ok = true;
    var psegs = segs.map(function (s) {
      var a = pmap[s.from], b = pmap[s.to];
      if (a == null || b == null) { ok = false; return null; }
      return { from: a, to: b, kind: s.kind === 'low' ? 'low' : 'high' };
    });
    if (!ok || psegs.length < 2) return;
    // A handle on a segment's FIRST row moves the boundary above it; on the LAST row, the one
    // below. The two outer edges of the side's whole sequence have nothing to trade with, so
    // those handles are inert — which is why this is the only place a handle is dropped.
    var k = h.dataset.edge === 'from' ? seg - 1 : seg;
    if (!(k >= 0 && k < psegs.length - 1)) return;
    segDrag = { c: c, side: side, k: k, own: own, psegs: psegs, table: tbl.id, moved: false };
    document.body.classList.add('seg-dragging');
    document.addEventListener('mousemove', segDragMove, true);
    document.addEventListener('mouseup', segDragEnd, true);
  }

  function segDragMove(e) {
    if (!segDrag) return;
    var tr = null;
    if (document.elementFromPoint) {
      var el = document.elementFromPoint(e.clientX, e.clientY);
      tr = el && el.closest ? el.closest('tr') : null;
    }
    if (!tr || tr.dataset.step == null) return;
    var g = parseInt(tr.dataset.step, 10);
    var own = segDrag.own;
    // The side's own position for the hovered row: how many of its hands sit at or before it.
    // A row belonging to the OPPONENT maps to the same position as the last own hand above it,
    // which is what the operator means when dragging across an interleaved sequence.
    var p = 0;
    for (var i = 0; i < own.length; i++) { if (own[i] <= g) p = i + 1; else break; }
    var ps = segDrag.psegs, k = segDrag.k;
    // Both sides of the boundary keep at least one hand (§1.4: the manual floor is 1). A drag
    // that would empty either is CLAMPED rather than refused, so the preview always tracks the
    // pointer instead of jumping.
    var lo = ps[k].from + 1, hi = ps[k + 1].to;
    p = Math.max(lo, Math.min(hi, p));
    if (p === ps[k + 1].from) return;
    ps[k].to = p - 1;
    ps[k + 1].from = p;
    segDrag.moved = true;
    paintSegPreview();
  }

  function paintSegPreview() {
    if (!segDrag) return;
    var map = {};
    psegsToGlobal(segDrag.psegs, segDrag.own).forEach(function (sg, k) {
      for (var i = sg.from; i <= sg.to; i++) {
        map[i] = { kind: sg.kind, seg: k, first: i === sg.from };
      }
    });
    var tb = document.querySelector('#' + segDrag.table + ' tbody');
    if (!tb) return;
    tb.querySelectorAll('tr').forEach(function (tr) {
      tr.classList.remove('seg-high', 'seg-low', 'seg-start');
      if (tr.dataset.side !== segDrag.side || tr.dataset.step == null) return;
      var m = map[parseInt(tr.dataset.step, 10)];
      if (!m) return;
      tr.classList.add(m.kind === 'low' ? 'seg-low' : 'seg-high');
      if (m.first && m.seg > 0) tr.classList.add('seg-start');
    });
  }

  function segDragEnd() {
    document.removeEventListener('mousemove', segDragMove, true);
    document.removeEventListener('mouseup', segDragEnd, true);
    document.body.classList.remove('seg-dragging');
    var d = segDrag;
    segDrag = null;
    if (!d || !d.moved) return;              // a press with no movement is not an edit
    // §1.4: on release the new boundary is written; the preview is already what is on screen,
    // so the repaint below only re-renders the handles at their new rows.
    d.c.persist(d.side, psegsToGlobal(d.psegs, d.own)).then(function () { d.c.repaint(); },
      function () { d.c.repaint(); });       // a failed write must not leave a stale rail
  }

  // ---- §1.4 right-click ----
  // Delegated per table, like the annotation handler, because the rows are rebuilt every render.
  STEP_TABLES.forEach(function (t) {
    var tb = document.querySelector('#' + t + ' tbody');
    if (!tb) return;
    tb.addEventListener('contextmenu', function (e) {
      var c = segContext(t);
      if (!c) return;                        // 检测's draft has nowhere to save an edit
      var tr = e.target && e.target.closest ? e.target.closest('tr') : null;
      if (!tr || tr.dataset.step == null) return;
      var side = tr.dataset.side;
      if (side !== 'B' && side !== 'W') return;
      e.preventDefault();
      openSegMenu(e, c, side, parseInt(tr.dataset.step, 10));
    });
  });

  function openSegMenu(ev, c, side, stepIdx) {
    var rep = c.obj.report || {};
    var hasManual = !!(rep.manualSegments && Array.isArray(rep.manualSegments[side]));
    showCtx(
      '<div class="it" data-a="new">' + T('viewer|创建分段') + ' <span class="k">▸</span></div>' +
      (hasManual ? '<div class="it" data-a="reset">' + T('viewer|恢复自动分段') + '</div>' : ''),
      ev.clientX, ev.clientY);
    ctx.querySelectorAll('.it').forEach(function (it) {
      it.onclick = function (e2) {
        e2.stopPropagation();               // we are about to replace ctx.innerHTML
        var act = it.dataset.a;
        closeCtx();
        if (act === 'reset') { applySegEdit(c, side, null); return; }
        openSegCreateMenu(e2, c, side, stepIdx);
      };
    });
  }

  function openSegCreateMenu(ev, c, side, stepIdx) {
    showCtx(
      '<div class="it" data-a="one">' + T('viewer|单步分段') + '</div>' +
      '<div class="it" data-a="tail">' + T('viewer|到本段末尾') + '</div>' +
      '<div class="it" data-a="custom">' + T('viewer|自定义范围') + '</div>',
      ev.clientX, ev.clientY);
    ctx.querySelectorAll('.it').forEach(function (it) {
      it.onclick = function (e2) {
        e2.stopPropagation();
        var act = it.dataset.a;
        closeCtx();
        createSegment(c, side, stepIdx, act);
      };
    });
  }

  function createSegment(c, side, stepIdx, mode) {
    var own = ownIdxOf(c.obj.report, side);
    var pmap = posMapOf(own);
    var p = pmap[stepIdx];
    if (p == null) return;
    var psegs = materialiseSegs(c.obj, side).map(function (s) {
      return { from: pmap[s.from], to: pmap[s.to], kind: s.kind };
    }).filter(function (s) { return isFinite(s.from) && isFinite(s.to); });
    // A report with no automatic segmentation at all — a pre-0.4.3 archive, or a game too
    // short for the 3-hand minimum. Seed one run over the whole side so the operator can still
    // carve a segment out of it; `rangeSeg` below re-colours every piece from the hands it
    // contains, so the seed's own colour never leaks into the result.
    if (!psegs.length) {
      if (!own.length) return;
      psegs = [{ from: 0, to: own.length - 1, kind: 'high' }];
    }
    var hit = -1;
    for (var i = 0; i < psegs.length; i++) if (p >= psegs[i].from && p <= psegs[i].to) hit = i;
    if (hit < 0) return;

    var fromP = p, toP = p;
    if (mode === 'tail') toP = psegs[hit].to;
    if (mode === 'custom') {
      var def = (p + 1) + '-' + (toP + 1);
      var ans = prompt(T('viewer|该段包含哪几步？（当前手 {n}，默认 1 步）', { n: p + 1 }), def);
      if (ans == null) return;
      var m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(ans);
      if (!m) return;
      fromP = clamp(parseInt(m[1], 10) - 1, 0, own.length - 1);
      toP = m[2] ? clamp(parseInt(m[2], 10) - 1, 0, own.length - 1) : fromP;
      if (fromP > toP) { var t0 = fromP; fromP = toP; toP = t0; }
    }
    // Split the containing run at both ends of [fromP, toP], re-colouring every resulting
    // piece from its own hands.
    var rep = c.obj.report;
    var out = [];
    psegs.forEach(function (sg, k) {
      if (k !== hit) { out.push(rangeSeg(rep, own, sg.from, sg.to)); return; }
      if (fromP > sg.from) out.push(rangeSeg(rep, own, sg.from, fromP - 1));
      out.push(rangeSeg(rep, own, fromP, toP));
      if (toP < sg.to) out.push(rangeSeg(rep, own, toP + 1, sg.to));
    });
    applySegEdit(c, side, psegsToGlobal(out, own));
  }

  function applySegEdit(c, side, glob) {
    c.persist(side, glob).then(function () { c.repaint(); });
  }

  function stepCellsHtml(s) {
    var badges = [];
    if (s.source === 'prejoin') badges.push('<span class="badge b-pre">' + T('viewer|还原') + '</span>');
    if (s.isOpening) badges.push('<span class="badge">' + T('viewer|开局') + '</span>');
    if (s.source === 'ai-suggest') badges.push('<span class="badge b-ai">' + T('viewer|AI参考') + '</span>');
    // 0.4.8 §1.2 — the run length belongs beside the badge, not only in the summary: the whole
    // point of the term is that a RUN of these is different from the same hands scattered, and
    // only the row can show where the run actually was. `sharpStreak` is stamped on the step by
    // app.js, so this is a read, not a second derivation.
    if (s.isSharp) badges.push('<span class="badge b-sharp">' + T('viewer|唯一手') +
      ((s.sharpStreak || 0) >= 2 ? T('viewer|（连续 {n}）', { n: s.sharpStreak }) : '') + '</span>');
    if (s.desperate) badges.push('<span class="badge b-desp">' + T('viewer|将败') + '</span>');
    // 0.4.2 §2.5: its own colour, because "this hand was deliberately bad" is a claim about
    // intent and must not read like the engine's 可疑 verdict or like 将败's hopelessness.
    if (s.evasion) badges.push('<span class="badge b-evasion">' + T('viewer|回避') + '</span>');
    if (s.forcedDefense) badges.push('<span class="badge" style="background:#888;color:#fff">' + T('viewer|豁免') + '</span>');
    // 0.5.0 §1.1 — a 跳四 + 活三, which is deliberately NOT treated as a 四三杀 (the four's only
    // answer sits inside it, where one stone can also answer the three). The badge exists so the
    // operator can tell "the detector decided this was not a kill" apart from "the detector
    // missed a kill": without it, a four that did not stop the game has no visible reason.
    if (s.jumpFourFlag) badges.push('<span class="badge b-jump" title="' +
      T('viewer|跳四 + 活三不终止') + '">' + T('viewer|跳四') + '</span>');
    // 0.3.3 C: the step fingerprint-matched a human-confirmed AI move. Its own colour and
    // its own wording — it is a similarity to the operator's own library, which is a
    // different claim from the engine's 可疑 verdict and must not read as the same thing.
    if (s.aiSimilar) badges.push('<span class="badge b-sim" title="' +
      T('viewer|与特征库中的 AI 步骤相似度 {p}', { p: s.aiSim != null ? s.aiSim : '?' }) +
      '">' + T('viewer|疑AI指纹') + '</span>');
    if (isFlagged(s)) badges.push('<span class="badge b-flag">' + TO('level', '可疑') + '</span>');
    return '<td class="side-' + s.side + '">' + sideTag(s.side) + '</td>' +
      '<td>' + esc(s.actualStr) + '</td><td>' + esc(s.bestStr || '—') + '</td>' +
      '<td style="text-align:left;font-family:monospace">' + esc((s.candStrs || []).join(' ')) + '</td>' +
      '<td>' + (s.top1 ? '✓' : '') + '</td><td>' + (s.top3 ? '✓' : '') + '</td><td>' + (s.top5 ? '✓' : '') + '</td>' +
      // 0.5.5 §1.4.3 — 「该步是否好点（✓/空）」 plus the running count, and the count only from 2
      // so a lone good point does not print a column of 1s. `s.goodPool` is the stamped run length
      // and `s.isGood` the predicate's verdict; the latter is what makes a non-top5 hand that
      // qualified through the extended tier visible, `s.top5` alone would leave it blank.
      '<td>' + (s.isGood ? '✓' : '') + ((s.goodPool || 0) >= 2 ? T('viewer|（连续 {n}）', { n: s.goodPool }) : '') + '</td>' +
      '<td>' + (s.loss != null ? (s.loss * 100).toFixed(1) + '%' : '—') + '</td>' +
      '<td>' + (s.isSharp ? T('viewer|是') : '') + '</td><td>' + (s.desperate ? T('viewer|是') : '') + '</td>' +
      '<td>' + (s.evasion ? T('viewer|是') : '') + '</td>' +
      '<td>' + (s.forcedDefense ? '✓' : '') + '</td>' +
      '<td>' + (s.thinkMs != null ? s.thinkMs : '—') + '</td>' +
      '<td>' + badges.join(' ') + '</td>';
  }

  function rowHtml(s, idx, table) {
    return '<td>' + handlesFor(s.side, idx, table) + (s.moveNo == null ? '—' : s.moveNo) + '</td>' +
      stepCellsHtml(s) +
      '<td class="ma" data-i="' + (idx == null ? '' : idx) + '">' + maCell(s.manualAI) + '</td>';
  }

  // 0.3.5 §2.4: every step table colours the WHOLE row by the side that played it, so a hand
  // can be followed across all seventeen columns. The class goes on the <tr>; the badges and
  // annotation buttons inside keep their own colours (see viewer.html). All four step tables
  // share this one helper so a new table can never be added without it.
  //
  // 0.4.3 §1.3/§1.4: it also stamps the row with the step index and side — the drag handles
  // and the segment context menu are delegated (the rows are rebuilt on every render), and the
  // DOM row number is NOT the step index once the opponent's hands are interleaved — and
  // applies the segment rail.
  function markSide(tr, s, idx) {
    if (s && (s.side === 'B' || s.side === 'W')) {
      tr.classList.add('side-' + s.side);
      tr.dataset.side = s.side;
      if (idx != null) tr.dataset.step = idx;
      markSeg(tr, s.side, idx);
    }
    return tr;
  }

  function appendRow(s, idx) {
    var tb = document.querySelector('#tbl tbody');
    if (!tb) return;
    var tr = document.createElement('tr');
    // The incremental live path appends the newest step without an index; deriving it here
    // keeps every row addressable by step, which is what the segment rail and its handles
    // read. O(n) once per hand is nothing next to the engine call that produced it.
    if (idx == null) idx = report ? report.steps.indexOf(s) : -1;
    if (idx < 0) idx = null;
    if (isFlagged(s)) tr.classList.add('flagged');
    markSide(tr, s, idx);
    tr.innerHTML = rowHtml(s, idx, 'tbl');
    tb.appendChild(tr);
  }

  function renderScoreCards() {
    var box = $('scores'); box.innerHTML = '';
    var shown = 0;
    [report.black, report.white].forEach(function (a) {
      if (!a) return;
      shown++;
      var div = document.createElement('div'); div.className = 'card';
      div.innerHTML = '<div class="big lv-' + a.level + '">' + a.risk.toFixed(0) + '</div>' +
        '<div class="lab">' + sideName(a.side) + ' · ' + TO('level', a.level) + '</div>' +
        '<div class="contrib">n=' + a.n + ' · T1=' + pct(a.top1) + ' · ' +
          T('viewer|均损={p}%', { p: (a.meanLoss * 100).toFixed(1) }) + '</div>';
      box.appendChild(div);
    });
    // sideAggregate returns null when no move survives the filters. That is reachable
    // (e.g. the whole game sits inside 开局排除), and an empty box reads as a crash.
    if (!shown) {
      box.innerHTML = '<div class="hint">' +
        T('viewer|没有可用于统计的手：所有手都在「开局排除」范围内，或全部判定为冲四豁免（被迫应手）。把开局排除调小后重新分析即可。') +
        '</div>';
    }
  }

  function anyAggregate(rep) { return !!(rep && (rep.black || rep.white)); }

  // The per-side metric table. Shared by the detect tab, the replay detail and the 0.3.3
  // sample detail so one game never reads differently depending on which pane it is open in.
  // `opts.sim` adds the AI-fingerprint row, which only carries information once a feature
  // library exists — leaving it off keeps an unlearned archive's table byte-identical.
  // Cell formatters for summaryTableHtml. Three of its rows repeat the same shape on both
  // sides, and inlining them twice each was what made the rows unreadable.
  function sharpHit(a) {
    if (!a || a.sharpHit == null) return '—';
    return pct(a.sharpHit) + T('viewer|（{n}手）', { n: a.sharpCount });
  }
  function desCount(a) { return a ? T('viewer|{n}次', { n: a.desperateCount }) : '—'; }
  // 0.4.8 §1.2. `—` when the field is absent, which is what a pre-0.4.8 archive looks like: the
  // two streak figures were never computed for it, and `0次` would be a clean answer nobody
  // actually measured.
  function ssCell(a, key) {
    if (!a || a[key] == null) return '—';
    return T('viewer|{n}次', { n: a[key] || 0 });
  }
  // 0.5.5 §1.4.1 — the 好点占比 cell. The RATE alone would hide how much evidence is behind it: 100%
  // of four hands and 100% of fifty are the same number and not the same claim, so the counts ride
  // in the same cell (the shape the spec prints). `—` when the ratio is absent, i.e. a pre-0.5.5
  // archive — and also when the side has no countable hands at all, which is the same "no reading"
  // the other rows print rather than a rate of 0 the side never earned.
  function goodRatioCell(a) {
    if (!a || a.goodRatio == null || !a.goodTotal) return '—';
    return T('viewer|{p}（{n}/{m}）', { p: pct(a.goodRatio), n: a.goodCount || 0, m: a.goodTotal });
  }
  function simCount(a) { return a ? T('viewer|{n} 步', { n: a.simCount || 0 }) : '—'; }
  // 0.4.2 §2.5. The evasion row carries two numbers because they answer different questions —
  // how many, and how evenly they were spaced. `0.00` regularity is the normal answer for one
  // or two evasions (below the count that makes a rhythm measurable), so it is printed rather
  // than hidden. `—` means the archive predates the field, NOT "we looked and found none":
  // claiming a clean answer we never computed is the one thing this row must not do.
  function evCount(a) {
    if (!a || a.evasionCount == null) return '—';
    var n = a.evasionCount || 0;
    // The zero case reuses the plain `{n}次` row the 将败冲四 row above already uses, so the
    // two rows stay typographically identical when there is nothing to report.
    return n ? T('viewer|{n}次（规律性 {p}）', { n: n, p: (a.evasionRegularity || 0).toFixed(2) })
             : T('viewer|{n}次', { n: 0 });
  }
  function wbCount(a) {
    if (!a || a.winBlunderCount == null) return '—';
    return T('viewer|{n}次', { n: a.winBlunderCount || 0 });
  }
  // 0.4.7 §1.1 — the 冲四序列 breakdown, read straight out of the report. `side` omitted means
  // "both sides together", which is what the total row under 冲四序列 wants. `—` again means the
  // archive predates the field: `fourRuns` is absent on every 0.4.6-and-earlier record, and
  // printing `0次` there would claim a clean scan that never ran.
  //
  // Two shapes on purpose: `frRunNum` returns the NUMBER (for the total, which needs to say 段)
  // and `frRun` wraps it as `{n}次` (for the three per-class rows). Returning the formatted
  // string from one function and interpolating it into a second template produced "3次 段".
  function frRunNum(rep, kind) {
    var n = 0, seen = false;
    [rep.black, rep.white].forEach(function (a) {
      if (!a || !a.fourRuns) return;
      seen = true;
      n += a.fourRuns[kind] || 0;
    });
    return seen ? n : 0;
  }
  function frAny(rep) {
    return [rep.black, rep.white].some(function (a) { return a && a.fourRuns; });
  }
  function frRun(rep, kind, side) {
    if (!frAny(rep)) return '—';
    var a = rep[side];
    return T('viewer|{n}次', { n: (a && a.fourRuns ? a.fourRuns[kind] : 0) || 0 });
  }

  function summaryTableHtml(rep, opts) {
    rep = rep || {};
    opts = opts || {};
    return '<table style="text-align:left">' +
      '<tr><th>' + T('viewer|指标') + '</th><th>' + T('viewer|黑方') + '</th><th>' + T('viewer|白方') + '</th></tr>' +
      '<tr><td>' + T('viewer|Top-1 吻合') + '</td><td>' + (rep.black ? pct(rep.black.top1) : '—') + '</td><td>' + (rep.white ? pct(rep.white.top1) : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|Top-3') + '</td><td>' + (rep.black ? pct(rep.black.top3) : '—') + '</td><td>' + (rep.white ? pct(rep.white.top3) : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|Top-5') + '</td><td>' + (rep.black ? pct(rep.black.top5) : '—') + '</td><td>' + (rep.white ? pct(rep.white.top5) : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|ACPL（均损）') + '</td><td>' + (rep.black ? (rep.black.meanLoss * 100).toFixed(1) + '%' : '—') + '</td><td>' + (rep.white ? (rep.white.meanLoss * 100).toFixed(1) + '%' : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|唯一手命中') + '</td><td>' + sharpHit(rep.black) + '</td><td>' + sharpHit(rep.white) + '</td></tr>' +
      // 0.4.8 §1.2 — the two streak rows sit directly under 唯一手命中 because they are the same
      // hands read a different way: the row above is the RATE, these two are the RUN. A side can
      // hold an unremarkable 唯一手命中 rate and still have a ten-hand run in it, and only the
      // streak rows say so.
      '<tr><td>' + T('viewer|唯一手最长连续命中') + '</td><td>' + ssCell(rep.black, 'sharpStreakMax') + '</td><td>' + ssCell(rep.white, 'sharpStreakMax') + '</td></tr>' +
      '<tr><td>' + T('viewer|唯一手累计命中') + '</td><td>' + ssCell(rep.black, 'sharpStreakHits') + '</td><td>' + ssCell(rep.white, 'sharpStreakHits') + '</td></tr>' +
      // 0.5.5 §1.4.1 — the redefined 好点池, reported as its two components rather than as one run
      // length: the RATE is the headline (它 is 70% of the sub-score) and the longest RUN is the
      // supporting figure the old row already carried. Both are `—` for an archive that predates
      // 0.5.5 — its `goodPoolMax` measured a different quantity (好点 was Top3 then, Top5 now), so
      // relabelling it would be a lie rather than a fallback.
      '<tr><td>' + T('viewer|好点占比') + '</td><td>' + goodRatioCell(rep.black) + '</td><td>' + goodRatioCell(rep.white) + '</td></tr>' +
      '<tr><td>' + T('viewer|好点最长连击') + '</td><td>' + ssCell(rep.black, 'goodStreak') + '</td><td>' + ssCell(rep.white, 'goodStreak') + '</td></tr>' +
      '<tr><td>' + T('viewer|活三好手最长连击') + '</td><td>' + ssCell(rep.black, 'liveThreeMax') + '</td><td>' + ssCell(rep.white, 'liveThreeMax') + '</td></tr>' +
      '<tr><td>' + T('viewer|Top5 之外') + '</td><td>' + (rep.black ? pct(rep.black.outTop5) : '—') + '</td><td>' + (rep.white ? pct(rep.white.outTop5) : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|将败冲四') + '</td><td>' + desCount(rep.black) + '</td><td>' + desCount(rep.white) + '</td></tr>' +
      '<tr><td>' + T('viewer|回避手') + '</td><td>' + evCount(rep.black) + '</td><td>' + evCount(rep.white) + '</td></tr>' +
      '<tr><td>' + T('viewer|将胜乱下') + '</td><td>' + wbCount(rep.black) + '</td><td>' + wbCount(rep.white) + '</td></tr>' +
      // 0.4.7 §1.1 — the four-run breakdown, one row per class. Sitting next to 将败冲四 is the
      // point: a 「无用冲四」 is what a 将败冲四 looks like when it repeats, and the two rows
      // together are how an operator sees the difference. VCF / 防御性 are reported for symmetry
      // even though only 无用 moves the score — a column of zeros under two labels is the
      // clearest possible statement that those two are not being punished.
      // The total is a RUN count, so it uses the 段 noun rather than repeating the three
      // per-class 次 counts — `frRun` returns a formatted `{n}次` STRING, which is why this row
      // cannot just wrap it in another template (it would read "3次 段").
      '<tr><td>' + T('viewer|冲四序列') + '</td><td colspan="2">' + T('viewer|{n} 段',
        { n: frRunNum(rep, 'vcf') + frRunNum(rep, 'defensive') + frRunNum(rep, 'useless') }) + '</td></tr>' +
      '<tr><td>' + T('viewer|VCF') + '</td><td>' + frRun(rep, 'vcf', 'black') + '</td><td>' + frRun(rep, 'vcf', 'white') + '</td></tr>' +
      '<tr><td>' + T('viewer|防御性冲四') + '</td><td>' + frRun(rep, 'defensive', 'black') + '</td><td>' + frRun(rep, 'defensive', 'white') + '</td></tr>' +
      '<tr><td>' + T('viewer|无用冲四') + '</td><td>' + frRun(rep, 'useless', 'black') + '</td><td>' + frRun(rep, 'useless', 'white') + '</td></tr>' +
      (opts.sim ? ('<tr><td>' + T('viewer|AI 指纹命中') + '</td><td>' + simCount(rep.black) + '</td><td>' + simCount(rep.white) + '</td></tr>') : '') +
      '<tr><td>' + T('viewer|时间模式') + '</td><td colspan="2">' + (rep.hasTime ? T('viewer|真实间隔') : T('viewer|固定预算')) + '</td></tr>' +
      '<tr><td>' + T('viewer|冲四豁免') + '</td><td colspan="2">' + T('viewer|{n} 手', { n: rep.forcedCount || 0 }) + '</td></tr>' +
      // 0.4.8 §1.3 — shown only when there is something to show. A four-three answered by a
      // counter-four is the case where detection deliberately did NOT stop, so the row explains
      // why this record is longer than the old build's would have been.
      (function () {
        var list = (rep.fourThreeCounters || []).filter(function (x) { return x && x.moveNo != null; });
        if (!list.length) return '';
        return '<tr><td>' + T('viewer|四三被反四') + '</td><td colspan="2">' +
               T('viewer|第 {moves} 手', { moves: list.map(function (x) { return x.moveNo; }).join(', ') }) +
               '</td></tr>';
      })() +
      '</table>';
  }

  function renderReport() {
    // 0.3.4: park the cursor at the end of the RECORD, not at the end of the REPORT. If the
    // analysis stopped early (a genuine live four) the later hands are still part of the game
    // the operator typed, and they must stay on the board — ghosted, so it is obvious they were
    // not scored. Setting curStep = report.steps.length was half of the 「只剩 3 手」 bug.
    curStep = draftMoves.length;
    // The terminal note is appended to 「分析完成」 rather than replacing it: the run DID
    // complete, it just stopped early, and any operator (or poller) watching for the
    // completion phrase must still see it.
    if (report.terminal) {
      setStatus(T('viewer|引擎分析完成：第 {m} 手检测提前终止（{reason}）。已录入 {total} 手，其中 {scored} 手已评分（其余显示为半透明）',
        {
          m: report.terminal.moveNo != null ? report.terminal.moveNo : '?',
          reason: TO('stopReason', report.terminal.reason) || T('viewer|任一方形成四三杀或活四'),
          total: draftMoves.length, scored: report.steps.length,
        }));
    } else {
      setStatus(T('viewer|引擎分析完成'));
    }
    renderAllSteps();
    renderBoardView();
  }
  // 0.5.6 补增 §三 — the parameters THIS page must score with: the learner's table with the
  // operator's pins folded in, exactly as the analysis path resolves it. One function, because the
  // page re-aggregates in more than one place and a caller that forgot the pins would report a
  // score the detector is not producing. `applySignalPins` returns its argument untouched when
  // nothing is pinned (or when a set could not be honoured), so an unconfigured profile is
  // bit-for-bit the previous release here as well.
  function viewerSignalParams() {
    try {
      if (typeof applySignalPins === 'function') return applySignalPins(curLearned, S.signalWeights);
    } catch (e) { /* app.js absent (a stripped harness): fall back to the learned table */ }
    return curLearned;
  }

  function renderReportIncremental() {
    // 0.3.3: recompute with the SAME learned parameters analyzeGame used, or the incremental
    // numbers would disagree with the final ones the moment a learned model is in play.
    //
    // 0.5.6 补增 §三 — "the same parameters" now includes the operator's signal pins: the analysis
    // that produced these steps resolved `applySignalPins(curLearned, S.signalWeights)`, and a
    // recompute that stopped at `curLearned` would re-score every hand with the table the operator
    // just overrode. It is the third reading of one table in this file (the panel and 标签百科 are
    // the other two) and all three go through app.js's own resolver.
    var params = viewerSignalParams();
    report.black = sideAggregate(report.steps, 'B', report.hasTime, params);
    report.white = sideAggregate(report.steps, 'W', report.hasTime, params);
    // 0.4.3 §1.2/§1.3: the last boundary can move when a hand is added, and the rows already
    // on screen were classified against the previous segmentation — so the map is rebuilt and
    // every existing row re-striped before the new one is appended. `manualSegments` is not
    // touched: this pane's report is a draft with no editor, so the automatic rail is all
    // there is to recompute.
    report.segments = { B: segmentSide(report.steps, 'B'), W: segmentSide(report.steps, 'W') };
    buildSegMap(report);
    restripeSegs('tbl');
    renderScoreCards();
    appendRow(report.steps[report.steps.length - 1]);
    curStep = draftMoves.length;
    renderBoardView();
  }
  // Re-apply the segment rail to the rows already in a table, without rebuilding them. Used by
  // the live incremental path above and by nothing else.
  function restripeSegs(table) {
    var tb = document.querySelector('#' + table + ' tbody');
    if (!tb) return;
    tb.querySelectorAll('tr').forEach(function (tr) {
      tr.classList.remove('seg-high', 'seg-low', 'seg-start');
      if (tr.dataset.step == null) return;
      markSeg(tr, tr.dataset.side, parseInt(tr.dataset.step, 10));
    });
  }
  function renderAllSteps() {
    renderScoreCards();
    // 0.4.11 §一.5 — this pane used to carry its OWN eight-row summary table, hand-written and
    // never updated, while the replay detail rendered `summaryTableHtml(report, {})`. The rows
    // 0.4.7 (冲四序列 / VCF / 防御性冲四 / 无用冲四) and 0.4.8 (唯一手最长连续命中 / 唯一手累计命中)
    // added landed in the shared builder ONLY, so the same game showed two different sets of
    // numbers depending on which pane you opened — which is the whole reason summaryTableHtml
    // exists. `sim: true` matches the replay detail's call exactly (the AI-fingerprint row is
    // meaningful here too: this is the run that produced those verdicts).
    $('summary').innerHTML = summaryTableHtml(report, { sim: true });
    document.querySelector('#tbl tbody').innerHTML = '';
    // 0.4.3 §1.3: the segment index has to exist before the rows are built — every row asks it
    // for its rail colour and for its handles.
    buildSegMap(report);
    report.steps.forEach(function (s, i) { appendRow(s, i); });
  }

  $('expJson').onclick = function () { if (report) download('report.json', JSON.stringify(report, null, 2), 'application/json'); };
  $('expCsv').onclick = function () {
    if (!report) return;
    var csv = 'move,side,actual,best,top1,top3,top5,loss,sharp,desperate,evasion,thinkMs,manualAI\n';
    report.steps.forEach(function (s) {
      csv += [s.moveNo, s.side, s.actualStr, s.bestStr, s.top1, s.top3, s.top5,
              s.loss == null ? '' : s.loss, s.isSharp, s.desperate, s.evasion, s.thinkMs == null ? '' : s.thinkMs,
              s.manualAI ? '是' : ''].join(',') + '\n';
    });
    download('report.csv', csv, 'text/csv');
  };
  $('expPrint').onclick = function () { window.print(); };

  // =====================================================================
  // 回放：列表 / 排序 / 筛选
  // =====================================================================
  var archives = [];
  // 0.3.0: newest first. It is the order the operator actually wants when the list opens
  // ("the game I just played"), and the other two keys stay one click away on the headers.
  var sortKey = 'time';
  var sortDir = 'desc';
  var filtersOpen = false;
  var curArchive = null;
  var dStep = 0;
  // 0.3.1: the list is a column-first grid — 15 cards per column, as many columns as fit
  // the container width. So "page size" is 15 × columns, and it changes with the window.
  // PER_COL is the one fixed number; the column count is measured at render time.
  var PER_COL = 15;
  // 0.4.10 §一.4 — a hard ceiling of 3 columns (45 cards a page) and a wider minimum. Measured
  // from the live box, a 4K window fit 5–6 columns, which is more cards on screen than anyone
  // reads at once while making each one narrow enough that the name and the metrics start to
  // clip. 380px is what a card needs before its 名字 + 2 lines of metadata stop eliding.
  var MIN_COL_W = 380;   // min column width before another column fits
  var MAX_COLS = 3;      // §一.4 — no window is wide enough for a 4th column
  var COL_GAP = 16;      // matches .archive-grid gap
  var currentPage = 0;

  // How many columns currently fit. Measured from the live box so it tracks the window; at
  // least 1, and never more than the columns actually needed for the list. `id` lets the
  // sample library reuse the exact same measurement on its own grid (0.3.3 §1.7).
  function computeCols(id) {
    var box = document.getElementById(id || 'cards');
    var w = (box && box.clientWidth) || 1000;
    if (w <= 0) w = 1000;   // hidden (e.g. replay tab not open yet) → safe fallback
    var cols = Math.max(1, Math.floor((w + COL_GAP) / (MIN_COL_W + COL_GAP)));
    return Math.min(cols, MAX_COLS);
  }

  function pageCount(n, size) { return Math.max(1, Math.ceil(n / size)); }

  // Filtering, sorting or deleting can leave the current page past the end; pull it back
  // rather than showing an empty list on a page that should not exist.
  function clampPage(n, size) {
    var last = pageCount(n, size) - 1;
    if (currentPage > last) currentPage = last;
    if (currentPage < 0) currentPage = 0;
  }

  function readRange(sel, minEl, maxEl) {
    var v = $(sel).value;
    if (v === '') return { min: null, max: null };
    if (v === 'custom') {
      var a = $(minEl).value === '' ? null : +$(minEl).value;
      var b = $(maxEl).value === '' ? null : +$(maxEl).value;
      return { min: a, max: b };
    }
    var parts = v.split(':');
    return { min: parts[0] === '' ? null : +parts[0], max: parts[1] === '' ? null : +parts[1] };
  }

  function currentFilters() {
    var r = readRange('fRisk', 'fRiskMin', 'fRiskMax');
    var m = readRange('fMoves', 'fMovesMin', 'fMovesMax');
    var f = {
      riskMin: r.min, riskMax: r.max,
      riskField: $('fRiskField').value,
      movesMin: m.min, movesMax: m.max,
      mode: $('fMode').value,
      rule: $('fRule').value,
      category: $('fCategory').value || null,
      // '' = all · '__none__' = 未识别 · 'D'/'I' = whole family · 'D1'… = one opening.
      opening: $('fOpening').value || null,
      // 0.3.1 活四停止: '' = all · 'yes' = 活四终止 · 'no' = 完整对局.
      terminated: $('fTerm').value || null,
    };
    var age = $('fAge').value;
    if (age === 'custom') {
      var now = Date.now();
      var from = $('fAgeFrom').value ? Date.parse($('fAgeFrom').value) : null;
      var to = $('fAgeTo').value ? Date.parse($('fAgeTo').value) : null;
      // age = now - createdAt, so a NEWER timestamp means a SMALLER age.
      // keep createdAt >= from  -> age <= now - from  -> ageTo  = now - from
      // keep createdAt <= to    -> age >= now - to    -> ageFrom = now - to
      f.ageId = 'custom';
      f.ageTo = (from != null && !isNaN(from)) ? now - from : null;
      f.ageFrom = (to != null && !isNaN(to)) ? now - to : null;
    } else if (age) {
      f.ageId = age;
    }
    return f;
  }

  function updateRiskField() {
    var active = $('fRisk').value !== '';
    $('fRiskField').disabled = !active;
  }

  function onFilterChange() {
    var r = $('fRisk').value;
    $('fRiskCustom').classList.toggle('hidden', r !== 'custom');
    var m = $('fMoves').value;
    $('fMovesCustom').classList.toggle('hidden', m !== 'custom');
    var a = $('fAge').value;
    $('fAgeCustom').classList.toggle('hidden', a !== 'custom');
    updateRiskField();
    // A filter narrows the result set, so page 5 of the old set means nothing in the new one.
    currentPage = 0;
    renderList();
  }

  ['fRisk', 'fRiskMin', 'fRiskMax', 'fRiskField', 'fMoves', 'fMovesMin', 'fMovesMax',
   'fAge', 'fAgeFrom', 'fAgeTo', 'fCategory', 'fOpening', 'fMode', 'fRule', 'fTerm'].forEach(function (id) {
    $(id).addEventListener('change', onFilterChange);
  });

  $('toggleFilters').onclick = function () {
    filtersOpen = !filtersOpen;
    $('filterGrid').classList.toggle('hidden', !filtersOpen);
    $('toggleFilters').textContent = filtersOpen ? T('viewer|筛选 ▴') : T('viewer|筛选 ▾');
  };

  $('resetFilters').onclick = function () {
    $('fRisk').value = ''; $('fRiskMin').value = ''; $('fRiskMax').value = '';
    $('fRiskField').value = 'max';
    $('fMoves').value = ''; $('fMovesMin').value = ''; $('fMovesMax').value = '';
    $('fAge').value = ''; $('fAgeFrom').value = ''; $('fAgeTo').value = '';
    $('fCategory').value = ''; $('fOpening').value = ''; $('fMode').value = 'all'; $('fRule').value = 'all';
    $('fTerm').value = '';
    onFilterChange();
  };

  // The three-level opening filter, built from GMOpening.TREE so the 26 names live in
  // exactly one place (openings.js). A native <select> with <optgroup> IS the cascading /
  // tree control here: 全部 → 大类（全部直止 / 全部斜止）→ 具体开局 → 未识别.
  function fillOpeningFilter() {
    // GMOpening.tree() rather than .TREE: the table itself is built at load time, before the
    // stored language is known, so it carries label KEYS and renders them live here.
    var h = '<option value="">' + T('viewer|全部') + '</option>';
    GMOpening.tree().forEach(function (g) {
      h += '<optgroup label="' + esc(g.label) + '">' +
        '<option value="' + g.code + '">' + esc(g.label) + '</option>';
      g.items.forEach(function (it) {
        h += '<option value="' + it.code + '">' + it.code + ' ' + esc(it.label) + '</option>';
      });
      h += '</optgroup>';
    });
    h += '<option value="__none__">' + T('viewer|未识别') + '</option>';
    $('fOpening').innerHTML = h;
  }

  function fillCategoryFilter() {
    var cur = $('fCategory').value;
    var cats = G.listCategories(archives);
    var h = '<option value="">' + T('viewer|全部') + '</option>' +
            '<option value="__none__">' + T('viewer|未分类') + '</option>';
    cats.forEach(function (c) { h += '<option value="' + esc(c) + '">' + esc(c) + '</option>'; });
    $('fCategory').innerHTML = h;
    $('fCategory').value = (cur === '' || cats.indexOf(cur) >= 0 || cur === '__none__') ? cur : '';
  }

  async function refreshArchives() {
    archives = await G.loadArchives();
    fillCategoryFilter();
    renderList();
  }

  function riskColorOf(a) {
    var r = a.maxRisk || 0;
    return r >= 70 ? '#e74c3c' : (r >= 40 ? '#f1c40f' : '#2ecc71');
  }

  // The title you click in the list and the title you land on in the detail view have to
  // be the same string. A default-named archive stores the whole generated sentence
  // ("A VS B  黑72/白85  全局  42手  2026-09-27 14:33") as its name, so printing a.name
  // verbatim above a subtitle that repeats mode/moves/time reads as a glitch.
  //
  // 0.4.6 §一 — THREE levels, and the last one is no longer "unnamed game". A 42-move game with a
  // risk score of 85 was showing the English "Unnamed game" as its title purely because no name
  // had been collected, which reads as "this archive is broken" when the record itself is fine.
  // An unnamed game and an unreadable one are different things, and the title should say which:
  // 「黑方 VS 白方」 states exactly as much as we know, and never less than the record holds.
  // The per-side halves fall back too, so a half-read pair prints 「Alice VS 白方」 rather than
  // 「Alice VS ?」 — the "?" told the operator nothing that the label does not say better.
  // 0.4.11 §一.4 — is this archive's name the GENERATED default, or one the operator typed?
  // The obvious test — `a.name === G.defaultArchiveName(a)` — compares a string built in the
  // language the archive was CREATED in against one built in the language live NOW, and
  // defaultArchiveName embeds T('archive|黑') / T('archive|手') / T('archive|和棋'). Switch the
  // UI language and every old archive reads as hand-renamed: the card grows an 原命名 line and
  // the detail title turns from 「A VS B」 into the whole 「A VS B 黑72/白85 全局 42手 …」 string.
  // 0.4.11 records the answer instead — buildArchive marks a generated name `nameIsDefault:
  // true`, a rename marks it `false` — and the string comparison survives only as the fallback
  // for archives written by 0.4.10 or earlier, which have no flag.
  function isDefaultName(a) {
    if (a.nameIsDefault === true) return true;
    if (a.nameIsDefault === false) return false;
    return !a.name || a.name === G.defaultArchiveName(a);
  }

  function displayName(a) {
    var p = a.players || {};
    // `!isDefaultName(a)` subsumes the old `a.name && a.name !== default` guard: a blank name
    // is the default (there is nothing to show as-is), so the VS title below still wins.
    if (!isDefaultName(a)) return a.name;
    if (p.black || p.white) return (p.black || T('viewer|黑方')) + ' VS ' + (p.white || T('viewer|白方'));
    if (p.self || p.opponent) return (p.self || T('viewer|黑方')) + ' VS ' + (p.opponent || T('viewer|白方'));
    return T('viewer|黑方') + ' VS ' + T('viewer|白方');
  }

  function renderList() {
    var f = currentFilters();
    var active = G.countActiveFilters(f);
    var list = G.filterArchives(archives, f);
    list = G.sortArchives(list, sortKey, sortDir);

    // 0.3.1: page size = 15 × columns. Measure how many columns fit, then paginate.
    var cols = computeCols();
    var size = PER_COL * cols;
    clampPage(list.length, size);

    var pages = pageCount(list.length, size);
    var start = currentPage * size;
    var pageList = list.slice(start, start + size);

    $('fchat').textContent = active ? T('viewer|筛选中：{n} 项', { n: active }) : '';
    $('resetFilters').disabled = !active;
    $('listCount').textContent = T('viewer|共 {n} 局 · 显示 {shown} 局', { n: archives.length, shown: list.length }) +
      (pages > 1 ? T('viewer|（第 {p}/{pages} 页）', { p: currentPage + 1, pages: pages }) : '') +
      (archives.length >= G.MAX_ARCHIVES
        ? T('viewer|（已达上限 {max}，旧的会被淘汰）', { max: G.MAX_ARCHIVES }) : '');

    var box = $('cards');
    if (!list.length) {
      box.className = '';
      box.innerHTML = '<div class="empty">' +
        (archives.length ? T('viewer|没有符合筛选条件的存档。')
                         : T('viewer|还没有存档。在 gomoku.com 对局结束后会自动写入。')) + '</div>';
      renderPager(0, size);
      updateSortHeaders();
      updateArchiveBulkBar([]);
      return;
    }
    // Column-first grid: 15 cards per column, as many columns as `cols`. The grid fills
    // top-to-bottom then left-to-right, so a card's position already encodes its number —
    // we just label it 1, 2, 3… in that same order.
    box.className = 'archive-grid' + (aBulkMode ? ' bulk' : '');
    box.innerHTML = pageList.map(function (a, i) {
      var no = start + i + 1;
      var isDefault = isDefaultName(a);
      // 0.4.1 §三.4: a game whose move order is wrong used to look exactly like a clean one
      // until it was opened. The badge is the whole point of `quality` — it is the only place
      // the difference is visible across the library at a glance.
      var rm = (a.record && a.record.meta) || {};
      var rp = a.report || {};
      var qUnordered = rm.unorderedCount != null ? rm.unorderedCount
        : rm.inferredCount != null ? rm.inferredCount : (rp.prejoinCount || 0);
      var q = qualityOf(a.quality, rm.orderIssues || (rp.orderIssues || []).length, qUnordered, rm.dropped || 0);
      // The two labels are chosen with an `if` rather than an inline ternary: the key
      // extractor (`_tools/keys.cjs`) only recognises a string literal sitting directly inside
      // a `T(` call, so a key buried in a `?:` never reaches the dictionary and falls back to
      // the Chinese original in every language. Same trap as 0.3.7's 12 missing strings.
      var qLabel;
      if (q === 'suspect') qLabel = T('viewer|数据可疑');
      else qLabel = T('viewer|数据不全');
      var qBadge = q === 'good' ? '' : ' · ' + qLabel;
      var meta = (a.blackRisk || 0) + '/' + (a.whiteRisk || 0) + ' · ' + G.modeLabel(a.mode) +
                 ' · ' + T('viewer|{n}手', { n: a.totalMoves || 0 }) +
                 // The opening, when it was identifiable. The archive stores only the code,
                 // so the name comes back from openings.js. 0.4.2 §4.1: a mid-join that pinned
                 // the FAMILY but not which of the 13 openings it was has no code at all — the
                 // family object lives in the record's meta, and without falling back to it the
                 // card would say nothing while the 大类 filter still found the game.
                 (function () {
                   var opo = (rm.opening) || a.opening;
                   return opo ? ' · ' + GMOpening.label(opo) : '';
                 })() +
                 ' · ' + G.beijingTime(a.createdAt) +
                 // 和棋 is the only outcome worth a badge here: a draw has no winner, so
                 // without it the card looks exactly like a game that never finished.
                 (a.outcome === 'draw' ? ' · ' + T('viewer|和棋') : '') +
                 (a.terminated ? ' · ' + T('viewer|活四终止') : '') +
                 (a.report && a.report.prejoinCount
                   ? ' · ' + T('viewer|还原{n}手', { n: a.report.prejoinCount }) : '') +
                 qBadge;
      var tick = aBulkMode
        ? '<span class="tick' + (aSelected[a.id] ? ' on' : '') + '" data-tick="1">' +
            (aSelected[a.id] ? '☑' : '☐') + '</span>'
        : '';
      return '<div class="acard' + (aSelected[a.id] && aBulkMode ? ' sel' : '') + '" data-id="' + a.id + '">' +
        tick +
        '<span class="dno">' + no + '</span>' +
        '<span class="ico" style="background:' + riskColorOf(a) + '"></span>' +
        '<span class="body">' +
          '<span class="nm">' + esc(displayName(a)) + '</span>' +
          (isDefault ? '' : '<span class="meta">' +
            esc(T('viewer|原命名：{name}', { name: G.defaultArchiveName(a) })) + '</span>') +
          '<span class="meta" style="' + (isDefault ? '' : 'margin-top:1px') + '">' + esc(meta) + '</span>' +
          typeLine(a, a.suspect) +
        '</span>' +
        (a.category ? '<span class="cat">' + esc(a.category) + '</span>' : '') +
        '</div>';
    }).join('');

    box.querySelectorAll('.acard').forEach(function (el) {
      el.addEventListener('click', function () {
        // In bulk mode a click is a tick, not a navigation — the same rule the sample grid
        // uses, so selecting five games to delete does not mean opening five detail views.
        if (aBulkMode) { toggleArchiveSel(el.dataset.id); return; }
        openDetail(el.dataset.id);
      });
      el.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (aBulkMode) { toggleArchiveSel(el.dataset.id); return; }
        openCardMenu(ev, el.dataset.id);
      });
    });
    renderPager(list.length, size);
    updateSortHeaders();
    updateArchiveBulkBar(pageList);
  }

  // ---------- 0.3.5 §3.3 存档批量操作 ----------
  // Deliberately the same interaction model as the sample library's 0.3.4 bulk mode
  // (批量 ▾ → tick → act, selection survives paging, leaving the mode clears it): two
  // libraries that behave differently for the same gesture is how a 批量删除 eats the
  // wrong thing.
  var aBulkMode = false;
  var aSelected = {};      // id -> true, kept across pages so a selection can span pages

  function bulkArchiveCount() {
    var n = 0;
    for (var k in aSelected) if (aSelected[k]) n++;
    return n;
  }
  function selectedArchives() {
    return archives.filter(function (a) { return aSelected[a.id]; });
  }
  // The ids of whatever the current page actually shows, so 全选/反选 act on what is visible
  // rather than on the whole (possibly filtered) library.
  function visibleArchivePage() {
    var list = G.sortArchives(G.filterArchives(archives, currentFilters()), sortKey, sortDir);
    var size = PER_COL * computeCols();
    var pages = pageCount(list.length, size);
    if (currentPage > pages - 1) currentPage = pages - 1;
    if (currentPage < 0) currentPage = 0;
    return list.slice(currentPage * size, currentPage * size + size);
  }
  function updateArchiveBulkBar(pageList) {
    if ($('aBulkBar')) $('aBulkBar').classList.toggle('hidden', !aBulkMode);
    if ($('aBulkToggle')) {
      $('aBulkToggle').textContent = aBulkMode ? T('viewer|批量 ▴') : T('viewer|批量 ▾');
      $('aBulkToggle').classList.toggle('on', aBulkMode);
    }
    if ($('aBulkCount')) {
      var n = bulkArchiveCount();
      var pageN = (pageList || []).filter(function (a) { return aSelected[a.id]; }).length;
      $('aBulkCount').textContent = T('viewer|已选 {n} 个', { n: n }) +
        (pageList ? T('viewer|（本页 {a}/{b}）', { a: pageN, b: pageList.length }) : '');
    }
    ['aBulkRename', 'aBulkCat', 'aBulkExport', 'aBulkDel'].forEach(function (id) {
      if ($(id)) $(id).disabled = !bulkArchiveCount();
    });
  }
  function toggleArchiveSel(id) {
    if (aSelected[id]) delete aSelected[id]; else aSelected[id] = true;
    renderList();
  }

  // 导出 envelope — the same one the samples library uses, so either file type can be told
  // apart by `kind` and neither can be fed to the wrong importer by accident.
  function archiveEnvelope(list) {
    return JSON.stringify({ kind: 'gomoku-archives', version: 1, exportedAt: Date.now(), archives: list }, null, 2);
  }

  $('aBulkToggle').onclick = function () {
    aBulkMode = !aBulkMode;
    // Leaving bulk mode clears the selection: a hidden selection that survives a mode switch
    // is how a later 批量删除 ends up eating archives the operator forgot they had ticked.
    if (!aBulkMode) aSelected = {};
    renderList();
  };
  $('aBulkNone').onclick = function () { aSelected = {}; renderList(); };
  $('aBulkAllPage').onclick = function () {
    visibleArchivePage().forEach(function (a) { aSelected[a.id] = true; });
    renderList();
  };
  $('aBulkInvert').onclick = function () {
    visibleArchivePage().forEach(function (a) {
      if (aSelected[a.id]) delete aSelected[a.id]; else aSelected[a.id] = true;
    });
    renderList();
  };
  $('aBulkDel').onclick = async function () {
    var picked = selectedArchives();
    if (!picked.length) { alert(T('viewer|还没有勾选存档。')); return; }
    if (!confirm(T('viewer|确定删除这 {n} 条存档？此操作不可撤销。', { n: picked.length }) + '\n\n' +
        picked.slice(0, 8).map(function (a) { return '· ' + displayName(a); }).join('\n') +
        (picked.length > 8 ? '\n' + T('viewer|· …还有 {n} 条', { n: picked.length - 8 }) : ''))) return;
    var n = await G.deleteArchives(picked.map(function (a) { return a.id; }));
    aSelected = {};
    await refreshArchives();
    alert(T('viewer|已删除 {n} 条存档。', { n: n }));
  };
  $('aBulkRename').onclick = async function () {
    var picked = selectedArchives();
    if (!picked.length) { alert(T('viewer|还没有勾选存档。')); return; }
    var v = prompt(T('viewer|把这 {n} 条存档统一改名为：', { n: picked.length }), picked[0].name);
    if (v == null || !v.trim()) return;
    var n = await G.renameArchives(picked.map(function (a) { return a.id; }), v.trim());
    await refreshArchives();
    alert(T('viewer|已重命名 {n} 条存档。', { n: n }));
  };
  $('aBulkCat').onclick = async function () {
    var picked = selectedArchives();
    if (!picked.length) { alert(T('viewer|还没有勾选存档。')); return; }
    var all = G.listCategories(archives);
    var v = prompt(T('viewer|把这 {n} 条存档归入分类（留空 = 取消分类）：', { n: picked.length }) + '\n\n' +
      T('viewer|已有分类：{list}', { list: all.length ? all.join(' / ') : T('viewer|（无）') }), '');
    if (v == null) return;
    var n = await G.setArchivesCategory(picked.map(function (a) { return a.id; }), v.trim() || null);
    await refreshArchives();
    alert(T('viewer|已更新 {n} 条存档的分类。', { n: n }));
  };
  $('aBulkExport').onclick = function () {
    var picked = selectedArchives();
    if (!picked.length) { alert(T('viewer|还没有勾选存档。')); return; }
    download('archives-' + picked.length + '.json', archiveEnvelope(picked), 'application/json');
  };
  $('aExportAll').onclick = function () {
    // Exports the FILTERED list, which is what the count next to it says. With no filter
    // that is the whole library, i.e. the backup case this button exists for.
    var list = G.sortArchives(G.filterArchives(archives, currentFilters()), sortKey, sortDir);
    if (!list.length) { alert(T('viewer|没有可导出的存档。')); return; }
    download('archives-all-' + list.length + '.json', archiveEnvelope(list), 'application/json');
  };
  $('aBulkImport').onclick = function () { $('aBulkFile').click(); };
  $('aBulkFile').onchange = async function () {
    var f = $('aBulkFile').files && $('aBulkFile').files[0];
    $('aBulkFile').value = '';
    if (!f) return;
    var text;
    try { text = await f.text(); } catch (e) { alert(T('viewer|读取文件失败：{err}', { err: TE(e.message) })); return; }
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { alert(T('viewer|不是有效的 JSON 文件。')); return; }
    // Accept the batch envelope, a bare array, or one archive object.
    var incoming = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.archives)) ? parsed.archives
      : (parsed && parsed.record) ? [parsed] : null;
    if (!incoming) { alert(T('viewer|文件里没有 archives 数组。')); return; }
    var res = await G.importArchives(incoming);
    await refreshArchives();
    // 0.5.2 §三.1 — after an import, prove the board can actually be painted before the operator
    // clicks into an archive and finds it blank.
    //
    // Two things happen here and they answer different halves of the same report:
    //   · `sizeBoards()` — an imported archive is usually opened in a panel that was hidden while
    //     the page loaded, and a canvas laid out at zero width paints nothing. Re-running it is
    //     cheap and idempotent (see its note).
    //   · the self-check — `archiveStones()` is exactly what `renderDetailBoard()` draws, so if it
    //     yields no stones for a record that HAS moves, the fault is in the record (missing
    //     `sources`, a `stones` array of the wrong length) and not in the board. That is worth a
    //     console line rather than a silent empty board, because the archive list will happily
    //     show the game's name and score.
    sizeBoards();
    if (res.added > 0) {
      var first = archives[0];
      var firstMoves = (first && first.record && first.record.moves) || [];
      if (firstMoves.length) {
        var probe = archiveStones(first, firstMoves.length);
        if (!probe.length) {
          console.warn('[import] 存档 ' + first.id + ' 的棋盘渲染为空，检查 record.moves / sources');
        }
      }
    }
    alert(T('viewer|导入完成：新增 {n} 条', { n: res.added }) +
      (res.remapped ? T('viewer|（其中 {n} 条 id 与现有存档重复，已分配新 id）', { n: res.remapped }) : '') +
      (res.added < incoming.length ? '\n' + T('viewer|另有 {n} 条被跳过（缺少有效的 record.moves）。', { n: incoming.length - res.added }) : '') +
      (archives.length >= G.MAX_ARCHIVES ? '\n' + T('viewer|注意：已达上限 {max}，最旧的存档会被淘汰。', { max: G.MAX_ARCHIVES }) : ''));
  };

  // 上一页 / 页码 / 下一页. Every page number is a button: with the 200-archive cap that is
  // at most 14 of them, so windowing the range would be complexity with no payoff.
  function renderPager(total, size) {
    var pages = pageCount(total, size);
    var el = $('pager');
    el.classList.toggle('hidden', pages <= 1);
    $('pgPrev').disabled = currentPage <= 0;
    $('pgNext').disabled = currentPage >= pages - 1;
    var h = '';
    for (var i = 0; i < pages; i++) {
      h += '<button class="sec' + (i === currentPage ? ' on' : '') + '" data-page="' + i + '">' +
        (i + 1) + '</button>';
    }
    $('pgNums').innerHTML = h;
    $('pgInfo').textContent = T('viewer|第 {p} / {pages} 页 · 每页 {size} 局（{cols} × {rows} 列）',
      { p: currentPage + 1, pages: pages, size: size, cols: PER_COL, rows: size / PER_COL });
  }

  // A page turn replaces 15 cards with 15 others; without scrolling back the operator stays
  // wherever the old list happened to end and sees nothing change. `id` lets the 0.3.3
  // sample grid scroll its own box rather than the archive list's.
  function listTop(id) {
    var box = $(id || 'cards');
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start' });
  }

  $('pgPrev').onclick = function () {
    if (currentPage <= 0) return;
    currentPage--; renderList(); listTop();
  };
  $('pgNext').onclick = function () {
    currentPage++; renderList(); listTop();
  };
  // Delegated: the number buttons are rebuilt on every render, so a per-button listener
  // would have to be re-attached on every render too.
  $('pgNums').onclick = function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-page]') : null;
    if (!b) return;
    currentPage = parseInt(b.dataset.page, 10) || 0;
    renderList();
    listTop();
  };

  function updateSortHeaders() {
    document.querySelectorAll('.ahead .h').forEach(function (h) {
      var on = h.dataset.sort === sortKey;
      h.classList.toggle('on', on);
      var ar = h.querySelector('.ar');
      ar.textContent = on ? (sortDir === 'asc' ? '▲' : '▼') : '';
    });
  }

  document.querySelectorAll('.ahead .h').forEach(function (h) {
    h.onclick = function () {
      var k = h.dataset.sort;
      if (k === sortKey) sortDir = (sortDir === 'asc' ? 'desc' : 'asc');
      else { sortKey = k; sortDir = 'desc'; }
      // Re-sorting reorders the whole set, so the current page number no longer refers to
      // the same games, and it always starts from "highest/newest first".
      currentPage = 0;
      renderList();
    };
  });

  // =====================================================================
  // 回放：右键菜单
  // =====================================================================
  var ctx = $('ctx');

  function closeCtx() { ctx.classList.add('hidden'); ctx.innerHTML = ''; }
  // Only a click that lands outside the open menu closes it. Menu items themselves must
  // stopPropagation (see below): their handler swaps `ctx.innerHTML`, which detaches the
  // clicked node, so by the time this listener runs `ctx.contains(target)` is already
  // false and the freshly opened submenu would be wiped the instant it appeared.
  document.addEventListener('click', function (e) {
    if (!ctx.contains(e.target)) closeCtx();
  });
  window.addEventListener('blur', closeCtx);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeCtx(); closeModal(); } });

  function showCtx(html, x, y) {
    ctx.innerHTML = html;
    ctx.classList.remove('hidden');
    var w = ctx.offsetWidth, h = ctx.offsetHeight;
    ctx.style.left = Math.min(x, window.innerWidth - w - 6) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 6) + 'px';
  }

  function openCardMenu(ev, id) {
    var a = archives.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    showCtx(
      '<div class="it" data-a="view">' + T('viewer|查看') + '</div>' +
      '<div class="it" data-a="rename">' + T('viewer|重命名…') + '</div>' +
      '<div class="it" data-a="cat">' + T('viewer|分类') + ' <span class="k">▸</span></div>' +
      '<div class="sep"></div>' +
      // 0.3.3 §2.4 兼容: an archive's binary `manualAI` marks become 人工标注 labels on the
      // sample, so the 0.3.1 review work is not thrown away when a game is promoted.
      '<div class="it" data-a="tosample">' + T('viewer|转为样本…') + '</div>' +
      '<div class="it" data-a="json">' + T('viewer|导出 JSON') + '</div>' +
      '<div class="it danger" data-a="del">' + T('viewer|删除…') + '</div>',
      ev.clientX, ev.clientY);
    ctx.querySelectorAll('.it').forEach(function (it) {
      it.onclick = function (e2) {
        e2.stopPropagation();               // we are about to replace ctx.innerHTML
        var act = it.dataset.a;
        closeCtx();
        if (act === 'view') openDetail(id);
        else if (act === 'rename') renameDialog(a);
        else if (act === 'cat') openCategoryMenu(e2.clientX, e2.clientY, a);
        else if (act === 'tosample') archiveToSample(a);
        else if (act === 'json') exportArchiveJson(a);
        else if (act === 'del') deleteDialog(a);
      };
    });
  }

  function openCategoryMenu(x, y, a) {
    var cats = G.listCategories(archives);
    var h = '<div class="ti">' + esc(a.name.slice(0, 22)) + '</div>' +
      '<div class="it" data-c="__none__">' + T('viewer|未分类') + (a.category ? '' : ' <span class="k">✓</span>') + '</div>';
    cats.forEach(function (c) {
      h += '<div class="it" data-c="' + esc(c) + '">' + esc(c) + (a.category === c ? ' <span class="k">✓</span>' : '') + '</div>';
    });
    h += '<div class="sep"></div><div class="it" data-c="__new__">' + T('viewer|＋ 新建分类…') + '</div>' +
         '<div class="it" data-c="__manage__">' + T('viewer|管理分类…') + '</div>';
    showCtx(h, x, y);
    ctx.querySelectorAll('.it').forEach(function (it) {
      it.onclick = async function (e2) {
        e2.stopPropagation();
        var c = it.dataset.c;
        closeCtx();
        if (c === '__manage__') { manageCategories(); return; }
        if (c === '__new__') { c = prompt(T('viewer|新建分类名称')); if (!c) return; }
        if (c === '__none__') c = null;
        await G.categorizeArchive(a.id, c);
        await refreshArchives();
      };
    });
  }

  function renameDialog(a) {
    var v = prompt(T('viewer|新名称（只改显示名，不改 id）'), a.name);
    if (v == null || !v.trim()) return;
    G.renameArchive(a.id, v.trim()).then(refreshArchives);
  }

  function deleteDialog(a) {
    if (!confirm(T('viewer|删除存档「{name}」？此操作不可撤销。', { name: a.name }))) return;
    G.deleteArchive(a.id).then(refreshArchives);
  }

  function exportArchiveJson(a) {
    download('gomoku-archive-' + a.id + '.json', JSON.stringify(a, null, 2), 'application/json');
  }

  function manageCategories() {
    var cats = G.listCategories(archives);
    if (!cats.length) { alert(T('viewer|还没有分类。在存档上右键 → 分类 → 新建分类。')); return; }
    var h = cats.map(function (c) {
      var n = archives.filter(function (a) { return a.category === c; }).length;
      return '<div class="crow"><span class="cn">' + esc(c) + ' <span class="hint">' + T('viewer|（{n} 局）', { n: n }) + '</span></span>' +
        '<button class="sec" data-r="' + esc(c) + '">' + T('viewer|重命名') + '</button>' +
        '<button class="sec danger" data-d="' + esc(c) + '">' + T('viewer|删除') + '</button></div>';
    }).join('');
    openModal(T('viewer|管理分类'), h, function (body) {
      body.querySelectorAll('[data-r]').forEach(function (b) {
        b.onclick = async function () {
          var from = b.dataset.r;
          var to = prompt(T('viewer|分类重命名'), from);
          if (!to || to === from) return;
          await G.renameCategory(from, to);
          await refreshArchives();
          closeModal();
          manageCategories();
        };
      });
      body.querySelectorAll('[data-d]').forEach(function (b) {
        b.onclick = async function () {
          var c = b.dataset.d;
          if (!confirm(T('viewer|删除分类「{name}」？该分类下的存档会变为未分类，存档本身保留。', { name: c }))) return;
          await G.deleteCategory(c);
          await refreshArchives();
          closeModal();
          manageCategories();
        };
      });
    });
  }

  // ---- modal ----
  // 0.5.4 §5.1.2 turned this into a STACK. Before, `openModal` began with `closeModal()`, so the
  // one flow that opens a dialog FROM a dialog — clicking a card inside 标签百科 — destroyed the
  // list behind it: the operator read one entry and had nowhere to go but reopen the wiki. The
  // stack is the smallest shape that fixes it; every other caller opens at depth 1 and therefore
  // behaves exactly as before, because `closeModal()` on a one-deep stack is the old code.
  var maskStack = [];
  var maskEl = null;
  function openModal(title, bodyHtml, onMount, opts) {
    var o = opts || {};
    if (!o.stack) closeAllModals();
    maskEl = document.createElement('div');
    maskEl.className = 'mask';
    maskEl.innerHTML = '<div class="modal' + (o.size === 'large' ? ' modal-lg' : '') +
      '"><h3>' + esc(title) + '</h3>' +
      '<div class="bd"></div><div class="ft"><button class="sec" data-close="1">' + T('viewer|关闭') + '</button></div></div>';
    maskEl.querySelector('.bd').innerHTML = bodyHtml;
    maskEl.querySelector('[data-close]').onclick = closeModal;
    maskEl.addEventListener('click', function (e) { if (e.target === maskEl) closeModal(); });
    maskStack.push(maskEl);
    document.body.appendChild(maskEl);
    if (onMount) onMount(maskEl.querySelector('.bd'));
  }
  // Pops the TOP layer only. Escape and the per-dialog 关闭 button both land here, which is what
  // makes the detail window return to the list instead of closing everything.
  function closeModal() {
    var el = maskStack.pop();
    if (el && el.parentNode) el.parentNode.removeChild(el);
    maskEl = maskStack.length ? maskStack[maskStack.length - 1] : null;
  }
  function closeAllModals() {
    while (maskStack.length) {
      var el = maskStack.pop();
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    maskEl = null;
  }

  // =====================================================================
  // 0.4.10 §三 新手教程
  // =====================================================================
  // The spec calls for ~5000–8000 characters across 13 languages and says to ship 中文 + 英文
  // first, with the rest falling back to English. That is exactly why this content does NOT go
  // into `locale/*.js`: those tables are generated from `_tools/i18n-ui.js`, every key there is
  // required to carry all 12 translations, and `gen-locale --check` would fail the moment one
  // language was missing. A separate, partially-translated corpus with an explicit fallback is
  // the only shape that can be half-done on purpose.
  //
  // It is deliberately NOT translated through T()/GMI18n either: every consumer of that path
  // resolves a key in ONE current locale, whereas this needs "the reader's language, or English".
  var TUTORIAL = [
    {
      h: { 'zh-CN': '1. 快速开始', en: '1. Quick start' },
      b: {
        'zh-CN': [
          '白身（Baishen）是这套反作弊检测器的名字。采集与引擎分析都在你自己的浏览器里完成。',
          '安装扩展后打开 gomoku.com 或 papergames.io 的对局页，浮层会自动出现在角落并开始采集。',
          '一局结束（或你点「分析当前对局」）后引擎开始分析。看两样东西：面板上的风险分，和浮层边框的颜色。',
          '边框是给眼角看的：绿=低风险，橙=可疑，红=高风险。详细结论在「查看器」里。',
        ],
        en: [
          'Baishen（白身）is the name of this anti-cheat detector. Collection and engine analysis both happen inside your own browser.',
          'Open a game on gomoku.com or papergames.io. The overlay appears in a corner on its own and starts collecting.',
          'After the game ends — or when you press 分析当前对局 — the engine analyses it. Watch two things: the risk score in the panel, and the colour of the overlay border.',
          'The border is meant for the corner of your eye: green = low, orange = suspect, red = high. The detailed verdict lives in the viewer.',
        ],
      },
    },
    {
      h: { 'zh-CN': '2. 浮层按钮', en: '2. Panel buttons' },
      b: {
        'zh-CN': [
          '查看器：打开完整窗口（回放、样本库、黑名单、设置）。',
          '复制对局数据：把当前报告压成一行文本，方便贴给别人。',
          '🚫：把对手加入或移出本地黑名单。取不到对手用户名时它会变灰且不可点。',
          '语言 / 规则：切换界面语言；切换五子棋规则（自动 / 自由 / 标准 / 连珠）。',
          '提问：先选语言，再从题库里挑一道题发给对手。只有预设题目，没有自由输入。',
          '缩略 / —：把浮层缩成只显示评估值，或缩成一个图标。✕ 关闭浮层（采集继续进行，点扩展图标可以再打开）。',
        ],
        en: [
          '查看器 (viewer): opens the full window — replay, sample library, blacklist, settings.',
          '复制对局数据 (copy): flattens the current report into one line you can paste elsewhere.',
          '🚫: adds or removes the opponent from your local blacklist. It greys out and stops responding when no username can be resolved.',
          '语言 / 规则 (language / rules): switches the interface language, and the gomoku rule set (auto / free / standard / renju).',
          '提问 (ask): pick a language, then pick a question from the bank and send it. Preset questions only — there is no free-text box.',
          '缩略 / — (compact / minimise): shrinks the overlay to just the scores, or to a single icon. ✕ closes it; collection keeps running and the extension icon brings it back.',
        ],
      },
    },
    {
      h: { 'zh-CN': '3. 边框状态', en: '3. Border states' },
      b: {
        'zh-CN': [
          '蓝色呼吸：待机 —— 还没开始一局，或者这局已经看完了。',
          '蓝色常亮：就绪 —— 有棋局，但还没有任何分析结果。',
          '绿色闪 3 下后转绿：本局第一次检测开始了，接着就是低风险的结果。',
          '绿色常亮 = 低风险；橙色常亮 = 可疑；红色闪 2 下后常亮 = 高风险。',
          '红色闪 3 下：匹配到黑名单里的玩家（优先级最高，播完交还给本该显示的状态）。',
          '风险从高降到低时边框直接切换、不会闪 —— 降级不是新闻。',
        ],
        en: [
          'Breathing blue: idle — no game started, or the current one is finished.',
          'Solid blue: ready — a game exists but nothing has been analysed yet.',
          'Green, three flashes then solid: the first detection of this game started; green is also the low-risk result colour.',
          'Solid green = low risk; solid orange = suspect; red, two flashes then solid = high risk.',
          'Three red flashes: the opponent is on your blacklist. This outranks everything and hands the border back when it finishes.',
          'A risk that DROPS cuts straight across without flashing — a downgrade is not news.',
        ],
      },
    },
    {
      h: { 'zh-CN': '4. 检测结果怎么看', en: '4. Reading the result' },
      b: {
        'zh-CN': [
          '风险分：0–100，越高越可疑。一般低于 40 视为正常，40–69 可疑，70 以上高风险。',
          'AI 分类：把每一手归为「像人」「像 AI」「存疑」，看的是整局的分布而不是单步。',
          '分段：把连续同向的手数连成一段，一眼看清哪一段开始变了。',
          '回避手：明明该走却故意避开的选择，单独统计、不计入主要指标。',
          '唯一手：全局唯一正确手，连续命中是强信号。',
          '无用冲四：白冲一四、不产生威胁，是典型的「装作在进攻」。',
          '跳四：间隔型的四（如 X_XXX / XX_XX）。它有且只有一个成五点，但那个点在四的中间，挡它的同一手也可能顺手挡掉活三，所以「跳四 + 活三」不按四三杀处理 —— 检测会继续，并在步骤里标出「跳四」。',
        ],
        en: [
          'Risk score: 0–100, higher is more suspicious. Below 40 is normally human, 40–69 suspect, 70+ high.',
          'AI classification: each move is labelled human-like, AI-like or doubtful. Read the distribution over the game, not one move.',
          'Segments: consecutive hands pointing the same way are joined into one bar, so you can see where the game changed.',
          'Evasion moves: choices that deliberately avoid the natural move. Counted separately and kept out of the main metrics.',
          'Unique moves: the one globally correct move. Streaks of them are a strong signal.',
          'Useless fours: a four that creates no real threat — the hallmark of pretending to attack.',
          'Jump four: a four with a gap (X_XXX / XX_XX). It has exactly one completing point, but that point sits INSIDE the four — the same stone that blocks it may also block an open three. So 跳四 + 活三 is not treated as a kill: detection continues and the step is badged 跳四.',
        ],
      },
    },
    {
      h: { 'zh-CN': '5. 指标含义', en: '5. What the metrics mean' },
      b: {
        'zh-CN': [
          'Top-1 / Top-3 / Top-5 命中率：实走落在引擎前 1 / 3 / 5 个选点里的比例。',
          'ACPL：平均每手与引擎首选相差多少分，越低越像引擎。',
          '唯一手命中：唯一正确手里被实际走出的比例，连续命中尤其说明问题。',
          'Top-5 外：前三五名之外的选择，人会有，引擎很少有。',
          '时间模式：落子耗时的分布。人类忽快忽慢，引擎常常过分均匀。',
          '冲四豁免：被对手逼出来的唯一防守不算可疑，按形状判定而不是按引擎判定。',
          '豁免的范围只有「冲四强制应对手」这一种。开放局面里引擎恰好只推荐一个的「唯一好手」不算被迫，正常计入统计。',
        ],
        en: [
          'Top-1 / 3 / 5: how often the played move is inside the engine\'s best 1 / 3 / 5 candidates.',
          'ACPL: the average score lost per move against the engine\'s first choice. Lower looks more like an engine.',
          'Unique-move hits: how many of the single correct moves were actually played. Consecutive hits are the interesting case.',
          'Outside Top-5: choices the engine would rarely make but a human often would.',
          'Time pattern: the distribution of move times. Humans are erratic; engines are often unnaturally even.',
          'Forced-four exemption: a defence forced by the opponent is not suspicious. This is decided by the SHAPE, not by the engine.',
          'The exemption covers exactly one kind of hand: a forced answer to a four. A 唯一好手 that is merely the engine\'s favourite in an open position is not forced, so it counts normally.',
        ],
      },
    },
    {
      h: { 'zh-CN': '6. 标签体系', en: '6. Tags' },
      b: {
        'zh-CN': [
          '预设标签（标准、存疑、黑方AI、白方AI 等）用来给整局归类，方便以后筛选和统计。',
          '自定义标签由你自己创建，用来放自己的分类法；它们在颜色上与预设标签区分开。',
        ],
        en: [
          'Preset tags (standard, doubtful, black-AI, white-AI, …) classify a whole game so you can filter and count later.',
          'Custom tags are yours to invent. They are coloured differently so they never look like part of the fixed vocabulary.',
        ],
      },
    },
    {
      h: { 'zh-CN': '7. 人工标注', en: '7. Manual annotation' },
      b: {
        'zh-CN': [
          '在回放里可以逐手标注：判断准确 / 判断错误、AI 步骤、冲四、无用冲四、可疑、豁免。',
          '这些标注是学习器的输入 —— 你标的越多，阈值越贴合你实际遇到的对局。',
        ],
        en: [
          'In the replay you can label moves one by one: correct / wrong, AI move, four, useless four, suspicious, exempt.',
          'Those labels feed the learner. The more you mark, the closer the thresholds get to the games you actually meet.',
        ],
      },
    },
    {
      h: { 'zh-CN': '8. 样本库', en: '8. Sample library' },
      b: {
        'zh-CN': [
          '为什么需要：单局的分数只是这一局的证据，样本库让很多局的结论可以互相校准。',
          '怎么积累：对局结束后把它存成样本（或直接标注），标出它到底是人还是 AI。',
          '学习机制：样本足够后运行一次学习，各指标的权重与阈值会据此调整。',
        ],
        en: [
          'Why: one game is evidence about one game. The library lets many games calibrate each other.',
          'How: save a finished game as a sample (or annotate it directly) and say whether it was human or AI.',
          'Learning: once you have enough samples, run the learner and the weights and thresholds move accordingly.',
        ],
      },
    },
    {
      h: { 'zh-CN': '9. 黑名单', en: '9. Blacklist' },
      b: {
        'zh-CN': [
          '用途：记住你不再想遇到的玩家，下次匹配到时浮层会红闪提醒。',
          '怎么添加：点浮层头部的 🚫，或在查看器的「黑名单」页手动添加。',
          '键是用户名（playerId），不是会变的显示名；只存在这台机器上，从不上传。',
        ],
        en: [
          'What for: remember players you would rather not meet again. The overlay flashes red when you do.',
          'How to add: press 🚫 in the panel header, or add one by hand on the viewer\'s 黑名单 page.',
          'The key is the username (playerId), not the display name, which can change. It lives on this machine only and is never uploaded.',
        ],
      },
    },
    {
      h: { 'zh-CN': '10. 如何提高精准度', en: '10. Improving accuracy' },
      b: {
        'zh-CN': [
          '多打几局再下结论：一局的样本量太小，累计多局的结论才可靠。',
          '勤标注：把你已经确定的「人」和「机」存进样本库，学习器需要正反两类。',
          '重新学习：样本积累到一定数量后重跑学习，阈值会更新。',
          '调整检测思考时间：思考时间越长，引擎越准，也越慢。',
          '选对规则：连珠（有禁手）与自由规则的最优手不同，规则错了结论也会偏。',
        ],
        en: [
          'Play several games before deciding: one game is a very small sample.',
          'Annotate as you go: the learner needs both the human and the AI cases, so save the ones you are sure about.',
          'Re-run the learner once the library has grown; the thresholds move with it.',
          'Raise the detection think time: more time means a stronger engine, at the cost of speed.',
          'Pick the right rule set: renju (with forbidden moves) and free gomoku have different best moves, and the wrong rule skews everything.',
        ],
      },
    },
    {
      h: { 'zh-CN': '11. 常见问题', en: '11. Common questions' },
      b: {
        'zh-CN': [
          '中途加入对局：加入之前的手数没有数据，风险分只反映你看到的那部分。',
          '数据不完整：页面刷新、掉线或中途退出都会丢手数，报告里会写明采集到多少手。',
          '引擎降级：多线程构建不可用时会自动退回单线程，结论仍然有效，只是更慢。',
          '无法获取玩家名：观战、游客身份或页面结构变化时取不到用户名，黑名单会变灰不可用。',
        ],
        en: [
          'Joining mid-game: moves played before you joined are not in the record, so the score only covers what you saw.',
          'Incomplete data: a refresh, a disconnect or leaving early loses moves. The report states how many hands were collected.',
          'Engine fallback: when the multi-threaded build is unavailable the engine drops to single-threaded. The verdict still stands, it is just slower.',
          'No username: while spectating, as a guest, or if the page structure changes, no username can be read and the blacklist greys out.',
        ],
      },
    },
  ];

  // The reader's language, or English. 「中文先行」 means both Chinese locales get the Chinese
  // text; every other language gets English rather than nothing.
  function tutPick(map) {
    if (!map) return '';
    if (LANG === 'zh-TW') return map['zh-TW'] || map['zh-CN'] || map.en;
    if (LANG === 'zh-CN') return map['zh-CN'] || map.en;
    return map.en || map['zh-CN'];
  }

  function tutorialHtml() {
    var out = '';
    for (var i = 0; i < TUTORIAL.length; i++) {
      var sec = TUTORIAL[i];
      var body = tutPick(sec.b) || [];
      out += '<h4 class="tut-h">' + esc(tutPick(sec.h)) + '</h4><ul class="tut-ul">';
      for (var j = 0; j < body.length; j++) out += '<li>' + esc(body[j]) + '</li>';
      out += '</ul>';
    }
    return out;
  }

  function openTutorial() {
    openModal(T('viewer|新手教程'), tutorialHtml());
  }

  // =====================================================================
  // 0.5.3 §1.4 标签百科
  // =====================================================================
  // The list is rendered, filtered and re-rendered on every keystroke rather than being built
  // once and hidden with CSS. 36 entries is small enough that the rebuild is free, and a
  // rebuild is the only version that cannot leave a stale row visible: hiding rows means
  // remembering to un-hide them, and that is where this kind of UI goes wrong.
  //
  // The search runs over the FILLED text (see `GM_TAG_WIKI.matches`), so typing `75` finds the
  // AI bands and typing `吻合` finds the signal whose displayed name contains it but whose slug
  // does not — the name is resolved through TO() here and handed to the matcher, because
  // tagWiki.js deliberately has no i18n dependency.
  var twState = { q: '', cat: 'all' };

  function twNameOf(entry) { return TO(entry.nameNs, entry.nameVal); }

  // Literal `T()` calls, for the reason spelled out at `tpLabel()`: the category id is a
  // runtime value, so a computed key would be invisible to `_tools/keys.cjs` and every
  // non-Chinese locale would print the Chinese category name.
  function twCatLabel(id) {
    if (id === 'all') return T('viewer|全部');
    if (id === 'preset') return T('viewer|预设标签');
    if (id === 'ann') return T('viewer|人工标注');
    if (id === 'type') return T('viewer|AI分类');
    if (id === 'signal') return T('viewer|检测信号');
    return id;
  }

  function tagWikiHtml() {
    // 0.5.6 补增 §三 — the figures are read from the live table while this HTML is built, and the
    // operator's own weights are part of that table. Handed over once per paint rather than cached
    // at boot: the panel may have changed since, and the wiki opens long after it.
    syncTagWeightTable();
    var list = GM_TAG_WIKI.filter({ q: twState.q, cat: twState.cat, nameOf: twNameOf });
    if (!list.length) return '<div class="tw-empty">' + esc(T('viewer|没有匹配的标签')) + '</div>';
    return '<div class="tw-list">' + list.map(function (entry) {
      var body = GM_TAG_WIKI.resolve(entry, LANG);
      // §1.4.3's card: name, category, then 意义 / 用法 / 影响. The 「仅记录」 chip appears only
      // on the entries whose effect the code does not implement — see the header of tagWiki.js
      // for why three of them say so.
      return '<div class="tw-item" data-id="' + esc(entry.id) + '"><h4>' + esc(twNameOf(entry)) +
        '<span class="tw-cat-chip">' + esc(twCatLabel(entry.cat)) + '</span>' +
        (body.applied ? '' : '<span class="tw-rec">' + esc(T('viewer|仅记录')) + '</span>') +
        '</h4><dl>' +
        '<dt>' + esc(T('viewer|意义')) + '</dt><dd>' + esc(body.meaning) + '</dd>' +
        '<dt>' + esc(T('viewer|用法')) + '</dt><dd>' + esc(body.usage) + '</dd>' +
        '<dt>' + esc(T('viewer|影响')) + '</dt><dd>' + esc(body.impact) + '</dd>' +
        '</dl></div>';
    }).join('') + '</div>';
  }

  function tagWikiChrome() {
    var cats = [{ id: 'all' }].concat(GM_TAG_WIKI.CATS);
    return '<div class="tw-bar">' +
      '<input type="search" id="twQ" placeholder="' + esc(T('viewer|搜索标签')) + '" value="' + esc(twState.q) + '">' +
      '<div class="tw-cats">' + cats.map(function (c) {
        return '<span class="tw-cat' + (twState.cat === c.id ? ' on' : '') + '" data-cat="' +
          esc(c.id) + '">' + esc(twCatLabel(c.id)) + '</span>';
      }).join('') + '</div></div>' +
      '<div id="twBody">' + tagWikiHtml() + '</div>';
  }

  function openTagWiki() {
    twState = { q: '', cat: 'all' };
    openModal(T('viewer|标签百科'), tagWikiChrome(), function (bd) {
      var q = bd.querySelector('#twQ');
      var body = bd.querySelector('#twBody');
      // Only the body is repainted while typing, so the input keeps focus and the caret does not
      // jump to the end on every keystroke — the same reason the settings page refuses to
      // rewrite a focused box.
      function repaint() {
        if (body) body.innerHTML = tagWikiHtml();
        var chips = bd.querySelectorAll('.tw-cat');
        for (var i = 0; i < chips.length; i++) {
          chips[i].classList.toggle('on', chips[i].getAttribute('data-cat') === twState.cat);
        }
      }
      if (q) {
        q.addEventListener('input', function () { twState.q = q.value; repaint(); });
        q.focus();
      }
      bd.addEventListener('click', function (e) {
        var chip = e.target && e.target.closest ? e.target.closest('.tw-cat') : null;
        if (chip) {
          twState.cat = chip.getAttribute('data-cat') || 'all';
          repaint();
          return;
        }
        // 0.5.4 §5.1.1 — a card opens the 大字详情 window. The two hits are checked in one
        // delegated listener rather than two, because `repaint()` replaces the cards' DOM on
        // every keystroke: per-card listeners would have to be re-bound on each paint, and the
        // one that is forgotten is the one that stops working.
        var item = e.target && e.target.closest ? e.target.closest('.tw-item') : null;
        if (item) openTagDetail(item.getAttribute('data-id'));
      });
    });
  }

  // 0.5.4 §5.1.2 — 「数值影响」 with the figures in it.
  //
  // The spec calls `renderImpactTable(t.impactValues)`. tagWiki.js has no `impactValues`, and
  // that is on purpose: its header explains that no entry stores a figure, only the KEY one can
  // be read from (`weightKey` / `bandLo` / `bandHi`), so the wiki cannot drift away from
  // `BASE_WEIGHTS` / `BASE_THRESHOLDS`. This renders those live figures instead, which is the
  // same table the spec wants, minus the second copy of the numbers.
  //
  // A key that cannot be read prints an em dash and never a zero — `tagWiki.js:fill()`'s rule, and
  // the reason `weight()` returns null instead of a default.
  function tagImpactTable(entry) {
    var rows = [];
    if (entry.weightKey) {
      var w = GM_TAG_WIKI.weight(entry.weightKey);
      rows.push([T('viewer|权重'), w == null ? GM_TAG_WIKI.DASH : String(w)]);
    }
    if (entry.bandLo || entry.bandHi) {
      // `bandLo: null` means 0 and `bandHi: null` means 100 (tagWiki.js's own table comment) —
      // unlike `weight()`, which returns null to mean "unreachable". Absent and unreadable are
      // different answers, so only the absent side gets the documented default.
      var lo = entry.bandLo ? GM_TAG_WIKI.band(entry.bandLo) : 0;
      var hi = entry.bandHi ? GM_TAG_WIKI.band(entry.bandHi) : 100;
      var d = GM_TAG_WIKI.DASH;
      rows.push([T('viewer|区间'),
        (lo == null ? d : String(Math.round(lo))) + ' \u2013 ' + (hi == null ? d : String(Math.round(hi)))]);
    }
    if (!rows.length) return '';
    return '<table class="impact-table">' + rows.map(function (r) {
      return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>';
    }).join('') + '</table>';
  }

  function openTagDetail(tagId) {
    var entry = GM_TAG_WIKI.byId(tagId);
    if (!entry) return;
    // 0.5.6 补增 §三 — this window renders `resolve()`'s `{w}` figures and the impact table below,
    // both straight off the live table. See tagWikiHtml for why the hand-over is here rather than
    // at boot.
    syncTagWeightTable();
    var body = GM_TAG_WIKI.resolve(entry, LANG);
    function section(title, text) {
      return '<div class="tag-detail-section"><h3>' + esc(title) + '</h3>' +
        '<p>' + esc(text) + '</p></div>';
    }
    var html = '<div class="tag-detail">' +
      '<h2 class="tag-detail-title">' + esc(twNameOf(entry)) +
      (body.applied ? '' : '<span class="tag-detail-rec">' + esc(T('viewer|仅记录')) + '</span>') +
      '</h2>' +
      '<div class="tag-detail-category">' + esc(T('viewer|分类：') + twCatLabel(entry.cat)) + '</div>' +
      section(T('viewer|意义'), body.meaning) +
      section(T('viewer|用法'), body.usage) +
      '<div class="tag-detail-section"><h3>' + esc(T('viewer|数值影响')) + '</h3>' +
      '<p>' + esc(body.impact) + '</p>' + tagImpactTable(entry) + '</div>' +
      '</div>';
    // `{stack:true}` so 关闭 returns to the list the card came from — see the modal section.
    openModal(T('viewer|标签详情'), html, null, { size: 'large', stack: true });
  }

  // =====================================================================
  // 回放：详情
  // =====================================================================
  // The board is fed by `record.moves` — every stone that was ever on the board — while
  // the step slider walks `report.steps` — only the moves that carry a verdict. The two
  // arrays are NOT the same length, and treating the step ordinal as a stone count is
  // exactly what made a 25-move mid-join game draw 12 stones: the record's two blocks (an
  // order-unknown prefix recovered from a board render, then the moves the socket really
  // reported) are 12 + 13 long, so "step 13" cut the board off inside the first block.
  //
  // What links the two is the record index a step judged (`step.i`). Archives written
  // before that field existed fall back to the coordinate: a gomoku point is played at
  // most once per game, so `actual` identifies the slot exactly.
  function stepRecordIdx(rec, s) {
    if (s && typeof s.i === 'number' && s.i >= 0) return s.i;
    var mv = (rec && rec.moves) || [];
    if (!s || !s.actual) return -1;
    for (var i = 0; i < mv.length; i++) {
      if (mv[i] && mv[i][0] === s.actual[0] && mv[i][1] === s.actual[1]) return i;
    }
    return -1;
  }

  // Record index a step judged. `ordinal` (its 0-based position among the steps) is the
  // last resort for an archive whose steps cannot be located — hand-edited JSON, or a
  // report written by something other than app.js.
  function stepIdxOf(a, s, ordinal) {
    var idx = stepRecordIdx((a && a.record) || {}, s);
    return idx < 0 ? ordinal : idx;
  }

  // 0.5.2 §三.1 — the slider's upper bound, and the ONLY definition of it.
  //
  // `dStep` used to be bounded by `report.steps.length` everywhere (openDetail, the slider's
  // `max`, 下一步/末步, the jump box). An archive whose report carries NO steps — a 导入 archive
  // built from a bare `record`, a game analysed to a shorter depth, an archive whose report was
  // trimmed by 精简存档 — therefore had a bound of 0. `stonesShown()` returns 0 at `dStep <= 0`,
  // so the board came up EMPTY and the slider could not move off 0: the operator's 「导入后棋盘
  // 不显示棋子」.
  //
  // The bound is the step count when there is one and the MOVE count when there is not. Falling
  // back to `record.moves.length` is what makes `stonesShown` paint the whole board: at
  // `dStep >= steps.length` it already returns `total`, and with `steps.length === 0` every
  // non-zero `dStep` satisfies that. So no change to `stonesShown` itself is needed — only the
  // bound was wrong. Keeping this in one function is the point: five call sites used to spell the
  // same `curArchive.report ? …steps.length : 0` out by hand, and fixing four of them would have
  // left the fifth to re-break it.
  function detailMax(a) {
    var steps = (a && a.report && a.report.steps) || [];
    var moves = (a && a.record && a.record.moves) || [];
    return steps.length || moves.length;
  }

  // How many stones of `record.moves` belong on the board at step `dStep` (0 = opening).
  // The end of the slider means the whole board, not "as many stones as there are steps".
  function stonesShown(a, dStep) {
    var steps = (a && a.report && a.report.steps) || [];
    var total = ((a && a.record && a.record.moves) || []).length;
    if (dStep <= 0) return 0;
    if (dStep >= steps.length) return total;
    return Math.min(stepIdxOf(a, steps[dStep - 1], dStep - 1) + 1, total);
  }

  // `shown` is a count of record moves, NOT a step number — see stonesShown.
  function archiveStones(a, shown) {
    var rec = (a && a.record) || {};
    var moves = rec.moves || [];
    var sources = rec.sources || [];
    var stones = rec.stones || [];
    var out = [];
    var pi = 0;
    for (var i = 0; i < moves.length && i < shown; i++) {
      var src = sources[i] || 'player';
      var ref = src === 'ai-suggest';
      // A stone recovered from a board render: its POSITION is exact, its place in the
      // move order is not. It has to be drawn (every later position is only correct with
      // it on the board) but it must not read like an ordinary numbered move.
      var unordered = src === 'prejoin';
      // The recorded colour when we have it. Index parity is only a fallback: the board
      // must not repaint a black stone as white just because one move went missing.
      var side = stones[i] ? (stones[i] === 1 ? 'B' : 'W') : (pi % 2 === 0 ? 'B' : 'W');
      if (ref) {
        out.push({ x: moves[i][0], y: moves[i][1], side: side, moveNo: null, ref: true });
      } else {
        out.push({ x: moves[i][0], y: moves[i][1], side: side, moveNo: pi + 1, ref: false,
                   unordered: unordered });
        pi++;
      }
    }
    return out;
  }

  function openDetail(id) {
    var a = archives.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    curArchive = a;
    // 0.5.2 §三.1 — open on the LAST position, and let detailMax() decide what "last" means for
    // an archive with no steps (see its note). Was `a.report ? (a.report.steps || []).length : 0`,
    // which is 0 for a stepless report and left the board blank.
    dStep = detailMax(a);
    $('replayList').classList.add('hidden');
    $('replayDetail').classList.remove('hidden');
    renderDetail();
  }
  $('backToList').onclick = async function () {
    curArchive = null;
    $('replayDetail').classList.add('hidden');
    $('replayList').classList.remove('hidden');
    await refreshArchives();
  };

  function renderDetail() {
    var a = curArchive;
    var rep = a.report || {};
    var p = a.players || {};

    $('dTitle').textContent = displayName(a);
    var sub = [G.beijingTime(a.createdAt), G.modeLabel(a.mode),
               RULE_LABEL[a.rule] || a.rule, T('viewer|被怀疑方：{side}', { side: suspectName(a.suspect) }),
               T('viewer|{n} 手', { n: a.totalMoves || 0 })];
    if (rep.prejoinCount) sub.push(T('viewer|其中 {n} 手由盘面还原（手序未知，不计入统计）', { n: rep.prejoinCount }));
    if (a.record && a.record.meta && a.record.meta.winner) sub.push(T('viewer|胜方：{name}', { name: a.record.meta.winner }));
    if (a.record && a.record.meta && a.record.meta.roomId) sub.push(T('viewer|房间 #{id}', { id: a.record.meta.roomId }));
    if (p.black || p.white) sub.push(T('viewer|黑 {b} / 白 {w}', { b: p.black || '?', w: p.white || '?' }));
    else if (p.self || p.opponent) sub.push(T('viewer|{a} vs {b}（未对应黑白）', { a: p.self || '?', b: p.opponent || '?' }));
    $('dSub').textContent = sub.join(' · ');

    // 开局: a badge next to the title, and hidden entirely when the game could not be
    // identified. The archive keeps only the code, so the readable name comes back from
    // openings.js — which is also what keeps the 26 names in a single place.
    var opLabel = GMOpening.label((a.record && a.record.meta && a.record.meta.opening) || a.opening);
    var opEl = $('dOpening');
    opEl.classList.toggle('hidden', !opLabel);
    opEl.textContent = opLabel || '';

    var box = $('dScores'); box.innerHTML = '';
    [rep.black, rep.white].forEach(function (x) {
      var div = document.createElement('div'); div.className = 'card';
      if (!x) {
        div.innerHTML = '<div class="big" style="color:#6e7b8a">—</div>' +
          '<div class="lab">' + T('viewer|未分析') + '</div>';
      }
      else {
        div.innerHTML = '<div class="big lv-' + x.level + '">' + x.risk.toFixed(0) + '</div>' +
          '<div class="lab">' + sideName(x.side) + ' · ' + TO('level', x.level) + '</div>' +
          '<div class="contrib">n=' + x.n + '</div>';
      }
      box.appendChild(div);
    });

    $('dSummary').innerHTML = summaryTableHtml(rep, {});

    var contribRows = [rep.black, rep.white].map(function (x) {
      if (!x || !x.contributions) return '';
      var c = x.contributions;
      var tw = x.time ? '<div>' + T('viewer|时间：均值 {mean}ms · 标准差 {std}ms · 与损失相关 {corr}', {
        mean: Math.round(x.time.meanT), std: Math.round(x.time.stdT), corr: x.time.corrLoss.toFixed(2),
      }) + '</div>' : '';
      // The keys are the risk model's stable identifiers (`top1`, `uselessFour`, …), which is
      // what `learn.js` looks its labels up by — but a raw camelCase slug in the panel is not
      // readable. `CONTRIB_TXT` maps the ones the viewer shows to their canonical Chinese, and
      // anything unmapped falls back to the slug rather than being hidden: a component that
      // silently vanishes from the breakdown is worse than one with an ugly name.
      return '<div style="margin-bottom:6px"><b>' + sideName(x.side) + '</b> ' +
        Object.keys(c).map(function (k) {
          return (CONTRIB_TXT[k] ? T('learn.weight.' + k) : k) + ' ' + c[k].toFixed(1);
        }).join(' · ') +
        tw + '</div>';
    }).join('');
    // #dMetrics sat at its placeholder ("—") forever: the per-metric numbers live in the
    // table above, so this panel carries the game-level facts instead of repeating them.
    var recMeta = (a.record && a.record.meta) || {};
    var srcLabel = {
      socket: T('viewer|站点数据（socket）'),
      dom: T('viewer|页面盘面（DOM 还原）'),
      import: T('viewer|导入棋谱'),
    }[recMeta.source];
    var scored = rep.scoredCount != null ? rep.scoredCount
      : (rep.steps || []).filter(function (s) { return s.analyzed; }).length;
    // The order-unknown prefix of the record. `unorderedCount` is the 0.2.6 name,
    // `inferredCount` is what 0.2.5 wrote into the record, and `prejoinCount` is the
    // report's own count of the same stones — accepting all three keeps an older or a
    // hand-built archive from being labelled "complete" just because it predates a rename.
    var unordered = recMeta.unorderedCount != null ? recMeta.unorderedCount
      : recMeta.inferredCount != null ? recMeta.inferredCount
      : (rep.prejoinCount || 0);
    // 0.4.1 §三.4: the record's own verdict when it has one (0.4.1+), and otherwise derived
    // from the fields a pre-0.4.1 archive does carry — so an old game gets the same badge the
    // new one would, instead of silently reading as "complete".
    var quality = qualityOf(recMeta.quality, recMeta.orderIssues || (rep.orderIssues || []).length,
                            unordered, recMeta.dropped || 0);
    var qualVerdict = quality === 'suspect'
      ? T('viewer|⚠ 异常（{n} 处相邻同色，结论仅供参考）', { n: recMeta.orderIssues || (rep.orderIssues || []).length })
      : quality === 'partial'
        // `partial` covers two things — a mid-join prefix whose order is unknown, and stones
        // the capture had to drop. Only the first has a hand count to report; the second would
        // read "前 0 手缺失" if it borrowed that sentence, so it gets the short label instead.
        ? (unordered
            ? T('viewer|⚠ 不完整（前 {missing} 手缺失，有效样本 {scored} / {total} 手）',
                { missing: unordered, scored: scored, total: a.totalMoves || 0 })
            : T('viewer|数据不全'))
        : T('viewer|完整');
    // 0.4.4 §十四 — 「交流检测」. Only present when there WAS a chat exchange: an archive from a
    // game with no questions has nothing to say here, and a row reading 「0 次 · 0」 on every
    // archive would train the operator to ignore the row that matters.
    var chatRow = [];
    if (rep.chatAdjust && rep.chatAdjust.asks) {
      var ca = rep.chatAdjust;
      chatRow.push([T('viewer|交流检测'),
        // `{n}` and not `{q}`: the panel says the same sentence, and the dictionary is keyed by
        // TEXT, so a different placeholder name would force a second row saying the same thing.
        T('viewer|提问 {n} 次 · 累计调整 {d}', { n: ca.asks, d: (ca.total > 0 ? '+' : '') + ca.total })]);
      if (ca.side) chatRow.push([T('viewer|调整对象'), ca.side === 'B' ? T('panel|黑方') : T('panel|白方')]);
      if (ca.how) chatRow.push([T('viewer|发送者识别'), TO('senderHow', ca.how)]);
    }
    // 0.4.7 §5.4 — 冲四序列. The §1.1 pass classifies every run of ≥2 consecutive same-side fours
    // into VCF / 防御性 / 无用, and only 无用 moves the score. Reported here rather than buried in
    // the contributions map because the three counts are what the operator needs to tell "this
    // side had a winning four sequence" from "this side wasted fours and lost" — a distinction
    // the risk number alone cannot express (a VCF run contributes exactly 0).
    //
    // Only shown when at least one run exists: an archive whose game never had two consecutive
    // fours would otherwise carry a row reading 「0 · 0 · 0」 on every single record.
    var fourRow = [];
    var fr = {};
    [rep.black, rep.white].forEach(function (x) {
      if (x && x.fourRuns) {
        fr.vcf = (fr.vcf || 0) + (x.fourRuns.vcf || 0);
        fr.defensive = (fr.defensive || 0) + (x.fourRuns.defensive || 0);
        fr.useless = (fr.useless || 0) + (x.fourRuns.useless || 0);
      }
    });
    if (fr.vcf || fr.defensive || fr.useless) {
      // One line, and only the three numbers: the per-side breakdown sits one panel below in
      // the summary table, and repeating 「无用冲四 3 段」 here would print the same fact twice
      // on a screen the operator reads at a glance.
      fourRow.push([T('viewer|冲四序列'),
        T('viewer|VCF {v} · 防御性 {d} · 无用 {u}', { v: fr.vcf || 0, d: fr.defensive || 0, u: fr.useless || 0 })]);
    }
    var facts = [
      [T('viewer|总手数'), T('viewer|{n} 手', { n: a.totalMoves || 0 })],
      [T('viewer|计入手数'), T('viewer|{n} 手', { n: scored })],
      [T('viewer|人工标记'), T('viewer|{n} 手（人工）',
        { n: (rep.steps || []).filter(function (s) { return s.manualAI; }).length })],
      [T('viewer|盘面还原'), T('viewer|{n} 手', { n: unordered }) +
        (unordered ? T('viewer|（手序未知，不计分）') : '')],
      [T('viewer|开局'), opLabel || T('viewer|未识别')],
    ].concat(fourRow, [
      // 注册 / 游客 / 观战. A capture fact, not a game fact: it explains why the other
      // rows read the way they do (a spectator has no "self", a guest game can end without
      // the usual end channels).
      [T('viewer|身份'), TO('idLabel', recMeta.identity) || '—'],
      // Mid-game join is a data-quality fact, not a detail: it has to be visible before
      // the numbers above it are read.
      [T('viewer|数据完整性'), unordered
        ? T('viewer|⚠ 不完整（前 {missing} 手缺失，有效样本 {scored} / {total} 手）',
            { missing: unordered, scored: scored, total: a.totalMoves || 0 })
        : T('viewer|完整')],
      [T('viewer|冲四豁免'), T('viewer|{n} 手', { n: rep.forcedCount || 0 })],
      // Two moves of one colour in a row cannot happen in gomoku: the capture lost or
      // duplicated a stone, so the per-side figures below are built on a wrong order.
      // Said out loud rather than quietly corrected.
      [T('viewer|手序校验'), rep.orderSuspect
        ? T('viewer|⚠ 异常（{n} 处相邻同色，结论仅供参考）', { n: (rep.orderIssues || []).length })
        : T('viewer|正常（黑白交替）')],
      // 0.4.1 §三.4: the two rows above, said in one word. They are already there, but they are
      // buried under a dozen other facts and an operator reading only the percentages has no
      // reason to go looking for them. A summary line at the point where the verdict is read
      // is the cheapest possible way to make bad data visible.
      //
      // Display-only: nothing reads `quality` to move a score. Downgrading the risk when the
      // record is suspect would silently rewrite a verdict the operator already saw, and the
      // honest fix for a bad record is to capture a better one.
      [T('viewer|数据质量'), qualVerdict],
      [T('viewer|时间模式'), rep.hasTime ? T('viewer|真实落子间隔') : T('viewer|固定预算（无时间数据）')],
      [T('viewer|对局结果'), (recMeta.outcome === 'draw' || a.outcome === 'draw') ? T('viewer|和棋（无胜方）')
        : recMeta.winner ? T('viewer|胜方：{name} 方', { name: recMeta.winner })
        : T('viewer|未记录')],
      // Which engine produced these verdicts. A run on the single-threaded fallback thinks
      // to a shallower depth in the same budget, so a cross-thread comparison of two
      // archives is only meaningful when this row matches.
      //
      // 0.5.1 §2.1.5 #4 — the MODEL as well as the build. Two archives analysed by different
      // models are not comparable either, and now that a custom weight package is a supported
      // choice, 「多线程 16 线程」 no longer identifies which one answered.
      [T('viewer|分析引擎'), rep.engine ? engineSummary(rep.engine) : T('viewer|未记录')],
      // 0.3.3 §3.5: which parameter set produced the risk numbers above. A learned run and a
      // default run give different scores for the same game, so without this row two
      // archives cannot be compared at all.
      [T('viewer|学习参数'), rep.learned
        ? T('viewer|已学习（{t} · 样本 {n} · 特征库 {f}）',
            { t: G.beijingTime(rep.learned.trainedAt), n: rep.learned.sampleCount, f: rep.learned.featureCount })
        : T('viewer|0.3.1 默认')],
      // 0.4.6 §一 — 'dom-pair' and 'dom-pair-order' are two DIFFERENT claims about the same
      // reading, so they get two labels. On papergames.io the two names sit side by side with no
      // colour and no "you"/"opponent" wording, and their order is NOT self-first; the pair is
      // only trustworthy once the account menu has said which of the two we are. 'dom-pair' means
      // that happened; 'dom-pair-order' means the names are right but which one is us is a guess,
      // which is exactly what an operator staring at a swapped "A VS B" needs to be told.
      [T('viewer|玩家名来源'), {
        socket: T('viewer|socket 事件'), dom: T('viewer|页面 DOM'),
        'dom-pair': T('viewer|并排两名（已定向）'),
        'dom-pair-order': T('viewer|并排两名（顺序未定）'),
        none: T('viewer|未取到（命名已降级）'),
      }[recMeta.nameSource]
        || '—'],
      [T('viewer|数据来源'), srcLabel || recMeta.source || '—'],
    ]).concat(chatRow);
    $('dMetrics').innerHTML = '<table class="facts">' + facts.map(function (kv) {
      var warn = String(kv[1]).charAt(0) === '⚠';
      var cls = warn ? ' class="warn"' : (kv[0] === T('viewer|人工标记') ? ' class="ma-row"' : '');
      return '<tr' + cls + '><td>' + esc(kv[0]) + '</td><td>' +
        esc(String(kv[1])) + '</td></tr>';
    }).join('') + '</table>';
    $('dContrib').innerHTML = contribRows || '—';

    // 数据完整性横幅. Said above the numbers rather than inside them: a reader who does not
    // notice that the first N stones have no order will read "Top-1 吻合 62%" as a fact
    // about the player, when it is a fact about the last 13 moves only.
    var warnEl = $('dWarn');
    if (unordered > 0) {
      warnEl.classList.remove('hidden');
      warnEl.innerHTML = '<b>' + T('viewer|⚠ 数据不完整') + '</b>' +
        '<div>' + T('viewer|前 {n} 手为中途加入前已存在，无手序，不计入检测。', { n: unordered }) + '</div>' +
        '<div>' + T('viewer|有效样本：后 {scored} 手（共 {total} 手）。',
          { scored: scored, total: a.totalMoves || 0 }) + '</div>';
    } else {
      warnEl.classList.add('hidden');
      warnEl.innerHTML = '';
    }

    // 0.3.1 活四停止横幅. Distinct blue box from the yellow data-incompleteness one: a game
    // cut short by a live four is COMPLETE data, just analysed to a shorter depth — the two
    // warnings must not read as the same kind of problem.
    var termEl = $('dTerm');
    if (rep.terminal) {
      termEl.classList.remove('hidden');
      termEl.innerHTML = '<b>' + T('viewer|⏹ 检测提前终止') + '</b>' +
        '<div>' + T('viewer|第 {m} 手检测提前终止（{reason}），后续未分析。', {
          m: rep.terminal.moveNo != null ? rep.terminal.moveNo : '?',
          reason: esc(TO('stopReason', rep.terminal.reason) || T('viewer|任一方形成四三杀或活四')),
        }) + '</div>' +
        '<div>' + T('viewer|对局实际总手数 {total} 手，本局仅分析前 {scored} 手。',
          { total: rep.originalTotalMoves || '?', scored: (rep.steps || []).length }) + '</div>';
    } else {
      termEl.classList.add('hidden');
      termEl.innerHTML = '';
    }

    var steps = rep.steps || [];
    // 0.5.2 §三.1 — detailMax(), not steps.length: a stepless archive still has a draggable
    // range (one notch per recorded move), and its 棋谱 line below already reads
    // 「棋谱：N / total 子（拖滑块或点按钮逐步查看）」.
    $('dSlider').max = detailMax(a);
    $('dSlider').value = dStep;
    $('dJump').value = dStep;
    // 0.4.3 §1.3/§1.5: the rail's index and the class row are both built here, before any row
    // is rendered, so every row can ask one place for its colour and its handles.
    buildSegMap(a);
    renderTypeRow($('dType'), a,
      function (side, v) { return G.saveArchiveType(a.id, side, v); },
      function () { return refetchArchive(); });
    var tb = document.querySelector('#dTbl tbody');
    tb.innerHTML = '';
    steps.forEach(function (s, i) {
      var tr = document.createElement('tr');
      if (isFlagged(s)) tr.classList.add('flagged');
      markSide(tr, s, i);
      tr.innerHTML = rowHtml(s, i, 'dTbl');
      tb.appendChild(tr);
    });
    renderDetailBoard();
  }

  // Stones currently painted on the replay board — the hover test needs the same list the
  // painter used, and a canvas has no DOM nodes to hit-test against.
  var dBoardStones = [];

  function renderDetailBoard() {
    var a = curArchive;
    if (!a) return;
    var rep = a.report || {};
    var total = (a.record && a.record.moves ? a.record.moves.length : 0);
    var shown = stonesShown(a, dStep);
    var stones = archiveStones(a, shown);
    dBoardStones = stones;
    var marks = [];
    // A mark belongs on the board when the stone it flags is on the board — i.e. when the
    // step's RECORD index is inside the drawn window. Comparing `moveNo` against the step
    // ordinal (the 0.2.5 rule) silently dropped every mark of a mid-join archive, whose
    // move numbers start at 13 while its step ordinals start at 1.
    (rep.steps || []).forEach(function (s, k) {
      if (!s.actual) return;
      if (stepIdxOf(a, s, k) >= shown) return;
      if (s.desperate) marks.push({ x: s.actual[0], y: s.actual[1], color: '#e67e22', r: 0.6 });
      if (isFlagged(s)) marks.push({ x: s.actual[0], y: s.actual[1], color: '#e74c3c', r: 0.5 });
    });
    var last = null;
    for (var i = stones.length - 1; i >= 0; i--) if (!stones[i].ref) { last = [stones[i].x, stones[i].y]; break; }

    // The engine's pick for the step on screen, as a dashed blue ring. Solid blue is
    // already taken by AI-suggest stones, and dashes keep it from reading as a stone.
    // Skipped when the player played exactly that move — the ring would sit on the stone
    // and say nothing; the info line already reports Top1 in that case.
    var curStepInfo = (rep.steps || [])[dStep - 1];
    if (curStepInfo && curStepInfo.analyzed && curStepInfo.best &&
        !(curStepInfo.actual && curStepInfo.actual[0] === curStepInfo.best[0] &&
          curStepInfo.actual[1] === curStepInfo.best[1])) {
      marks.push({ x: curStepInfo.best[0], y: curStepInfo.best[1], color: '#3c5ee7', r: 0.5, dash: true });
    }
    drawBoard($('dBoard'), { stones: stones, marks: marks, last: last });

    $('dSlider').value = dStep;
    $('dJump').value = dStep;
    var s = (rep.steps || [])[dStep - 1];
    $('dBoardInfo').textContent = s
      ? T('viewer|第{m}手 {side} 走 {move} · 引擎最佳 {best} · {wr}', {
          m: s.moveNo, side: sideTag(s.side), move: s.actualStr, best: s.bestStr,
          wr: s.bestWR != null ? T('viewer|胜率{p}', { p: pct(s.bestWR) }) : T('viewer|未分析'),
        }) +
        ' · ' + (!s.analyzed ? T('viewer|(跳过)') : (s.top1 ? 'Top1' : (s.top3 ? 'Top3' : (s.top5 ? 'Top5' : T('viewer|Top5外'))))) +
        (s.isSharp ? ' · ' + T('viewer|唯一手') : '') + (s.desperate ? ' · ' + T('viewer|将败') : '') + (s.evasion ? ' · ' + T('viewer|回避') : '') +
        (s.forcedDefense ? ' · ' + T('viewer|冲四豁免') : '') +
        (s.jumpFourFlag ? ' · ' + T('viewer|跳四') : '') +
        ' · ' + T('viewer|前5候选 {list}', { list: (s.candStrs || []).join(' ') })
      : T('viewer|棋谱：{n} / {total} 子（拖滑块或点按钮逐步查看）', { n: stones.length, total: total });
    // The legend doubles as the hover readout, so a dashed grey ring explains itself even
    // before the pointer lands on one.
    var pj = (a.record && a.record.meta ? (a.record.meta.unorderedCount != null
      ? a.record.meta.unorderedCount : a.record.meta.inferredCount) : 0) || rep.prejoinCount || 0;
    $('dBoardTip').textContent = pj
      ? T('viewer|虚线灰圈 = 中途加入前已存在的 {n} 手（手序未知，不计入统计）；把指针放在棋子上可查看它的说明。', { n: pj })
      : '';
    document.querySelectorAll('#dTbl tbody tr').forEach(function (tr, i) {
      tr.classList.toggle('cur', i === dStep - 1);
    });
  }

  // Hovering an order-unknown stone says so. Same grid maths as drawBoard, and the same
  // CSS-shrink correction the click handler uses on the detect board.
  $('dBoard').addEventListener('mousemove', function (e) {
    if (!curArchive || !dBoardStones.length) return;
    var cv = $('dBoard');
    var rect = cv.getBoundingClientRect();
    if (!rect.width) return;
    var px = (e.clientX - rect.left) * (cv.width / rect.width);
    var py = (e.clientY - rect.top) * (cv.height / rect.height);
    var pad = cv.width / (SIZE + 1);
    var hit = null;
    for (var i = 0; i < dBoardStones.length; i++) {
      var s = dBoardStones[i];
      var dx = px - (pad + s.x * pad), dy = py - (pad + s.y * pad);
      if (dx * dx + dy * dy <= pad * pad * 0.25) { hit = s; break; }
    }
    if (!hit || !hit.unordered) return;
    $('dBoardTip').textContent = T('viewer|第 {m} 子（{side}）：中途加入前已存在于盘面，无手序，不计入命中率与时间统计。',
      { m: hit.moveNo, side: sideTag(hit.side) });
  });

  $('dSlider').oninput = function (e) { dStep = +e.target.value; renderDetailBoard(); };
  $('dPrev').onclick = function () { dStep = Math.max(0, dStep - 1); renderDetailBoard(); };
  $('dNext').onclick = function () { dStep = Math.min(detailMax(curArchive), dStep + 1); renderDetailBoard(); };
  $('dStart').onclick = function () { dStep = 0; renderDetailBoard(); };
  $('dEnd').onclick = function () { dStep = detailMax(curArchive); renderDetailBoard(); };
  $('dJump').onchange = function () {
    var max = detailMax(curArchive);
    dStep = clamp(parseInt($('dJump').value, 10) || 0, 0, max);
    renderDetailBoard();
  };

  $('dExpJson').onclick = function () { if (curArchive) exportArchiveJson(curArchive); };
  $('dExpCsv').onclick = function () {
    if (!curArchive || !curArchive.report) return;
    var csv = 'move,side,actual,best,top1,top3,top5,loss,sharp,desperate,evasion,thinkMs,badges,manualAI\n';
    (curArchive.report.steps || []).forEach(function (s) {
      csv += [s.moveNo, s.side, s.actualStr, s.bestStr, s.top1, s.top3, s.top5,
              s.loss == null ? '' : s.loss, s.isSharp, s.desperate, s.evasion, s.thinkMs == null ? '' : s.thinkMs,
              [s.isSharp ? '唯一手' : '', s.desperate ? '将败' : '', s.evasion ? '回避' : '', s.forcedDefense ? '豁免' : '',
               isFlagged(s) ? '可疑' : '', s.source === 'prejoin' ? '还原' : ''].filter(Boolean).join('/'),
              s.manualAI ? '是' : ''
             ].join(',') + '\n';
    });
    download('gomoku-archive-' + curArchive.id + '.csv', csv, 'text/csv');
  };
  $('dExpPrint').onclick = function () { window.print(); };

  // 0.3.1: clicking the 人工标记 cell toggles the operator's own verdict on a step. On the
  // detail view it is written to the archive immediately; on the detect tab it toggles the
  // in-memory report (and rides along when the operator saves the archive from there). The
  // engine's "可疑" badge and this human mark are deliberately independent.
  function makeMAHandler(getSteps, getArchive) {
    return function (e) {
      if (!e.target.closest) return;
      var td = e.target.closest('td.ma');
      if (!td) return;
      var idx = parseInt(td.dataset.i, 10);
      if (isNaN(idx)) return;
      var steps = getSteps();
      if (!steps || !steps[idx]) return;
      var s = steps[idx];
      s.manualAI = !s.manualAI;
      td.innerHTML = maCell(s.manualAI);
      if (getArchive) {
        var a = getArchive();
        if (a) {
          G.saveArchive(a);   // persist the mark to the archive at once
          var rep2 = a.report || {};
          var mc = (rep2.steps || []).filter(function (x) { return x.manualAI; }).length;
          var row = document.querySelector('#dMetrics tr.ma-row');
          if (row) row.cells[1].textContent = T('viewer|{n} 手（人工）', { n: mc });
        }
      }
    };
  }
  // The two step tables (detect tab + replay detail) both use rowHtml, so both get the
  // clickable column; each is wired to its own step source.
  (function wireManualAI() {
    var t1 = document.querySelector('#tbl tbody');
    var t2 = document.querySelector('#dTbl tbody');
    if (t1) t1.addEventListener('click', makeMAHandler(function () { return report; }, null));
    if (t2) t2.addEventListener('click', makeMAHandler(
      function () { return (curArchive && curArchive.report) ? curArchive.report.steps : null; },
      function () { return curArchive; }));
  })();

  // 0.3.4: clicking a step row parks the board cursor on that hand — the table and the board are
  // two views of one cursor, so either can drive 回溯. The 人工 cell keeps its own toggle
  // (makeMAHandler above), so it is excluded here.
  (function wireRowCursor() {
    var tb = document.querySelector('#tbl tbody');
    if (!tb) return;
    tb.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('td.ma')) return;
      var tr = e.target.closest ? e.target.closest('tr') : null;
      if (!tr) return;
      var rows = Array.prototype.slice.call(tb.querySelectorAll('tr'));
      var i = rows.indexOf(tr);
      if (i < 0) return;
      curStep = clamp(i + 1, 0, draftMoves.length);
      renderBoardView();
    });
  })();

  // 0.3.1: the list is a column-first grid whose column count is measured from #cards width,
  // so resizing the window changes the page size. Re-render only while the list (not the
  // detail view) is showing, debounced, so dragging the window doesn't thrash.
  var _resizeTimer = null;
  window.addEventListener('resize', function () {
    if ($('replayList').classList.contains('hidden') &&
        $('sampleList').classList.contains('hidden')) return;     // a detail/editor view is open
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(function () {
      if (!$('replayList').classList.contains('hidden')) renderList();
      if (!$('sampleList').classList.contains('hidden')) renderSampleList();
    }, 150);
  });

  // =====================================================================
  // 0.3.3 样本库
  // =====================================================================
  // A curated set, kept in its own storage key so nothing here can overwrite an archive.
  // Three sub-views inside the tab: 列表 → 详情 → 编辑器, exactly the 5-step flow of §1.4.
  var samples = [];
  var sSortKey = 'time';
  var sSortDir = 'desc';
  var sFiltersOpen = false;
  var sPage = 0;

  var curSample = null;      // the sample open in the detail view
  var sStep = 0;             // detail board slider position
  var sBoardStones = [];

  var editing = null;        // the draft the editor is working on (a deep copy)
  var editingId = null;      // null = a brand-new sample
  var seDraft = [];          // [{c:[x,y], s:'player'|'ai-suggest'}]
  var seReport = null;       // the analysed report for the draft
  var seEngineBusy = false;
  // 0.3.4 二.1: the editor gets the same cursor model as the detect page — seStep counts draft
  // slots played, stones at index >= seStep are ghosted, and a branch parks its dropped tail
  // here so a misclick is recoverable. Without it the editor could only append/undo at the end,
  // which is the "回溯后只能看不能修改" complaint applied to the sample library.
  var seStep = 0;
  var seUndoStack = [];
  var SE_UNDO_MAX = 24;

  // ---------- 0.3.4 二.2 批量操作 ----------
  var sBulkMode = false;
  var sSelected = {};        // id -> true, kept across pages so a selection can span pages

  var RULE_IDX = { freestyle: 0, standard: 1, renju: 2 };

  function findSample(id) {
    for (var i = 0; i < samples.length; i++) if (samples[i].id === id) return samples[i];
    return null;
  }

  // ---------- 列表 ----------
  function sampleFilters() {
    return {
      tag: $('sfTag').value || null,
      rule: $('sfRule').value,
      annotated: $('sfAnn').value || null,
      ageId: $('sfAge').value || null,
    };
  }

  function fillSampleTagFilter() {
    var cur = $('sfTag').value;
    var tags = G.listSampleTags(samples);
    var h = '<option value="">' + T('viewer|全部') + '</option>' +
            '<option value="__none__">' + T('viewer|无标签') + '</option>';
    tags.forEach(function (t) { h += '<option value="' + esc(t) + '">' + esc(t) + '</option>'; });
    $('sfTag').innerHTML = h;
    $('sfTag').value = (cur === '' || cur === '__none__' || tags.indexOf(cur) >= 0) ? cur : '';
  }

  async function refreshSamples() {
    samples = await G.loadSamples();
    fillSampleTagFilter();
    renderSampleList();
    renderLearnStatus();
  }

  // Risk-coloured dot, grey when the sample has not been analysed yet — an unanalysed sample
  // is not a "low risk" sample, and showing it green would say exactly that.
  function sampleDotColor(s) {
    var rep = s.report || {};
    if (!(rep.steps || []).length) return '#4a5568';
    var r = Math.max(rep.black ? rep.black.risk : 0, rep.white ? rep.white.risk : 0);
    return r >= 70 ? '#e74c3c' : (r >= 40 ? '#f1c40f' : '#2ecc71');
  }

  // 0.3.4 二.2: how many of the current page's samples are ticked, and the bar's own label.
  function bulkCount() {
    var n = 0;
    for (var k in sSelected) if (sSelected[k]) n++;
    return n;
  }
  function updateBulkBar(pageList) {
    if ($('sBulkBar')) $('sBulkBar').classList.toggle('hidden', !sBulkMode);
    if ($('sBulkToggle')) $('sBulkToggle').textContent = sBulkMode ? T('viewer|批量 ▴') : T('viewer|批量 ▾');
    if ($('sBulkToggle')) $('sBulkToggle').classList.toggle('on', sBulkMode);
    if ($('sBulkCount')) {
      var n = bulkCount();
      var pageN = (pageList || []).filter(function (s) { return sSelected[s.id]; }).length;
      $('sBulkCount').textContent = T('viewer|已选 {n} 个', { n: n }) +
        (pageList ? T('viewer|（本页 {a}/{b}）', { a: pageN, b: pageList.length }) : '');
    }
    ['sBulkTag', 'sBulkExport', 'sBulkDel'].forEach(function (id) {
      if ($(id)) $(id).disabled = !bulkCount();
    });
  }

  function renderSampleList() {
    var f = sampleFilters();
    var active = G.countActiveSampleFilters(f);
    var list = G.sortSamples(G.filterSamples(samples, f), sSortKey, sSortDir);
    var cols = computeCols('sampleCards');
    var size = PER_COL * cols;
    var pages = pageCount(list.length, size);
    if (sPage > pages - 1) sPage = pages - 1;
    if (sPage < 0) sPage = 0;
    var start = sPage * size;
    var pageList = list.slice(start, start + size);

    $('sfchat').textContent = active ? T('viewer|筛选中：{n} 项', { n: active }) : '';
    $('sResetFilters').disabled = !active;
    $('sListCount').textContent = T('viewer|共 {n} 个样本 · 显示 {shown} 个', { n: samples.length, shown: list.length }) +
      (pages > 1 ? T('viewer|（第 {p}/{pages} 页）', { p: sPage + 1, pages: pages }) : '');

    var box = $('sampleCards');
    if (!list.length) {
      box.className = '';
      box.innerHTML = '<div class="empty">' + (samples.length
        ? T('viewer|没有符合筛选条件的样本。')
        : T('viewer|还没有样本。点右上角「＋ 新建样本」，或在「回放」里右键存档 →「转为样本…」。')) + '</div>';
      renderSamplePager(0, size);
      updateSSortHeaders();
      updateBulkBar([]);
      return;
    }
    box.className = 'archive-grid' + (sBulkMode ? ' bulk' : '');
    box.innerHTML = pageList.map(function (s, i) {
      var no = start + i + 1;
      var moves = ((s.record && s.record.moves) || []).length;
      var meta = T('viewer|{n}手', { n: moves }) + ' · ' + G.modeLabel(s.mode) + ' · v' + (s.version || 1) +
                 ' · ' + G.beijingTime(s.updatedAt || s.createdAt) +
                 ' · ' + T('viewer|标注 {n} 步', { n: G.countAnnotated(s) }) +
                 (s.note ? ' · ' + s.note.slice(0, 16) : '');
      var tagHtml = (s.tags || []).slice(0, 3).map(function (t) {
        return '<span class="cat">' + esc(t) + '</span>';
      }).join(' ');
      var tick = sBulkMode
        ? '<span class="tick' + (sSelected[s.id] ? ' on' : '') + '" data-tick="1">' +
            (sSelected[s.id] ? '☑' : '☐') + '</span>'
        : '';
      return '<div class="acard' + (sSelected[s.id] && sBulkMode ? ' sel' : '') + '" data-sid="' + esc(s.id) + '">' +
        tick +
        '<span class="dno">' + no + '</span>' +
        '<span class="ico" style="background:' + sampleDotColor(s) + '"></span>' +
        '<span class="body">' +
          '<span class="nm">' + esc(s.name || T('viewer|未命名样本')) + '</span>' +
          '<span class="meta">' + esc(meta) + '</span>' +
          typeLine(s, s.suspect) +
        '</span>' + tagHtml +
        '</div>';
    }).join('');

    box.querySelectorAll('.acard').forEach(function (el) {
      el.addEventListener('click', function () {
        // In bulk mode a click is a tick, not a navigation — otherwise selecting three samples
        // to delete would mean opening and backing out of three detail views.
        if (sBulkMode) { toggleSampleSel(el.dataset.sid); return; }
        openSample(el.dataset.sid);
      });
      el.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (sBulkMode) { toggleSampleSel(el.dataset.sid); return; }
        openSampleMenu(ev, el.dataset.sid);
      });
    });
    renderSamplePager(list.length, size);
    updateSSortHeaders();
    updateBulkBar(pageList);
  }

  function toggleSampleSel(id) {
    if (sSelected[id]) delete sSelected[id]; else sSelected[id] = true;
    renderSampleList();
  }

  function renderSamplePager(total, size) {
    var pages = pageCount(total, size);
    $('sPager').classList.toggle('hidden', pages <= 1);
    $('sPgPrev').disabled = sPage <= 0;
    $('sPgNext').disabled = sPage >= pages - 1;
    var h = '';
    for (var i = 0; i < pages; i++) {
      h += '<button class="sec' + (i === sPage ? ' on' : '') + '" data-spage="' + i + '">' + (i + 1) + '</button>';
    }
    $('sPgNums').innerHTML = h;
    $('sPgInfo').textContent = T('viewer|第 {p} / {pages} 页 · 每页 {size} 个（{cols} × {rows} 列）',
      { p: sPage + 1, pages: pages, size: size, cols: PER_COL, rows: size / PER_COL });
      /* folded into the line above */
  }

  function updateSSortHeaders() {
    document.querySelectorAll('.ahead .h[data-ssort]').forEach(function (h) {
      var on = h.dataset.ssort === sSortKey;
      h.classList.toggle('on', on);
      h.querySelector('.ar').textContent = on ? (sSortDir === 'asc' ? '▲' : '▼') : '';
    });
  }

  $('sPgPrev').onclick = function () { if (sPage > 0) { sPage--; renderSampleList(); listTop('sampleCards'); } };
  $('sPgNext').onclick = function () { sPage++; renderSampleList(); listTop('sampleCards'); };
  $('sPgNums').onclick = function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-spage]') : null;
    if (!b) return;
    sPage = parseInt(b.dataset.spage, 10) || 0;
    renderSampleList();
    listTop('sampleCards');
  };

  document.querySelectorAll('.ahead .h[data-ssort]').forEach(function (h) {
    h.onclick = function () {
      var k = h.dataset.ssort;
      if (k === sSortKey) sSortDir = (sSortDir === 'asc' ? 'desc' : 'asc');
      else { sSortKey = k; sSortDir = 'desc'; }
      sPage = 0;
      renderSampleList();
    };
  });

  ['sfTag', 'sfRule', 'sfAnn', 'sfAge'].forEach(function (id) {
    $(id).addEventListener('change', function () { sPage = 0; renderSampleList(); });
  });
  $('sToggleFilters').onclick = function () {
    sFiltersOpen = !sFiltersOpen;
    $('sFilterGrid').classList.toggle('hidden', !sFiltersOpen);
    $('sToggleFilters').textContent = sFiltersOpen ? T('viewer|筛选 ▴') : T('viewer|筛选 ▾');
  };
  $('sResetFilters').onclick = function () {
    $('sfTag').value = ''; $('sfRule').value = 'all'; $('sfAnn').value = ''; $('sfAge').value = '';
    sPage = 0;
    renderSampleList();
  };
  $('sNew').onclick = function () { openSampleEditor(null); };

  // ---------- 0.3.4 二.2 批量操作 ----------
  $('sBulkToggle').onclick = function () {
    sBulkMode = !sBulkMode;
    // Leaving bulk mode clears the selection: a hidden selection that survives a mode switch is
    // how a later 批量删除 ends up eating samples the operator forgot they had ticked.
    if (!sBulkMode) sSelected = {};
    renderSampleList();
  };
  $('sBulkNone').onclick = function () { sSelected = {}; renderSampleList(); };
  $('sBulkAllPage').onclick = function () {
    visibleSamplePage().forEach(function (s) { sSelected[s.id] = true; });
    renderSampleList();
  };
  $('sBulkInvert').onclick = function () {
    visibleSamplePage().forEach(function (s) {
      if (sSelected[s.id]) delete sSelected[s.id]; else sSelected[s.id] = true;
    });
    renderSampleList();
  };
  // The ids of whatever the current page actually shows, so 全选/反选 act on what is visible
  // rather than on the whole (possibly filtered) library.
  function visibleSamplePage() {
    var list = G.sortSamples(G.filterSamples(samples, sampleFilters()), sSortKey, sSortDir);
    var size = PER_COL * computeCols('sampleCards');
    var pages = pageCount(list.length, size);
    if (sPage > pages - 1) sPage = pages - 1;
    if (sPage < 0) sPage = 0;
    return list.slice(sPage * size, sPage * size + size);
  }
  function selectedSamples() {
    return samples.filter(function (s) { return sSelected[s.id]; });
  }

  $('sBulkDel').onclick = async function () {
    var picked = selectedSamples();
    if (!picked.length) { alert(T('viewer|还没有勾选样本。')); return; }
    if (!confirm(T('viewer|确定删除这 {n} 个样本？此操作不可撤销。', { n: picked.length }) + '\n\n' +
        picked.slice(0, 8).map(function (s) { return '· ' + (s.name || T('viewer|未命名样本')); }).join('\n') +
        (picked.length > 8 ? '\n' + T('viewer|· …还有 {n} 个', { n: picked.length - 8 }) : ''))) return;
    var n = await G.deleteSamples(picked.map(function (s) { return s.id; }));
    sSelected = {};
    await refreshSamples();
    alert(T('viewer|已删除 {n} 个样本。', { n: n }));
  };

  $('sBulkExport').onclick = function () {
    var picked = selectedSamples();
    if (!picked.length) { alert(T('viewer|还没有勾选样本。')); return; }
    // The same envelope the single-sample 导出JSON uses, so either file can be fed to 批量导入.
    download('samples-' + picked.length + '.json',
      JSON.stringify({ kind: 'gomoku-samples', version: 1, exportedAt: Date.now(), samples: picked }, null, 2),
      'application/json');
  };

  $('sBulkImport').onclick = function () { $('sBulkFile').click(); };
  $('sBulkFile').onchange = async function () {
    var f = $('sBulkFile').files && $('sBulkFile').files[0];
    $('sBulkFile').value = '';
    if (!f) return;
    var text;
    try { text = await f.text(); } catch (e) { alert(T('viewer|读取文件失败：{err}', { err: TE(e.message) })); return; }
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { alert(T('viewer|不是有效的 JSON 文件。')); return; }
    // Accept both the batch envelope and a bare array / a single sample object.
    var incoming = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.samples)) ? parsed.samples
      : (parsed && parsed.record) ? [parsed] : null;
    if (!incoming) { alert(T('viewer|文件里没有 samples 数组。')); return; }
    var res = await G.importSamples(incoming);
    await refreshSamples();
    alert(T('viewer|导入完成：新增 {n} 个', { n: res.added }) +
      (res.remapped ? T('viewer|（其中 {n} 个 id 与现有样本重复，已分配新 id）', { n: res.remapped }) : '') +
      (res.trimmed ? '\n' + T('viewer|注意：超出样本上限，最旧的样本已被丢弃。') : '') +
      (res.added < incoming.length ? '\n' + T('viewer|另有 {n} 条被跳过（缺少有效的 record.moves）。', { n: incoming.length - res.added }) : ''));
  };

  $('sBulkTag').onclick = async function () {
    var picked = selectedSamples();
    if (!picked.length) { alert(T('viewer|还没有勾选样本。')); return; }
    var all = G.listSampleTags(samples);
    var raw = prompt(T('viewer|给这 {n} 个样本改标签。', { n: picked.length }) + '\n\n' +
      T('viewer|要添加的标签（逗号分隔，可留空）：\n可用：{list}', { list: all.join(' / ') }), '');
    if (raw === null) return;
    var add = raw.split(/[,，\s]+/).map(function (t) { return t.trim(); }).filter(Boolean);
    var rawRem = prompt(T('viewer|要移除的标签（逗号分隔，可留空）：'), '');
    if (rawRem === null) return;
    var rem = rawRem.split(/[,，\s]+/).map(function (t) { return t.trim(); }).filter(Boolean);
    if (!add.length && !rem.length) { alert(T('viewer|没有要添加或移除的标签。')); return; }
    var n = await G.setSamplesTags(picked.map(function (s) { return s.id; }), add, rem);
    await refreshSamples();
    alert(T('viewer|已更新 {n} 个样本的标签。', { n: n }));
  };

  // ---------- 详情 ----------
  function openSample(id) {
    var s = findSample(id);
    if (!s) return;
    curSample = s;
    // 0.5.2 §三.1 — same bound as an archive's detail view: a sample whose report carries no
    // steps must still open on its whole board. Samples go through the same stonesShown().
    sStep = detailMax(s);
    $('sampleList').classList.add('hidden');
    $('sampleEditor').classList.add('hidden');
    $('sampleDetail').classList.remove('hidden');
    renderSampleDetail();
  }

  $('sBackToList').onclick = async function () {
    curSample = null;
    $('sampleDetail').classList.add('hidden');
    $('sampleEditor').classList.add('hidden');
    $('sampleList').classList.remove('hidden');
    await refreshSamples();
  };
  $('sEditBtn').onclick = function () { if (curSample) openSampleEditor(curSample); };
  $('sExpJson').onclick = function () {
    if (!curSample) return;
    download('gomoku-sample-' + curSample.id + '.json', JSON.stringify(curSample, null, 2), 'application/json');
  };
  $('sDelBtn').onclick = async function () {
    if (!curSample) return;
    var s = curSample;
    if (!confirm(T('viewer|删除样本「{name}」？此操作不可撤销。', { name: s.name }) + '\n\n' +
        T('viewer|注意：删除样本不会自动更新学习结果，需要回到样本库点「重新学习」。'))) return;
    await G.deleteSample(s.id);
    curSample = null;
    $('sampleDetail').classList.add('hidden');
    $('sampleList').classList.remove('hidden');
    await refreshSamples();
    setStatus(T('viewer|样本已删除'));
  };

  // The step row for a SAMPLE: identical cells to an archive row, but the leading # cell is
  // the note toggle and the trailing cell is the multi-label annotation column (§2.2).
  function annCellHtml(sample, moveNo) {
    if (moveNo == null) return '';
    var labels = G.sampleLabels(sample, moveNo);
    var h = G.ANN_LABELS.map(function (lab) {
      var on = labels.indexOf(lab) >= 0;
      return '<button class="ann-btn' + (on ? ' on' : '') + '" data-move="' + moveNo +
        '" data-label="' + esc(lab) + '" title="' + esc(lab) + '">' + G.ANN_BTN[lab] + '</button>';
    }).join('');
    // A custom label has no glyph, so it renders as its own (short) name — a button showing
    // "?" for two different custom tags would be unusable.
    labels.forEach(function (lab) {
      if (G.ANN_LABELS.indexOf(lab) >= 0) return;
      h += '<button class="ann-btn on custom" data-move="' + moveNo + '" data-label="' + esc(lab) +
        '" title="' + esc(lab) + '">' + esc(lab.slice(0, 4)) + '</button>';
    });
    return h;
  }

  function sRowHtml(s, idx, sample, table) {
    var noteMark = (G.annotationsOf(sample)[s.moveNo] || {}).note ? ' <span style="color:var(--yellow)">✎</span>' : '';
    return '<td class="sno" data-i="' + (idx == null ? '' : idx) + '" title="' + T('viewer|点开填写单步备注') + '" ' +
        'style="cursor:pointer">' + handlesFor(s.side, idx, table) +
        (s.moveNo == null ? '—' : s.moveNo) + noteMark + '</td>' +
      stepCellsHtml(s) +
      '<td class="annotations" data-i="' + (idx == null ? '' : idx) + '">' + annCellHtml(sample, s.moveNo) + '</td>';
  }

  function annStatHtml(s) {
    var counts = {}, custom = {}, noteN = 0;
    G.ANN_LABELS.forEach(function (l) { counts[l] = 0; });
    var ann = G.annotationsOf(s);
    for (var k in ann) {
      var e = ann[k];
      if (!e) continue;
      (e.labels || []).forEach(function (l) {
        if (counts[l] != null) counts[l]++; else custom[l] = (custom[l] || 0) + 1;
      });
      if (e.note) noteN++;
    }
    var h = G.ANN_LABELS.map(function (l) {
      return '<div>' + G.ANN_BTN[l] + ' ' + esc(TO('ann', l)) + '：<b>' + counts[l] + '</b> ' + T('viewer|步') + '</div>';
    }).join('');
    Object.keys(custom).forEach(function (l) {
      h += '<div>' + esc(l) + '：<b>' + custom[l] + '</b> ' + T('viewer|步（自定义）') + '</div>';
    });
    var total = (s.report && s.report.steps ? s.report.steps.length : 0);
    h += '<div style="margin-top:8px">' + T('viewer|单步备注：') + '<b>' + noteN + '</b> ' + T('viewer|条') + '<br>' +
      T('viewer|已标注步骤：') + '<b>' + G.countAnnotated(s) + '</b> / ' + total + '</div>';
    return h;
  }
  function updateSampleAnnStat(s) { $('sAnnStat').innerHTML = annStatHtml(s); }

  // Game-level facts, the sample-side counterpart of the archive detail's 指标汇总 table.
  // The per-metric numbers live in #sSummary; this pane answers "what IS this sample".
  function renderSampleMetrics(s) {
    var rep = s.report || {};
    var rec = s.record || {};
    var steps = rep.steps || [];
    var scored = rep.scoredCount != null ? rep.scoredCount
      : steps.filter(function (x) { return x.analyzed; }).length;
    var srcLabel = {
      socket: T('viewer|站点数据（socket）'), dom: T('viewer|页面盘面（DOM 还原）'),
      import: T('viewer|导入棋谱'), manual: T('viewer|手动打谱'),
    }[rec.meta && rec.meta.source];
    var facts = [
      [T('viewer|总手数'), T('viewer|{n} 手', { n: (rec.moves || []).length })],
      [T('viewer|计入手数'), T('viewer|{n} 手', { n: scored })],
      [T('viewer|已标注步骤'), G.countAnnotated(s) + ' / ' + T('viewer|{n} 步', { n: steps.length })],
      [T('viewer|版本'), 'v' + (s.version || 1)],
      [T('viewer|创建时间'), G.beijingTime(s.createdAt)],
      [T('viewer|更新时间'), G.beijingTime(s.updatedAt || s.createdAt)],
      [T('viewer|规则'), RULE_LABEL[s.rule] || s.rule || '—'],
      [T('viewer|被怀疑方'), suspectName(s.suspect)],
      [T('viewer|数据来源'), srcLabel || (rec.meta && rec.meta.source) || '—'],
      [T('viewer|学习参数'), rep.learned
        ? T('viewer|已学习（{t} · 特征库 {f}）', { t: G.beijingTime(rep.learned.trainedAt), f: rep.learned.featureCount })
        : T('viewer|0.3.1 默认')],
      [T('viewer|盘面还原'), T('viewer|{n} 手', { n: rep.prejoinCount || 0 }) +
        (rep.prejoinCount ? T('viewer|（手序未知，不计分）') : '')],
      [T('viewer|AI 指纹命中'), T('viewer|{b} / {w} 步（黑/白）', {
        b: rep.black ? (rep.black.simCount || 0) : 0, w: rep.white ? (rep.white.simCount || 0) : 0,
      })],
    ];
    $('sMetrics').innerHTML = '<table class="facts">' + facts.map(function (kv) {
      var warn = String(kv[1]).charAt(0) === '⚠';
      return '<tr' + (warn ? ' class="warn"' : '') + '><td>' + esc(kv[0]) + '</td><td>' +
        esc(String(kv[1])) + '</td></tr>';
    }).join('') + '</table>';
  }

  function renderSampleDetail() {
    var s = curSample;
    if (!s) return;
    var rep = s.report || {};
    var rec = s.record || {};

    $('sTitle').textContent = s.name || T('viewer|未命名样本');
    var sub = [G.beijingTime(s.updatedAt || s.createdAt), 'v' + (s.version || 1),
      G.modeLabel(s.mode), RULE_LABEL[s.rule] || s.rule,
      T('viewer|被怀疑方：{side}', { side: suspectName(s.suspect) }),
      T('viewer|{n} 手', { n: (rec.moves || []).length })];
    if (rep.prejoinCount) sub.push(T('viewer|其中 {n} 手由盘面还原（手序未知，不计入统计）', { n: rep.prejoinCount }));
    $('sSub').textContent = sub.join(' · ');

    var opLabel = GMOpening.label(rec.meta && rec.meta.opening);
    var opEl = $('sOpening');
    opEl.classList.toggle('hidden', !opLabel);
    opEl.textContent = opLabel || '';

    $('sTags').innerHTML = (s.tags || []).length
      ? (s.tags || []).map(function (t) { return '<span class="cat">' + esc(t) + '</span>'; }).join(' ')
      : '<span style="color:var(--mut)">' + T('viewer|无标签') + '</span>';
    $('sNote').innerHTML = s.note
      ? (T('viewer|备注：') + esc(s.note))
      : '<span style="color:var(--mut)">' + T('viewer|无备注') + '</span>';

    var box = $('sScores'); box.innerHTML = '';
    [rep.black, rep.white].forEach(function (x) {
      var div = document.createElement('div'); div.className = 'card';
      if (!x) {
        div.innerHTML = '<div class="big" style="color:#6e7b8a">—</div>' +
          '<div class="lab">' + T('viewer|未分析') + '</div>';
      }
      else {
        div.innerHTML = '<div class="big lv-' + x.level + '">' + x.risk.toFixed(0) + '</div>' +
          '<div class="lab">' + sideName(x.side) + ' · ' + TO('level', x.level) + '</div>' +
          '<div class="contrib">n=' + x.n + '</div>';
      }
      box.appendChild(div);
    });
    $('sSummary').innerHTML = (rep.steps || []).length
      ? summaryTableHtml(rep, { sim: true })
      : '<div class="hint">' + T('viewer|尚未分析。点「编辑」进入编辑器，用「AI 分析」生成步骤明细后即可标注。') + '</div>';
    updateSampleAnnStat(s);
    renderSampleMetrics(s);

    var steps = rep.steps || [];
    $('sSlider').max = detailMax(s);   // 0.5.2 §三.1 — see detailMax's note
    $('sSlider').value = sStep;
    $('sJump').value = sStep;
    // 0.4.3 §1.3/§1.5
    buildSegMap(s);
    renderTypeRow($('sType'), s,
      function (side, v) { return G.saveSampleType(s.id, side, v); },
      function () { return refetchSample(); });
    var tb = document.querySelector('#sTbl tbody');
    tb.innerHTML = '';
    steps.forEach(function (st, i) {
      var tr = document.createElement('tr');
      if (isFlagged(st)) tr.classList.add('flagged');
      markSide(tr, st, i);
      tr.innerHTML = sRowHtml(st, i, s, 'sTbl');
      tb.appendChild(tr);
    });
    renderSampleBoard();
  }

  function renderSampleBoard() {
    var s = curSample;
    if (!s) return;
    var rep = s.report || {};
    var total = ((s.record && s.record.moves) || []).length;
    var shown = stonesShown(s, sStep);
    var stones = archiveStones(s, shown);
    sBoardStones = stones;
    var marks = [];
    (rep.steps || []).forEach(function (st, k) {
      if (!st.actual) return;
      if (stepIdxOf(s, st, k) >= shown) return;
      if (st.desperate) marks.push({ x: st.actual[0], y: st.actual[1], color: '#e67e22', r: 0.6 });
      if (isFlagged(st)) marks.push({ x: st.actual[0], y: st.actual[1], color: '#e74c3c', r: 0.5 });
      // The fingerprint match gets its own ring, dashed so it is not confused with the
      // engine's solid 可疑 ring even where the two overlap.
      if (st.aiSimilar) marks.push({ x: st.actual[0], y: st.actual[1], color: '#b05aa0', r: 0.72, dash: true });
    });
    var last = null;
    for (var i = stones.length - 1; i >= 0; i--) if (!stones[i].ref) { last = [stones[i].x, stones[i].y]; break; }
    var cur = (rep.steps || [])[sStep - 1];
    if (cur && cur.analyzed && cur.best &&
        !(cur.actual && cur.actual[0] === cur.best[0] && cur.actual[1] === cur.best[1])) {
      marks.push({ x: cur.best[0], y: cur.best[1], color: '#3c5ee7', r: 0.5, dash: true });
    }
    drawBoard($('sBoard'), { stones: stones, marks: marks, last: last });

    $('sSlider').value = sStep;
    $('sJump').value = sStep;
    var st = (rep.steps || [])[sStep - 1];
    $('sBoardInfo').textContent = st
      ? (T('viewer|第{m}手 {side} 走 {move} · 引擎最佳 {best} · {wr}', {
          m: st.moveNo, side: sideTag(st.side), move: st.actualStr, best: st.bestStr,
          wr: st.bestWR != null ? T('viewer|胜率{p}', { p: pct(st.bestWR) }) : T('viewer|未分析'),
        }) +
         ' · ' + (!st.analyzed ? T('viewer|(跳过)') : (st.top1 ? 'Top1' : (st.top3 ? 'Top3' : (st.top5 ? 'Top5' : T('viewer|Top5外'))))) +
         (st.isSharp ? ' · ' + T('viewer|唯一手') : '') + (st.desperate ? ' · ' + T('viewer|将败') : '') + (st.evasion ? ' · ' + T('viewer|回避') : '') +
         (st.forcedDefense ? ' · ' + T('viewer|冲四豁免') : '') +
         (st.jumpFourFlag ? ' · ' + T('viewer|跳四') : '') +
         (st.aiSimilar ? ' · ' + T('viewer|疑AI指纹') +
            (st.aiSim != null ? '(' + st.aiSim + ')' : '') : ''))
      : T('viewer|棋谱：{n} / {total} 子（拖滑块或点按钮逐步查看）', { n: stones.length, total: total });

    $('sBoardTip').textContent = T('viewer|紫虚线 = 与特征库 AI 步骤相似 · 橙圈 = 将败冲四 · 红圈 = 可疑 · 蓝虚线 = 引擎最佳。点步骤行的编号可填单步备注。');
  }

  $('sSlider').oninput = function (e) { sStep = +e.target.value; renderSampleBoard(); };
  $('sPrev').onclick = function () { sStep = Math.max(0, sStep - 1); renderSampleBoard(); };
  $('sNext').onclick = function () {
    sStep = Math.min(detailMax(curSample), sStep + 1); renderSampleBoard();
  };
  $('sStart').onclick = function () { sStep = 0; renderSampleBoard(); };
  $('sEnd').onclick = function () {
    sStep = detailMax(curSample);
    renderSampleBoard();
  };
  $('sJump').onchange = function () {
    var max = detailMax(curSample);
    sStep = clamp(parseInt($('sJump').value, 10) || 0, 0, max);
    renderSampleBoard();
  };

  // Same hover readout as the archive board: an order-unknown stone says so, and a stone
  // carrying an annotation reports it. Without this the 人工标注 the operator just made is
  // invisible on the board, which is the one place they are thinking about positions.
  $('sBoard').addEventListener('mousemove', function (e) {
    if (!curSample || !sBoardStones.length) return;
    var cv = $('sBoard');
    var rect = cv.getBoundingClientRect();
    if (!rect.width) return;
    var px = (e.clientX - rect.left) * (cv.width / rect.width);
    var py = (e.clientY - rect.top) * (cv.height / rect.height);
    var pad = cv.width / (SIZE + 1);
    var hit = null;
    for (var i = 0; i < sBoardStones.length; i++) {
      var st = sBoardStones[i];
      var dx = px - (pad + st.x * pad), dy = py - (pad + st.y * pad);
      if (dx * dx + dy * dy <= pad * pad * 0.25) { hit = st; break; }
    }
    if (!hit) return;
    var bits = [];
    if (hit.moveNo != null) bits.push(T('viewer|第 {m} 手（{side}）', { m: hit.moveNo, side: sideTag(hit.side) }));
    if (hit.unordered) bits.push(T('viewer|中途加入前已存在于盘面，无手序，不计入命中率与时间统计'));
    var labels = hit.moveNo == null ? [] : G.sampleLabels(curSample, hit.moveNo);
    if (labels.length) bits.push(T('viewer|标注：{list}', { list: labels.map(function (l) { return TO('ann', l); }).join('、') }));
    var note = hit.moveNo == null ? '' : ((G.annotationsOf(curSample)[hit.moveNo] || {}).note || '');
    if (note) bits.push(T('viewer|备注：') + note);
    if (bits.length) $('sBoardTip').textContent = bits.join(' · ');
  });

  // ---------- 标注 (§2.2 / §2.3) ----------
  // The detail view persists every toggle immediately (§2.3). The editor keeps them in the
  // draft until 保存, because a Cancel has to discard the whole session — and a brand-new
  // sample has no id to persist against yet.
  function annToggleInMemory(sample, moveNo, label) {
    var ann = G.annotationsOf(sample);
    var cur = ann[moveNo] || { labels: [] };
    if (!Array.isArray(cur.labels)) cur.labels = [];
    var i = cur.labels.indexOf(label);
    if (i >= 0) cur.labels.splice(i, 1); else cur.labels.push(label);
    if (!cur.labels.length && !cur.note) delete ann[moveNo];
    else ann[moveNo] = cur;
    return sample;
  }

  function makeAnnHandler(cfg) {
    return function (e) {
      if (!e.target.closest) return;
      var sample = cfg.getSample();
      if (!sample) return;

      // The serial number opens the per-step note row (§2.2 行展开备注).
      var sno = e.target.closest('td.sno');
      if (sno) {
        var idx = parseInt(sno.dataset.i, 10);
        var steps = (sample.report && sample.report.steps) || [];
        var step = isNaN(idx) ? null : steps[idx];
        if (!step || step.moveNo == null) return;
        toggleNoteRow(sno.closest('tr'), step.moveNo, cfg);
        return;
      }

      var btn = e.target.closest('button.ann-btn');
      if (!btn) return;
      var moveNo = parseInt(btn.dataset.move, 10);
      var label = btn.dataset.label;
      if (!isFinite(moveNo) || !label) return;
      if (cfg.persist) {
        G.toggleSampleLabel(sample.id, moveNo, label).then(function (s2) {
          var cell = btn.closest('td.annotations');
          if (cell) cell.innerHTML = annCellHtml(s2, moveNo);
          cfg.after(s2);
        });
      } else {
        annToggleInMemory(sample, moveNo, label);
        var cell2 = btn.closest('td.annotations');
        if (cell2) cell2.innerHTML = annCellHtml(sample, moveNo);
        cfg.after(sample);
      }
    };
  }

  function toggleNoteRow(tr, moveNo, cfg) {
    if (!tr) return;
    var next = tr.nextElementSibling;
    if (next && next.classList.contains('step-note')) { next.parentNode.removeChild(next); return; }
    var sample = cfg.getSample();
    var cols = tr.children.length;
    var labels = G.sampleLabels(sample, moveNo);
    var note = (G.annotationsOf(sample)[moveNo] || {}).note || '';
    var trn = document.createElement('tr');
    trn.className = 'step-note';
    trn.innerHTML = '<td colspan="' + cols + '">' +
      '<div class="snote-hint">' + T('viewer|第 {m} 手单步备注', { m: moveNo }) +
        (labels.length
          ? T('viewer|（当前标签：{list}）', { list: esc(labels.map(function (l) { return TO('ann', l); }).join('、')) })
          : '') +
        ' · ' + T('viewer|失焦即保存') + '</div>' +
      '<textarea maxlength="' + G.MAX_NOTE_LEN + '" placeholder="' +
        esc(T('viewer|该步备注，例如：唯一防点秒下')) + '"></textarea>' +
      '</td>';
    tr.parentNode.insertBefore(trn, tr.nextSibling);
    var ta = trn.querySelector('textarea');
    ta.value = note;
    var last = note;
    var commit = function () {
      if (ta.value === last) return;      // blur after change: only write once
      last = ta.value;
      var v = ta.value;
      var cur = cfg.getSample();
      if (!cur) return;
      if (cfg.persist) {
        G.setSampleNote(cur.id, moveNo, v).then(function (s2) {
          // the note marker on the row has to follow the save, not the keystroke
          var noCell = tr.querySelector('td.sno');
          if (noCell) noCell.innerHTML = moveNo + (v ? ' <span style="color:var(--yellow)">✎</span>' : '');
          cfg.after(s2);
        });
      } else {
        var ann = G.annotationsOf(cur);
        var entry = ann[moveNo] || { labels: [] };
        if (v) entry.note = v; else delete entry.note;
        if (!entry.labels || !entry.labels.length) { if (v) ann[moveNo] = entry; else delete ann[moveNo]; }
        else ann[moveNo] = entry;
        var noCell2 = tr.querySelector('td.sno');
        if (noCell2) noCell2.innerHTML = moveNo + (v ? ' <span style="color:var(--yellow)">✎</span>' : '');
        cfg.after(cur);
      }
    };
    ta.addEventListener('change', commit);
    ta.addEventListener('blur', commit);
    ta.focus();
  }

  // One delegated listener per table, wired once — the rows are rebuilt on every render.
  (function wireSampleAnnotations() {
    var t1 = document.querySelector('#sTbl tbody');
    var t2 = document.querySelector('#seTbl tbody');
    if (t1) t1.addEventListener('click', makeAnnHandler({
      getSample: function () { return curSample; },
      persist: true,
      after: function (s2) { curSample = s2; updateSampleAnnStat(s2); },
    }));
    if (t2) t2.addEventListener('click', makeAnnHandler({
      getSample: function () { return editing; },
      persist: false,
      after: function () { updateSeAnnHint(); },
    }));
  })();

  // ---------- 右键菜单 / 标签 / 删除 ----------
  function openSampleMenu(ev, id) {
    var s = findSample(id);
    if (!s) return;
    showCtx(
      '<div class="it" data-a="view">' + T('viewer|查看') + '</div>' +
      '<div class="it" data-a="edit">' + T('viewer|编辑…') + '</div>' +
      '<div class="it" data-a="rename">' + T('viewer|重命名…') + '</div>' +
      '<div class="it" data-a="tags">' + T('viewer|标签') + ' <span class="k">▸</span></div>' +
      '<div class="sep"></div>' +
      '<div class="it" data-a="json">' + T('viewer|导出 JSON') + '</div>' +
      '<div class="it danger" data-a="del">' + T('viewer|删除…') + '</div>',
      ev.clientX, ev.clientY);
    ctx.querySelectorAll('.it').forEach(function (it) {
      it.onclick = function (e2) {
        e2.stopPropagation();
        var act = it.dataset.a;
        closeCtx();
        if (act === 'view') openSample(id);
        else if (act === 'edit') openSampleEditor(s);
        else if (act === 'rename') sampleRenameDialog(s);
        else if (act === 'tags') sampleTagsDialog(s);
        else if (act === 'json') {
          download('gomoku-sample-' + s.id + '.json', JSON.stringify(s, null, 2), 'application/json');
        } else if (act === 'del') sampleDeleteDialog(s);
      };
    });
  }

  function sampleRenameDialog(s) {
    var v = prompt(T('viewer|新名称（只改显示名，不改 id）'), s.name);
    if (v == null || !v.trim()) return;
    G.renameSample(s.id, v.trim()).then(refreshSamples);
  }

  function sampleDeleteDialog(s) {
    if (!confirm(T('viewer|删除样本「{name}」？此操作不可撤销。', { name: s.name }) + '\n\n' +
        T('viewer|注意：删除样本不会自动更新学习结果，需要点「重新学习」。'))) return;
    G.deleteSample(s.id).then(refreshSamples);
  }

  function sampleTagsDialog(s) {
    var all = G.listSampleTags(samples);
    var cur = (s.tags || []).slice();
    var h = '<div class="hint" style="margin-bottom:8px">' +
      T('viewer|点标签切换选中。自定义标签全局共享，出现在所有样本的标签列表里。') + '</div>' +
      '<div id="tagBox"></div>' +
      '<div class="btn-row" style="margin-top:12px">' +
        '<input type="text" id="tagNew" placeholder="' + esc(T('viewer|自定义标签')) + '" style="width:200px">' +
        '<button class="sec" id="tagAdd">' + T('viewer|＋ 添加') + '</button>' +
      '</div>';
    openModal(T('viewer|标签 · {name}', { name: (s.name || '').slice(0, 22) }), h, function (body) {
      var box = body.querySelector('#tagBox');
      function draw() {
        var shown = all.concat(cur.filter(function (t) { return all.indexOf(t) < 0; }));
        box.innerHTML = shown.map(function (t) {
          var custom = G.PRESET_TAGS.indexOf(t) < 0;
          return '<span class="tagchip' + (cur.indexOf(t) >= 0 ? ' on' : '') +
            (custom ? ' custom' : '') + '" data-t="' + esc(t) + '">' + esc(t) + '</span>';
        }).join('');
        box.querySelectorAll('.tagchip').forEach(function (el) {
          el.onclick = function () {
            var t = el.dataset.t;
            var i = cur.indexOf(t);
            if (i >= 0) cur.splice(i, 1); else cur.push(t);
            draw();
          };
        });
      }
      draw();
      body.querySelector('#tagAdd').onclick = function () {
        var v = body.querySelector('#tagNew').value.trim();
        if (!v) return;
        if (all.indexOf(v) < 0) all.push(v);
        if (cur.indexOf(v) < 0) cur.push(v);
        body.querySelector('#tagNew').value = '';
        draw();
      };
      var ft = body.parentNode.querySelector('.ft');
      var save = document.createElement('button');
      save.textContent = T('viewer|保存标签');
      save.onclick = async function () {
        await G.setSampleTags(s.id, cur);
        closeModal();
        await refreshSamples();
        if (curSample && curSample.id === s.id) {
          curSample = findSample(s.id);
          if (curSample) renderSampleDetail();
        }
      };
      ft.insertBefore(save, ft.firstChild);
    });
  }

  // 0.3.3 §2.4 兼容: promote an archive to a sample. buildSample runs the manualAI →
  // 人工标注 migration, so the 0.3.1 review marks become 「AI步骤」 labels on the sample.
  async function archiveToSample(a) {
    var s = G.buildSample({
      name: a.name,
      // A promoted archive is by definition unverified — it is the operator saying "I want
      // to study this one", not "I have checked it". 存疑样本 is the honest default, and it
      // is also what keeps an unreviewed game from dominating the learner (§3.3).
      tags: ['存疑样本'],
      rule: a.rule, mode: a.mode, suspect: a.suspect,
      record: a.record, report: a.report,
      createdAt: a.createdAt,
    });
    await G.saveSample(s);
    await refreshSamples();
    setStatus(T('viewer|已转为样本：{name}', { name: s.name }));
    if (confirm(T('viewer|已把存档转为样本「{name}」。\n\n是否现在打开样本库？', { name: s.name }))) showView('samples');
  }

  // ---------- 编辑器（新建 / 编辑） ----------
  function newDraftSample() {
    return {
      id: null, name: '', note: '', tags: [], version: 1,
      createdAt: Date.now(), updatedAt: Date.now(),
      rule: 'freestyle', mode: 'global', suspect: 'both',
      record: { moves: [], stones: [], times: [], sources: [], meta: { source: 'manual' } },
      report: null, annotations: {},
    };
  }

  function openSampleEditor(sample) {
    editingId = sample ? sample.id : null;
    // A deep copy so 返回样本库 really discards: the stored object is never mutated in place.
    editing = sample ? JSON.parse(JSON.stringify(sample)) : newDraftSample();
    if (!editing.record) editing.record = { moves: [], stones: [], times: [], sources: [], meta: {} };
    G.annotationsOf(editing);
    seDraft = (editing.record.moves || []).map(function (c, i) {
      return { c: c.slice(), s: (editing.record.sources || [])[i] || 'player' };
    });
    // An existing sample already carries a (slimmed) report; re-analysing is only needed if
    // the record changed (§1.5), so the table shows what is stored.
    seReport = editing.report || null;
    seEngineBusy = false;
    sStep = 0;
    // 0.3.4 二.1: the editor opens with the cursor at the end of the record and no parked
    // branch. Without this an editor opened after a branch would show the previous draft's
    // ghost/cursor positions.
    seStep = seDraft.length;
    seUndoStack = [];

    $('sampleList').classList.add('hidden');
    $('sampleDetail').classList.add('hidden');
    $('sampleEditor').classList.remove('hidden');

    $('seTitle').textContent = sample
      ? T('viewer|编辑样本 · {name}', { name: (sample.name || '').slice(0, 28) })
      : T('viewer|新建样本');
    setField($('seName'), editing.name || '');
    $('seNote').value = editing.note || '';
    $('seSuspect').value = editing.suspect || 'both';
    $('seRule').value = String(RULE_IDX[editing.rule] != null ? RULE_IDX[editing.rule] : 0);
    $('seThinkMs').value = S.thinkMs;
    $('seOpenCut').value = S.openingCutoff;
    $('seInput').value = seDraft.map(function (m) { return coordToShare(m.c); }).join('');
    setSeProgress(0, '');
    setSeStatus(sample
      ? T('viewer|已载入样本（v{n}）', { n: editing.version || 1 })
      : T('viewer|新样本：导入棋谱或直接在棋盘落子'));
    renderSeTags();
    renderSeBoard();
    renderSeTable();
    // 0.4.3 §2.1: an already-analysed sample must show its scores the instant the editor opens,
    // not only after a fresh run — re-opening a reviewed draft is the common case.
    renderSeScores(seReport);
    updateSeInputInfo();
  }

  $('seCancel').onclick = async function () {
    editing = null;
    editingId = null;
    seDraft = [];
    seReport = null;
    seStep = 0;
    seUndoStack = [];
    $('sampleEditor').classList.add('hidden');
    $('sampleList').classList.remove('hidden');
    await refreshSamples();
  };

  function setSeStatus(t) { $('seStatus').textContent = t; }
  function setSeProgress(p, msg) {
    $('seBar').style.width = p + '%';
    if (msg) $('sePmsg').textContent = msg;
  }
  function updateSeInputInfo() {
    var played = seDraft.filter(function (m) { return m.s !== 'ai-suggest'; }).length;
    $('seInputInfo').textContent = T('viewer|当前 {n} 手', { n: played }) +
      (seDraft.length !== played ? T('viewer|（含 {n} 个 AI 参考手）', { n: seDraft.length - played }) : '') +
      (played < 5 ? ' · ' + T('viewer|少于 5 手，无法分析') : '');
    $('seRun').disabled = seEngineBusy || played < 5;
  }
  function updateSeAnnHint() {
    $('seSaveHint').textContent = T('viewer|已标注 {n} 步', { n: G.countAnnotated(editing) }) +
      ' · ' + (editingId ? T('viewer|再次保存 version++') : T('viewer|首次保存 version=1'));
  }

  function editorRecord() {
    var stones = [], playedBefore = 0;
    seDraft.forEach(function (m) {
      stones.push(playedBefore % 2 === 0 ? 1 : 2);
      if (m.s !== 'ai-suggest') playedBefore++;
    });
    return {
      moves: seDraft.map(function (m) { return m.c; }),
      stones: stones,
      sources: seDraft.map(function (m) { return m.s; }),
      times: seDraft.map(function () { return null; }),
      meta: { source: 'manual', rule: RULE_NAME[parseInt($('seRule').value, 10)] || 'freestyle' },
    };
  }

  function seView() {
    var stones = [], playedBefore = 0;
    for (var i = 0; i < seDraft.length; i++) {
      var isRef = seDraft[i].s === 'ai-suggest';
      stones.push({
        x: seDraft[i].c[0], y: seDraft[i].c[1],
        side: (playedBefore % 2 === 0 ? 'B' : 'W'),
        moveNo: isRef ? null : playedBefore + 1, ref: isRef,
        ghost: i >= seStep, cursor: i === seStep - 1,
      });
      if (!isRef) playedBefore++;
    }
    var marks = [];
    if (seReport) {
      (seReport.steps || []).forEach(function (s, k) {
        if (!s.actual || k >= seStep) return;
        if (s.desperate) marks.push({ x: s.actual[0], y: s.actual[1], color: '#e67e22', r: 0.6 });
        if (isFlagged(s)) marks.push({ x: s.actual[0], y: s.actual[1], color: '#e74c3c', r: 0.5 });
        if (s.aiSimilar) marks.push({ x: s.actual[0], y: s.actual[1], color: '#b05aa0', r: 0.72, dash: true });
      });
    }
    var last = null;
    for (var k = stones.length - 1; k >= 0; k--) if (!stones[k].ref && !stones[k].ghost) { last = [stones[k].x, stones[k].y]; break; }
    return { stones: stones, marks: marks, last: last };
  }

  function seHint() {
    var total = seDraft.length;
    if (!total) return T('viewer|棋盘（点空点落子；右键悔一手）');
    if (seStep >= total) return T('viewer|第 {n} / {n} 手 · 末手。点空点继续打谱', { n: total });
    return T('viewer|第 {cur} / {total} 手 · 光标停在第 {cur} 手，其后 {rest} 手为变体预览（虚线半透明）。点空点在此打出变体',
      { cur: seStep, total: total, rest: total - seStep });
      
  }

  function renderSeBoard() {
    var total = seDraft.length;
    seStep = clamp(seStep, 0, total);
    $('seSlider').max = total; $('seSlider').value = seStep;
    $('seJump').max = total; $('seJump').value = seStep;
    drawBoard($('seBoard'), seView());
    var played = seDraft.filter(function (m) { return m.s !== 'ai-suggest'; }).length;
    $('seBoardInfo').textContent = seHint() +
      (seReport ? ' · ' + T('viewer|已分析 {n} 步', { n: (seReport.steps || []).length }) : ' · ' + T('viewer|未分析')) +
      (seDraft.length !== played ? T('viewer|（含 {n} 个 AI 参考手）', { n: seDraft.length - played }) : '');
    if ($('seUndoChange')) $('seUndoChange').disabled = !seUndoStack.length;
    if ($('seTruncate')) $('seTruncate').disabled = seStep >= total;
  }

  // 0.3.4 二.1: the sample editor uses the SAME snapshot-undo model as the detect page. Keeping
  // them identical matters — an operator who learns one board must not be surprised by the other.
  function seSnapshot(why) {
    seUndoStack.push({ moves: seDraft.slice(), at: seStep, why: why || '' });
    if (seUndoStack.length > SE_UNDO_MAX) seUndoStack.shift();
  }

  // Drop everything after `from`. The caller has already snapshotted.
  function seDropTail(from, why) {
    if (from >= seDraft.length) return 0;
    var n = seDraft.length - from;
    seDraft = seDraft.slice(0, from);
    seSyncInput();
    if (why) setSeStatus(T('viewer|已在第 {from} 手分支：原后续 {n} 手转为变体预览（可「撤销改动」找回）', { from: from, n: n }));
    return n;
  }

  function seSyncInput() {
    $('seInput').value = seDraft.map(function (m) { return coordToShare(m.c); }).join('');
  }

  // 0.4.3 §2.1: the sample editor showed the per-step verdicts but never the number they add
  // up to — an operator could analyse a draft and still have nowhere to read its risk score.
  // The cards mirror the detect pane's markup and the table reuses `summaryTableHtml(rep,{sim})`,
  // so the editor, the sample detail and the replay detail cannot print three readings of one
  // game. Called from seRun's success path and again by `openSampleEditor` when the sample
  // already carries a report, so re-entering an analysed draft shows its scores immediately.
  function renderSeScores(rep) {
    var box = $('seScores');
    if (!box) return;
    var sum = $('seSummary');
    if (!rep || (!rep.black && !rep.white)) {
      box.innerHTML = '<div class="hint">' + T('viewer|分析后显示') + '</div>';
      if (sum) sum.innerHTML = '—';
      return;
    }
    box.innerHTML = '';
    // A null side is normal — one player may not survive the filters — and it has to read as
    // 未分析 rather than being dropped, or B and W would silently swap columns between games.
    [rep.black, rep.white].forEach(function (a) {
      var div = document.createElement('div'); div.className = 'card';
      if (!a) {
        div.innerHTML = '<div class="big" style="color:#6e7b8a">—</div>' +
          '<div class="lab">' + T('viewer|未分析') + '</div>';
      } else {
        div.innerHTML = '<div class="big lv-' + a.level + '">' + a.risk.toFixed(0) + '</div>' +
          '<div class="lab">' + sideName(a.side) + ' · ' + TO('level', a.level) + '</div>' +
          '<div class="contrib">n=' + a.n + ' · T1=' + pct(a.top1) + '</div>';
      }
      box.appendChild(div);
    });
    if (sum) {
      // `steps` empty but an aggregate present is not reachable today (sideAggregate needs
      // steps to exist) — the guard is here so a future reader never gets an empty `<table>`
      // where the summary should be, and it reuses the spec's own wording.
      sum.innerHTML = (rep.steps || []).length
        ? summaryTableHtml(rep, { sim: true })
        : '<div class="hint">' + T('viewer|没有可用于统计的手。') + '</div>';
    }
  }

  function renderSeTable() {
    var tb = document.querySelector('#seTbl tbody');
    if (!tb) return;
    tb.innerHTML = '';
    // 0.4.3 §1.3/§1.4: this table gets handles too — the edit lands in `editing.report`, which
    // 保存 writes, so it is a deferred save rather than a discard.
    var rep = seReport || {};
    buildSegMap(rep);
    var steps = rep.steps || [];
    steps.forEach(function (st, i) {
      var tr = document.createElement('tr');
      if (isFlagged(st)) tr.classList.add('flagged');
      markSide(tr, st, i);
      tr.innerHTML = sRowHtml(st, i, editing, 'seTbl');
      tb.appendChild(tr);
    });
    updateSeAnnHint();
  }

  function renderSeTags() {
    var all = G.listSampleTags(samples.concat([editing]));
    var cur = editing.tags || (editing.tags = []);
    $('seTags').innerHTML = all.map(function (t) {
      var custom = G.PRESET_TAGS.indexOf(t) < 0;
      return '<span class="tagchip' + (cur.indexOf(t) >= 0 ? ' on' : '') +
        (custom ? ' custom' : '') + '" data-t="' + esc(t) + '">' + esc(t) + '</span>';
    }).join('');
    $('seTags').querySelectorAll('.tagchip').forEach(function (el) {
      el.onclick = function () {
        var t = el.dataset.t;
        var i = cur.indexOf(t);
        if (i >= 0) cur.splice(i, 1); else cur.push(t);
        renderSeTags();
      };
    });
  }

  $('seAddTag').onclick = function () {
    var v = $('seNewTag').value.trim();
    if (!v) return;
    if (!editing.tags) editing.tags = [];
    if (editing.tags.indexOf(v) < 0) editing.tags.push(v);
    $('seNewTag').value = '';
    renderSeTags();
  };
  $('seNewTag').onkeydown = function (e) { if (e.key === 'Enter') $('seAddTag').onclick(); };

  // Board editing. Any structural change invalidates a previous analysis: the report's
  // per-step verdicts describe the OLD game, and leaving them on screen next to a different
  // board is how a wrong verdict gets saved as fact. Annotations survive — they are keyed by
  // moveNo (§2.3), so they re-attach to the same hand after a re-analysis.
  function invalidateSeAnalysis() {
    seReport = null;
    editing.report = null;
    // 0.4.3 §2.1: a stale score is the same defect as a stale verdict — the cards must fall
    // back to 「分析后显示」 the moment the board they described stops existing.
    renderSeScores(null);
    renderSeTable();
  }

  $('seBoard').addEventListener('click', function (e) {
    if (seEngineBusy) { setSeStatus(T('viewer|分析进行中，暂不能改盘。')); return; }
    var cv = $('seBoard');
    var rect = cv.getBoundingClientRect();
    if (!rect.width) return;
    var px = (e.clientX - rect.left) * (cv.width / rect.width);
    var py = (e.clientY - rect.top) * (cv.height / rect.height);
    var pad = cv.width / (SIZE + 1);
    var gx = Math.round((px - pad) / pad);
    var gy = Math.round((py - pad) / pad);
    if (gx < 0 || gx >= SIZE || gy < 0 || gy >= SIZE) return;
    var idx = -1;
    for (var i = 0; i < seDraft.length; i++) {
      if (seDraft[i].c[0] === gx && seDraft[i].c[1] === gy) { idx = i; break; }
    }
    if (idx >= 0) {
      if (seDraft[idx].s === 'ai-suggest') {
        seDraft[idx].s = 'player';
        seStep = idx + 1;
      } else {
        // Same rule as the detect page: clicking a played stone moves the cursor instead of
        // silently deleting the rest of the record. Branch by clicking an empty point.
        seStep = idx + 1;
        renderSeBoard();
        setSeStatus(T('viewer|光标移到第 {n} 手', { n: idx + 1 }) +
          (seStep < seDraft.length ? T('viewer|，点空点即可在此打出变体') : ''));
        return;
      }
    } else {
      seSnapshot(seStep < seDraft.length ? T('viewer|分支') : T('viewer|落子'));
      if (seStep < seDraft.length) seDropTail(seStep, true);
      seDraft = seDraft.slice(0, seStep);
      seDraft.push({ c: [gx, gy], s: 'player' });
      seStep = seDraft.length;
    }
    seSyncInput();
    invalidateSeAnalysis();
    renderSeBoard();
    updateSeInputInfo();
  });
  $('seBoard').addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (seEngineBusy) return;
    seUndoOne();
  });
  function seUndoOne() {
    if (!seDraft.length) { setSeStatus(T('viewer|棋盘已空')); return; }
    var at = Math.max(1, Math.min(seStep, seDraft.length));
    seSnapshot(T('viewer|悔一手'));
    seDropTail(at - 1, null);
    seStep = seDraft.length;
    invalidateSeAnalysis();
    renderSeBoard();
    updateSeInputInfo();
  }
  $('seUndo').onclick = function () { if (!seEngineBusy) seUndoOne(); };
  $('seClear').onclick = function () {
    if (seEngineBusy) return;
    if (!seDraft.length) { setSeStatus(T('viewer|棋盘已空')); return; }
    seSnapshot(T('viewer|清空'));
    seDraft = []; seStep = 0;
    $('seInput').value = '';
    invalidateSeAnalysis();
    renderSeBoard();
    updateSeInputInfo();
    setSeStatus(T('viewer|已清空棋盘（可「撤销改动」找回）'));
  };
  $('seUndoChange').onclick = function () {
    if (seEngineBusy) return;
    if (!seUndoStack.length) { setSeStatus(T('viewer|没有可撤销的改动')); return; }
    var snap = seUndoStack.pop();
    seDraft = snap.moves;
    seStep = seDraft.length;
    seSyncInput();
    invalidateSeAnalysis();
    renderSeBoard();
    updateSeInputInfo();
    setSeStatus(T('viewer|已撤销{what}，棋谱回到 {n} 手', {
      what: snap.why ? T('viewer|「{why}」', { why: snap.why }) : T('viewer|上一步改动'),
      n: seDraft.length,
    }));
      
  };
  $('seTruncate').onclick = function () {
    if (seEngineBusy) return;
    if (seStep >= seDraft.length) { setSeStatus(T('viewer|光标已在末手，无需截断')); return; }
    var at = seStep;
    seSnapshot(T('viewer|截断到光标'));
    var n = seDropTail(at, null);
    invalidateSeAnalysis();
    renderSeBoard();
    updateSeInputInfo();
    setSeStatus(T('viewer|已截断到第 {at} 手，移除 {n} 手（可「撤销改动」找回）', { at: at, n: n }));
  };
  $('seSlider').oninput = function (e) { seStep = clamp(+e.target.value, 0, seDraft.length); renderSeBoard(); };
  $('sePrev').onclick = function () { seStep = Math.max(0, seStep - 1); renderSeBoard(); };
  $('seNext').onclick = function () { seStep = Math.min(seDraft.length, seStep + 1); renderSeBoard(); };
  $('seStart').onclick = function () { seStep = 0; renderSeBoard(); };
  $('seEnd').onclick = function () { seStep = seDraft.length; renderSeBoard(); };
  $('seJump').onchange = function () {
    seStep = clamp(parseInt($('seJump').value, 10) || 0, 0, seDraft.length);
    renderSeBoard();
  };
  $('seInput').oninput = function () {
    try {
      var rec = parseRecord($('seInput').value);
      seDraft = rec.moves.map(function (c) { return { c: c, s: 'player' }; });
    } catch (err) { seDraft = []; }
    seStep = seDraft.length;
    seUndoStack = [];
    invalidateSeAnalysis();
    renderSeBoard();
    updateSeInputInfo();
  };

  $('seRun').onclick = async function () {
    if (seEngineBusy) return;
    var rec = editorRecord();
    if (rec.moves.length < 5) { alert(T('viewer|有效手数过少：{n}', { n: rec.moves.length })); return; }
    seEngineBusy = true;
    $('seRun').disabled = true;
    setSeProgress(0, T('viewer|加载引擎中...'));
    setSeStatus(T('viewer|分析中...'));
    // 0.4.11 §一.2 — the sample editor's 「AI 分析」 runs on the shared engine, through the
    // stepwise path: one engine call per scored hand, in play order, which is the shape the
    // 人工标注 table needs.
    var jid = gmJobId('sample');
    pauseCtrl.jobId = jid; pauseCtrl.paused = false;
    jobSinks[jid] = setSeProgress;
    try {
      var resp = await askOffscreen({
        type: 'gm-analyze-stepwise',
        jobId: jid,
        record: rec,
        opts: {
          rule: parseInt($('seRule').value, 10),
          thinkMs: parseInt($('seThinkMs').value, 10),
          openingCutoff: parseInt($('seOpenCut').value, 10),
          suspect: $('seSuspect').value,
          threadNum: S.threadNum,
          learned: curLearned,
          engineId: S.engineId,
        },
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || T('viewer|offscreen 文档没有响应（检查扩展是否已重新加载）'));
      seReport = resp.report;
      editing.report = seReport;
      editing.record = rec;
      editing.rule = RULE_NAME[parseInt($('seRule').value, 10)] || 'freestyle';
      editing.suspect = $('seSuspect').value;
      // The 0.3.1 binary flag (if this draft came from an archive) becomes 人工标注 labels.
      G.migrateAnnotations(editing);
      // 0.3.4: park the cursor at the end of the RECORD, not the end of the report — a genuine
      // live-four stop must leave the later hands on the board (ghosted), not erase them.
      seStep = seDraft.length;
      renderSeTable();
      renderSeBoard();
      // 0.4.3 §2.1: the score cards and the metric summary update the moment the run finishes.
      renderSeScores(seReport);
      if (seReport.terminal) {
        // Same wording rule as the detect tab: 「分析完成」 stays at the front so anything
        // polling for the completion phrase is not fooled by a legitimate early stop.
        setSeStatus(T('viewer|分析完成：第 {m} 手检测提前终止（{reason}）。已录入 {total} 手，其中 {scored} 手已评分（其余显示为半透明）',
          {
            m: seReport.terminal.moveNo != null ? seReport.terminal.moveNo : '?',
            reason: TO('stopReason', seReport.terminal.reason) || T('viewer|任一方形成四三杀或活四'),
            total: seDraft.length, scored: (seReport.steps || []).length,
          }));
          
          
      } else {
        setSeStatus(T('viewer|分析完成：{n} 步，可逐步标注', { n: (seReport.steps || []).length }));
      }
    } catch (e) {
      setSeStatus(T('viewer|分析出错：{err}', { err: TE(e.message) }));
    } finally {
      delete jobSinks[jid];
      pauseCtrl.jobId = null;
      seEngineBusy = false;
      updateSeInputInfo();
    }
  };

  $('seSave').onclick = async function () {
    if (seEngineBusy) { alert(T('viewer|分析进行中，请等待完成。')); return; }
    var rec = editorRecord();
    if (rec.moves.length < 5) { alert(T('viewer|棋谱太短：至少 5 手才能保存为样本。')); return; }
    editing.record = rec;
    editing.rule = RULE_NAME[parseInt($('seRule').value, 10)] || 'freestyle';
    editing.suspect = $('seSuspect').value;
    editing.name = $('seName').value.trim();
    editing.note = $('seNote').value.slice(0, G.MAX_NOTE_LEN);
    editing.mode = 'global';
    editing.updatedAt = Date.now();
    if (editingId) {
      // §1.5: an edit bumps version and updatedAt. The learner reads the latest version, so
      // a save that did not bump it would be invisible to 重新学习.
      editing.version = (editing.version || 1) + 1;
    } else {
      editing.version = 1;
      editing.createdAt = Date.now();
    }
    if (!editing.name) editing.name = G.defaultSampleName(editing);
    var saved = await G.saveSample(editing);
    editingId = saved.id;
    await refreshSamples();
    setStatus(T('viewer|样本已保存：{name}（v{v}）', { name: saved.name, v: saved.version }));
    // Land on the detail view: annotations there persist immediately, which is what an
    // operator who just saved usually wants to keep doing.
    openSample(saved.id);
    // §3.4: offer a re-learn after a change, but never force one.
    if (samples.length >= G.MIN_SAMPLES &&
        confirm(T('viewer|样本已更新（共 {n} 个）。\n\n是否现在重新学习？', { n: samples.length }))) {
      await runLearn();
    }
  };

  // ---------- 学习 (§3) ----------
  async function renderLearnStatus() {
    var lp = await G.loadLearnedParams();
    curLearned = lp;
    var n = samples.length;
    var btn = $('btnLearn');
    if (btn) btn.disabled = n < G.MIN_SAMPLES;
    $('learnHint').textContent = n < G.MIN_SAMPLES
      ? T('viewer|样本 {n} 个 —— 少于 {min} 个，学习已禁用。', { n: n, min: G.MIN_SAMPLES })
      : (n < G.LOW_SAMPLES
          ? T('viewer|样本 {n} 个（少于 {low} 个），学习结果不可靠。', { n: n, low: G.LOW_SAMPLES })
          : T('viewer|样本 {n} 个。', { n: n }));
    if (!lp) {
      $('learnStatus').innerHTML = T('viewer|尚未学习 —— 检测使用 0.3.1 默认阈值与权重。');
      $('learnResult').innerHTML = '';
      return;
    }
    $('learnStatus').innerHTML = T('viewer|上次学习：{t}', { t: G.beijingTime(lp.trainedAt) }) +
      ' · ' + T('viewer|样本 {n} 个 · 特征库 {f} 条', { n: lp.sampleCount || 0, f: lp.featureCount || 0 }) +
      (lp.reliable === false
        ? ' · <span style="color:var(--yellow)">' + T('viewer|样本量不足，结果不可靠') + '</span>' : '');
    // 0.4.1 §一.5: the corpus has grown since the last run. Nothing re-trains on its own
    // (0.3.3 §3.6), so without this line the operator's only clue that the detector is still
    // scoring with month-old weights is to remember what 样本数 said last time.
    var drift = G.sampleDrift(lp.sampleCount, n);
    if (drift.grown) {
      $('learnStatus').innerHTML += '<div class="hint" style="color:var(--yellow)">' +
        T('viewer|样本已从 {was} 增至 {now}（+{pct}%），建议重新学习。',
          { was: drift.was, now: drift.now, pct: drift.pct }) + '</div>';
    }
    renderLearnResult(lp);
  }

  function fmtNum(v, d) { return v == null ? '—' : (typeof v === 'number' ? v.toFixed(d) : String(v)); }

  function numTable(rows, digits) {
    var h = '<table class="ltable"><tr><th>' + T('viewer|项') + '</th><th>' + T('viewer|学习前') +
      '</th><th>' + T('viewer|学习后') + '</th><th>' + T('viewer|变化') + '</th></tr>';
    rows.forEach(function (r) {
      var cls = 'same';
      if (r.delta != null && Math.abs(r.delta) > 1e-9) cls = r.delta > 0 ? 'up' : 'down';
      var sign = (r.delta != null && r.delta > 0) ? '+' : '';
      h += '<tr><td>' + esc(r.labelKey ? paramLabel(r.labelKey, r.label) : r.label) + '</td>' +
        '<td class="num">' + fmtNum(r.before, digits) + '</td>' +
        '<td class="num">' + fmtNum(r.after, digits) + '</td>' +
        '<td class="num ' + cls + '">' + (r.delta == null ? '—' : sign + fmtNum(r.delta, digits)) + '</td></tr>';
    });
    return h + '</table>';
  }

  function renderLearnResult(lp) {
    var box = $('learnResult');
    if (!lp) { box.innerHTML = ''; return; }
    var h = '<div class="lcards">' +
      '<div class="lcard"><div class="big">' + (lp.sampleCount || 0) + '</div><div class="lab">' + T('viewer|样本数') + '</div></div>' +
      '<div class="lcard"><div class="big">' + (lp.posCount || 0) + ' / ' + (lp.negCount || 0) + '</div><div class="lab">' + T('viewer|正样本 / 负样本') + '</div></div>' +
      '<div class="lcard"><div class="big">' + (lp.f1 == null ? '—' : lp.f1.toFixed(2)) + '</div><div class="lab">' + T('viewer|风险线 F1') + '</div></div>' +
      '<div class="lcard"><div class="big">' + (lp.featureCount || 0) + '</div><div class="lab">' + T('viewer|特征库条目') + '</div></div>' +
      '</div>';
    h += '<div class="lbox"><b>' + T('viewer|B · 分项权重（学习前 → 学习后）') + '</b>' +
      // 0.5.6 补增 §三·补 — the table below is a RECORD, not what the detector scores with. Saying so
      // is not pedantry: the whole reason the panel's 留空 figure can be the shipped table now is
      // that the learner stopped writing the score's weights, and a diff table with no note would
      // read as "the score just moved".
      '<div class="hint">' + T('viewer|学习器的权重只作记录，不参与评分：评分用的是「检测信号权重」面板里那张表（出厂默认 + 你的自定义）。') +
      '</div>' +
      numTable(GMLearn.diffWeights(lp.before && lp.before.weights, lp.weights), 4) + '</div>';
    if (lp.aucs) {
      h += '<div class="lbox"><b>' + T('viewer|AUC 区分度') + '</b><div class="hint">' +
        // 0.4.2: WEIGHT_KEYS (all eight), not BASE_KEYS — the two evasion terms are learned
        // too, just in their own budget. Guarded per key because a learnedParams written
        // before 0.4.2 has no `aucs` entry for them, and an unguarded .toFixed() here would
        // throw and blank the whole 学习面板.
        GMLearn.WEIGHT_KEYS.map(function (k) {
          return esc(paramLabel('learn.weight.' + k, GMLearn.WEIGHT_LABEL[k] || k)) + ' ' +
            (lp.aucs[k] != null ? lp.aucs[k].toFixed(3) : '—');
        }).join(' · ') +
        '</div><div class="hint">' + T('viewer|0.5 = 无区分度；越接近 1，该分项越能分开 AI 与人类。') + '</div></div>';
    }
    h += '<div class="lbox"><b>' + T('viewer|A · 阈值（学习前 → 学习后）') + '</b>' +
      numTable(GMLearn.diffThresholds(lp.before && lp.before.thresholds, lp.thresholds), 4) + '</div>';
    if (lp.metricThresholds) {
      var rows = GMLearn.METRIC_KEYS.filter(function (m) { return lp.metricThresholds[m]; });
      if (rows.length) {
        h += '<div class="lbox"><b>' + T('viewer|A · 单指标最优阈值（网格搜索 F1）') + '</b><div class="hint">' +
          rows.map(function (m) {
            var r = lp.metricThresholds[m];
            return T('viewer|{m} ≥ {th}（F1 {f1}，正/负 {pos}/{neg}）',
              { m: m, th: r.threshold, f1: r.f1, pos: r.pos, neg: r.neg });
          }).join('<br>') + '</div></div>';
      }
    }
    if (lp.note) {
      h += '<div class="lbox" style="border-color:#6b5416"><b style="color:var(--yellow)">' + T('viewer|提示') + '</b>' +
        '<div class="hint">' + esc(TE(lp.note)) + '</div></div>';
    }
    box.innerHTML = h;
  }

  async function runLearn() {
    samples = await G.loadSamples();
    if (samples.length < G.MIN_SAMPLES) {
      alert(T('viewer|样本不足 {min} 个（当前 {n} 个），无法学习。', { min: G.MIN_SAMPLES, n: samples.length }));
      return;
    }
    setStatus(T('viewer|学习中…'));
    var cur = await G.loadLearnedParams();
    var res = GMLearn.runLearning(samples, { current: cur });
    if (!res.ok) {
      alert(T('viewer|学习失败：可用样本 {n} 个（需要 {need} 个）。', { n: res.sampleCount, need: res.need }));
      setStatus(T('viewer|学习未执行'));
      return;
    }
    await G.saveLearnedParams(res);
    curLearned = res;
    await renderLearnStatus();
    setStatus(T('viewer|学习完成 · 样本 {n} · 特征库 {f}', { n: res.sampleCount, f: res.featureCount }) +
      (res.reliable === false ? T('viewer|（样本量不足）') : ''));
  }

  async function resetLearn() {
    if (!confirm(T('viewer|重置学习参数，恢复 0.3.1 默认阈值与权重？\n\n样本不会被删除。'))) return;
    await G.resetLearnedParams();
    curLearned = null;
    await renderLearnStatus();
    setStatus(T('viewer|学习参数已重置为默认'));
  }

  $('btnLearn').onclick = function () { runLearn(); };
  $('btnResetLearn').onclick = function () { resetLearn(); };
  $('setResetLearn').onclick = function () { resetLearn(); };

  // 0.4.7 §三.1 — `auto` is resolved by CSS, so an OS theme flip needs no JS at all to
  // REPAINT. The listener is here for a different reason: the theme dropdown's hint text
  // (and anything else that wants to NAME the resolved theme) has to be told, and a media
  // query change is the only moment at which the answer changes. It is registered
  // unconditionally so a switch to `auto` later still gets it.
  if (window.matchMedia) {
    var mqDark = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () {
      // Nothing to recompute in the palette — that is the stylesheet's job. The value is
      // re-applied anyway because it is cheap and idempotent, and because a future editor
      // who adds a JS-side dependency on the resolved theme will find the hook already here.
      applyTransparency(S.transparency);
    };
    if (mqDark.addEventListener) mqDark.addEventListener('change', onScheme);
    else if (mqDark.addListener) mqDark.addListener(onScheme);   // Safari < 14
  }

  // =====================================================================
  // 0.4.9 §一.7 — 黑名单
  // =====================================================================
  // The management half of the blacklist. The panel has the 🚫 button and the match alert; the
  // list itself lives here, because curating it is a sitting-down task (add an id read off
  // someone else's report, write a note, drop one that turned out to be a false alarm) and not
  // something to do mid-game.
  //
  // Two rules are load-bearing and both come from §1.2:
  //   · the USERNAME is the key — it is what `data-id` carries, what the row is sorted by, and
  //     the only field the add form requires;
  //   · the display name is a LABEL. It is shown, it is refreshed when the panel meets the
  //     player again, and it is never matched on — which is why the list can hold two rows with
  //     the same 显示名 and the operator can still tell them apart.
  var blRowsData = [];

  async function refreshBlacklist() {
    var bl = await G.loadBlacklist();
    blRowsData = bl.players;
    renderBlacklist();
  }

  // 0.4.11 §一.7 — the row's provenance. Three literal keys rather than a `TO('blSource', v)`
  // lookup: a runtime key would have to be declared a second time in i18n-extra.js, and a key
  // that lives in exactly one of the two places is how a language ends up printing a slug.
  function blSourceLabel(v) {
    if (v === 'overlay') return T('viewer|来自浮层');
    if (v === 'import') return T('viewer|导入');
    return T('viewer|手动添加');
  }

  function renderBlacklist() {
    var host = $('blRows');
    if (!host) return;
    var list = blRowsData;
    $('blCount').textContent = list.length ? T('viewer|共 {n} 条', { n: list.length }) : '—';
    if (!list.length) {
      host.innerHTML = '<div class="empty">' + esc(T('viewer|还没有黑名单记录。')) + '</div>';
      return;
    }
    var h = '';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      h += '<div class="blrow">' +
        '<span class="bid" title="' + esc(e.id) + '">' + esc(e.id) + '</span>' +
        '<span class="bnm">' + esc(e.displayName || '—') + '</span>' +
        '<span class="bnt" title="' + esc(e.note || '') + '">' + esc(e.note || '—') + '</span>' +
        '<span class="btm">' + esc(G.beijingTime(e.addedAt)) + '</span>' +
        '<span class="btm">' + esc(G.beijingTime(e.lastSeen)) + '</span>' +
        '<span class="bct">' + (Number(e.encounterCount) || 0) + '</span>' +
        '<span class="bsrc">' + esc(blSourceLabel(e.source)) + '</span>' +
        '<span class="bop">' +
          '<button class="sec" data-bl="note" data-id="' + esc(e.id) + '">' + esc(T('viewer|编辑备注')) + '</button>' +
          '<button class="danger" data-bl="rm" data-id="' + esc(e.id) + '">' + esc(T('viewer|移除')) + '</button>' +
        '</span></div>';
    }
    host.innerHTML = h;
  }

  // One delegated listener rather than two per row: the list is re-rendered wholesale on every
  // change, so per-row listeners would be re-bound on every render and leak the old ones.
  $('blRows').addEventListener('click', async function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-bl]') : null;
    if (!btn) return;
    var id = btn.dataset.id;
    var entry = null;
    for (var i = 0; i < blRowsData.length; i++) if (blRowsData[i].id === id) { entry = blRowsData[i]; break; }
    if (!entry) return;
    if (btn.dataset.bl === 'note') {
      // prompt() rather than an inline editor, matching how the sample library edits tags. An
      // empty answer CLEARS the note; `null` (cancel) leaves it alone — the two are different
      // and conflating them would make cancel a silent delete.
      var raw = prompt(T('viewer|备注（可留空以清除）：'), entry.note || '');
      if (raw === null) return;
      await G.setBlacklistNote(id, raw);
    } else {
      if (!confirm(T('viewer|将 {name}（{id}）移出黑名单？', { name: entry.displayName || '?', id: id }))) return;
      await G.removeFromBlacklist(id);
    }
    await refreshBlacklist();
  });

  $('blAdd').onclick = async function () {
    var id = ($('blNewId').value || '').trim();
    if (!id) { alert(T('viewer|请先填写用户名（playerId）。')); return; }
    var name = ($('blNewName').value || '').trim();
    var note = ($('blNewNote').value || '').trim();
    await G.addToBlacklist(id, name || null, note || null);
    $('blNewId').value = ''; $('blNewName').value = ''; $('blNewNote').value = '';
    await refreshBlacklist();
  };

  $('blExport').onclick = function () {
    // Same envelope shape as the archive and sample backups, so one JSON reader could in
    // principle take any of the three.
    download('blacklist-' + blRowsData.length + '.json',
      JSON.stringify({ kind: 'gomoku-blacklist', version: 1, exportedAt: Date.now(), players: blRowsData }, null, 2),
      'application/json');
  };

  $('blImport').onclick = function () { $('blFile').click(); };
  $('blFile').onchange = async function () {
    var f = $('blFile').files && $('blFile').files[0];
    $('blFile').value = '';
    if (!f) return;
    var text;
    try { text = await f.text(); } catch (e) { alert(T('viewer|读取文件失败：{err}', { err: TE(e.message) })); return; }
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { alert(T('viewer|不是有效的 JSON 文件。')); return; }
    if (!Array.isArray(parsed) && !(parsed && Array.isArray(parsed.players))) {
      alert(T('viewer|文件里没有 players 数组。')); return;
    }
    var res = await G.importBlacklist(parsed, 'merge');
    await refreshBlacklist();
    alert(T('viewer|导入完成：新增 {n} 个', { n: res.added }) +
      (res.updated ? T('viewer|（另有 {n} 个已存在，已合并备注与统计）', { n: res.updated }) : ''));
  };

  // =====================================================================
  // cross-page sync
  // =====================================================================
  // The in-page panel and this viewer are two windows onto one settings object. Without
  // this, changing 检测思考 in the panel would leave a stale value sitting in the 设置
  // tab until a reload — which reads as "the setting did not stick".
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      // 0.4.0 §一.4 — the worker's 12-hourly check writes `updateInfo` while this page is
      // open, and 「暂不更新」 in the panel writes `updateDismissed`. Either has to reach this
      // banner without a reload.
      if (changes.updateInfo || changes.updateDismissed) refreshUpdateBanner();
      if (changes.settings) {
        G.loadSettings().then(function (v) {
          // 0.4.1 §五.3: compare against the locale actually PAINTED (`LANG`), not against the
          // previous settings object. The 设置 dropdown writes through GMStorage, and
          // `saveSetting` resolves with the NEW settings, so `S` is already up to date by the
          // time this broadcast arrives — `v.lang !== S.lang` was therefore always false for a
          // change made on this very page, which made the viewer's own language switch the one
          // case that never repainted (the ▾ column menu kept the load-time language).
          var langChanged = GMI18n.resolveLang(v.lang) !== LANG;
          S = v;
          if (langChanged) { applyLang(S.lang); repaintForLang(); return; }
          // 0.4.7 §三.1/§三.2 — these two are NOT part of the `self` short-circuit below. A
          // theme or opacity change made in the in-page panel arrives here as a foreign write,
          // and even our own echo has to re-apply: the applyTheme/applyTransparency calls in the
          // bindings read the clamp's OUTPUT, but a change made in another tab leaves this
          // document holding the old attribute until something puts it back.
          applyTheme(S.theme);
          applyTransparency(S.transparency);
          // Our own write echoed back: S/syncDetectControls are enough. Re-filling the
          // whole form here would reach into whatever box the user moved on to.
          var self = (Date.now() - lastSelfWrite) < 1000;
          syncDetectControls();
          if (!self && $('view-settings').classList.contains('active')) fillSettingsForm();
        });
      }
      if (changes.archives) refreshArchives();
      // 0.4.9 §一.7 — the in-page panel's 🚫 button writes the same key while this window is
      // open, so the list has to follow without a reload.
      if (changes.blacklist) refreshBlacklist();
      // 0.3.3: a sample saved here (or 重新学习 run in another tab) has to reach this one,
      // or the library list and the detector's parameter set go stale in silence.
      if (changes.samples) refreshSamples();
      if (changes.learnedParams) {
        G.loadLearnedParams().then(function (lp) {
          curLearned = lp;
          if ($('view-samples').classList.contains('active')) renderLearnStatus();
          // 0.5.6 补增 §三 — every weight a pin does NOT cover comes from this blob, so the panel's
          // boxes and their 留空 references are stale the moment it moves. 重新学习 happening in
          // another tab is exactly the case this listener exists for.
          fillSignalWeightsForm();
        });
      }
    });
  }

  // =====================================================================
  // boot
  // =====================================================================
  // One board scale for the whole page. 0.2.4 sized the replay board up to 1.2x to match
  // the shell scale it sits next to, and the detect board stayed at its markup size, so
  // the same game looked different depending on which tab you were on. Both are upscaled
  // now: drawBoard derives every radius and font size from cv.width, so the stone numbers
  // scale with it, and CSS max-width lets it shrink again on a narrow window.
  // 0.2.6 rendered both canvases at the detail scale (×1.2); 0.3.0 shrinks the whole viewer
  // by another 0.85, so the boards follow: ×1.2×0.85 = ×1.02, i.e. 520 -> 530. The HTML
  // still carries the pre-scale 520 so the intrinsic drawing size stays the reference for
  // drawBoard (every radius and stone number is derived from cv.width).
  // 0.3.5 §2.2: the header is sticky, and the archive/sample sort bar (.ahead) sticks in the
  // viewport too — so it needs to know how tall the header actually is, or it parks under it.
  // Measured rather than hard-coded because the header wraps to a second line on a narrow
  // window, which is exactly when the offset would be wrong.
  function syncHeaderHeight() {
    var h = document.querySelector('header');
    if (!h) return;
    document.documentElement.style.setProperty('--header-h', h.offsetHeight + 'px');
  }
  syncHeaderHeight();
  window.addEventListener('resize', syncHeaderHeight);

  var BOARD_SHRINK = 0.85;
  // 0.5.2 §三.1 — now a NAMED function rather than the IIFE it used to be, so the import path can
  // re-run it. Why that matters: a canvas laid out while its panel was hidden can come back with
  // a zero-width box, and `drawBoard` scales through `cv.width / rect.width` — a zero rect paints
  // nothing. Re-running it after an import is the backstop.
  //
  // ⚠ It also had to be made IDEMPOTENT, which the old body was not: `cv.width * 1.2 *
  // BOARD_SHRINK` reads the value it just wrote, so a second call would have walked
  // 530 → 541 → 552 … and every board would creep larger on each import. The declared size in
  // viewer.html (520) is the real base, so it is captured ONCE per canvas in a data attribute and
  // every later call recomputes from that. `drawBoard` only ever READS `cv.width`, so nothing
  // else can invalidate the captured base.
  function sizeBoards() {
    // 0.3.3 adds the sample detail + sample editor canvases; sizing them here rather than
    // lazily on first render keeps every board on the page at one scale from the start.
    ['board', 'dBoard', 'sBoard', 'seBoard'].forEach(function (id) {
      var cv = $(id);
      if (!cv) return;
      if (!cv.dataset.gmBase) cv.dataset.gmBase = String(cv.width || 520);
      var px = Math.round(+cv.dataset.gmBase * 1.2 * BOARD_SHRINK);
      cv.width = px; cv.height = px;
      cv.style.width = px + 'px'; cv.style.height = px + 'px';
    });
  }
  sizeBoards();

  (async function boot() {
    S = await G.loadSettings();
    // 0.3.6 §1.5: the language is resolved BEFORE anything paints. The static pass has to run
    // while the document is still the pristine markup viewer.html shipped — a node the
    // renderers create later carries no `__gmKey`, and that is exactly what stops a language
    // switch from overwriting a player name with a stale static string.
    applyLang(S.lang);
    GMI18n.apply(document);
    // 0.4.7 §三.1/§三.2 — theme and transparency go on <html> BEFORE the first paint. Both are
    // attribute/custom-property swaps that the stylesheet resolves on its own, so doing them
    // here costs nothing and doing them later would flash the wrong palette on load.
    applyTheme(S.theme);
    applyTransparency(S.transparency);
    // 0.5.3 §1.2 — the toast stack lives in this document. Attached before anything can raise
    // one (the analysis notices come from a click, the update notice from the end of boot).
    GmToast.attach(document);
    // 0.5.2 §5.1 — the operator's own backdrop, if they set one. Awaited so the picture is on
    // screen with the first frame: `has-bg` swaps `body` from an opaque `--bg` to transparent,
    // and a late arrival would show one frame of the default palette first.
    await applyViewerBg();
    fillLangSelect();
    fillThreadSelect();
    fillThemeSelect();
    // 0.5.3 §1.1.6 — the panel's markup is generated (see buildTransparencyPanel), so it has to
    // exist before fillSettingsForm paints it. Rebuilt on a language switch too: its labels are
    // JS-built and carry no `__gmKey` for the static pass to reach.
    buildTransparencyPanel();
    // 0.5.4 §1.5 — the four labels and the two `max` attributes, before fillSettingsForm paints
    // the values. Rebuilt on a language switch too (see repaintForLang).
    buildStorageFilter();
    // 0.5.6 补增 §三 — the thirteen labels and their 留空 references, before fillSettingsForm
    // paints the numbers. Rebuilt on a language switch too (see repaintForLang).
    buildSignalWeightsPanel();
    // 0.5.6 §1.3 — the category grid and its labels. Built before fillSettingsForm like the two
    // panels above; the default ticks (§1.3.1: everything except 背景图片) are applied by
    // buildIoPanel's first call, which is this one.
    buildIoPanel();
    // 0.5.1 §2.1.4 — the custom models live in IndexedDB, so the registry has to be filled before
    // the three dropdowns can name them. Reads only; the engine status line is deliberately NOT
    // asked for here (see renderSettings).
    await refreshCustomRegistry();
    // 0.3.5 §3.2: build the per-column ▼ glyphs first (they are static markup-level), then
    // apply the stored fold state so the first paint already has the right columns hidden —
    // applying it after a render would flash the full width table on every load.
    buildColToggles();
    wireColMenu();
    await loadColPrefs();
    applyColPrefs();
    syncDetectControls();
    fillSettingsForm();
    resetReport();
    drawDetectBoard();
    setPauseLabel();
    // Static (26 names + 2 families + 未识别): built once, not per refresh.
    fillOpeningFilter();
    var list = await G.loadArchives();
    archives = list;
    fillCategoryFilter();
    // 0.3.3: the learned parameter set is read once here and reused by every analysis this
    // page runs, so the detect tab and the sample editor can never disagree about it.
    curLearned = await G.loadLearnedParams();
    // 0.5.6 补增 §三 — `fillSettingsForm()` above ran before this line, so every weight box that
    // is NOT pinned was painted from the compiled defaults; the learner's table arrives only now.
    // Without this second pass the panel shows numbers the detector is not using, which is the one
    // thing it is not allowed to do.
    fillSignalWeightsForm();
    samples = await G.loadSamples();
    fillSampleTagFilter();
    renderLearnStatus();
    setStatus(T('viewer|就绪 · 存档 {a} 局 · 样本 {s} 个', { a: list.length, s: samples.length }));
    // 0.4.0 §一.4 — the settings page's version/update controls, and whatever the last check
    // left in storage. This never triggers a check of its own; only the worker and the
    // 「检测更新」 button do that.
    fillVersionRow();
    refreshUpdateBanner();
    // 0.5.3 §1.3 — the one-shot companion to the banner above (see notifyUpdateOnce).
    notifyUpdateOnce();
    // 0.4.3 §1.3: the four tables' segment legends are static markup in viewer.html but their
    // text lives in the dictionary, so they are filled once here — a later language switch goes
    // through `repaintForLang`.
    renderSegLegends();
    // 1.0.0 §1.2/§3.4 — last, deliberately: the account state has to be settled (including a
    // boot-time renewal that may log us out) before any account-aware control is drawn, and it is
    // the only step here that can open a dialog.
    await cloudBoot();
  })();
})();
