/* toast.js — 0.5.3 §1.2, the bottom-right notification stack.
 *
 * A toast is the answer to "something happened, but it must not stop what I am doing". The
 * viewer's 「开始分析」 can take a minute, and 0.5.2's only way to report it was to write into the
 * status line at the top of the page — which the operator is not looking at, because they
 * scrolled to the step table. A modal would stop them; a status line they never see is not a
 * notification at all.
 *
 * ---------------------------------------------------------------------------
 * Two hosts, one implementation
 * ---------------------------------------------------------------------------
 * `attach(root)` takes a Document OR a ShadowRoot, because this file runs in both worlds:
 *
 *   viewer.js  -> GmToast.attach(document)
 *   content.js -> GmToast.attach(root)        // the panel's shadow root
 *
 * That is the whole reason it is a module rather than 30 lines in viewer.js. The overlay's
 * stylesheet lives inside its shadow root and the viewer's lives in <head>, so the CSS is
 * duplicated by necessity (there is no way to share a stylesheet across those two without a
 * constructed-stylesheet dance that MV3's CSP makes awkward) — but the BEHAVIOUR, which is what
 * a bug would live in, exists once. The §1.2.4 rules that can actually be wrong (cap of 5,
 * 3-second life, close on click and on right-click, newest on top) are all here.
 *
 * ---------------------------------------------------------------------------
 * Deliberately no i18n in this file
 * ---------------------------------------------------------------------------
 * `show()` takes an ALREADY-TRANSLATED string. Translating inside would mean this module has to
 * know which language is current, and the two hosts disagree about that: the viewer reads
 * `GMI18n` directly, the overlay has its own `T()`. The caller knows; this file does not need to.
 *
 * ---------------------------------------------------------------------------
 * Text goes in through textContent, never innerHTML
 * ---------------------------------------------------------------------------
 * `show()` is called with an error message (`T('toast|分析失败：{err}', {err: e.message})`), and
 * `e.message` is attacker-influenced in principle — a network error can echo a server-controlled
 * string. Building nodes rather than parsing HTML means there is nothing to escape and nothing
 * to forget to escape.
 */
var GmToast = (function () {
  'use strict';

  var MAX = 5;            // §1.2.1 — "堆叠：最多 5 个"
  var DEFAULT_MS = 3000;  // §1.2.1 — "每个持续 3 秒"
  var KINDS = ['info', 'success', 'warn', 'error'];

  var host = null;        // Document | ShadowRoot
  var box = null;         // the .toast-container, created on first use
  var live = [];          // toasts currently on screen, OLDEST FIRST

  /** Where new nodes go. Called once per host at boot. */
  function attach(root) {
    if (!root) return false;
    host = root;
    // A re-attach (a language switch rebuilds the overlay's shell) must not orphan the stack:
    // the container is re-created lazily against the NEW root, and anything still on screen is
    // dropped rather than left pointing at a detached tree.
    box = null;
    live = [];
    return true;
  }

  function doc() {
    if (!host) return null;
    return host.ownerDocument || host;
  }

  /** Where the container actually hangs. A Document accepts exactly ONE element child — appending
   *  the stack to it throws `HierarchyRequestError: Only one element on document allowed`, and
   *  because `attach()` runs at boot that exception takes the whole page down with it. A ShadowRoot
   *  has no such limit and is used directly.
   *
   *  The test is `nodeType === 9` OR "it can create elements": the second clause is what keeps the
   *  test suites' hand-built document honest, since their stub is a plain object rather than a real
   *  Document and would otherwise fall through to being appended to directly. */
  function mount() {
    if (!host) return null;
    if (host.nodeType === 9 || typeof host.createElement === 'function') {
      return host.body || host.documentElement || host;
    }
    return host;
  }

  function ensureBox() {
    if (box && box.isConnected !== false) return box;
    var d = doc();
    var m = mount();
    if (!host || !d || !m) return null;
    // Reuse an existing container if one is already in the tree — a second `attach()` without a
    // teardown must not leave two stacks on top of each other.
    var found = m.querySelector ? m.querySelector('.toast-container') : null;
    if (found) { box = found; return box; }
    box = d.createElement('div');
    box.className = 'toast-container';
    // `role="status"` + `aria-live="polite"`: a screen reader announces the text without
    // interrupting, which is the correct politeness for something that is also visible.
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    m.appendChild(box);
    return box;
  }

  function drop(el) {
    var i = live.indexOf(el);
    if (i >= 0) live.splice(i, 1);
    if (el._gmTimer) { clearTimeout(el._gmTimer); el._gmTimer = null; }
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  function close(el) { drop(el); }

  /**
   * §1.2.2. `opts` is optional: { link, linkText, duration }.
   * Returns the element, so a caller can close it early.
   */
  function show(msg, kind, opts) {
    var d = doc();
    var b = ensureBox();
    if (!d || !b) return null;
    var o = opts || {};
    var k = (KINDS.indexOf(kind) >= 0) ? kind : 'info';

    var el = d.createElement('div');
    el.className = 'toast ' + k;

    var text = d.createElement('div');
    text.className = 'tx';
    text.textContent = String(msg == null ? '' : msg);
    el.appendChild(text);

    // §1.3.2 — the update toast carries a link to the release page. It is a real <a> with
    // target=_blank, not a click handler on the toast: the operator can middle-click it, copy
    // the address, or open it in a new window, all of which a div with an onclick would take
    // away. `noopener` because the target is a third-party origin.
    if (o.link) {
      var a = d.createElement('a');
      a.className = 'lk';
      a.href = String(o.link);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = String(o.linkText || o.link);
      el.appendChild(a);
    }

    // §1.2.1 — closed by the button OR by right-click. `contextmenu` is the second gesture
    // because the close button is 16px in the corner of a 260px box and, over a live game
    // board, that is a small target to hit with a trackpad.
    var x = d.createElement('span');
    x.className = 'close';
    x.textContent = '\u00d7';
    x.title = 'close';
    x.addEventListener('click', function (ev) { ev.stopPropagation(); close(el); });
    el.appendChild(x);
    el.addEventListener('contextmenu', function (ev) { ev.preventDefault(); close(el); });

    // §1.2.1 — cap. The OLDEST goes, not the newest: the thing the operator has already had
    // three seconds to read is the one they are least likely to still need.
    while (live.length >= MAX) drop(live[0]);

    b.appendChild(el);
    live.push(el);

    var ms = (o.duration == null) ? DEFAULT_MS : Number(o.duration);
    if (!isFinite(ms) || ms <= 0) ms = DEFAULT_MS;
    el._gmTimer = setTimeout(function () { close(el); }, ms);
    return el;
  }

  /** Everything off screen — used by the suite, and by the overlay when its shell is rebuilt. */
  function clear() {
    while (live.length) drop(live[0]);
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
  }

  return {
    show: show,
    attach: attach,
    clear: clear,
    count: function () { return live.length; },
    MAX: MAX,
    DEFAULT_MS: DEFAULT_MS,
    KINDS: KINDS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
