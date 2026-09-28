// Offscreen document: the only place the Rapfi engine may legally run.
//
// app.js is loaded here as a plain script, so `Engine` / `analyzeGame` /
// `analyzeStepwise` / `analyzeStep` are globals of this document. `Engine.init()`
// does `new Worker('worker.js')`, which resolves to chrome-extension://<id>/worker.js —
// same origin as this page, so it works.
//
// Protocol (all via chrome.runtime, content.js is the peer):
//   gm-warmup           -> preload the engine so the first live step is not delayed
//   gm-engine-info      -> which build loaded, whether multi-threading is live
//   gm-analyze          -> 全局分析, one analyzeGame call
//   gm-analyze-stepwise -> 逐步分析（导入回放）, one analyzeStepwise call
//   gm-step             -> 逐步分析（实时）, one analyzeStep for one move
//   gm-step-report      -> full report for the live session
//   gm-step-finish      -> close the live session, return the full report
//   gm-abort            -> ask the running job to stop at the next move
// Broadcasts gm-progress { jobId, p, msg } while working.
//
// 0.2.5 — CONCURRENCY MODEL
// There is exactly ONE engine (one worker, one 40MB data package, one WASM instance), so
// all engine work is serialised through a single FIFO queue. What changed is the answer
// to "someone else is using it":
//
//   before: `if (busy) return { ok:false, error:'引擎正忙' }` — the second tab's analysis
//           was *rejected*, and a mid-join tab showed "引擎正忙" instead of "数据不完整",
//           which reads as a hang and explains the 0.2.5 bug report.
//   after:  the request is queued, runs when its turn comes, and a queued job is told so
//           through gm-progress ("引擎正忙，排队中…").
//
// Live sessions are keyed by jobId, so two tabs each get their own session and their own
// step history; only the underlying engine call is serialised. That is safe because
// analyzeStep re-sends the whole YXBOARD prefix for every move — no engine state carries
// over between steps. Serialising is not merely a courtesy here: analyzePosition/analyzeStep
// swap `worker.onmessage`, so two overlapping engine calls would interleave their output
// handlers and produce garbage verdicts.
'use strict';

