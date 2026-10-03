/* community.js — 1.0.2 二 社区: §2.3 聊天室 / §2.4 新闻 / §2.5 Bug与建议.
 *
 * ---------------------------------------------------------------------------------------------
 * THIS FILE CARRIES NO USER-VISIBLE TEXT
 * ---------------------------------------------------------------------------------------------
 * Every word the operator reads lives in viewer.js (`T('community|…')`) or in viewer.html's static
 * markup, exactly as it does for auth.js / sync.js / profile.js / admin.js. The modules below them
 * return FACTS — a row, a count, `{ok:false, error:'RATE_LIMITED'}` — and the view does the wording.
 * The reason is not tidiness: wording split across two files is two places to translate, and this
 * project's i18n pipeline inventories one of them (`_tools/keys.cjs` scans viewer.js but not this
 * file), so a sentence written here would ship in Chinese in all thirteen locales and nothing
 * would report it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY §2.3.4's `supabase.channel(...)` IS NOT WHAT IS WRITTEN HERE
 * ---------------------------------------------------------------------------------------------
 * §2.3.4's snippet is supabase-js, and there is no supabase-js in this extension and cannot be: MV3
 * forbids loading a remote script into an extension page (`script-src 'self'`), this repo has no
 * bundler, and vendoring ~100 KB of client library to open one websocket would be a worse trade
 * than speaking the protocol it speaks. Supabase Realtime is Phoenix channels over one plain
 * `WebSocket`, so the protocol is spoken directly — §2.3.1's requirement is 「实时消息推送
 * （Supabase Realtime）」 and that is what this implements, with three consequences worth naming:
 *
 *   · `vsn=1.0.0` is pinned in the URL (see `GMCloud.realtimeUrl`). The frame shapes differ
 *     between protocol versions and the default is not this one on every deployment.
 *   · The JWT travels in the `phx_join` payload's `access_token`, not in the query string, because
 *     §2.3.3's read policy is evaluated against it. It is re-read on every reconnect rather than
 *     captured at boot, so a renewal mid-session does not leave the room authorised by a token
 *     that has since been superseded.
 *   · A quiet failure is POSSIBLE and therefore has a visible answer: if the socket cannot join
 *     (a blocked `wss`, a refused token, a deployment with Realtime off) the room falls back to
 *     polling `chat_messages` through PostgREST and `state()` says `'polling'`. The UI prints the
 *     state beside the room's title, so 「实时」 and 「轮询刷新」 are never confused for each other.
 *     §2.3.1 asks for push; polling is what happens when push is unavailable, and saying so is
 *     cheaper than a room that silently stops updating.
 *
 * ---------------------------------------------------------------------------------------------
 * WHERE THIS SITS BETWEEN §2.3.3's POLICIES AND 005_community.sql
 * ---------------------------------------------------------------------------------------------
 * Read side goes through PostgREST + RLS (`GMCloud.rest`), so the same policies that authorise the
 * websocket authorise the list — one authority, not two. Write side goes through the Edge
 * Functions and never through a client INSERT, because RLS cannot count 「每分钟最多 10 条」 and
 * cannot read the word list; 005_community.sql therefore has no client INSERT policy at all. See
 * the header of `_shared/community.ts` for the long form of that argument.
 */
