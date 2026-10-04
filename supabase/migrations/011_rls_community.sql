-- 011_rls_community.sql — §一.8 (P0) and the whole read surface of 1.0.3, in one file.
--
-- This file does three jobs, and they are together because they are one decision: WHO MAY READ
-- WHAT. 1.0.3 makes the community readable by accounts that have not activated (§1.8.1's ✅ column),
-- which means the read gate is no longer 「已激活」 and every table added by 006..010 has to say what
-- its gate is.
--
--   1. `is_member()` — the new read predicate, and the two policies 005_community.sql wrote with
--      `is_activated()` are rewritten to use it. That rewrite IS §1.8's P0.
--   2. The read policy of every table this release adds.
--   3. The read/write grants on `users` that §1.3 (他人主页) and §3.1.6 (隐藏国籍) need.
--
-- (Renumbered from the spec's 010 — see the header of 006_friends.sql.)
--
-- ⚠⚠ WHAT THIS FILE DELIBERATELY DOES NOT DO, AND WHY IT IS THE MOST IMPORTANT PARAGRAPH IN IT
-- ---------------------------------------------------------------------------------------------
-- §1.8.2 asks for a `chat_insert` INSERT policy on chat_messages, and §2.4 repeats the shape for
-- 「所有需要「发言」的操作」, so that a cracked client is still stopped by the database:
--
--     create policy "chat_insert" on chat_messages for insert with check ( ... )
--
-- It is NOT created, here or anywhere. 005_community.sql already explains the first half —
-- 「频率限制 每分钟最多 10 条」 and 「敏感词过滤」 cannot be evaluated by RLS, which sees a row and
-- not a history and not a word list — and 1.0.3 adds a second, sharper reason: an INSERT policy
-- checks `auth.uid() = user_id` and lets the row through, so a client that skips `chat-send` can
-- write a message carrying a `mentioned_users` array nobody resolved, an `attachment` whose
-- `cloud_id` points at a row the author never shared, and a `reply_preview` attributed to whoever
-- it likes. §1.6 and §1.7 turn those three columns into NAVIGATION AND NOTIFICATION, so a forged
-- one is a forged push into somebody else's 消息 list.
--
-- ⇒ §1.8's intent — 「客户端被破解后，服务端 RLS 依然拦截」 — is honoured, by the server, one layer
-- up: every write in this release goes through an Edge Function, and each of them re-reads the
-- account row and refuses on `activated_at is null` / `is_banned` / `muted_until > now()`. The
-- checks §1.8.2 wanted inside a policy are the same checks, in the only place that can also count
-- a rate limit and read a word list. RLS's job stays what 005_community.sql made it: no client
-- write policy at all means `authenticated` is refused outright, so the Function is not merely the
-- intended path — it is the only one that exists.
--
-- ⚠ The consequence a reader should notice: §1.8.2's sample policy tests `users.is_muted`, a column
-- 010_users_ext.sql does not create. See that file's header — the mute is `muted_until > now()`.
--
-- Idempotent: every policy is preceded by `drop policy if exists`, every function is
-- `create or replace`.

-- ---------------------------------------------------------------------------
-- 1. is_member() — §1.8.1's read predicate, in one place
-- ---------------------------------------------------------------------------
-- §1.8.1 turns 社区 into 「未激活只读」: the four READ rows are ✅ for 未激活, the six WRITE rows are
-- ❌. So the read gate stops being 「已激活」 and becomes 「是一个有效账号」 — authenticated, not
-- banned, not soft-deleted, and nothing about `activated_at`.
--
-- Same shape and reasoning as `is_activated()` / `is_admin()`: SECURITY DEFINER (it reads the
-- caller's own row, which RLS on `users` would otherwise hide from this policy), STABLE (answered
-- once per statement), and read from the DATABASE rather than from a claim on the token.
--
-- ⚠ WHY NOT 「NO POLICY AT ALL」 FOR THE PUBLIC TABLES: `using (true)` would also admit the anon
-- role, and the anon key is shipped in the extension — every 「读得到」 table would then be readable
-- by anyone who looks at the source. §1.8.1's ✅ is about ACCOUNTS, not about the internet.
--
-- ⚠ A banned account keeps its token until it expires (up to 30 days), so `is_banned = false` in
-- this predicate is what makes 封禁 take effect on the read side immediately rather than at the
-- next login. `deleted_at is null` is §4.2's 30-day retention: the row is on its way out and must
-- not keep reading the room.
create or replace function public.is_member() returns boolean language sql stable security definer as $$
  select coalesce((
    select u.is_banned = false and u.deleted_at is null
    from public.users u where u.id = auth.uid()
  ), false)
$$;

comment on function public.is_member() is
  '1.0.3 §1.8.1 — may this account READ the community? Authenticated, not banned, not deleted; '
  'activation is deliberately not tested (未激活只读). Writes are gated in the Edge Functions.';

-- ---------------------------------------------------------------------------
-- 2. §1.8 P0 — the two 1.0.2 read policies move from is_activated() to is_member()
-- ---------------------------------------------------------------------------
-- These two `drop`/`create` pairs are the entire client-visible change of §1.8.1: before them the
-- room and the news feed answer 401-shaped emptiness to an unactivated account, and after them they
-- answer rows. Everything else in this section is the same policy text with a different predicate.
--
-- ⚠ `is_activated()` is NOT dropped, and it is not dead: see §5, where it gates the `temp-shares`
-- bucket. It remains the SQL spelling of 「这个账号激活过」 for the parts of the product where that
-- still decides something.
drop policy if exists chat_read on public.chat_messages;
create policy chat_read on public.chat_messages
  for select
  using (public.is_member());

drop policy if exists news_read on public.news;
create policy news_read on public.news
  for select
  using (public.is_member());

-- The table comment 005_community.sql left says 「read by every activated account」, which §1.8.1
-- has just made untrue. Corrected here rather than edited there, because 005 is already applied on
-- the operator's remote and a comment is the one change a migration can make to a shipped file
-- without re-running it.
comment on table public.chat_messages is
  '公共聊天室 messages (§2.3.2). Written only by the chat-send Edge Function; read by every member '
  '(§1.8.1: 未激活只读, so is_member() rather than is_activated()).';

comment on table public.news is
  '§2.4 更新日志 + 管理员公告. Written only by admin-publish-news; read by every member (§1.8.1).';

-- ---------------------------------------------------------------------------
-- 3. §1.3 他人主页 — the public projection of an account
-- ---------------------------------------------------------------------------
-- 002_rls.sql's only SELECT policies on `users` are `users_select_self` and `users_admin_select_all`,
-- so today a client literally cannot read anybody else's row — which is fine until §1.3 asks it to
-- draw a 他人主页 with 「加入时间 / 样本库 42 个 / 🇨🇳 中国大陆」 on it.
--
-- ⚠ AN RLS POLICY IS ROW-LEVEL, SO ALONE IT WOULD ALSO PUBLISH `email`. The row predicate below
-- says WHICH ROWS are public; the column grant says WHICH COLUMNS are, and both are needed. This is
-- the same two-part arrangement 002_rls.sql already uses for updates
-- (`revoke update … grant update (username, bio, avatar_url)`), applied to reads.
--
-- ⚠ WHAT THIS BREAKS, CHECKED BEFORE WRITING IT: nothing. The extension never queries `users`
-- through PostgREST — its own profile comes from `profile-get` (service role), and the 管理 panel's
-- user list from `admin-list-users`. `sync.js` touches `user_kv`, `samples`, `archives`. So the
-- grant can be narrowed to the public columns without a single existing call losing a column it
-- reads. ⚠ If a future change adds a PostgREST read of `users`, it will get a 401 on `email` rather
-- than a silent leak — which is the failure mode to want.
drop policy if exists users_select_public on public.users;
create policy users_select_public on public.users
  for select to authenticated
  using (deleted_at is null and is_banned = false);

revoke select on public.users from authenticated;
-- The public projection: §1.3.1's four lines (用户名 / 加入时间 / 样本库数量 / 国籍) plus the
-- status dot. `is_admin` is included because the room and the profile badge it. `last_seen_at` is
-- included because §3.2.4's 「在线/离线」 is derived from it and the client computes 离线 as
-- 「超过 5 分钟」 — publishing the timestamp publishes exactly the same fact as the dot, and lets
-- the client keep the dot live without polling a Function.
--
-- ⚠ `email` is NOT granted. `hide_country` IS granted — it is not a secret (it is a display switch)
-- and the reader needs it to decide 白旗 vs 国旗. `muted_until` IS granted: §2.4's client half asks
-- 「你已被禁言至 …」, and that is a fact about the caller's own account that the caller must be able
-- to see; it is not rendered for anybody else, and a mute is not a secret from its subject.
grant select (id, username, avatar_url, bio, created_at, activated_at, is_admin,
              country_code, hide_country, manual_status, last_seen_at, muted_until)
  on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 4. §3.1.6 / §3.2.3 — the two settings the USER owns
-- ---------------------------------------------------------------------------
-- 002_rls.sql granted `update (username, bio, avatar_url)`. §3.1.6's 「隐藏国籍」 and §3.2.3's 「在线
-- 状态」 are user-owned settings of the same kind, so they join that grant rather than getting a new
-- door. The `users_update_self` policy already restricts the rows to the caller's own.
--
-- ⚠ NOT granted: `country_code` / `country_updated_at` / `last_seen_at` (server-observed — a client
-- that could write its own country could claim any flag, which would make §3.1 a claim rather than
-- an observation), `muted_until` (§2.3.1's ladder is administrative), `is_admin` / `is_banned` /
-- `token_epoch` / `deleted_at` (001's and 002's original reasoning).
grant update (hide_country, manual_status) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 5. the `temp-shares` bucket (§1.2.3 / §1.2.4)
-- ---------------------------------------------------------------------------
-- Private, and the only consumer of `is_activated()` after this file's §2. §1.2.3 stores a share's
-- bytes here when the payload is 「超出 [500KB]」.
--
-- ⚠ THE PRIMARY DOWNLOAD ROUTE IS A SIGNED URL MINTED BY `friend-share`, not a direct Storage call:
-- the Function checks that the caller is the recipient (or the sender), that the share has not
-- expired and that it has not been consumed, and only then signs. A signed URL is authorised by its
-- signature, so it needs no policy.
--
-- The policy below is therefore defence in depth, and it is deliberately narrower than
-- 「已激活即可」: it admits only the two accounts a live share connects. Without it the bucket would
-- be readable by any activated account that knew an object name — an object name is not a secret,
-- it is the thing the client was handed.
insert into storage.buckets (id, name, public)
values ('temp-shares', 'temp-shares', false)
on conflict (id) do nothing;

drop policy if exists temp_shares_read on storage.objects;
create policy temp_shares_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'temp-shares'
    and public.is_activated()
    and exists (
      select 1 from public.friend_shares s
      where s.storage_url = storage.objects.name
        and (s.from_user = auth.uid() or s.to_user = auth.uid())
        and s.expires_at > now()
    )
  );

-- No INSERT / UPDATE / DELETE policy on this bucket: `friend-share` uploads with the service role,
-- and `friend-share-purge` deletes the same way. §1.2.4 makes the deletion a promise, so it happens
-- on a clock rather than when the recipient remembers to clean up.

-- ---------------------------------------------------------------------------
-- 6. the read policies of every table 006..010 added
-- ---------------------------------------------------------------------------
-- All SELECT, all `to authenticated`, all gated on `is_member()` unless the data is narrower than
-- the community. Written out one per table rather than as one comment, because 「谁能读到这一行」
-- is the question a reviewer will have, and a table with no policy is refused — which is a silent
-- feature outage rather than a visible error.

-- §1.2.1 — a friendship is visible to the two people in it, and to nobody else. Note this covers
-- BOTH directions in one predicate: the pair is ordered, so a request from either side matches.
drop policy if exists friendships_read_involved on public.friendships;
create policy friendships_read_involved on public.friendships
  for select to authenticated
  using (public.is_member() and auth.uid() in (user_a, user_b));

drop policy if exists friendships_read_admin on public.friendships;
create policy friendships_read_admin on public.friendships
  for select to authenticated
  using (public.is_admin());

-- §1.2.3 — a share is visible to its sender (so 「发送成功」 can be confirmed) and to its recipient.
-- ⚠ `expires_at > now()` is IN the policy, not only in the query the client sends: §1.2.4's
-- 「15 分钟后数据消失」 must hold for a client that simply asks for the row, and the purge job is
-- allowed to be late (or never enabled).
drop policy if exists friend_shares_read_involved on public.friend_shares;
create policy friend_shares_read_involved on public.friend_shares
  for select to authenticated
  using (
    public.is_member()
    and (auth.uid() = to_user or auth.uid() = from_user)
    and expires_at > now()
  );

-- §1.1.2 / §1.1.3 — a room share is public BY DESIGN (that is the difference from §1.2.3's friend
-- share), so the gate is the community itself. ⚠ `expires_at > now()` is in the policy, not only in
-- the query: §1.1.2's 「保留时间与普通消息一致（7 天）」 has to hold for a client that just asks for
-- the row, and the room's own read window is enforced the same way (1.0.2's chatRetentionCutoff).
drop policy if exists cloud_shares_read_community on public.cloud_shares;
create policy cloud_shares_read_community on public.cloud_shares
  for select to authenticated
  using (public.is_member() and expires_at > now());

-- §1.2.5 — your own counters. Read so the client can show 「今日还可发送 7 个」 before it tries.
drop policy if exists daily_quotas_read_self on public.daily_quotas;
create policy daily_quotas_read_self on public.daily_quotas
  for select to authenticated
  using (public.is_member() and auth.uid() = user_id);
drop policy if exists daily_quotas_read_admin on public.daily_quotas;
create policy daily_quotas_read_admin on public.daily_quotas
  for select to authenticated
  using (public.is_admin());

-- §1.4.3 — a poll exists to be read by the community. §1.4 / §七.5 attach it to a CLOUD-shared item,
-- so the row itself carries no private data; the ballots do, and those are next.
drop policy if exists votes_read_community on public.votes;
create policy votes_read_community on public.votes
  for select to authenticated
  using (public.is_member());

-- ⚠ §七.3 「匿名投票，仅显示票数」 — YOU may read YOUR OWN ballot (so the radio comes back selected
-- when the page reloads) and nobody else's. The counts do not come from here; they come from
-- `public.vote_tally`, which aggregates under `security_invoker = false` and cannot be
-- un-aggregated. A policy that admitted every member would publish 「谁投了什么」 and quietly turn
-- the poll into a public vote.
drop policy if exists vote_ballots_read_self on public.vote_ballots;
create policy vote_ballots_read_self on public.vote_ballots
  for select to authenticated
  using (public.is_member() and auth.uid() = user_id);

-- §2.4 / §2.3.4 — 「我提交的举报」 for the reporter; everything for an admin. Same two-policy shape
-- 005_community.sql gave `feedback`, for the same reason.
drop policy if exists reports_read_own on public.reports;
create policy reports_read_own on public.reports
  for select to authenticated
  using (auth.uid() = reporter_id);

drop policy if exists reports_read_admin on public.reports;
create policy reports_read_admin on public.reports
  for select to authenticated
  using (public.is_admin());

-- §1.5.3's 系统通知 inbox. ⚠ THIS IS THE ONE TABLE IN 1.0.3 WITH A CLIENT **WRITE** POLICY, and the
-- exception is deliberate rather than an oversight:
--
--   * What the client writes is 「这条已读」 — a fact about the reader, with no moderation value and
--     no effect on anybody else. The rows are created only by `admin-handle-report` (service role),
--     and no user can forge one.
--   * The precedent is `samples` / `archives` / `user_kv` (002_rls.sql), which are per-user private
--     data written straight through PostgREST under RLS. The rule 005_community.sql states — 「写只
--     走 Edge Function」 — is about PUBLIC and MODERATED data, where the server has to count a rate
--     limit or read a word list. A read flag is neither.
--   * Column-level grants below keep the write to exactly two columns, so the same policy cannot be
--     used to rewrite `kind`/`body` — i.e. to forge a 警告 from an existing row.
drop policy if exists notifications_read_own on public.notifications;
create policy notifications_read_own on public.notifications
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Belt and braces: with the table grant intact, `update notifications set body = ...` would be
-- permitted by the policy above. Narrowing the grant to the two flag columns is what makes the
-- policy's `with check` about ROWS rather than about CONTENT.
revoke all on public.notifications from authenticated;
grant select on public.notifications to authenticated;
grant update (read, read_at) on public.notifications to authenticated;

drop policy if exists notifications_read_admin on public.notifications;
create policy notifications_read_admin on public.notifications
  for select to authenticated
  using (public.is_admin());

-- §2.3.2 / §2.3.3 — the two product-wide switches. ⚠ CORRECTION (1.0.3 安全修订): the earlier wording
-- here claimed 「read by every client on every send (the 聊天室 input is disabled when `chat_enabled`
-- is false)」. That was never true — the client does not read this table at all; §2.3.2's
-- 「所有人不能发消息」 is enforced by `chat-send`, which reads the switch and fails CHAT_DISABLED.
-- The gate is 「已登录」 rather than 「是社区成员」 (`is_member()`) so that a banned or unactivated
-- account could still be told WHY the input is closed, and because there is no private data in two
-- booleans. (An even earlier cut of this file had the policy right and 009's `enable row level
-- security` missing — which made this policy decorative; see 012_global_settings_rls.sql.)
drop policy if exists global_settings_read_all on public.global_settings;
create policy global_settings_read_all on public.global_settings
  for select to authenticated
  using (true);
