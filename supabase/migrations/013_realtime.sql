-- 013_realtime.sql — 1.0.4 §P1: make Realtime actually deliver.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------------------------
-- `community.js` has spoken the Phoenix protocol by hand since 1.0.2 and 1.0.3 added a second
-- socket for presence. Both `phx_join` payloads declare `postgres_changes` subscriptions — and
-- until this file, `supabase_realtime` was a publication with **zero tables in it**:
--
--     select c.relname from pg_publication p
--       left join pg_publication_rel pr on pr.prpubid = p.oid
--       left join pg_class c on c.oid = pr.prrelid
--      where p.pubname = 'supabase_realtime';        -- -> one row, relname = NULL
--
-- A publication with no members accepts the join and then never emits a change. ⇒ Every
-- 「实时」 surface in this product has been the 6-second poller (`RT_POLL_MS`) wearing the word
-- 实时, and `RT.status` has been reporting `'live'` while delivering nothing — the join succeeds,
-- so the client's own state machine cannot tell.
--
-- ⚠ THE FAILURE MODE IS WHY THIS WAS INVISIBLE: nothing errors. The socket connects, joins, and
-- stays quiet; the poller fills in every message a few seconds late, so the room looks like it
-- works. There is no log line anywhere that says 「this table is not replicated」. Only comparing
-- `pg_publication_tables` with the tables the client subscribes to finds it — which is what
-- `verify-066` now does for every name below.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT GOES IN, AND ON WHICH EVENT
-- ---------------------------------------------------------------------------------------------
-- The list is `REALTIME_TABLES` in `_shared/community.ts`'s shared block, and `verify-066` pins
-- these two lists equal. It is the client that subscribes, so the client's list is the authority
-- and this file follows it — not the other way round.
--
--   chat_messages   INSERT         §2.3 — a new message
--   friendships     *              §1.2.1 — a request / accept / block is an UPDATE
--   friend_shares   *              §1.2.3 — arrival is an INSERT, 「已接收」 an UPDATE
--   notifications   *              §1.5.3 — an @提及 / 警告 arriving, and 「已读」 coming back
--   votes           *              §1.4 — a poll opening / closing / being closed by hand
--   news            *              §2.4 — an entry published while the feed is open
--   feedback        *              §2.5 — an admin reply landing on the submitter's own row
--
-- ⚠ `vote_ballots` IS DELIBERATELY ABSENT, and it is the one entry a reader should stop on.
-- §七.3 makes the poll anonymous and 011_rls_community.sql gives ballots a self-only SELECT policy
-- (`auth.uid() = user_id`). Realtime enforces the SAME policies on the rows it delivers — so
-- publishing ballots would deliver each subscriber exactly the ballots they may already read,
-- i.e. their own, and nothing else. The tally lives in the `vote_tally` VIEW, and a view is not a
-- table a publication can carry. ⇒ Counts are refreshed by the poller while a poll is on screen
-- (see `votes/tally` in community.js). The alternative — broadcasting 「有人投了 B」 to the room —
-- is a different feature (§七.3 does not ask for it) and would leak the shape of the room's
-- choices in real time. Not doing it is the anonymity decision, not an omission.
--
-- ⚠ `replica identity full` ON EVERY TABLE SUBSCRIBED WITH `*`. Realtime evaluates RLS against the
-- row it is about to send; on an UPDATE and a DELETE the row that carries the predicate is the OLD
-- one, and the default replica identity ships only the primary key. Without this, an RLS-protected
-- table silently drops UPDATE and DELETE events — the same class of quiet failure this whole file
-- exists to fix. `chat_messages` is the exception ON PURPOSE: it is subscribed INSERT-only (a
-- message is never edited), so it keeps the default identity and pays no extra WAL. It is the one
-- table here that grows to millions of rows.
--
-- Idempotent: the loop skips a table that is already published, so re-running `db push` on a
-- project where someone added one by hand is a no-op rather than an error (42710, 「already member
-- of publication」).

-- ---------------------------------------------------------------------------
-- 1. the publication membership
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
  wanted text[] := array[
    'chat_messages', 'friendships', 'friend_shares', 'notifications',
    'votes', 'news', 'feedback'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Supabase creates this publication with every project; a project where it is missing is not
    -- one this migration should guess about. Fail loudly rather than create it with different
    -- settings (a recreated publication would drop `publish_via_partition_root` etc.).
    raise exception 'publication supabase_realtime is missing — enable Realtime for this project';
  end if;

  foreach tbl in array wanted loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. replica identity for everything subscribed with event '*'
-- ---------------------------------------------------------------------------
-- Written as its own loop, keyed on the same list minus the INSERT-only table, so 「which table
-- needs FULL」 is one readable sentence rather than a footnote on each `alter`.
do $$
declare
  tbl text;
  full_identity text[] := array[
    'friendships', 'friend_shares', 'notifications', 'votes', 'news', 'feedback'
  ];
begin
  foreach tbl in array full_identity loop
    execute format('alter table public.%I replica identity full', tbl);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. the correction 005/011 could not make
-- ---------------------------------------------------------------------------
-- Both of those files describe the room as 「实时」 in a comment that predates working Realtime.
-- The wording is corrected here for the same reason 011 corrected 005's table comment: a comment
-- is the one change a migration can make to a shipped file without re-running it, and a reader who
-- greps for 「实时」 should land on the sentence that is true.
comment on table public.chat_messages is
  '公共聊天室 messages (§2.3.2). Written only by the chat-send Edge Function; read by every member '
  '(§1.8.1: 未激活只读, so is_member() rather than is_activated()). 1.0.4: published to '
  'supabase_realtime (INSERT) — see 013_realtime.sql for why that was missing until then.';

comment on table public.notifications is
  '§1.5.3 系统通知 + §1.6 @提及 + §2.3.1 警告. Written by admin-handle-report and chat-send (service '
  'role); the ONLY client write in the product is 「这条已读」, narrowed to (read, read_at). '
  '1.0.4: published to supabase_realtime with replica identity full.';