(function () {
  // 0.3.6 §1.6/§1.7: this file TRANSPORTS messages, it never translates them. Every string it
  // returns to a consumer travels as a `__i18n:` code and is turned into text by whichever
  // surface shows it (content.js panel / viewer.js), because only that surface knows the
  // operator's language. Defined locally rather than borrowed from app.js so the two files
  // stay independently loadable.
  function i18nErr(key, vars) {
    if (typeof GMI18n !== 'undefined' && GMI18n && GMI18n.errCode) return GMI18n.errCode(key, vars);
    var s = '__i18n:' + key;
    if (vars) Object.keys(vars).forEach(function (k) { s += '|' + k + '=' + encodeURIComponent(vars[k]); });
    return s;
  }

  var queue = [];        // FIFO of { jobId, fn, ahead, resolve }
  var processing = false;
  var currentJobId = null;
  var sessions = {};     // jobId -> 实时逐步 session
  var aborted = {};

  // 0.3.6 §1.8: this document has no UI, but it does produce strings that reach one — the
  // default archive name, the 排队中 note, every error code. It therefore has to know the
  // operator's language too, and it has to keep knowing it: a switch mid-session must not
  // leave the rest of that session naming archives in the old language.
  function applyLang(setting) {
    if (typeof GMI18n === 'undefined' || !GMI18n) return;
    GMI18n.setLocale(GMI18n.resolveLang(setting));
  }
  try {
    GMStorage.loadSettings().then(function (s) { applyLang(s && s.lang); }, function () {});
  } catch (e) { /* storage unavailable — the zh-CN default stands */ }
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes || !changes.settings) return;
      applyLang(changes.settings.newValue && changes.settings.newValue.lang);
    });
  } catch (e) { /* no storage API in this context — nothing to track */ }

  function broadcast(type, payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: type }, payload));
    } catch (e) {
      // No receiver left (page closed) — harmless.
    }
  }

  function progressFn(jobId) {
    return function (p, msg) { broadcast('gm-progress', { jobId: jobId, p: p, msg: msg }); };
  }

  function engineSnapshot() {
    try { return engineInfo(); } catch (e) { return null; }
  }

  // ---------- the queue ----------
  function runQueued(jobId, fn) {
    return new Promise(function (resolve) {
      // Everything ahead of this request: the one currently on the engine plus the ones
      // still waiting. Counting only `queue.length` would report 0 for the second arrival,
      // because the first was already shifted into `processing` before it landed.
      var ahead = queue.length + (processing ? 1 : 0);
      queue.push({
        jobId: jobId,
        fn: fn,
        ahead: ahead,
        resolve: function (res) {
          // Tell the caller it had to wait, so the panel can drop the "排队中" note.
          if (res && typeof res === 'object' && ahead > 0 && !res.queuedAhead) res.queuedAhead = ahead;
          resolve(res);
        },
      });
      if (ahead > 0) {
        broadcast('gm-progress', {
          jobId: jobId, p: 0,
          msg: i18nErr('queue.busy', { ahead: ahead }),
        });
      }
      pumpQueue();
    });
  }

  function pumpQueue() {
    if (processing) return;
    var item = queue.shift();
    if (!item) return;
    processing = true;
    currentJobId = item.jobId;

    function next() { processing = false; currentJobId = null; pumpQueue(); }

    // A job aborted while it waited must not run at all.
    if (aborted[item.jobId]) {
      delete aborted[item.jobId];    // it never started, so no tombstone is needed
      item.resolve({ ok: false, aborted: true, error: i18nErr('job.abortedInQueue') });
      next();
      return;
    }

    Promise.resolve()
      .then(item.fn)
      .then(
        function (res) { item.resolve(res); },
        function (e) {
          var text = String((e && e.message) || e);
          item.resolve(text === '__aborted__' ? { ok: false, aborted: true } : { ok: false, error: text });
        }
      )
      .then(next, next);
  }

  // ---------- report slimming ----------
  // The engine returns a `bestline` (principal variation) per candidate: up to a few
  // dozen coordinates each, and nothing renders it. Dropping it here as well as in
  // storage.js keeps the message channel small — a 42-move game would otherwise ship
  // several hundred arrays per analysis just to have them thrown away.
  function trimStep(step) {
    if (!step) return step;
    step.cands = (step.cands || []).map(function (c) {
      return { move: c.move, winrate: c.winrate, eval: c.eval };
    });
    return step;
  }

  function trimReport(rep) {
    if (!rep) return rep;
    if (Array.isArray(rep.steps)) rep.steps = rep.steps.map(trimStep);
    // `flagged` is a filtered copy of `steps`, so shipping it would double the payload
    // for data the consumer can recompute in one line. Nothing reads it today.
    delete rep.flagged;
    return rep;
  }

  async function handleWarmup() {
    await getEngine();
    return { ok: true, engine: 'ready', info: engineSnapshot() };
  }

  function handleEngineInfo() {
    return { ok: true, info: engineSnapshot() };
  }

  async function runOneShot(msg, kind) {
    aborted[msg.jobId] = false;
    try {
      var opts = Object.assign({}, msg.opts, { shouldAbort: function () { return !!aborted[msg.jobId]; } });
      var fn = kind === 'global' ? analyzeGame : analyzeStepwise;
      var report = await fn(msg.record, opts, progressFn(msg.jobId));
      return { ok: true, report: trimReport(report), info: engineSnapshot() };
    } finally {
      delete aborted[msg.jobId];
    }
  }

  // ---- 实时逐步分析 ----
  async function doStep(msg) {
    if (msg.reset) {
      sessions[msg.jobId] = {
        jobId: msg.jobId, steps: [], times: [], opts: msg.opts, ended: false,
        prejoinCount: msg.prejoinCount || 0, seen: {},
      };
    }
    var live = sessions[msg.jobId];
    if (!live) {
      return { ok: false, error: i18nErr('live.goneMaybe') };
    }
    if (live.ended) return { ok: false, error: i18nErr('live.ended') };

    // One entry per PLAYED move. The collector can legitimately ask twice for the same
    // hand — a socket reconnect re-delivers it, or the board render confirms a stone we
    // already stepped — and a second engine run would append a second row with the same
    // move number, which reads as a broken move order in the step table.
    var key = msg.actual ? msg.actual[0] + ',' + msg.actual[1] : String(msg.playerIdx);
    if (live.seen[key] != null) {
      return { ok: true, step: live.steps[live.seen[key]], duplicate: true,
               summary: withPrejoin(summarizeSteps(live.steps, live.times, live.opts), live.prejoinCount) };
    }

    var eng = await getEngine();
    var allMoves = msg.prefix.concat([msg.actual]);
    var budget = stepBudget(msg.recorded, msg.opts).budget;
    // 0.3.4: the live-four test needs the real colours of the prefix, which index parity
    // cannot give (a duplicated or dropped stone shifts every later slot). The collector
    // sends them alongside `prefix`; when it does not, analyzeStep falls back to parity.
    var board = null;
    if (Array.isArray(msg.prefixSides) && msg.prefixSides.length === allMoves.length) {
      board = allMoves.map(function (c, k) {
        return { x: c[0], y: c[1], side: msg.prefixSides[k] };
      });
    }
    var step = await analyzeStep(eng, allMoves, msg.playerIdx, msg.actual, msg.opts, budget, msg.recorded, msg.side, board);

    // 0.3.4 活四停止: a real live four ends the live session so no further hand is scored —
    // the rest of the game carries no signal.
    if (step.terminal) live.ended = true;

    live.seen[key] = live.steps.length;
    live.steps.push(step);
    live.times.push(msg.recorded != null ? msg.recorded : null);
    markDesperate(live.steps);

    return {
      ok: true,
      step: trimStep(step),
      summary: withPrejoin(summarizeSteps(live.steps, live.times, live.opts), live.prejoinCount),
      info: engineSnapshot(),
    };
  }

  // Stones recovered from a board render (joining mid-game) are on the board and count
  // as moves, but they are never stepped, so they are absent from `steps`.
  function withPrejoin(rep, prejoinCount) {
    if (!rep) return rep;
    rep.prejoinCount = prejoinCount || 0;
    // Both buildReport and summarizeSteps report totalMoves as steps.length, which
    // counts verdicts, not stones on the board.
    rep.totalMoves = (rep.totalMoves || 0) + rep.prejoinCount;
    rep.orderKnown = rep.prejoinCount === 0;
    return rep;
  }

  function liveReport(jobId) {
    var live = sessions[jobId];
    if (!live) return null;
    return trimReport(withPrejoin(buildReport(live.steps, {
      moves: live.steps.map(function (s) { return s.actual; }),
      times: live.times,
      sources: live.steps.map(function () { return 'player'; }),
    }, live.opts), live.prejoinCount));
  }

  function handleStepReport(msg) {
    if (!sessions[msg.jobId]) return { ok: false, error: i18nErr('live.gone') };
    return { ok: true, report: liveReport(msg.jobId) };
  }

  function handleStepFinish(msg) {
    if (!sessions[msg.jobId]) return { ok: false, error: i18nErr('live.gone') };
    var report = liveReport(msg.jobId);
    delete sessions[msg.jobId];
    return { ok: true, report: report, info: engineSnapshot() };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('gm-') !== 0) return;
    if (msg.type === 'gm-ensure-offscreen') return; // background's job
    if (msg.type === 'gm-progress') return;

    var work;
    switch (msg.type) {
      case 'gm-warmup': work = handleWarmup(); break;
      case 'gm-engine-info': work = Promise.resolve(handleEngineInfo()); break;
      case 'gm-analyze':
        work = runQueued(msg.jobId, function () { return runOneShot(msg, 'global'); });
        break;
      case 'gm-analyze-stepwise':
        work = runQueued(msg.jobId, function () { return runOneShot(msg, 'stepwise'); });
        break;
      case 'gm-step':
        work = runQueued(msg.jobId, function () { return doStep(msg); });
        break;
      case 'gm-step-report': work = Promise.resolve(handleStepReport(msg)); break;
      case 'gm-step-finish': work = Promise.resolve(handleStepFinish(msg)); break;
      case 'gm-abort':
        aborted[msg.jobId] = true;
        // Drop it out of the queue immediately when it has not started yet: it would
        // otherwise keep its slot and run a doomed analysis.
        var wasPending = false;
        for (var i = queue.length - 1; i >= 0; i--) {
          if (queue[i].jobId === msg.jobId) {
            queue[i].resolve({ ok: false, aborted: true, error: i18nErr('job.aborted') });
            queue.splice(i, 1);
            wasPending = true;
          }
        }
        // Nothing owns the id any more -> do not leave a permanent tombstone behind.
        if (!wasPending && currentJobId !== msg.jobId) delete aborted[msg.jobId];
        work = Promise.resolve({ ok: true });
        break;
      default: return;
    }

    work
      .then(function (res) { sendResponse(res); })
      .catch(function (e) {
        var text = String((e && e.message) || e);
        sendResponse(text === '__aborted__' ? { ok: false, aborted: true } : { ok: false, error: text });
      });
    return true; // keep the channel open for the async reply
  });

  broadcast('gm-offscreen-ready', {});
})();
