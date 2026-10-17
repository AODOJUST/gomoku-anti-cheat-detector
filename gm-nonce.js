// 白身 (Baishen) — per-install channel key DELIVERY (isolated world, document_start).
//
// Why this file exists (1.0.5, audit P1「MAIN world 的事件通道没有防伪造能力」):
//
// hook.js runs in the page's own MAIN world, so everything it sends to the isolated world travels
// over a `CustomEvent` on `window` — a channel ANY script on the page can write to as well.
// `validateGmEvent()` in content.js only checks the SHAPE of a frame (kind in a list, moves is an
// array, count === length, clock within 5s), so a statistics tag, an ad frame, a CDN shim or an
// injected script could dispatch a well-shaped `__gm_event` and have it merged into the captured
// record as if the socket had sent it. For a detector that is a trust problem and not a cosmetic
// one: the record that feeds the risk score could be written by the page being audited.
//
// The fix is a keyed MAC, and the whole design turns on ONE fact about content scripts:
// **at `document_start` this file runs before a single line of the page's own JavaScript.** That
// is the only window in which the extension can hand something to the MAIN world without the page
// overhearing it. So the key travels by DOM attribute exactly once:
//
//   1. this file publishes the key into `data-gm-c` on <html>, and removes it again on a timer as
//      a backstop (hook.js removes it sooner — see step 2);
//   2. hook.js reads that attribute ONCE and erases it in the same breath, keeping the value in a
//      closure. It signs nothing before it has the key;
//   3. every frame hook.js sends carries a monotonically increasing sequence number and a
//      HMAC-SHA256 tag over `'gm1:' + n + ':' + <event name> + ':' + <frame json>`, so a frame
//      that a page script merely *observes* on the wire cannot be replayed either;
//   4. content.js reads the SAME key from `chrome.storage.local` — it is an isolated context, so
//      it never needed the DOM for this — and verifies before parsing a single field.
//
// What this is NOT: a cryptographic boundary against a hostile page in general. The socket tap
// lives inside the page; a page that wants to lie can still patch `document.querySelector`, refuse
// to render stones, or hand us a fabricated socket. What is bought here is narrower and exact —
// **the page cannot craft a frame the recorder accepts**, so an accepted frame can only come from
// the code path that read the socket. Provenance, not truth.
//
// Degradation is deliberate and announced, never silent. If the key is missing on either side (a
// harness that loads only part of the extension, an exotic build without WebCrypto), frames travel
// unsigned and content.js falls back to shape-only validation with a console warning. A detector
// that silently stops recording is a worse failure than one that is forgeable, and this extension
// has eaten that trade before.
(function () {
  // `ATTR` and `TAG` are mirrored literals in hook.js — no shared file can exist across the two
  // worlds (a content script in one world cannot read the other's globals), so verify-067 pins the
  // two pairs of literals equal instead. The MAC tag is versioned so a future format change can be
  // rejected by an old verifier rather than silently mis-parsed.
  var ATTR = 'data-gm-c';
  var TAG = 'gm1';
  var SLOT = '__gmChanKey';   // chrome.storage.local slot — per install, not per page
  var TTL_MS = 10000;         // backstop delete: never leave the key readable for long
  var KEY_RE = /^[0-9a-f]{64}$/;

  function hex(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  // <html> is not guaranteed to exist at document_start on every engine; publishing late is
  // survivable because hook.js reads the attribute lazily at its first send (a socket attach is
  // hundreds of milliseconds away), but publishing NEVER is not — so retry a bounded number of
  // times rather than dropping the key on the floor.
  function publish(key, tries) {
    var el = null;
    try { el = document.documentElement; } catch (e) { /* detached document */ }
    if (!el) {
      if (tries > 0) setTimeout(function () { publish(key, tries - 1); }, 5);
      return;
    }
    try {
      el.setAttribute(ATTR, key);
      // Backstop only. hook.js removes the attribute as it reads it, which normally happens
      // before this timer ever fires; this covers the case where hook.js never loaded at all
      // (site with watchSocket:false, a page that never creates a socket, a rejected injection).
      setTimeout(function () {
        try {
          if (el.getAttribute(ATTR) === key) el.removeAttribute(ATTR);
        } catch (e) { /* detached */ }
      }, TTL_MS);
    } catch (e) { /* non-standard element: the key simply never arrives, and both sides degrade */ }
  }

  var area = null;
  try {
    if (chrome && chrome.storage && chrome.storage.local) area = chrome.storage.local;
  } catch (e) { /* no extension storage (a stripped harness): no key, shape-only on both sides */ }
  if (!area || !area.get) return;

  try {
    area.get(SLOT, function (o) {
      var key = o && typeof o[SLOT] === 'string' ? o[SLOT] : '';
      if (!KEY_RE.test(key)) {
        try {
          key = hex(crypto.getRandomValues(new Uint8Array(32)));
        } catch (e) {
          return;   // no CSPRNG: no key, both sides degrade to shape-only
        }
        var w = {};
        w[SLOT] = key;
        try { area.set(w); } catch (e) { /* quota: the key is still published, content.js will
                                             simply not find it and degrade — same as no key */ }
      }
      publish(key, 200);
    });
  } catch (e) { /* storage threw (rare, e.g. a locked profile): degrade rather than break */ }
})();
