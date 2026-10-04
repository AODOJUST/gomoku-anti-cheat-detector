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
   *
   * ⚠⚠ 1.0.4 — THE FOUR 1.0.3 COLUMNS WERE MISSING FROM THIS LIST, AND IT COST THEM EVERYTHING.
   * 1.0.3 added `attachment` (§1.1.3's card), `mentioned_users` (§1.6.3's highlight), `reply_to`
   * (§1.7.3's click target) and `reply_preview` (§1.7.4's quoted line) — to the TABLE, to
   * `publicChatMessage` on the server, and to `cmMsgHtml` in the view. It did not add them here, so
   * every row that reached the client through this query arrived without them. The only rows that
   * ever carried them were the SENDER's own, because `chatSend` returns the inserted row and
   * `cmPush` draws it locally. ⇒ 附件 / 提及 / 引用 worked exactly once each, for the person who
   * wrote them, and vanished on reload or for everybody else.
   *
   * ⚠ WHY NOTHING CAUGHT IT: the harness stubs `GMCloud.rest` with fixture rows that DO carry the
   * columns, so the view rendered correctly in every suite while the query asked for less. A stub
   * cannot notice a missing `select=` term — the fixture is the second thing under test, and this
   * one disagreed with production for the whole 1.0.3 cycle. `verify-066` reads this list against
   * `publicChatMessage`'s keys instead, which is the comparison a stub cannot make.
   */
  var CHAT_COLS = 'id,user_id,username,avatar_url,content,created_at,' +
    'attachment,mentioned_users,reply_to,reply_preview';

  /**
   * The room's scrollback: §2.3.5's 「历史保留 最近 7 天」 as a read window, newest page first.
   *
   * `opts.since` narrows it to one instant, which is what the polling fallback asks for: it is the
   * same query with the retention floor replaced by 「everything after the last row I have」, so
   * live and polled messages arrive through one code path and one shape.
   *
   * ⚠ 1.0.4 §P1 — `opts.before` IS THE THIRD BOUND, AND THE SAME QUERY. §1.1.2 keeps seven days and
   * `CHAT_PAGE_SIZE` is 50, so a busy room's older messages were simply unreachable: `chatLoad`
   * could only ever ask for 「the last N」. `before` is the OLDEST row in hand, and the request
   * becomes 「the 50 before that」 — identical shape (`desc` + `limit` + reverse), so 「加载更多」 is
   * not a second reader with its own ordering rules.
   *
   * The three are alternatives, never combined. PostgREST reads a repeated `created_at` parameter as
   * two conjuncts on one column and `gt`/`lt` would then quietly win or lose depending on the
   * server's parameter folding — an ordering nobody should have to know. One bound per request.
   */
  function chatLoad(opts) {
    var o = opts || {};
    var S = shared() || {};
    if (!jwt()) return Promise.resolve(noSession());
    var bound = o.since ? ('gt.' + o.since)
              : (o.before ? ('lt.' + o.before) : ('gte.' + S.chatRetentionCutoff()));
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

  /**
   * §2.3's send. The row comes back so the sender sees their message without waiting for a push.
   *
   * `opts` is 1.0.3 §1.1.2 / §1.7: `{attachment: {kind, name, summary, payload}}` and
   * `{replyTo: <message id>}`. Both are passed through UNTOUCHED and neither is validated here —
   * `chat-send` owns the attachment's shape, the size threshold that decides inline-vs-Storage, and
   * whether the quoted message is still in the retention window. A check here would be a second
   * opinion that refuses things the server would have taken (or worse, accepts things it will not).
   *
   * ⚠ `attachment` AND `reply_to` GO IN THE SAME CALL as `content`, deliberately. A separate
   * upload step would make 「上传成功，发消息失败」 reachable, and the artefact would be a bucket
   * object nothing points at — see the note in chat-send/index.ts.
   */
  function chatSend(text, opts) {
    if (!jwt()) return Promise.resolve(noSession());
    var o = opts || {};
    var body = { content: String(text == null ? '' : text) };
    if (o.attachment) body.attachment = o.attachment;
    if (o.replyTo) body.reply_to = String(o.replyTo);
    return cloud().call('chat-send', body, { jwt: jwt() })
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

  /**
   * 1.0.4 §P1 — how often an OPEN poll re-reads its tallies, while it is on screen.
   *
   * A count CANNOT be pushed. `public.vote_tally` is a view, and a publication carries tables;
   * `vote_ballots` is the table underneath it, and its SELECT policy is self-only
   * (011_rls_community.sql) so Realtime — which applies the same policies — would deliver to each
   * subscriber exactly the ballots they may already read, i.e. their own. Publishing anything
   * finer-grained would mean broadcasting 「有人投了 B」, which is more than §七.3's 「仅显示票数」.
   *
   * Slower than `RT_POLL_MS` on purpose: the room's poller is standing in for a message push and
   * wants to feel instant, while this one is a tally behind a button the operator is not watching
   * keystroke-by-keystroke. Ten seconds closes 「其他人投票后不会自动更新」 without turning a page
   * with four open polls into forty requests a minute.
   */
  var VOTE_TALLY_POLL_MS = 10000;

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
   *
   * ⚠⚠ 1.0.4 §P1 — THE TABLE LIST IS NO LONGER WRITTEN HERE. It is `S.realtimeChanges()`, from
   * `REALTIME_TABLES` in the shared block, and that is not a style preference: the same list has to
   * be dispatched on by `rtFrame` and PUBLISHED by `013_realtime.sql`, and the 1.0.2/1.0.3 shape —
   * one hard-coded chat entry here, a publication with no members at all — is a client asking for
   * changes nobody ever sent. It read as working because the join is answered `ok` either way.
   * `S` is read lazily (per connect), so a suite that installs the shared block after load works.
   */
  function joinFrame(ref, token) {
    var S = (g.GMCommunityShared) || {};
    // The fallback is `chat_messages` alone rather than `[]`: a build where the shared block failed
    // to load should still get the room it had before, not a subscription to nothing.
    var changes = typeof S.realtimeChanges === 'function'
      ? S.realtimeChanges()
      : [{ event: 'INSERT', schema: 'public', table: 'chat_messages' }];
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
          postgres_changes: changes,
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

  /**
   * 1.0.4 §P1 — the same frame, read as `{ table, event, row, old }` for ANY subscribed table.
   *
   * Kept separate from `rowFromChange` rather than widening it, and the separation is load-bearing:
   * the room's own path is INSERT-only by definition (§2.3 — a message is never edited), while the
   * six tables 1.0.4 adds are subscribed with `'*'` precisely because their OUTCOMES are updates
   * («接受好友», «已接收», «已读», «已结束»). One function serving both would have to answer
   * 「is this frame a chat row」 and 「is this frame any row」 at once, and the first caller's
   * `!== 'INSERT' ⇒ null` is exactly the answer the second must not give.
   *
   * `row` is null on a DELETE (there is nothing left to draw) and `old` is whatever the server sent
   * — the primary key alone unless the table has `replica identity full`, which 013_realtime.sql
   * sets on every table subscribed with `'*'`. Nothing here depends on `old`: the listeners re-read
   * the list they own rather than patching it from a partial row, which is the only way a DELETE and
   * an UPDATE can share one handler.
   */
  function changeFromFrame(frame) {
    var d = frame && frame.payload && frame.payload.data;
    if (!d || typeof d.table !== 'string' || typeof d.type !== 'string') return null;
    return {
      table: d.table,
      event: d.type,
      row: (d.record && typeof d.record === 'object') ? d.record : null,
      old: (d.old_record && typeof d.old_record === 'object') ? d.old_record : null,
    };
  }

  // ---- 1.0.4 §P1: the multi-table fan-out ----------------------------------------------------
  /**
   * Listeners registered through `watch()`. Every one of them is called for every change on the
   * tables it asked for, and a listener that throws is dropped for that change rather than for the
   * connection — a broken repaint must not take the socket down with it (the same rule `rtEmit`
   * states for `RT.onRow`).
   *
   * ⚠ A plain array rather than an object keyed by table: `REALTIME_TABLES` is the authority on
   * which tables exist, and a map would be a second list that could hold a key nobody subscribes to.
   */
  var RT_LISTENERS = [];

  /**
   * Watch the tables the community can change behind the operator's back.
   *
   * `tables` is a table name, an array of them, or `'*'` for everything except the room (which has
   * its own `chat.subscribe` channel and its own `onRow` contract). Returns the unsubscribe.
   *
   * ⚠ THE CALLER MUST OWN A RELOAD PATH, NOT A PATCH PATH. The handler is told `(table, event)`;
   * it is deliberately NOT handed the row to splice in. Every list in this product has one builder
   * (`cmPaintMsgs`, `cmLoadFriends`, …) and a second, incremental one is the shape this project has
   * paid six times for — and it is the shape that silently loses a DELETE, since a delete has no row
   * to splice. `event` is passed anyway, because 「好友请求来了」 and 「好友请求被撤销」 are worth
   * different words even when they reload the same list.
   */
  function watch(tables, fn) {
    if (typeof fn !== 'function') return function () { };
    var want = tables === '*' || tables == null
      ? null
      : (Object.prototype.toString.call(tables) === '[object Array]' ? tables : [tables]);
    var entry = { want: want, fn: fn };
    RT_LISTENERS.push(entry);
    return function () {
      var i = RT_LISTENERS.indexOf(entry);
      if (i >= 0) RT_LISTENERS.splice(i, 1);
    };
  }

  /** Drop every listener. Called with the room's teardown so leaving 社区 does not leave handlers
   *  pointing at a view that is gone. */
  function unwatchAll() { RT_LISTENERS.length = 0; }

  function realtimeEmit(table, event, row, old) {
    for (var i = 0; i < RT_LISTENERS.length; i++) {
      var L = RT_LISTENERS[i];
      if (L.want && L.want.indexOf(table) < 0) continue;
      try { L.fn(table, event, row, old); } catch (e) { /* a repaint must not kill the socket */ }
    }
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
    // ⚠ 1.0.4 §P1 — the frame is routed by TABLE. The room has its own listener contract
    // (`RT.onRow`, one row, INSERT only) and `changeFromFrame` is what tells the two apart; a
    // `chat_messages` frame still reaches `rtEmit` so `RT.since` advances and the poller's `gt`
    // bound stays right, while everything else fans out to `watch()` listeners. Routing the room
    // through the fan-out as well would give it two delivery paths that a `*`-listener could
    // double-count.
    if (f.event === 'postgres_changes') {
      var c = changeFromFrame(f);
      if (!c) return;
      if (c.table === 'chat_messages') { rtEmit(c.row); return; }
      realtimeEmit(c.table, c.event, c.row, c.old);
      return;
    }
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
    // The §P1 listeners go with the room. They repaint a view that is being left, and one that
    // outlived it would call `cmLoadMsgs()` into a hidden pane on every change the socket delivers
    // — a leak the operator cannot see, because the work happens where nobody is looking.
    unwatchAll();
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

  // =====================================================================
  // 1.0.3 — the two wrappers every block below is built from
  // =====================================================================

  /** A PostgREST read with the caller's bearer. The `rest()` side of §1.8's read/write split. */
  function restRead(table, query) {
    if (!jwt()) return Promise.resolve(noSession());
    return cloud().rest(table, { query: query, jwt: jwt() });
  }

  /**
   * An Edge Function write.
   *
   * ⚠ EVERY 1.0.3 WRITE GOES THROUGH HERE, and that is §1.8.2's 「服务端 RLS 依然拦截」 implemented
   * rather than promised: `friendships`, `friend_shares`, `votes`, `vote_ballots`, `reports` and
   * `daily_quotas` have NO client write policy at all (011). A cracked client that skips this can
   * still not write — the database refuses. See 011's header for why the INSERT policy §1.8.2
   * sketches is deliberately not created.
   */
  function fnCall(name, body) {
    if (!jwt()) return Promise.resolve(noSession());
    return cloud().call(name, body || {}, { jwt: jwt() });
  }

  /** The public projection 011 §3 grants the client. Spelled out rather than `select=*` — the same
   *  reason `CHAT_COLS` is: a column added to `users` later must not start travelling by default,
   *  and `email` is exactly the column that would. */
  var USER_PUBLIC_COLS =
    'id,username,avatar_url,bio,created_at,country_code,hide_country,manual_status,last_seen_at';

  /** §1.2.1's row shape, by name for the same reason. */
  var FRIEND_COLS =
    'id,user_a,user_b,status,blocked_by,requester,remark_a,remark_b,created_at,updated_at';

  // =====================================================================
  // §1.3 他人主页
  // =====================================================================

  /**
   * §1.3.1's card: 用户名 / 加入时间 / 样本库 N 个 / 国籍 / 简介 / 当前状态.
   *
   * Goes through `profile-get` rather than PostgREST because of the SAMPLE COUNT — see that
   * Function's header. `status` comes back already resolved (§3.2.1's three states), computed by
   * the same `presenceState` the room and the friend list use.
   *
   * ⚠ THE FLAG IS NOT RESOLVED HERE. `country_code` and `hide_country` both come back and the VIEW
   * applies `countryFlagChinaUnified` — §3.1.5 「存储仍保留真实 code，仅在显示时映射」 is the point
   * of that pair, and resolving it in this file would put the display rule in two places.
   */
  function memberProfile(userId) {
    var id = String(userId == null ? '' : userId);
    if (!id) return Promise.resolve({ ok: false, error: 'BAD_REQUEST' });
    return fnCall('profile-get', { user_id: id }).then(function (r) {
      if (!r.ok) return r;
      var d = r.data || {};
      return {
        ok: true,
        status: r.status,
        user: d.user || null,
        sampleCount: Number(d.sampleCount) || 0,
        presence: typeof d.status === 'string' ? d.status : 'offline',
      };
    });
  }

  // =====================================================================
  // §1.2 好友系统
  // =====================================================================

  /** The other party in an ordered pair. §1.2.1 makes `user_a < user_b`, so this is a comparison
   *  and not a lookup — and it is the ONE spelling of 「这一行里的对方是谁」. */
  function friendOtherId(row, me) {
    if (!row) return '';
    var self = me || uid();
    return row.user_a === self ? row.user_b : row.user_a;
  }

  /** §1.5.2's 「备注：修改备注名」 as the VIEWER sees it. Mirrors `remarkFor` on the server (it has
   *  to be readable without a round trip, since the list renders dozens of rows). */
  function friendRemarkFor(row, me) {
    if (!row) return null;
    var self = me || uid();
    return self === row.user_a ? (row.remark_a || null) : (row.remark_b || null);
  }

  /** The relationship between me and one account, or null. Used by §1.3.2's 「添加好友 / 已添加好友」
   *  button and by §1.5.2's 拉黑 check. */
  function friendRelation(otherId, rows) {
    var me = uid();
    var other = String(otherId == null ? '' : otherId);
    if (!me || !other || other === me) return Promise.resolve(null);
    if (rows) return Promise.resolve(findRelation(rows, me, other));
    return friendshipsMine().then(function (r) {
      return (r && r.ok) ? findRelation(r.rows, me, other) : null;
    });
  }

  function findRelation(rows, me, other) {
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (friendOtherId(r, me) === other) return r;
    }
    return null;
  }

  /** Every `friendships` row the caller is a party to. 011 §6 admits exactly those rows, and the
   *  `or=` filter says the same thing again so the result cannot change when a policy changes. */
  function friendshipsMine() {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    var filter = '&or=' + encodeURIComponent('(user_a.eq.' + me + ',user_b.eq.' + me + ')');
    return restRead('friendships',
      'select=' + FRIEND_COLS + filter + '&order=updated_at.desc&limit=300').then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  /**
   * §1.5.2's 好友列表 and §1.5.3's 消息 screen's first two sections, in ONE round trip each.
   *
   * ⚠ TWO QUERIES AND A JOIN, NOT A `select=*,users(...)` EMBED. PostgREST can embed `users` here
   * (there is a foreign key), and an embed would silently return the WHOLE `users` row — including
   * `email` — because an embed's column list is a separate expression and the narrowed column grant
   * (011 §3) applies to the EMBEDDED relation, where a bare `users(...)` means all of it. Two
   * explicit reads keep the projection where this file can see it.
   *
   * ⚠ THE JOIN IS IN THE CLIENT, so it must not also be in a policy. It is not: the two queries ask
   * for "my rows" and "these ids" and both are admitted by their own policy.
   *
   * Returns `{ friends, incoming, outgoing }` — accepted / 「请求添加你为好友」 / 「我已发出」.
   * `blocked` rows are EXCLUDED from all three: §1.5.2's 拉黑 is 「不再接收对方消息」, and a blocked
   * relationship is not a friendship to render. The view reaches them through `relation()` when it
   * needs to offer 「解除拉黑」.
   */
  function friendsList() {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    return friendshipsMine().then(function (r) {
      if (!r.ok) return r;
      var rows = r.rows;
      var ids = [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].status === 'blocked') continue;
        var other = friendOtherId(rows[i], me);
        if (other && ids.indexOf(other) < 0) ids.push(other);
      }
      if (ids.length === 0) {
        return { ok: true, status: r.status, friends: [], incoming: [], outgoing: [], rows: rows };
      }
      return restRead('users',
        'select=' + USER_PUBLIC_COLS + '&id=in.(' + ids.join(',') + ')&limit=300').then(function (u) {
        // ⚠ A FAILED PROFILE READ DOES NOT FAIL THE LIST. The friendships are the answer; the names
        // are decoration on it, and refusing the whole screen because one profile could not be
        // fetched would hide 「王五 请求添加你为好友」 from the person who has to answer it.
        var byId = {};
        var list = (u && u.ok && Array.isArray(u.data)) ? u.data : [];
        for (var k = 0; k < list.length; k++) byId[list[k].id] = list[k];

        var out = { friends: [], incoming: [], outgoing: [] };
        for (var j = 0; j < rows.length; j++) {
          var row = rows[j];
          if (row.status === 'blocked') continue;
          var otherId = friendOtherId(row, me);
          var entry = {
            friendship: row,
            user: byId[otherId] || null,
            otherId: otherId,
            remark: friendRemarkFor(row, me),
          };
          if (row.status === 'accepted') out.friends.push(entry);
          else if (row.requester === me) out.outgoing.push(entry);
          else out.incoming.push(entry);
        }
        // §1.5.2's list is ordered by name so the dot column does not reshuffle on every reload; the
        // message list keeps the table's own order (newest first), which is what a queue wants.
        out.friends.sort(function (a, b) {
          var an = (a.remark || (a.user && a.user.username) || '').toLowerCase();
          var bn = (b.remark || (b.user && b.user.username) || '').toLowerCase();
          return an < bn ? -1 : (an > bn ? 1 : 0);
        });
        out.rows = rows;
        return { ok: true, status: r.status, friends: out.friends,
                 incoming: out.incoming, outgoing: out.outgoing, rows: rows };
      });
    });
  }

  /** §1.2.2's 「A 点击「添加好友」」. `user_id` is the TARGET — the server decides the pair order. */
  function friendRequest(userId) {
    return fnCall('friend-request', { user_id: String(userId == null ? '' : userId) })
      .then(function (r) {
        if (!r.ok) return r;
        return { ok: true, status: r.status, friendship: (r.data && r.data.friendship) || null };
      });
  }

  /**
   * §1.2.2's accept/reject and §1.5.2's 备注 / 删除 / 拉黑, through one verb table.
   *
   * ⚠ ONE ENDPOINT, SIX VERBS — see `friend-accept`'s header. The view supplies the verb; nothing
   * here re-implements 「我可以对这条记录做什么」, because that question is answered against the row
   * (`blocked_by`, `requester`, the caller's side of the pair) and this file does not have the row.
   */
  function friendAct(friendshipId, action, remark) {
    var body = { friendship_id: String(friendshipId == null ? '' : friendshipId), action: action };
    if (remark !== undefined) body.remark = remark;
    return fnCall('friend-accept', body).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status,
               friendship: (r.data && r.data.friendship) || null,
               removed: !!(r.data && r.data.removed) };
    });
  }

  // =====================================================================
  // §1.2.3–§1.2.5 好友间分享
  // =====================================================================

  /** §1.2.5's 「今日还可发送 N 个」. Reads the caller's own row; 011 §6 admits exactly that row. */
  function shareQuota() {
    var me = uid();
    var S = shared() || {};
    if (!me) return Promise.resolve(noSession());
    // ⚠ The day KEY comes from the shared block, and it is the ONLY spelling of it. This line used
    // to read `S.serverDate ? S.serverDate() : new Date()…` while `serverDate` lived below the
    // shared marker — server only — so the guard's first branch could never be taken and the two
    // spellings of 「今天」 were the fallback and the server's. See the note on `serverDate`.
    var today = S.serverDate();
    return restRead('daily_quotas',
      'select=user_id,date,shares_archive,shares_config' +
      '&user_id=eq.' + encodeURIComponent(me) + '&date=eq.' + today).then(function (r) {
      if (!r.ok) return r;
      var row = (Array.isArray(r.data) && r.data[0]) || null;
      return {
        ok: true, status: r.status, date: today,
        archive: row ? Number(row.shares_archive) || 0 : 0,
        config: row ? Number(row.shares_config) || 0 : 0,
        maxArchive: S.SHARE_DAILY_ARCHIVE_MAX || 0,
        maxConfig: S.SHARE_DAILY_CONFIG_MAX || 0,
      };
    });
  }

  /**
   * §1.2.3 「A 在好友列表中选择 B → 点击「发送」 → 选择内容」.
   *
   * ⚠ `payload` IS THE ALREADY-STRUCTURED JSON — §1.2.4's 「数据已是结构化 JSON；直接调用现有的
   * importArchives / importSamples / importCustomData」 is the SAME object format this project
   * already exports, so nothing is re-packed here. A 「二次打包」 would be a second serialisation of
   * one archive, and the two would drift the first time an archive field was added.
   */
  function shareSend(input) {
    var i = input || {};
    return fnCall('friend-share', {
      action: 'send',
      to_user: String(i.to_user == null ? '' : i.to_user),
      kind: String(i.kind == null ? '' : i.kind),
      name: String(i.name == null ? '' : i.name),
      summary: i.summary === undefined ? null : i.summary,
      payload: i.payload === undefined ? null : i.payload,
    }).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, share: (r.data && r.data.share) || null };
    });
  }

  /**
   * The 「payload 在哪」 branch, ONCE. Shared by `shareFetch` (a friend's share) and
   * `cloudShareFetch` (a room 附件) since 1.0.4 — both Functions answer in this shape, and the
   * client must not learn which storage route was used.
   *
   * `d` is the Function's JSON body: either `{ payload, kind }` or `{ url, expires_in, kind }`.
   * The returned object keeps `stored`/`url` as evidence for the suite and for a future 「另存为」.
   */
  function resolveSharePayload(d, status) {
    if (d.payload !== undefined && d.payload !== null) {
      return Promise.resolve({ ok: true, status: status, payload: d.payload, kind: d.kind || null,
                               stored: false, url: null });
    }
    if (!d.url) return Promise.resolve({ ok: false, error: 'NOT_FOUND', status: status });
    return cloud().getJson(d.url).then(function (g) {
      if (!g.ok) return g;
      return { ok: true, status: status, payload: g.data, kind: d.kind || null,
               stored: true, url: d.url };
    });
  }

  /**
   * §1.2.4 「客户端拉取 payload（或下载 storage_url）」 → 「展示预览」.
   *
   * ⚠ RESOLVES TO A PAYLOAD EITHER WAY. A share under 500 KB carries its body in the row; a larger
   * one is a signed URL. The caller needs the same thing from both — the JSON, so it can draw
   * 「黑 72 / 白 85 · 全局 · 42 手」 — so the download happens HERE, through `GMCloud.getJson`, and
   * the caller never learns which storage route was used. The raw answer is still on the returned
   * object as `url`/`stored` for the suite and for a future 「另存为」 path.
   *
   * ⚠ A SIGNED URL IS SHORT-LIVED (`SIGNED_URL_SECONDS` = 60), so an expired signature arrives as a
   * transport failure and the remedy is to call this again — which is why the error is passed
   * through in the standard vocabulary rather than being swallowed into 「分享坏了」.
   */
  function shareFetch(shareId) {
    var id = String(shareId == null ? '' : shareId);
    if (!id) return Promise.resolve({ ok: false, error: 'BAD_REQUEST' });
    return fnCall('friend-share', { action: 'fetch', share_id: id }).then(function (r) {
      if (!r.ok) return r;
      return resolveSharePayload(r.data || {}, r.status);
    });
  }

  /**
   * 1.0.4 §P1 — the same answer for a ROOM 附件 (`cloud_shares`), through `cloud-share`.
   *
   * ⚠ THE ROW AND THE BYTES ARE TWO DIFFERENT QUESTIONS, AND THIS FUNCTION IS THE SECOND ONE. The
   * card draws itself from the message's own snapshot of `name` / `summary` / `expires_at`, so
   * 「打开」 is not what makes a share visible — it is what makes it READABLE. That is why there is a
   * Function at all: a body over 500 KB is an object in the private `temp-shares` bucket, and only
   * the service role may sign it (`cloud.js` documents that the client has no signing API).
   *
   * ⚠ RESOLVED THROUGH `resolveSharePayload`, THE SAME BRANCH `shareFetch` USES. Two tables, one
   * shape: 「payload 在行里就直接用，在 Storage 就先下」 is decided in one place, so a reader cannot
   * work for a friend's replay and fail for the room's.
   */
  function cloudShareFetch(cloudId) {
    var id = String(cloudId == null ? '' : cloudId);
    if (!id) return Promise.resolve({ ok: false, error: 'BAD_REQUEST' });
    return fnCall('cloud-share', { cloud_id: id }).then(function (r) {
      if (!r.ok) return r;
      return resolveSharePayload(r.data || {}, r.status);
    });
  }

  /** §1.2.4 「若选「导入」，立即写入，并标记 consumed = true」. Called AFTER the local write
   *  succeeded — a recipient whose import failed must still see the share as untaken. */
  function shareConsume(shareId) {
    return fnCall('friend-share', { action: 'consume', share_id: String(shareId == null ? '' : shareId) })
      .then(function (r) {
        if (!r.ok) return r;
        return { ok: true, status: r.status, share: (r.data && r.data.share) || null };
      });
  }

  /** §1.2.4's 「B 在消息列表看到「A 发送了一个存档」」 — sent TO me, still live, not yet taken. */
  function shareInbox() {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    return restRead('friend_shares',
      'select=id,from_user,to_user,kind,size_bytes,created_at,expires_at,consumed' +
      '&to_user=eq.' + encodeURIComponent(me) + '&consumed=is.false' +
      '&order=created_at.desc&limit=100').then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  /** 「我还发出去了什么」 — the sender's half of §1.2.4, so 「A 需重发」 is a decision the sender can
   *  make rather than guess. */
  function shareSent() {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    return restRead('friend_shares',
      'select=id,from_user,to_user,kind,size_bytes,created_at,expires_at,consumed' +
      '&from_user=eq.' + encodeURIComponent(me) + '&order=created_at.desc&limit=100').then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  /** §1.2.4's window, client-side, through the shared block so the 15 minutes are one number. */
  function shareIsLive(row) {
    var S = shared() || {};
    return S.isShareLive ? S.isShareLive(row) : false;
  }

  // =====================================================================
  // §1.4 投票
  // =====================================================================

  /** §1.4.2's 「24 小时 或 发布者手动关闭」, through the shared block. */
  function voteIsOpen(row) {
    var S = shared() || {};
    return S.isVoteOpen ? S.isVoteOpen(row) : false;
  }

  /**
   * §1.4.4's poll for one shared item: the `votes` row, its four counts, and MY ballot.
   *
   * ⚠ THREE QUERIES, AND THEY CANNOT BE ONE. The tally is a VIEW (`vote_tally`) because §七.3's
   * anonymity is enforced by aggregation under `security_invoker = false`; my ballot is readable
   * only through `vote_ballots_read_self`; the poll row is public. They are three different
   * visibility rules, so they are three requests.
   *
   * ⚠ THE COUNT IS ZERO-FILLED BY `voteTally` IN THE SHARED BLOCK, not here: the view emits rows
   * only for choices somebody picked, and a renderer iterating raw rows would draw two buttons on a
   * poll nobody has voted in.
   */
  function voteForTarget(targetKind, cloudId) {
    var S = shared() || {};
    var me = uid();
    var kind = String(targetKind == null ? '' : targetKind);
    var id = String(cloudId == null ? '' : cloudId);
    if (!kind || !id) return Promise.resolve({ ok: false, error: 'BAD_REQUEST' });
    return restRead('votes',
      'select=id,target_kind,target_cloud_id,creator_id,created_at,closes_at,closed_manually' +
      '&target_kind=eq.' + encodeURIComponent(kind) +
      '&target_cloud_id=eq.' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) return r;
      var vote = (Array.isArray(r.data) && r.data[0]) || null;
      if (!vote) return { ok: true, status: r.status, vote: null, tally: null, mine: null };
      return Promise.all([
        restRead('vote_tally', 'select=vote_id,choice,n&vote_id=eq.' + encodeURIComponent(vote.id)),
        me
          ? restRead('vote_ballots',
              'select=vote_id,choice&vote_id=eq.' + encodeURIComponent(vote.id) +
              '&user_id=eq.' + encodeURIComponent(me))
          : Promise.resolve({ ok: true, data: [] }),
      ]).then(function (both) {
        var tallyRows = (both[0] && both[0].ok && Array.isArray(both[0].data)) ? both[0].data : [];
        var mineRows = (both[1] && both[1].ok && Array.isArray(both[1].data)) ? both[1].data : [];
        return {
          ok: true, status: r.status, vote: vote,
          tally: S.voteTally ? S.voteTally(tallyRows) : null,
          mine: (mineRows[0] && mineRows[0].choice) || null,
          open: voteIsOpen(vote),
        };
      });
    });
  }

  /** §1.4.1 「发布者在发送存档或样本时可勾选「启用投票」」. Ownership is the server's check. */
  function voteCreate(targetKind, cloudId) {
    return fnCall('vote-create', {
      target_kind: String(targetKind == null ? '' : targetKind),
      target_cloud_id: String(cloudId == null ? '' : cloudId),
    }).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, vote: (r.data && r.data.vote) || null,
               created: !!(r.data && r.data.created) };
    });
  }

  /** §1.4.3's ballot. `close` is the same endpoint — see `vote-cast`. */
  function voteCast(voteId, choice) {
    return fnCall('vote-cast', { vote_id: String(voteId == null ? '' : voteId), choice: choice })
      .then(function (r) {
        if (!r.ok) return r;
        // The tally comes back FRESH and must not be incremented again by the caller — see the
        // Function's header, which says so where the arithmetic lives.
        return { ok: true, status: r.status, tally: (r.data && r.data.tally) || null,
                 total: Number(r.data && r.data.total) || 0 };
      });
  }

  /** §1.4.4's 「[关闭投票]（发布者可见）」. */
  function voteClose(voteId) {
    return fnCall('vote-cast', { action: 'close', vote_id: String(voteId == null ? '' : voteId) })
      .then(function (r) {
        if (!r.ok) return r;
        return { ok: true, status: r.status, vote: (r.data && r.data.vote) || null,
                 tally: (r.data && r.data.tally) || null,
                 total: Number(r.data && r.data.total) || 0 };
      });
  }

  // =====================================================================
  // §二.1 举报
  // =====================================================================

  /** §2.1's form → §2.3.4's 信箱. The rate limit and the category set are the server's. */
  function reportSubmit(input) {
    var i = input || {};
    return fnCall('report-submit', {
      reported_id: String(i.reported_id == null ? '' : i.reported_id),
      category: String(i.category == null ? '' : i.category),
      detail: i.detail === undefined ? '' : i.detail,
      evidence: i.evidence === undefined ? null : i.evidence,
    }).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, report: (r.data && r.data.report) || null };
    });
  }

  /** 「我提交的举报」. The `reporter_id` filter is what makes an ADMIN's view of this page match what
   *  the page says, for the same reason `feedbackMine` carries one. */
  function reportMine() {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    return restRead('reports',
      'select=id,reported_id,category,detail,status,admin_action,handled_at,created_at' +
      '&reporter_id=eq.' + encodeURIComponent(me) + '&order=created_at.desc&limit=50').then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  // =====================================================================
  // §1.5.3 消息 / §1.6.3 提醒
  // =====================================================================

  /**
   * The 系统通知 and @提及 rows.
   *
   * ⚠ §1.5.3's OTHER TWO SECTIONS DO NOT COME FROM HERE — 好友请求 is `friendships` and 分享 is
   * `friend_shares`, both read above. The rule and its reasons are written out in
   * 009_reports.sql: a section whose source row DIES when the event is dealt with is derived, and a
   * section that needs an unread marker gets a row in this table. A reminder to "make it uniform"
   * should read that file first.
   */
  function noticesList() {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    return restRead('notifications',
      'select=id,kind,title,body,data,read,created_at,read_at' +
      '&user_id=eq.' + encodeURIComponent(me) + '&order=created_at.desc&limit=100').then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  /** §1.6.3's 「头像上小红点」, as a count. `head: true` so no rows travel — the badge needs a
   *  number and `notifications_update_own` is the only write this client has. */
  function noticesUnread() {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    return restRead('notifications',
      'select=id&user_id=eq.' + encodeURIComponent(me) + '&read=is.false').then(function (r) {
      // `rest()` cannot ask for a count without an extra header, so this reads the rows it is going
      // to count. Capped at the same 100 the list uses, and the badge renders 「99+」 above it — a
      // badge is not a ledger.
      if (!r.ok) return r;
      var n = Array.isArray(r.data) ? r.data.length : 0;
      return { ok: true, status: r.status, count: n };
    });
  }

  /**
   * Mark one notification read.
   *
   * ⚠ THIS IS THE ONE CLIENT WRITE IN 1.0.3, and 011 §6 argues it at length: the column grant is
   * `update (read, read_at)`, so the same policy cannot be used to rewrite `kind` or `body` — i.e.
   * to forge a 警告 out of an existing row. The rows themselves are only created by
   * `admin-handle-report` (service role).
   */
  function noticeMarkRead(id) {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    if (!id) return Promise.resolve({ ok: false, error: 'BAD_REQUEST' });
    var now = new Date().toISOString();
    return cloud().rest('notifications', {
      query: 'id=eq.' + encodeURIComponent(String(id)) + '&user_id=eq.' + encodeURIComponent(me),
      jwt: jwt(),
      method: 'PATCH',
      body: { read: true, read_at: now },
      // `resolution=merge-duplicates` is PostgREST's upsert intent; for a PATCH it is meaningless
      // and actively wrong, so only `return=representation` is set here.
      prefer: 'return=representation',
    }).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  /** 「全部标记已读」, as ONE request rather than N. ⚠ PostgREST refuses an unfiltered write, so the
   *  `read=is.false` filter is what makes this legal as well as narrow. */
  function noticesMarkAllRead() {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    return cloud().rest('notifications', {
      query: 'user_id=eq.' + encodeURIComponent(me) + '&read=is.false',
      jwt: jwt(),
      method: 'PATCH',
      body: { read: true, read_at: new Date().toISOString() },
      prefer: 'return=representation',
    }).then(function (r) {
      if (!r.ok) return r;
      return { ok: true, status: r.status, rows: Array.isArray(r.data) ? r.data : [] };
    });
  }

  // =====================================================================
  // §3.1.6 / §3.2.3 — the two user-owned settings
  // =====================================================================

  /**
   * §3.1.6's 「隐藏国籍」 and §3.2.3's 「在线状态」, in one PATCH.
   *
   * ⚠ STRAIGHT THROUGH PostgREST, unlike every other 1.0.3 write, and 011 §4 is where that is
   * argued: these are the caller's own two cosmetic columns, they affect nobody else's data, and
   * the policies and column grants that make that safe are the same ones 002_rls.sql already uses
   * for `username` / `bio` / `avatar_url`. A Function here would be an eleventh Function to change
   * a boolean.
   *
   * ⚠ `country_code` / `country_updated_at` / `last_seen_at` are NOT writable this way — 011 §4
   * explains why (a client that could write its own country would make §3.1 a claim rather than an
   * observation) and `geo-update` is the route.
   */
  function settingsPatch(patch) {
    var me = uid();
    if (!me) return Promise.resolve(noSession());
    var body = {};
    if (patch && patch.hide_country !== undefined) body.hide_country = !!patch.hide_country;
    if (patch && patch.manual_status !== undefined) {
      var S = shared() || {};
      var allowed = S.MANUAL_STATUSES || ['online', 'busy', 'hidden'];
      // §3.2.3's three radios. Checked here so a bad value is a local refusal rather than a 23514
      // from `users_manual_status_known` — the constraint still exists as the backstop.
      if (allowed.indexOf(patch.manual_status) < 0) return Promise.resolve({ ok: false, error: 'BAD_REQUEST' });
      body.manual_status = patch.manual_status;
    }
    if (Object.keys(body).length === 0) return Promise.resolve({ ok: false, error: 'BAD_REQUEST' });
    return cloud().rest('users', {
      query: 'id=eq.' + encodeURIComponent(me),
      jwt: jwt(),
      method: 'PATCH',
      body: body,
      prefer: 'return=representation',
    }).then(function (r) {
      if (!r.ok) return r;
      var row = (Array.isArray(r.data) && r.data[0]) || null;
      return { ok: true, status: r.status, user: row };
    });
  }

  // =====================================================================
  // §3.2 状态系统 — the Realtime presence channel
  // =====================================================================
  // §3.2.2's snippet is supabase-js, which this extension cannot load (see this file's header), so
  // the channel is spoken directly like the chat one. The frame set is smaller: a join carrying a
  // `presence` config, a `presence` message to announce ourselves, and `presence_state` /
  // `presence_diff` coming back.
  //
  // ⚠ ITS OWN SOCKET, NOT THE CHAT ROOM'S. Phoenix multiplexes channels over one socket, and sharing
  // would be the obvious economy — but the chat socket's retry budget, join timeout and fallback are
  // tuned for 「a room that must keep updating」 (it degrades to polling). A presence channel that
  // fails must NOT drag the room into polling with it, and a presence channel on a recycled socket
  // must not spend the room's two retries. Two sockets, two budgets, no coupling.
  //
  // ⚠ WHAT THIS ADDS OVER `last_seen_at`. §3.2.1's thresholds are already answerable from the
  // timestamp the server stamps on every authenticated call (`touchLastSeen`), and that is the BASE
  // — it covers 「他是谁，在线吗」 for anybody, including an account that has never opened the
  // community. The socket is the ENHANCEMENT: it turns join/leave into an event, so a friend list
  // updates the moment somebody arrives rather than up to one beat later, and it is the only source
  // for a user who is in the room while this page is open. `stateOf` reads the socket first and falls
  // back to the row, so a page with no socket still shows a truthful dot.

  /** §3.2.2's channel name. One presence channel for the product, keyed by user id. */
  var PRESENCE_TOPIC = 'realtime:presence';
  var PRESENCE_RETRY_MS = 3000;
  var PRESENCE_MAX_ATTEMPTS = 2;

  /**
   * The `phx_join` for the presence channel.
   *
   * ⚠ THE DIFFERENCE FROM `joinFrame` IS THE WHOLE FRAME: `presence.key` carries MY user id (the
   * chat frame sends an empty key because it wants no presence), and there is NO `postgres_changes`
   * entry — this channel is not subscribed to a table, so asking for one would be a subscription the
   * server has nothing to send.
   */
  function presenceJoinFrame(ref, token, userId) {
    return {
      topic: PRESENCE_TOPIC,
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: String(userId == null ? '' : userId) },
        },
        access_token: token,
      },
      ref: String(ref),
    };
  }

  /** §3.2.2's `presenceChannel.track({ status, last_seen })`, as the raw frame. `status` is the
   *  caller's `manual_status` (or 'online' when they never chose) — the SERVER stores the choice and
   *  this repeats it, so 「隐身」 stays hidden on every reader's screen. */
  function presenceTrackFrame(ref, status, lastSeenIso) {
    return {
      topic: PRESENCE_TOPIC,
      event: 'presence',
      payload: { status: String(status || 'online'), last_seen: String(lastSeenIso || '') },
      ref: String(ref),
    };
  }

  /**
   * The presence map inside a `presence_state` / `presence_diff` frame.
   *
   * Phoenix sends `{ <key>: { metas: [ { phx_ref, status, last_seen }, … ] } }`. ⚠ `metas` is a LIST
   * because one key may be tracked several times (two tabs, a reconnect that has not timed out yet),
   * and reading `payload[key].status` — the shape supabase-js's `presenceState()` returns — would be
   * undefined on every entry. The FIRST meta is what is rendered; a second tab is not a second
   * person.
   */
  function presenceFromFrame(event, payload) {
    var out = { joins: {}, leaves: {} };
    var p = payload || {};
    if (event === 'presence_state') {
      out.joins = p;
      return out;
    }
    if (event === 'presence_diff') {
      out.joins = p.joins || {};
      out.leaves = p.leaves || {};
      return out;
    }
    return out;
  }

  // ---- the presence socket's lifecycle ---------------------------------------------------------
  var PR = {
    status: 'off',      // 'off' | 'connecting' | 'live'
    ws: null,
    ref: 0,
    joinRef: 0,
    hb: null,
    beat: null,
    joinTimer: null,
    retry: null,
    attempts: 0,
    closed: true,
    metav: {},          // userId -> { refs: { phx_ref: status-obj }, order: [phx_ref] }
    onState: null,
  };

  function prStateOf(userId) {
    var entry = PR.metav[String(userId == null ? '' : userId)];
    if (!entry || !entry.order.length) return null;
    var first = entry.refs[entry.order[0]];
    return first || null;
  }

  /** Apply one frame's joins/leaves to `metav`. Keys whose last meta left are DROPPED, which is what
   *  turns a `leave` into 「他走了」 rather than 「他有零个连接」. */
  function prApply(frame) {
    var keys = Object.keys(frame.joins);
    var i, key, metas, m;
    for (i = 0; i < keys.length; i++) {
      key = keys[i];
      metas = (frame.joins[key] && frame.joins[key].metas) || [];
      if (!PR.metav[key]) PR.metav[key] = { refs: {}, order: [] };
      for (var j = 0; j < metas.length; j++) {
        m = metas[j];
        var rid = m && m.phx_ref ? String(m.phx_ref) : ('k' + j);
        if (!PR.metav[key].refs[rid]) PR.metav[key].order.push(rid);
        PR.metav[key].refs[rid] = { status: m && m.status, last_seen: m && m.last_seen };
      }
    }
    var lkeys = Object.keys(frame.leaves);
    for (i = 0; i < lkeys.length; i++) {
      key = lkeys[i];
      metas = (frame.leaves[key] && frame.leaves[key].metas) || [];
      var entry = PR.metav[key];
      if (!entry) continue;
      for (var k = 0; k < metas.length; k++) {
        m = metas[k];
        var lid = m && m.phx_ref ? String(m.phx_ref) : null;
        if (lid && entry.refs[lid]) {
          delete entry.refs[lid];
          var at = entry.order.indexOf(lid);
          if (at >= 0) entry.order.splice(at, 1);
        }
      }
      if (entry.order.length === 0) delete PR.metav[key];
    }
  }

  /** The caller's own §3.2.3 choice, from the cached session's user projection. Defaults to
   *  'online' — which is §3.2.2's own `user.manualStatus || 'online'`, not a default invented here. */
  function myManualStatus() {
    var a = auth();
    var s = a && a.session && a.session();
    var v = s && s.user && s.user.manual_status;
    var S = shared() || {};
    return (S.MANUAL_STATUSES || []).indexOf(v) >= 0 ? v : 'online';
  }

  function prTrack() {
    if (!PR.ws || PR.ws.readyState !== 1) return;
    // ⚠ `last_seen` IS NOW, not the row's stored value: this is §3.2.2's `track({ last_seen })`, and
    // the whole point of the beat is that it advances. The row's timestamp is the fallback for
    // accounts that are not in this channel.
    var payload = presenceTrackFrame(++PR.ref, myManualStatus(), new Date().toISOString());
    try { PR.ws.send(JSON.stringify(payload)); } catch (e) { /* rtFail via close */ }
  }

  function prDropTimers() {
    if (PR.hb) { clearInterval(PR.hb); PR.hb = null; }
    if (PR.beat) { clearInterval(PR.beat); PR.beat = null; }
    if (PR.joinTimer) { clearTimeout(PR.joinTimer); PR.joinTimer = null; }
    if (PR.retry) { clearTimeout(PR.retry); PR.retry = null; }
  }

  function prKill() {
    var ws = PR.ws;
    PR.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (e) { /* already closing */ }
  }

  function prNotify() {
    if (PR.onState) { try { PR.onState(); } catch (e) { /* a repaint must not kill the socket */ } }
  }

  function prSetStatus(s) {
    if (PR.status === s) return;
    PR.status = s;
    prNotify();
  }

  function prFail() {
    if (PR.closed) return;
    prDropTimers();
    prKill();
    // ⚠ NO POLLING FALLBACK, unlike the chat room. There is nothing to poll: `last_seen_at` is
    // already the row-based answer and `stateOf` reads it — so a failed socket degrades to the BASE
    // rather than to a slower copy of itself. Retrying is still worth two attempts, because a
    // recycled socket is the common failure and it is one retry away from working.
    if (PR.attempts < PRESENCE_MAX_ATTEMPTS) {
      PR.attempts++;
      prSetStatus('connecting');
      PR.retry = setTimeout(function () { PR.retry = null; prConnect(); }, PRESENCE_RETRY_MS);
      return;
    }
    prSetStatus('off');
  }

  function prFrame(raw) {
    var f = parseFrame(raw);
    if (!f) return;
    if (f.event === 'phx_reply') {
      if (String(f.ref) !== String(PR.joinRef)) return;
      if (f.payload && f.payload.status === 'ok') prLive(); else prFail();
      return;
    }
    if (f.event === 'presence_state' || f.event === 'presence_diff') {
      prApply(presenceFromFrame(f.event, f.payload));
      prNotify();
      return;
    }
    if (f.event === 'phx_error' || f.event === 'phx_close') prFail();
  }

  function prLive() {
    if (PR.closed) return;
    if (PR.joinTimer) { clearTimeout(PR.joinTimer); PR.joinTimer = null; }
    PR.attempts = 0;
    if (!PR.hb) {
      PR.hb = setInterval(function () {
        if (!PR.ws || PR.ws.readyState !== 1) return;
        try { PR.ws.send(JSON.stringify(heartbeatFrame(++PR.ref))); } catch (e) { /* via close */ }
      }, RT_HEARTBEAT_MS);
    }
    if (!PR.beat) {
      var S = shared() || {};
      PR.beat = setInterval(prTrack, (S.PRESENCE_BEAT_MS || 60000));
    }
    prSetStatus('live');
    prTrack();
  }

  function prConnect() {
    if (PR.closed) return;
    var C = cloud();
    var W = g.WebSocket;
    if (typeof W !== 'function' || !C || typeof C.realtimeUrl !== 'function') {
      prSetStatus('off');
      return;
    }
    var ws;
    try { ws = new W(C.realtimeUrl()); } catch (e) { prFail(); return; }
    PR.ws = ws;
    PR.joinRef = ++PR.ref;
    prSetStatus('connecting');

    PR.joinTimer = setTimeout(function () { PR.joinTimer = null; prFail(); }, RT_JOIN_TIMEOUT_MS);
    ws.onopen = function () {
      try { ws.send(JSON.stringify(presenceJoinFrame(PR.joinRef, jwt(), uid()))); }
      catch (e) { prFail(); }
    };
    ws.onmessage = function (ev) { prFrame(ev && ev.data); };
    ws.onerror = function () { };
    ws.onclose = function () { prFail(); };
  }

  /**
   * Join the presence channel. `onChange()` is called on every arrival and departure.
   *
   * ⚠ SAFE TO CALL WHEN A CHANNEL IS ALREADY OPEN — it is torn down first, exactly like
   * `chatSubscribe`. The view calls it on entering 社区 and on switching to a sub-view that shows
   * dots, and a second call must not leave the first socket streaming into a dead list.
   */
  function presenceWatch(onChange) {
    presenceStop();
    PR.onState = onChange || null;
    PR.closed = false;
    PR.attempts = 0;
    PR.metav = {};
    var C = cloud();
    if (!C || typeof C.isConfigured !== 'function' || !C.isConfigured() || !jwt() || !uid()) {
      prSetStatus('off');
      return Promise.resolve({ ok: false, error: 'NOT_CONFIGURED' });
    }
    prConnect();
    return Promise.resolve({ ok: true });
  }

  /** Leave. Safe to call when not watching; called on every view change, like `chatUnsubscribe`. */
  function presenceStop() {
    PR.closed = true;
    prDropTimers();
    prKill();
    PR.metav = {};
    PR.onState = null;
    PR.status = 'off';
  }

  /** `'off' | 'connecting' | 'live'` — what the view prints beside a status column. */
  function presenceStateOf() { return PR.status; }

  /** The socket's own admission that it is live. The room's 「实时」 label uses the same idea for
   *  the same reason: a dot that keeps refreshing is indistinguishable from a stale one. */
  function presenceIsLive() { return PR.status === 'live'; }

  /**
   * §3.2.1's state for one account, SOCKET FIRST, ROW SECOND.
   *
   * `row` is a `users` public-projection row (or anything with `manual_status` / `last_seen_at`), and
   * it may be absent — a user id we have never fetched. In that case only the socket can answer, and
   * an unknown user reads 离线.
   *
   * ⚠ BOTH HALVES GO THROUGH ONE `presenceState`. The socket's payload carries `status` (which
   * §3.2.2 filled from `manual_status`) and `last_seen`; the row carries the same two facts. Feeding
   * them to the same function is what stops 「隐身」 from meaning one thing in the room and another
   * on a profile page.
   */
  function presenceStateFor(userId, row) {
    var S = shared() || {};
    var live = prStateOf(userId);
    var manual = live ? live.status : (row && row.manual_status);
    var seen = live ? live.last_seen : (row && row.last_seen_at);
    if (!S.presenceState) return 'offline';
    return S.presenceState(seen, manual, Date.now());
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

    // 1.0.4 §P1 — the fan-out half of the SAME socket. `chat` keeps its 1.0.2 shape on purpose
    // (one room, one row at a time, INSERT only), because `verify-064` pins that surface and
    // because the room's contract genuinely differs: a message is a row, everything else here is an
    // event about a list. `changes()` reads the shared block rather than copying it — a local copy
    // would be a second answer to 「订阅哪些表」, and the first answer is already the one
    // 013_realtime.sql is checked against.
    realtime: {
      watch: watch,
      changes: function () {
        var S = shared() || {};
        return typeof S.realtimeChanges === 'function' ? S.realtimeChanges() : [];
      },
      state: chatState,
    },
    news: { load: newsLoad },
    feedback: { submit: feedbackSubmit, mine: feedbackMine },

    // ---- 1.0.3 §一/§二/§三 -------------------------------------------------------------------
    members: { profile: memberProfile },
    friends: {
      list: friendsList,
      relation: friendRelation,
      request: friendRequest,
      act: friendAct,
      otherId: friendOtherId,
      // The two §1.2.5 budgets, read off the shared block so the view's 「今日还可发送 …」 and the
      // Function's refusal cannot disagree about the ceiling.
      quota: shareQuota,
    },
    shares: {
      send: shareSend, fetch: shareFetch, consume: shareConsume,
      fetchCloud: cloudShareFetch,
      inbox: shareInbox, sent: shareSent,
      isLive: shareIsLive,
    },
    votes: { forTarget: voteForTarget, create: voteCreate, cast: voteCast,
             close: voteClose, isOpen: voteIsOpen, POLL_MS: VOTE_TALLY_POLL_MS },
    reports: { submit: reportSubmit, mine: reportMine },
    notices: { list: noticesList, unread: noticesUnread, markRead: noticeMarkRead,
               markAllRead: noticesMarkAllRead },
    // ⚠ TWO DIFFERENT ANSWERS, TWO NAMES. `socket` is 「这个页面连着实时吗」 (for the dot column's
    // header); `forUser` is 「这个人在线吗」 (for every avatar). Collapsing them into one `state`
    // would be the shape this project keeps paying for.
    presence: { watch: presenceWatch, stop: presenceStop,
                socket: presenceStateOf, forUser: presenceStateFor,
                isLive: presenceIsLive, manualStatus: myManualStatus },
    settings: { patch: settingsPatch },

    // Pure protocol pieces. Exported for the suite: they are the only part of the socket that can
    // be exercised without a server, and the join frame's shape is the part that fails silently.
    _frames: {
      TOPIC: CHAT_TOPIC,
      join: joinFrame,
      heartbeat: heartbeatFrame,
      parse: parseFrame,
      rowFromChange: rowFromChange,
      changeFromFrame: changeFromFrame,
      presenceTopic: PRESENCE_TOPIC,
      presenceJoin: presenceJoinFrame,
      presenceTrack: presenceTrackFrame,
      presenceFrom: presenceFromFrame,
    },
  };

  // Same dual-export shape as storage.js / cloud.js: the browser gets `GMCommunity` on the global,
  // a Node suite gets the same object back from `require`.
  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMCommunity;
})(typeof globalThis !== 'undefined' ? globalThis : this);
