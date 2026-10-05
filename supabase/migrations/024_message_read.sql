-- 024_message_read.sql — 1.0.6 四号 §二.1.1 (P0): 「进入分区即标记为已读」.
--
--   users.friends_read_at   timestamptz   — 好友请求
--   users.shares_read_at    timestamptz   — 分享
--   users.mentions_read_at  timestamptz   — @提及
--   users.system_read_at    timestamptz   — 系统通知
--   users.reports_read_at   timestamptz   — 我的举报
--
-- (The spec splits this across `017_read_at.sql` and `018_notifications.sql`. The tree is at 022, so
-- this is 024 — see the header of 006_friends.sql. ⚠ THERE IS NO SECOND MIGRATION, BECAUSE THERE IS
-- ALREADY A `notifications` TABLE: 009_reports.sql created it, and it is the same object the spec's
-- §2.1.2 sketch is asking for. Its names differ and the mapping is exact — the spec's `type` is
-- `kind`, its `content` is `body`, its `link` is `data`, and its four proposed kinds
-- (`'admin-reply' | 'mute' | 'ban' | 'announcement'`) are already inside `notifications_kind_known`
-- as `'feedback_reply' | 'mute' | 'ban' | 'system'`. 013_realtime.sql already publishes it and
-- 011 §6 already gave it a self-only read policy and a two-column read write. Adding the spec's table
-- would be a SECOND inbox with a SECOND 「读过没有」 — the exact shape this project has paid for six
-- times. If a kind is missing, add it to the whitelist; do not add a table.)
--
-- ---------------------------------------------------------------------------------------------
-- ⚠⚠ THE READ WATERMARK AND `notifications.read` ARE NOT TWO ANSWERS TO ONE QUESTION
-- ---------------------------------------------------------------------------------------------
-- This is the paragraph to read before "unifying" anything, because the overlap looks total and is
-- not. §2.1.1 asks for a badge that disappears when you OPEN a partition, and the product already has
-- a per-row read flag. They answer two DIFFERENT questions:
--
--   「自上次进这个分区以来，有没有新的？」   ← THE WATERMARK (`users.*_read_at`). One value per
--                                             (account, category), moved when the partition opens.
--   「这一条我处理完了吗？」                 ← THE ROW STATE. `notifications.read` for the inbox,
--                                             `reports.status` for 我的举报, `friend_shares.consumed`
--                                             for 分享, `friendships.status` for 好友请求.
--
-- ⇒ A watermark that is newer than a row does NOT mean the row is handled, and a row marked read does
-- NOT mean the badge is clear. Both are true at once and they are both wanted: the badge answers
-- 「有什么新东西」, the row state answers 「我办完了没有」. Collapsing them would break one of the two —
-- marking a notification read by hand would clear the badge for its whole category (hiding the next
-- arrival), and opening the partition would tick every row as handled (silently lying about work not
-- done).
--
-- ⚠ THE ONE THING THAT MUST NOT BE DUPLICATED IS THE BADGE COUNT, and there is exactly one predicate
-- for it, stated here once: a row is NEW iff `created_at > coalesce(<category>_read_at, epoch)`. The
-- client computes the five counts with that predicate; nothing else counts anything. (Before this
-- file the 系统通知 badge was `count(notifications where read = false)` — a second answer, and the one
-- §2.1.1's 「红点仍显示」 bug came from: it measured 「处理完了吗」 while the user read it as 「有新东西吗」.)
--
-- ⚠ THE EPOCH DEFAULT IS LOAD-BEARING. `created_at > null` is NULL, not true, so a bare
-- `created_at > friends_read_at` counts NOTHING for an account that has never opened the partition —
-- i.e. every account, right up until its first visit, would be told it has no messages. The
-- `coalesce(…, '1970-01-01')` in the spec's own §2.1.1 snippet is what makes 「从未进入」 read as
-- 「所有都算新的」, and it is reproduced in the client's `unreadSince()` (shared block) so there is one
-- spelling of it rather than five.
--
-- ---------------------------------------------------------------------------------------------
-- ⚠ WHY THE WATERMARKS ARE COLUMNS ON `users` RATHER THAN A `message_reads` TABLE
-- ---------------------------------------------------------------------------------------------
-- A table keyed by (user_id, category) would be the tidier normal form, and it is the wrong shape
-- here for one concrete reason: the row is ALREADY IN HAND everywhere it is needed. `requireUser`
-- fetches the caller's `users` row on every authenticated call, `profile-get` returns it, and
-- `auth-login` / `auth-renew` project it into `toPublicUser` — so the five values travel with data
-- that is already being fetched. A side table costs a join (or a second round trip) per category on
-- the one screen whose whole complaint (§2.1.1) is that it felt stale, and it would need its own
-- RLS/grant surface to say something only its owner may read.
--
-- ⚠ AND THEY ARE THE USER'S OWN WRITE, WHICH IS ALREADY THE ESTABLISHED EXCEPTION. 011 §6 argues it
-- for `notifications.read`: a read flag is neither public nor moderated, so it does not need an Edge
-- Function the way a message or a vote does (「写只走 Edge Function」 is about content a server must
-- rate-limit or censor). The write is narrowed to these five columns by the grant below, so the same
-- path cannot be used to touch `platforms`, `role`, or anything else on the row.
--
-- ---------------------------------------------------------------------------------------------
-- ⚠ WHICH TABLE EACH CATEGORY READS, AND THE ONE SPLIT THAT IS NOT ONE TABLE PER CATEGORY
-- ---------------------------------------------------------------------------------------------
-- §2.1.2's five partitions and their sources (the client's `MESSAGE_CATEGORIES` in the shared block is
-- the same table, from the same five ids — one list, two realms):
--
--   friends    friendships      pending, requester ≠ me          §1.2.2
--   shares     friend_shares    to_user = me                     §1.2.4
--   mentions   notifications    kind = 'mention'                 §1.6.3
--   system     notifications    kind ≠ 'mention'                 §2.3.1 / §1.5.3
--   reports    reports          reporter_id = me                 §2.2 / §2.4
--
-- ⚠ `mentions` AND `system` ARE ONE TABLE PARTITIONED BY `kind`, WHICH IS WHY TWO WATERMARKS SIT ON
-- ONE SOURCE. The partition must stay TOTAL AND DISJOINT or a row lands in neither tab: every value
-- in `notifications_kind_known` belongs to exactly one of the two, and `'mention'` is the only kind
-- that goes left. Adding a kind to the whitelist means deciding which side it is on — a kind that is
-- neither is a notification that raises no badge and appears nowhere.
--
-- Idempotent: `add column if not exists`, and the grant is re-issued (granting twice is a no-op).