(function (g) {
  'use strict';

  // Resolved at CALL time, not captured at load — the same shape auth.js / sync.js / admin.js use,
  // so a suite can swap the instance (verify-062 does) and every path here follows.
  function cloud() { return g.GMCloud; }
  function auth() { return g.GMAuth; }
  function shared() { return g.GMCommunityShared; }

  function noSession() { return { ok: false, error: 'UNAUTHORIZED', status: 401 }; }

  /** The caller's bearer. '' when there is none — callers turn that into `noSession()`. */
  function jwt() {
    var a = auth();
    var s = a && a.session && a.session();
    return (s && s.jwt) || '';
  }

  function uid() {
    var a = auth();
    var s = a && a.session && a.session();
    return (s && s.user && s.user.id) || '';
  }

  // =====================================================================
  // §2.3 聊天室
  // =====================================================================

  /**
   * §2.3.2's row shape, asked for by name.
   *
   * Spelled out rather than `select=*` so a column added to the table later cannot start travelling
   * to clients by default — the same reason `publicChatMessage` projects explicitly on the server.
   */
  var CHAT_COLS = 'id,user_id,username,avatar_url,content,created_at';

  /**
   * The room's scrollback: §2.3.5's 「历史保留 最近 7 天」 as a read window, newest page first.
   *
   * `opts.since` narrows it to one instant, which is what the polling fallback asks for: it is the
   * same query with the retention floor replaced by 「everything after the last row I have」, so
   * live and polled messages arrive through one code path and one shape.
   *
   * The two are alternatives, never combined. PostgREST reads a repeated `created_at` parameter as
   * two conjuncts on one column and `gt` would then quietly win or lose depending on the server's
   * parameter folding — an ordering nobody should have to know. One bound per request.
   */
  function chatLoad(opts) {
    var o = opts || {};
    var S = shared() || {};
    if (!jwt()) return Promise.resolve(noSession());
    var bound = o.since ? ('gt.' + o.since) : ('gte.' + S.chatRetentionCutoff());
    var query = 'select=' + CHAT_COLS +
      '&created_at=' + encodeURIComponent(bound) +
      '&order=created_at.' + (o.since ? 'asc' : 'desc') +
      '&limit=' + (o.limit || S.CHAT_PAGE_SIZE);
    return cloud().rest('chat_messages', { query: query, jwt: jwt() }).then(function (r) {
      if (!r.ok) return r;
      var rows = Array.isArray(r.data) ? r.data : [];
      // The full page arrives newest-first (that is the only way to ask for "the last N" without
      // knowing the table's size); the room reads oldest-first. The incremental page is already
      // ascending, so reversing it would be wrong — hence the branch rather than an unconditional
      // `reverse()`, which is the kind of detail that survives review by being invisible.
      return { ok: true, status: r.status, rows: o.since ? rows : rows.slice().reverse() };
    });
  }

  /** §2.3's send. The row comes back so the sender sees their message without waiting for a push. */
  function chatSend(text) {
    if (!jwt()) return Promise.resolve(noSession());
    return cloud().call('chat-send', { content: String(text == null ? '' : text) }, { jwt: jwt() })
      .then(function (r) {
        if (!r.ok) return r;
        return { ok: true, status: r.status, row: (r.data && r.data.message) || null };
      });
  }

  // ---- the Realtime client -------------------------------------------------------------------
  // The four constants below are protocol choices, not §2.3.5 limits; the limits live in the shared
  // block (`_tools/gen-community-shared.cjs` mirrors them from the Edge Function).

  /** §2.3.1's 「全部已激活用户共享一个公共聊天室」 — one room, so one topic. */
  var CHAT_TOPIC = 'realtime:chat';
  /** How long a socket may sit silent after opening before we call it dead. */
  var RT_JOIN_TIMEOUT_MS = 8000;
  var RT_HEARTBEAT_MS = 25000;
  var RT_RETRY_MS = 3000;
  /** Reconnects before giving up on push entirely. One retry rides out a recycled socket; two
   *  failures in a row is a deployment that will keep failing, and the operator is better served
   *  by a room that updates than by a spinner that retries forever. */
  var RT_MAX_ATTEMPTS = 2;
  var RT_POLL_MS = 6000;

  // =====================================================================
  // protocol frames — pure, and the only part of the socket that can be tested without one
  // =====================================================================

  /**
   * The `phx_join` frame.
   *
   * Pure and exported because the frame SHAPE is where this file's real risk sits: Phoenix answers
   * a malformed join with `{status:"error"}` and no explanation, so the one thing worth pinning is
   * the request the server is being asked to accept — including `vsn`-sensitive nesting
   * (`postgres_changes` under `config`, `access_token` at the payload root).
   *
   * ⚠ `event: 'INSERT'` and the table name are the values §2.3.4's snippet uses. They are also
   * constrained by 005_community.sql: the table has a SELECT policy and no INSERT policy, and a
   * subscription only delivers rows the token may read.
   */
  function joinFrame(ref, token) {
    return {
      topic: CHAT_TOPIC,
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { ack: false, self: false },
          // Sent because it is part of the shape supabase-js sends and a config the server does not
          // expect is a rejection; NOT used for anything. §2.3.1's requirement list has no
          // presence, and §2.3.6's 「[在线 12]」 is a sketch of a header, so no online count is
          // rendered — a number built from a payload nothing validates is worse than no number.
          presence: { key: '' },
          postgres_changes: [
            { event: 'INSERT', schema: 'public', table: 'chat_messages' },
          ],
        },
        access_token: token,
      },
      ref: String(ref),
    };
  }

  /** Phoenix closes an idle socket; this is the keep-alive the server expects on the `phoenix`
   *  topic rather than on the channel's. */
  function heartbeatFrame(ref) {
    return { topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(ref) };
  }

  /** Every frame is a JSON object carrying `event`. Anything else is dropped, never thrown on:
   *  a malformed frame from the server must not take the room down. */
  function parseFrame(raw) {
    var o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || typeof o.event !== 'string') return null;
    return o;
  }

  /** The chat row inside a `postgres_changes` frame, or null for anything else (an UPDATE, a
   *  DELETE, a frame for another table). */
  function rowFromChange(frame) {
    var d = frame && frame.payload && frame.payload.data;
    if (!d || d.type !== 'INSERT' || !d.record) return null;
    var r = d.record;
    return (r && typeof r.id === 'string') ? r : null;
  }

  // ---- the socket lifecycle ------------------------------------------------------------------
  var RT = {
    status: 'off',      // 'off' | 'connecting' | 'live' | 'polling'
    ws: null,
    ref: 0,
    joinRef: 0,
    hb: null,
    joinTimer: null,
    retry: null,
    poll: null,
    pollBusy: false,
    since: null,        // newest created_at delivered, for the polling fallback's `gt` bound
    attempts: 0,
    closed: true,
    onRow: null,
    onState: null,
  };

  function rtState(s) {
    if (RT.status === s) return;
    RT.status = s;
    if (RT.onState) { try { RT.onState(s); } catch (e) { /* a repaint must not kill the socket */ } }
  }

  function rtDropTimers() {
    if (RT.hb) { clearInterval(RT.hb); RT.hb = null; }
    if (RT.joinTimer) { clearTimeout(RT.joinTimer); RT.joinTimer = null; }
    if (RT.retry) { clearTimeout(RT.retry); RT.retry = null; }
  }

  function rtKillSocket() {
    var ws = RT.ws;
    RT.ws = null;
    if (!ws) return;
    // Handlers first: `close()` fires `onclose`, and `rtFail` must not be re-entered from a socket
    // this function is in the middle of discarding.
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (e) { /* already closing */ }
  }

  /** One row in, whoever found it — the live socket or the poller. Keeping the bookkeeping here
   *  is what makes the two paths deliver identical output. */
  function rtEmit(row) {
    if (!row) return;
    if (typeof row.created_at === 'string' && (!RT.since || row.created_at > RT.since)) {
      RT.since = row.created_at;
    }
    if (RT.onRow) { try { RT.onRow(row); } catch (e) { /* same */ } }
  }

  function rtPollOnce() {
    if (RT.pollBusy) return;
    RT.pollBusy = true;
    chatLoad({ since: RT.since }).then(function (r) {
      RT.pollBusy = false;
      if (!r || !r.ok || !r.rows) return;
      for (var i = 0; i < r.rows.length; i++) rtEmit(r.rows[i]);
    }, function () { RT.pollBusy = false; });
  }

  function rtFallback() {
    if (RT.closed || RT.poll) return;
    rtState('polling');
    RT.poll = setInterval(rtPollOnce, RT_POLL_MS);
    rtPollOnce();
  }

  function rtFail() {
    if (RT.closed) return;
    rtDropTimers();
    rtKillSocket();
    if (RT.attempts < RT_MAX_ATTEMPTS) {
      RT.attempts++;
      rtState('connecting');
      RT.retry = setTimeout(function () { RT.retry = null; rtConnect(); }, RT_RETRY_MS);
      return;
    }
    rtFallback();
  }

  function rtFrame(raw) {
    var f = parseFrame(raw);
    if (!f) return;
    if (f.event === 'phx_reply') {
      // Heartbeat replies share the event name; only the join's ref is a verdict on the room.
      if (String(f.ref) !== String(RT.joinRef)) return;
      if (f.payload && f.payload.status === 'ok') rtLive(); else rtFail();
      return;
    }
    if (f.event === 'postgres_changes') { rtEmit(rowFromChange(f)); return; }
    // A refused join, a revoked token, a banned account, or the server recycling the socket.
    if (f.event === 'phx_error' || f.event === 'phx_close') rtFail();
  }

  function rtLive() {
    if (RT.closed) return;
    if (RT.joinTimer) { clearTimeout(RT.joinTimer); RT.joinTimer = null; }
    RT.attempts = 0;
    // Push works, so the poller is not only unnecessary but WRONG: two sources for one list is this
    // project's most expensive recurring defect, and the two would disagree exactly when a message
    // is dropped by one and kept by the other.
    if (RT.poll) { clearInterval(RT.poll); RT.poll = null; }
    if (!RT.hb) {
      RT.hb = setInterval(function () {
        if (!RT.ws || RT.ws.readyState !== 1) return;
        try { RT.ws.send(JSON.stringify(heartbeatFrame(++RT.ref))); } catch (e) { /* rtFail via close */ }
      }, RT_HEARTBEAT_MS);
    }
    rtState('live');
  }

  function rtConnect() {
    if (RT.closed) return;
    var C = cloud();
    var W = g.WebSocket;
    // No WebSocket in this realm (a Node suite, or a browser with it unavailable): go straight to
    // polling rather than reporting a failure the operator cannot act on. `typeof W !== 'function'`
    // rather than truthiness, because a suite that installs a fake must be able to install a plain
    // function.
    if (typeof W !== 'function' || !C || typeof C.realtimeUrl !== 'function') { rtFallback(); return; }

    var ws;
    try { ws = new W(C.realtimeUrl()); } catch (e) { rtFail(); return; }
    RT.ws = ws;
    RT.joinRef = ++RT.ref;
    rtState('connecting');

    RT.joinTimer = setTimeout(function () {
      // The failure that has no event: the server accepts the TCP connection and answers only
      // after the join, so a wrong `vsn` or a socket swallowed by a proxy looks exactly like a
      // network that accepts and then says nothing. Only a clock can tell that apart from slow.
      RT.joinTimer = null;
      rtFail();
    }, RT_JOIN_TIMEOUT_MS);

    ws.onopen = function () {
      try { ws.send(JSON.stringify(joinFrame(RT.joinRef, jwt()))); } catch (e) { rtFail(); }
    };
    ws.onmessage = function (ev) { rtFrame(ev && ev.data); };
    // `onerror` is deliberately empty: a browser always fires `onclose` after it, so handling both
    // would double-count an attempt and spend the retry budget on one failure.
    ws.onerror = function () { };
    ws.onclose = function () { rtFail(); };
  }

  /**
   * Enter the room: load the scrollback, then keep it up to date by whichever means is available.
   *
   * `opts.onRow(row)` is called for every row — the page just loaded, and every message after it —
   * so the caller keeps ONE list-building path. `opts.onState(s)` reports `'off' | 'connecting' |
   * 'live' | 'polling'`. Both may fire several times; both are called synchronously.
   *
   * The socket is opened BEFORE the load, on purpose: an INSERT that lands during the load would
   * otherwise be missed by both halves. Delivering it twice is fine — the caller de-duplicates by
   * `id`, which it has to do anyway because a reconnect re-delivers — while missing it is not.
   */
  function chatSubscribe(opts) {
    chatUnsubscribe();
    var o = opts || {};
    RT.onRow = o.onRow || null;
    RT.onState = o.onState || null;
    RT.closed = false;
    RT.attempts = 0;
    RT.since = null;
    RT.pollBusy = false;

    var C = cloud();
    if (!C || typeof C.isConfigured !== 'function' || !C.isConfigured() || !jwt()) {
      rtState('off');
      return Promise.resolve({ ok: false, error: 'NOT_CONFIGURED' });
    }

    rtConnect();
    return chatLoad().then(function (r) {
      if (r && r.ok && r.rows) for (var i = 0; i < r.rows.length; i++) rtEmit(r.rows[i]);
      return r;
    });
  }

  /** Leave the room. Safe to call when not subscribed, and called on every view change. */
  function chatUnsubscribe() {
    RT.closed = true;
    rtDropTimers();
    rtKillSocket();
    if (RT.poll) { clearInterval(RT.poll); RT.poll = null; }
    RT.onRow = null;
    RT.onState = null;
    RT.since = null;
    RT.pollBusy = false;
    RT.status = 'off';
  }

  /** The connection state as a name, for the room's header. */
  function chatState() { return RT.status; }

  // =====================================================================
  // §2.4 新闻
  // =====================================================================

  /**
   * §2.4.1's feed: both content types in one list, pinned first.
   *
   * §2.4.2 indexes `idx_news_feed (is_pinned desc, published_at desc)`, which is this ORDER BY —
   * so the order is the index's order and not a second opinion about it.
   *
   * `translations` IS selected: §2.4.4's whole fallback chain runs on the client (the reader's
   * `settings.lang` lives here, not on the server), and `newsText` in the shared block is the one
   * implementation of it.
   */
  function newsLoad() {
    if (!jwt()) return Promise.resolve(noSession());
    return cloud().rest('news', {
      query: 'select=id,category,title,content,lang,translations,published_at,is_pinned' +
        '&order=is_pinned.desc,published_at.desc&limit=100',
      jwt: jwt(),
    }).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  // =====================================================================
  // §2.5 Bug与建议
  // =====================================================================

  /**
   * §2.5.4's submit.
   *
   * `contact` is passed through as TEXT and is never treated as the reply address — §2.5.7's mail
   * goes to the account's own address (see `admin-reply-feedback`). The server stores both.
   */
  function feedbackSubmit(form) {
    var f = form || {};
    if (!jwt()) return Promise.resolve(noSession());
    return cloud().call('feedback-submit', {
      category: f.category,
      title: f.title,
      content: f.content,
      contact: f.contact == null ? '' : f.contact,
    }, { jwt: jwt() }).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, row: (r.data && r.data.feedback) || null };
    });
  }

  /**
   * §2.5.5's 「我的提交」.
   *
   * The `user_id` filter is not redundant with RLS even though it looks it: `feedback_read_own`
   * and `feedback_read_admin` are two SELECT policies and policies OR together, so an ADMIN
   * running this query would otherwise get the whole inbox where the page says 「我的提交」. The
   * filter is what makes the query's meaning independent of which policies happen to apply.
   */
  function feedbackMine() {
    if (!jwt()) return Promise.resolve(noSession());
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    return cloud().rest('feedback', {
      query: 'select=id,category,title,content,status,admin_reply,replied_at,created_at' +
        '&user_id=eq.' + encodeURIComponent(me) + '&order=created_at.desc&limit=50',
      jwt: jwt(),
    }).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  g.GMCommunity = {
    // §2.3.5's limits, §2.4.4's fallback chain and the word list are defined once, in the shared
    // block generated from _shared/community.ts. Handed out through one accessor rather than
    // re-exported field by field: a copy here would be the second answer this project keeps
    // paying for, and the view needs the whole block anyway (it prints the numbers).
    shared: shared,

    chat: { load: chatLoad, send: chatSend, subscribe: chatSubscribe,
            unsubscribe: chatUnsubscribe, state: chatState,
            TOPIC: CHAT_TOPIC, POLL_MS: RT_POLL_MS },
    news: { load: newsLoad },
    feedback: { submit: feedbackSubmit, mine: feedbackMine },

    // Pure protocol pieces. Exported for the suite: they are the only part of the socket that can
    // be exercised without a server, and the join frame's shape is the part that fails silently.
    _frames: {
      TOPIC: CHAT_TOPIC,
      join: joinFrame,
      heartbeat: heartbeatFrame,
      parse: parseFrame,
      rowFromChange: rowFromChange,
    },
  };

  // Same dual-export shape as storage.js / cloud.js: the browser gets `GMCommunity` on the global,
  // a Node suite gets the same object back from `require`.
  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMCommunity;
})(typeof globalThis !== 'undefined' ? globalThis : this);
