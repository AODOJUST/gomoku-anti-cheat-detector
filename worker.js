// Engine bridge worker. Loads the Rapfi WASM build (compiled from dhbloo/gomoku-calculator)
// and bridges postMessage <-> engine stdin/stdout. Protocol mirrors src/ai/engine-warpper.worker.js.
//
// 0.2.5: this worker now also hosts the MULTI-THREADED builds (rapfi-multi[-simd128]).
// Two things had to change for that to work:
//   1. `WebAssembly.Memory` must be `shared: true`, otherwise the pthread build refuses to
//      start (it hands the memory to its own workers via postMessage).
//   2. `mainScriptUrlOrBlob` must be set to the engine script URL. The pthread build spawns
//      its threads with `new Worker(mainScriptUrlOrBlob || _scriptName, {name:'em-pthread'})`,
//      and inside a worker `_scriptName` resolves to `self.location.href` — which here is
//      *this* bridge file, not the engine. Without the override every spawned thread would
//      re-import the bridge and the engine would hang on the first search.
var EngineInstance = null;

function locateFile(url, engineDirURL) {
  // The multi and single builds ask for differently-named data packages
  // (rapfi-multi-simd128.data / rapfi-single.data); all of them ship as one rapfi.data.
  if (/^rapfi.*\.data$/.test(url)) url = 'rapfi.data';
  return engineDirURL + url;
}

// A shared memory can only be created when the page is cross-origin isolated.
// Extension pages are, but a defence-in-depth probe costs nothing and lets us report a
// clean "downgraded to single-thread" instead of an opaque instantiation error.
function sharedMemoryUsable() {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  try {
    var probe = new WebAssembly.Memory({ initial: 1024, maximum: 32768, shared: true });
    probe.grow(1);
    return true;
  } catch (e) {
    return false;
  }
}

function makeMemory(isShared) {
  if (!isShared) return new WebAssembly.Memory({ initial: 1024, maximum: 32768, shared: false });
  // 2048MB is the upstream default but not every machine can reserve that much contiguous
  // address space; halve until the browser accepts it (upstream does the same).
  var max = 32768;
  while (max > 8192) {
    try {
      var m = new WebAssembly.Memory({ initial: 1024, maximum: max, shared: true });
      m.grow(1);
      return m;
    } catch (e) { max /= 2; }
  }
  return new WebAssembly.Memory({ initial: 1024, maximum: max, shared: true });
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type === 'command') {
    if (EngineInstance) EngineInstance.sendCommand(msg.data);
    return;
  }
  if (msg.type === 'engineScriptURL') {
    var data = msg.data || {};
    var engineURL = data.engineURL;
    var engineDirURL = engineURL.substring(0, engineURL.lastIndexOf('/') + 1);
    var isMulti = /-multi/.test(engineURL);
    if (isMulti && (data.threads === false || !sharedMemoryUsable())) {
      self.postMessage({
        type: 'error',
        data: 'multi-threaded build unusable here (SharedArrayBuffer/crossOriginIsolated unavailable)',
        reason: 'no-threads',
      });
      return;
    }
    try {
      self.importScripts(engineURL);
    } catch (err) {
      self.postMessage({ type: 'error', data: 'importScripts failed: ' + err });
      return;
    }
    if (typeof self['Rapfi'] !== 'function') {
      self.postMessage({ type: 'error', data: 'engine build did not define Rapfi()' });
      return;
    }
    self['Rapfi']({
      locateFile: function (url) { return locateFile(url, engineDirURL); },
      mainScriptUrlOrBlob: engineURL,
      onReceiveStdout: function (o) { self.postMessage({ type: 'stdout', data: o }); },
      onReceiveStderr: function (o) { self.postMessage({ type: 'stderr', data: o }); },
      onExit: function (c) { self.postMessage({ type: 'exit', data: c }); },
      setStatus: function (s) { self.postMessage({ type: 'status', data: s }); },
      wasmMemory: makeMemory(isMulti),
    }).then(function (inst) {
      EngineInstance = inst;
      self.postMessage({ type: 'ready', threads: isMulti, data: engineURL });
    }).catch(function (err) {
      self.postMessage({ type: 'error', data: 'engine init failed: ' + err, reason: isMulti ? 'multi-failed' : null });
    });
  }
};