-- ---------------------------------------------------------------------------
-- 1. the five watermarks
-- ---------------------------------------------------------------------------
-- ⚠ NULLABLE AND UNCONSTRAINED, ON PURPOSE. `null` means 「从未进入过这个分区」, which is NOT the same
-- as `'1970-01-01'` for any purpose other than the count — the client uses the null to decide whether
-- to draw the partition's 「还没有…」 empty state or a list, and a sentinel epoch would make every
-- account look like it had visited every partition on the day the account was created. There is
-- nothing to check: any instant is a valid watermark, and the only values that matter are 「早于某行」
-- and 「晚于某行」.
--
-- ⚠ NO `default now()`. That would clear every badge for every existing account the moment this
-- migration ran — the feature would ship looking like it worked and would silently swallow the first
-- batch of messages for every account in the product.
alter table public.users add column if not exists friends_read_at  timestamptz;
alter table public.users add column if not exists shares_read_at   timestamptz;
alter table public.users add column if not exists mentions_read_at timestamptz;
alter table public.users add column if not exists system_read_at  timestamptz;
alter table public.users add column if not exists reports_read_at  timestamptz;

comment on column public.users.friends_read_at is
  '1.0.6 四号 §2.1.1 — the 好友请求 watermark: `friendships` rows newer than this are the badge. '
  '⚠ The BADGE, not the row state — 「这条处理完了吗」 is `friendships.status`. See 024''s header.';
comment on column public.users.shares_read_at is
  '1.0.6 四号 §2.1.1 — the 分享 watermark over `friend_shares` (to_user = me). ⚠ Opening the tab '
  'clears this dot even while an unconsumed share is still listed; `consumed` is the row state.';
comment on column public.users.mentions_read_at is
  '1.0.6 四号 §2.1.1 — the @提及 watermark over `notifications where kind = ''mention''`. ⚠ Same '
  'table as system_read_at, partitioned by kind; the partition must stay total and disjoint.';
comment on column public.users.system_read_at is
  '1.0.6 四号 §2.1.1 — the 系统通知 watermark over `notifications where kind <> ''mention''`. ⚠ NOT '
  'the same question as `notifications.read` (which row was handled) — see 024''s header.';
comment on column public.users.reports_read_at is
  '1.0.6 四号 §2.1.1 — the 我的举报 watermark over `reports` (reporter_id = me). ⚠ The row state is '
  '`reports.status`; the watermark only answers 「有没有别人动过我的举报」.';

-- ---------------------------------------------------------------------------
-- 2. the write, narrowed to these five columns
-- ---------------------------------------------------------------------------
-- The `users_update_self` policy (002_rls.sql) restricts the ROW to the caller's own; the grant
-- restricts the COLUMNS to these five. ⚠ BOTH ARE NEEDED — a policy is row-level and would happily
-- let the caller rewrite their own `role` column if the grant allowed it. This is the same two-part
-- arrangement 011 §4 uses for `hide_country` / `manual_status`, and it is why that file's grant is
-- left alone rather than replaced.
--
-- ⚠ NOT granted, and the reasons are the same ones 011 §4 lists: `platforms` / `last_platform` /
-- `last_platform_at` (server-observed — see 023's header), `country_code` / `last_seen_at` (ditto),
-- `muted_until` / `role` / `is_banned` (administrative). A read watermark is the only kind of column
-- on this table whose correct value is known to the client alone.
grant update (friends_read_at, shares_read_at, mentions_read_at, system_read_at, reports_read_at)
  on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 3. what this file deliberately does NOT change
-- ---------------------------------------------------------------------------
-- ⚠ `notifications` IS UNTOUCHED — no column, no policy, no index. Its `read` / `read_at` columns and
-- the 「这条已读」 button keep working exactly as 011 §6 defined them; they are the ROW STATE described
-- in the header, not the badge. `idx_notifications_unread` (009) still serves 「未处理的系统通知」.
--
-- ⚠ `friend_shares` / `reports` / `friendships` ARE UNTOUCHED for the same reason. §2.1.2's 分享 tab
-- keeps rendering `consumed` (「已接收」 vs not) and its 15-minute `expires_at` rule (011 §6) — what
-- changes in this release is only the BADGE, which now counts 「比水位新的分享」 instead of 「未过期的
-- 分享」. ⚠ That IS a behaviour change and it is the spec's: §2.1.1 says 「进入分区即标记为已读」, so
-- opening 分享 clears its dot even while an unconsumed share is still listed inside.
--
-- ⚠ AND NO RETENTION / PRUNING. A watermark is a scalar; there is nothing to grow.
