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

  // 黑 / 白 as a one-character side label, and 黑方 / 白方 as the two-character form used in
  // headings and detail rows. Both pairs recur a dozen times; one function each beats twelve
  // keys that could drift apart.
  function sideTag(side) { return side === 'B' ? T('viewer|黑') : T('viewer|白'); }
  function sideName(side) { return side === 'B' ? T('viewer|黑方') : T('viewer|白方'); }
  // 被怀疑方 is three-valued and the same ternary was spelled out four times.
  function suspectName(v) {
    return v === 'B' ? T('viewer|黑方') : (v === 'W' ? T('viewer|白方') : T('viewer|双方'));
  }
  // 0.4.1 §三.4: a record's trustworthiness in one word — see content.js's toRecord() for how
  // it is derived. Only 0.4.1+ records carry it, so everything older falls back to the same
  // verdict computed from the fields it does have; that also keeps the list badge and the
  // detail row from disagreeing about a game. Kept in step with viewer's other mirrors of
  // app-side rules: `quality` is display-only, nothing here feeds a score.
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
  // because they are the same 15 columns in the same order and a per-table setting would mean
  // four places to keep in sync for no benefit.
  //
  // Default: the seven columns that describe a hand (方 / 实际 / T1 / T3 / T5 / 标记 / 人工标记)
  // stay; the engine's working (最佳 / 前5候选 / 胜率差 / 妙手 / 将败 / 被迫防守 / 耗时ms) folds
  // away. `#` is fixed — it is the row's identity, not a column to read, and hiding it would
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
      { key: 'cands',     label: T('viewer|前5候选'),    hide: true  },
      { key: 'top1',      label: 'T1',         hide: false },
      { key: 'top3',      label: 'T3',         hide: false },
      { key: 'top5',      label: 'T5',         hide: false },
      { key: 'loss',      label: T('viewer|胜率差'),     hide: true  },
      { key: 'sharp',     label: T('viewer|妙手'),       hide: true  },
      { key: 'desperate', label: T('viewer|将败'),       hide: true  },
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
  // menu is the way back, and it is the only place that lists all fifteen at once.
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
  function showView(name) {
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
    if (name === 'settings') renderSettings();
  }
  document.querySelectorAll('.navbtn').forEach(function (b) {
    b.onclick = function () { showView(b.dataset.view); };
  });

  // ---- 0.3.6 §1.8: repaint on a language switch, without a reload ----
  // Three groups have to be redrawn: the static markup the implicit pass tagged, the detect
  // pane (always in the DOM), and whichever list or report the active view owns. The
  // `<select>` in 设置 is refilled by fillSettingsForm, so the switch itself stays visible.
  function repaintForLang() {
    GMI18n.apply(document);
    fillLangSelect();
    fillThreadSelect();
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
    // 0.4.1 §五.3: the fifteen step columns are a JS-built table of contents, so the static
    // pass above cannot reach them. `buildColToggles` re-stamps the fold glyphs' titles and
    // `renderColMenu` rebuilds the ▾ menu from scratch — between them the whole column UI
    // follows the language, which it did not before (the menu kept the load-time language).
    buildColToggles();
    renderColMenu();
    // A finished report is re-rendered rather than cleared: switching language mid-review must
    // not cost the operator the analysis they were reading.
    if (report) renderReport(); else resetReport();
    var active = document.querySelector('.navbtn.active');
    showView(active ? active.dataset.view : 'detect');
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
    $('setAuto').checked = !!S.autoAnalyze;      // a checkbox has no half-edited state
  }

  // ---- 0.3.6 §1.2: the language dropdown ----
  // Built from GMI18n.LOCALES instead of being written into viewer.html, so a ninth language
  // costs one entry in i18n.js plus one table and cannot leave this list behind. The labels
  // are endonyms (locale/*.js), so the list reads the same under every UI language.
  function fillLangSelect() {
    var sel = $('setLang');
    if (!sel) return;
    var html = '<option value="auto">' + esc(T('set|跟随浏览器')) + '</option>';
    GMI18n.LOCALES.forEach(function (code) {
      html += '<option value="' + code + '">' + esc(T('lang.' + code)) + '</option>';
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

  async function renderSettings() {
    fillSettingsForm();
    fillVersionRow();
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
      '<span class="blk" data-upd="open">' + esc(T('update.view')) + '</span>' +
      '<span class="blk" data-upd="dismiss">' + esc(T('update.dismiss')) + '</span>';
    el.classList.remove('hidden');
  }

  // The automatic path: honours the 7-day「暂不更新」. The manual button deliberately does
  // not — asking for the check is itself a decision to be told the answer.
  function refreshUpdateBanner() {
    return G.pendingUpdate().then(
      function (info) { renderUpdateBanner(info); },
      function () { renderUpdateBanner(null); });
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
      if (what === 'open') openUpdatePage();
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
  function bindSetting(el, key, read) {
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
  // A language change is written like any other setting; the repaint comes from the
  // storage.onChanged broadcast (§1.8), which is also what keeps the toolbar menu's checkmark
  // and this dropdown from disagreeing when the change was made on the other entry point.
  bindSetting($('setLang'), 'lang', function (e) { return e.value; });

  $('setClearArchives').onclick = async function () {
    var list = await G.loadArchives();
    if (!list.length) { alert(T('viewer|没有存档。')); return; }
    if (!confirm(T('viewer|将删除全部 {n} 条存档（设置不受影响），确定吗？', { n: list.length }))) return;
    for (var i = 0; i < list.length; i++) await G.deleteArchive(list[i].id);
    await renderSettings();
    setStatus(T('viewer|存档已清空'));
  };

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
  var pauseCtrl = { paused: false, _resume: null };
  var detectMode = 'global';
  var stepQueue = [];
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
    if (!pauseCtrl.paused && pauseCtrl._resume) { var r = pauseCtrl._resume; pauseCtrl._resume = null; r(); }
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
      var eng = await getEngine();
      var thinkMs = parseInt($('aiThinkMs').value, 10) || 2000;
      eng.configure({ rule: parseInt($('rule').value, 10), thinkMs: thinkMs, threadNum: S.threadNum });
      var prefix = draftMoves.map(function (m) { return m.c; });
      var nbest = clamp(parseInt($('aiNbest').value, 10) || 1, 1, 32);
      var res = await eng.analyzePosition(prefix, nbest);
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
    try {
      report = await analyzeGame(rec, {
        rule: parseInt($('rule').value, 10),
        thinkMs: parseInt($('thinkMs').value, 10),
        openingCutoff: parseInt($('openCut').value, 10),
        suspect: $('suspect').value,
        threadNum: S.threadNum,
        pauseCtrl: pauseCtrl,
        // 0.3.3 §3.5: hand the learned parameters in explicitly rather than letting
        // analyzeGame re-read them, so the run and the incremental recompute above cannot
        // drift apart mid-analysis.
        learned: curLearned,
      }, setProgress);
      renderReport();
      await archiveCurrent('global');
    } catch (e) {
      alert(T('viewer|分析出错: {err}', { err: TE(e.message) }));
      setStatus(T('viewer|引擎错误: {err}', { err: TE(e.message) }));
    } finally {
      $('run').disabled = false; engineBusy = false; setPauseLabel();
    }
  };

  // 存档：detect tab analyses are archived too, so the replay list is the single
  // history for both the page panel and this page.
  async function archiveCurrent(mode) {
    if (!report) return null;
    // A null aggregate is a legitimate outcome (nothing survived the filters), not a
    // reason to throw the game away — the record and the per-move verdicts are still
    // worth replaying. Only a report with no verdicts at all is refused.
    if (!anyAggregate(report) && !(report.steps || []).length) return null;
    var rec = currentRecord();
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
    await archiveCurrent(detectMode === 'stepwise' ? 'stepwise' : 'global');
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
    try {
      var eng = await getEngine();
      eng.configure({ rule: parseInt($('rule').value, 10), threadNum: S.threadNum });
      while (stepQueue.length) {
        if (pauseCtrl.paused) await new Promise(function (r) { pauseCtrl._resume = r; });
        var task = stepQueue.shift();
        eng.send('INFO TIMEOUT_TURN ' + task.thinkMs);
        setStatus(T('viewer|逐步检测中… 队列剩余 {n}（本手 {ms}ms）', { n: stepQueue.length + 1, ms: task.thinkMs }));
        var step = await analyzeStep(eng, task.prefixMoves, task.playerIdx, task.actual, {
          openingCutoff: parseInt($('openCut').value, 10),
        }, task.thinkMs, null, null, task.board);
        if (!report) report = { steps: [], hasTime: false, suspect: $('suspect').value, totalMoves: 0, opts: {}, black: null, white: null, forcedCount: 0 };
        report.steps.push(step);
        report.totalMoves = report.steps.length;
        renderReportIncremental();
      }
      if (report) await archiveCurrent('stepwise');
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
        (s.isSharp ? ' · ' + T('viewer|唯一手') : '') + (s.desperate ? ' · ' + T('viewer|将败') : '')
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
  function stepCellsHtml(s) {
    var badges = [];
    if (s.source === 'prejoin') badges.push('<span class="badge b-pre">' + T('viewer|还原') + '</span>');
    if (s.isOpening) badges.push('<span class="badge">' + T('viewer|开局') + '</span>');
    if (s.source === 'ai-suggest') badges.push('<span class="badge b-ai">' + T('viewer|AI参考') + '</span>');
    if (s.isSharp) badges.push('<span class="badge b-sharp">' + T('viewer|唯一手') + '</span>');
    if (s.desperate) badges.push('<span class="badge b-desp">' + T('viewer|将败') + '</span>');
    if (s.forcedDefense) badges.push('<span class="badge" style="background:#888;color:#fff">' + T('viewer|豁免') + '</span>');
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
      '<td>' + (s.loss != null ? (s.loss * 100).toFixed(1) + '%' : '—') + '</td>' +
      '<td>' + (s.isSharp ? T('viewer|是') : '') + '</td><td>' + (s.desperate ? T('viewer|是') : '') + '</td>' +
      '<td>' + (s.forcedDefense ? '✓' : '') + '</td>' +
      '<td>' + (s.thinkMs != null ? s.thinkMs : '—') + '</td>' +
      '<td>' + badges.join(' ') + '</td>';
  }

  function rowHtml(s, idx) {
    return '<td>' + (s.moveNo == null ? '—' : s.moveNo) + '</td>' +
      stepCellsHtml(s) +
      '<td class="ma" data-i="' + (idx == null ? '' : idx) + '">' + maCell(s.manualAI) + '</td>';
  }

  // 0.3.5 §2.4: every step table colours the WHOLE row by the side that played it, so a hand
  // can be followed across all fifteen columns. The class goes on the <tr>; the badges and
  // annotation buttons inside keep their own colours (see viewer.html). All four step tables
  // share this one helper so a new table can never be added without it.
  function markSide(tr, s) {
    if (s && (s.side === 'B' || s.side === 'W')) tr.classList.add('side-' + s.side);
    return tr;
  }

  function appendRow(s, idx) {
    var tb = document.querySelector('#tbl tbody');
    var tr = document.createElement('tr');
    if (isFlagged(s)) tr.classList.add('flagged');
    markSide(tr, s);
    tr.innerHTML = rowHtml(s, idx);
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
  function simCount(a) { return a ? T('viewer|{n} 步', { n: a.simCount || 0 }) : '—'; }

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
      '<tr><td>' + T('viewer|Top5 之外') + '</td><td>' + (rep.black ? pct(rep.black.outTop5) : '—') + '</td><td>' + (rep.white ? pct(rep.white.outTop5) : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|将败冲四') + '</td><td>' + desCount(rep.black) + '</td><td>' + desCount(rep.white) + '</td></tr>' +
      (opts.sim ? ('<tr><td>' + T('viewer|AI 指纹命中') + '</td><td>' + simCount(rep.black) + '</td><td>' + simCount(rep.white) + '</td></tr>') : '') +
      '<tr><td>' + T('viewer|时间模式') + '</td><td colspan="2">' + (rep.hasTime ? T('viewer|真实间隔') : T('viewer|固定预算')) + '</td></tr>' +
      '<tr><td>' + T('viewer|冲四豁免') + '</td><td colspan="2">' + T('viewer|{n} 手', { n: rep.forcedCount || 0 }) + '</td></tr>' +
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
  function renderReportIncremental() {
    // 0.3.3: recompute with the SAME learned parameters analyzeGame used, or the incremental
    // numbers would disagree with the final ones the moment a learned model is in play.
    report.black = sideAggregate(report.steps, 'B', report.hasTime, curLearned);
    report.white = sideAggregate(report.steps, 'W', report.hasTime, curLearned);
    renderScoreCards();
    appendRow(report.steps[report.steps.length - 1]);
    curStep = draftMoves.length;
    renderBoardView();
  }
  function renderAllSteps() {
    renderScoreCards();
    var sm = report.black, sw = report.white;
    $('summary').innerHTML = '<table style="text-align:left">' +
      '<tr><th>' + T('viewer|指标') + '</th><th>' + T('viewer|黑方') + '</th><th>' + T('viewer|白方') + '</th></tr>' +
      '<tr><td>' + T('viewer|Top-1 吻合') + '</td><td>' + (sm ? pct(sm.top1) : '—') + '</td><td>' + (sw ? pct(sw.top1) : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|Top-3') + '</td><td>' + (sm ? pct(sm.top3) : '—') + '</td><td>' + (sw ? pct(sw.top3) : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|Top-5') + '</td><td>' + (sm ? pct(sm.top5) : '—') + '</td><td>' + (sw ? pct(sw.top5) : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|ACPL') + '</td><td>' + (sm ? (sm.meanLoss * 100).toFixed(1) + '%' : '—') + '</td><td>' + (sw ? (sw.meanLoss * 100).toFixed(1) + '%' : '—') + '</td></tr>' +
      '<tr><td>' + T('viewer|将败冲四') + '</td><td>' + desCount(sm) + '</td><td>' + desCount(sw) + '</td></tr>' +
      '<tr><td>' + T('viewer|被迫防守豁免') + '</td><td colspan="2">' + T('viewer|{n} 手', { n: report.forcedCount || 0 }) + '</td></tr>' +
      '</table>';
    document.querySelector('#tbl tbody').innerHTML = '';
    report.steps.forEach(function (s, i) { appendRow(s, i); });
  }

  $('expJson').onclick = function () { if (report) download('report.json', JSON.stringify(report, null, 2), 'application/json'); };
  $('expCsv').onclick = function () {
    if (!report) return;
    var csv = 'move,side,actual,best,top1,top3,top5,loss,sharp,desperate,thinkMs,manualAI\n';
    report.steps.forEach(function (s) {
      csv += [s.moveNo, s.side, s.actualStr, s.bestStr, s.top1, s.top3, s.top5,
              s.loss == null ? '' : s.loss, s.isSharp, s.desperate, s.thinkMs == null ? '' : s.thinkMs,
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
  var MIN_COL_W = 300;   // min column width before another column fits
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
    return cols;
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
  function displayName(a) {
    var p = a.players || {};
    if (a.name !== G.defaultArchiveName(a)) return a.name;
    if (p.black || p.white) return (p.black || '?') + ' VS ' + (p.white || '?');
    if (p.self || p.opponent) return (p.self || '?') + ' VS ' + (p.opponent || '?');
    return T('viewer|未命名对局');
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
      var isDefault = a.name === G.defaultArchiveName(a);
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
                 // so the name comes back from openings.js.
                 (a.opening ? ' · ' + GMOpening.label(a.opening) : '') +
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
  var maskEl = null;
  function openModal(title, bodyHtml, onMount) {
    closeModal();
    maskEl = document.createElement('div');
    maskEl.className = 'mask';
    maskEl.innerHTML = '<div class="modal"><h3>' + esc(title) + '</h3>' +
      '<div class="bd"></div><div class="ft"><button class="sec" data-close="1">' + T('viewer|关闭') + '</button></div></div>';
    maskEl.querySelector('.bd').innerHTML = bodyHtml;
    maskEl.querySelector('[data-close]').onclick = closeModal;
    maskEl.addEventListener('click', function (e) { if (e.target === maskEl) closeModal(); });
    document.body.appendChild(maskEl);
    if (onMount) onMount(maskEl.querySelector('.bd'));
  }
  function closeModal() {
    if (maskEl && maskEl.parentNode) maskEl.parentNode.removeChild(maskEl);
    maskEl = null;
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
    dStep = a.report ? (a.report.steps || []).length : 0;
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
      return '<div style="margin-bottom:6px"><b>' + sideName(x.side) + '</b> ' +
        Object.keys(c).map(function (k) { return k + ' ' + c[k].toFixed(1); }).join(' · ') +
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
    var facts = [
      [T('viewer|总手数'), T('viewer|{n} 手', { n: a.totalMoves || 0 })],
      [T('viewer|计入手数'), T('viewer|{n} 手', { n: scored })],
      [T('viewer|人工标记'), T('viewer|{n} 手（人工）',
        { n: (rep.steps || []).filter(function (s) { return s.manualAI; }).length })],
      [T('viewer|盘面还原'), T('viewer|{n} 手', { n: unordered }) +
        (unordered ? T('viewer|（手序未知，不计分）') : '')],
      [T('viewer|开局'), opLabel || T('viewer|未识别')],
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
      [T('viewer|分析引擎'), rep.engine
        ? (rep.engine.degraded
            ? T('viewer|单线程（降级：{reason}）', { reason: rep.engine.reason || T('viewer|环境不支持多线程') })
            : T('viewer|多线程 {n} 线程', { n: rep.engine.threadNum || '?' }))
        : T('viewer|未记录')],
      // 0.3.3 §3.5: which parameter set produced the risk numbers above. A learned run and a
      // default run give different scores for the same game, so without this row two
      // archives cannot be compared at all.
      [T('viewer|学习参数'), rep.learned
        ? T('viewer|已学习（{t} · 样本 {n} · 特征库 {f}）',
            { t: G.beijingTime(rep.learned.trainedAt), n: rep.learned.sampleCount, f: rep.learned.featureCount })
        : T('viewer|0.3.1 默认')],
      [T('viewer|玩家名来源'), {
        socket: T('viewer|socket 事件'), dom: T('viewer|页面 DOM'),
        none: T('viewer|未取到（命名已降级）'),
      }[recMeta.nameSource]
        || '—'],
      [T('viewer|数据来源'), srcLabel || recMeta.source || '—'],
    ];
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
    $('dSlider').max = steps.length;
    $('dSlider').value = dStep;
    $('dJump').value = dStep;
    var tb = document.querySelector('#dTbl tbody');
    tb.innerHTML = '';
    steps.forEach(function (s, i) {
      var tr = document.createElement('tr');
      if (isFlagged(s)) tr.classList.add('flagged');
      markSide(tr, s);
      tr.innerHTML = rowHtml(s, i);
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
        (s.isSharp ? ' · ' + T('viewer|唯一手') : '') + (s.desperate ? ' · ' + T('viewer|将败') : '') +
        (s.forcedDefense ? ' · ' + T('viewer|冲四豁免') : '') +
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
  $('dNext').onclick = function () { dStep = Math.min((curArchive && curArchive.report ? curArchive.report.steps.length : 0), dStep + 1); renderDetailBoard(); };
  $('dStart').onclick = function () { dStep = 0; renderDetailBoard(); };
  $('dEnd').onclick = function () { dStep = (curArchive && curArchive.report ? curArchive.report.steps.length : 0); renderDetailBoard(); };
  $('dJump').onchange = function () {
    var max = (curArchive && curArchive.report ? curArchive.report.steps.length : 0);
    dStep = clamp(parseInt($('dJump').value, 10) || 0, 0, max);
    renderDetailBoard();
  };

  $('dExpJson').onclick = function () { if (curArchive) exportArchiveJson(curArchive); };
  $('dExpCsv').onclick = function () {
    if (!curArchive || !curArchive.report) return;
    var csv = 'move,side,actual,best,top1,top3,top5,loss,sharp,desperate,thinkMs,badges,manualAI\n';
    (curArchive.report.steps || []).forEach(function (s) {
      csv += [s.moveNo, s.side, s.actualStr, s.bestStr, s.top1, s.top3, s.top5,
              s.loss == null ? '' : s.loss, s.isSharp, s.desperate, s.thinkMs == null ? '' : s.thinkMs,
              [s.isSharp ? '唯一手' : '', s.desperate ? '将败' : '', s.forcedDefense ? '豁免' : '',
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
    sStep = (s.report && s.report.steps ? s.report.steps.length : 0);
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

  function sRowHtml(s, idx, sample) {
    var noteMark = (G.annotationsOf(sample)[s.moveNo] || {}).note ? ' <span style="color:var(--yellow)">✎</span>' : '';
    return '<td class="sno" data-i="' + (idx == null ? '' : idx) + '" title="' + T('viewer|点开填写单步备注') + '" ' +
        'style="cursor:pointer">' + (s.moveNo == null ? '—' : s.moveNo) + noteMark + '</td>' +
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
    $('sSlider').max = steps.length;
    $('sSlider').value = sStep;
    $('sJump').value = sStep;
    var tb = document.querySelector('#sTbl tbody');
    tb.innerHTML = '';
    steps.forEach(function (st, i) {
      var tr = document.createElement('tr');
      if (isFlagged(st)) tr.classList.add('flagged');
      markSide(tr, st);
      tr.innerHTML = sRowHtml(st, i, s);
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
         (st.isSharp ? ' · ' + T('viewer|唯一手') : '') + (st.desperate ? ' · ' + T('viewer|将败') : '') +
         (st.forcedDefense ? ' · ' + T('viewer|冲四豁免') : '') +
         (st.aiSimilar ? ' · ' + T('viewer|疑AI指纹') +
            (st.aiSim != null ? '(' + st.aiSim + ')' : '') : ''))
      : T('viewer|棋谱：{n} / {total} 子（拖滑块或点按钮逐步查看）', { n: stones.length, total: total });

    $('sBoardTip').textContent = T('viewer|紫虚线 = 与特征库 AI 步骤相似 · 橙圈 = 将败冲四 · 红圈 = 可疑 · 蓝虚线 = 引擎最佳。点步骤行的编号可填单步备注。');
  }

  $('sSlider').oninput = function (e) { sStep = +e.target.value; renderSampleBoard(); };
  $('sPrev').onclick = function () { sStep = Math.max(0, sStep - 1); renderSampleBoard(); };
  $('sNext').onclick = function () {
    var max = (curSample && curSample.report ? curSample.report.steps.length : 0);
    sStep = Math.min(max, sStep + 1); renderSampleBoard();
  };
  $('sStart').onclick = function () { sStep = 0; renderSampleBoard(); };
  $('sEnd').onclick = function () {
    sStep = (curSample && curSample.report ? curSample.report.steps.length : 0);
    renderSampleBoard();
  };
  $('sJump').onchange = function () {
    var max = (curSample && curSample.report ? curSample.report.steps.length : 0);
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

  function renderSeTable() {
    var tb = document.querySelector('#seTbl tbody');
    if (!tb) return;
    tb.innerHTML = '';
    var steps = (seReport && seReport.steps) || [];
    steps.forEach(function (st, i) {
      var tr = document.createElement('tr');
      if (isFlagged(st)) tr.classList.add('flagged');
      markSide(tr, st);
      tr.innerHTML = sRowHtml(st, i, editing);
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
    try {
      seReport = await analyzeGame(rec, {
        rule: parseInt($('seRule').value, 10),
        thinkMs: parseInt($('seThinkMs').value, 10),
        openingCutoff: parseInt($('seOpenCut').value, 10),
        suspect: $('seSuspect').value,
        threadNum: S.threadNum,
        learned: curLearned,
      }, setSeProgress);
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
      numTable(GMLearn.diffWeights(lp.before && lp.before.weights, lp.weights), 4) + '</div>';
    if (lp.aucs) {
      h += '<div class="lbox"><b>' + T('viewer|AUC 区分度') + '</b><div class="hint">' +
        GMLearn.BASE_KEYS.map(function (k) {
          return esc(paramLabel('learn.weight.' + k, GMLearn.WEIGHT_LABEL[k] || k)) + ' ' + lp.aucs[k].toFixed(3);
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
          // Our own write echoed back: S/syncDetectControls are enough. Re-filling the
          // whole form here would reach into whatever box the user moved on to.
          var self = (Date.now() - lastSelfWrite) < 1000;
          syncDetectControls();
          if (!self && $('view-settings').classList.contains('active')) fillSettingsForm();
        });
      }
      if (changes.archives) refreshArchives();
      // 0.3.3: a sample saved here (or 重新学习 run in another tab) has to reach this one,
      // or the library list and the detector's parameter set go stale in silence.
      if (changes.samples) refreshSamples();
      if (changes.learnedParams) {
        G.loadLearnedParams().then(function (lp) {
          curLearned = lp;
          if ($('view-samples').classList.contains('active')) renderLearnStatus();
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
  (function sizeBoards() {
    // 0.3.3 adds the sample detail + sample editor canvases; sizing them here rather than
    // lazily on first render keeps every board on the page at one scale from the start.
    ['board', 'dBoard', 'sBoard', 'seBoard'].forEach(function (id) {
      var cv = $(id);
      if (!cv) return;
      var px = Math.round(cv.width * 1.2 * BOARD_SHRINK);
      cv.width = px; cv.height = px;
      cv.style.width = px + 'px'; cv.style.height = px + 'px';
    });
  })();

  (async function boot() {
    S = await G.loadSettings();
    // 0.3.6 §1.5: the language is resolved BEFORE anything paints. The static pass has to run
    // while the document is still the pristine markup viewer.html shipped — a node the
    // renderers create later carries no `__gmKey`, and that is exactly what stops a language
    // switch from overwriting a player name with a stale static string.
    applyLang(S.lang);
    GMI18n.apply(document);
    fillLangSelect();
    fillThreadSelect();
    // 0.3.5 §3.2: build the per-column ▼ glyphs first (they are static markup-level), then
    // apply the stored fold state so the first paint already has the right columns hidden —
    // applying it after a render would flash the full fifteen-column table on every load.
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
    samples = await G.loadSamples();
    fillSampleTagFilter();
    renderLearnStatus();
    setStatus(T('viewer|就绪 · 存档 {a} 局 · 样本 {s} 个', { a: list.length, s: samples.length }));
    // 0.4.0 §一.4 — the settings page's version/update controls, and whatever the last check
    // left in storage. This never triggers a check of its own; only the worker and the
    // 「检测更新」 button do that.
    fillVersionRow();
    refreshUpdateBanner();
  })();
})();
