-- 005_community.sql — §二 社区互动: the three tables the 社区 view reads and writes.
--
--   public.chat_messages — §2.3.2 verbatim (public room, 全部已激活用户共享一个)
--   public.news          — §2.4.2 verbatim (更新日志 + 管理员公告, 多语言)
--   public.feedback      — §2.5.2 verbatim (Bug 与建议 → 管理员信箱)
--
-- ⚠ THE FILE NAME IS NOT THE SPEC'S. §实现清单 calls this `004_community.sql`, but 004 was taken by
-- `004_email_codes.sql` in 1.0.1 — the 定稿 was written against a tree where 1.0.1's migration did
-- not exist yet. Renumbering is the only option (the CLI orders migrations by filename prefix), and
-- this is the same 「公式 vs 示例」 case this project has met three times: the spec's SHAPE is the
-- requirement, the NUMBER is an artefact of when it was written.
--
-- Idempotent, like every other migration here: `supabase db push` re-runs safely, which matters
-- because the operator's remote `supabase_migrations` table is empty and a push therefore replays
-- 001..005. Every `create policy` is preceded by a `drop policy if exists`.
--
-- ---------------------------------------------------------------------------------------------
-- HOW THE SHARED-READ TABLES ARE GATED, AND WHERE THAT DIFFERS FROM THE SPEC'S SAMPLE POLICIES
-- ---------------------------------------------------------------------------------------------
-- §2.1 says 社区 is 「仅对已激活用户开放」 and §2.4.1 says its reader is 「所有已激活用户」. That is
-- the requirement. §2.3.3 / §2.4.3 / §2.5.3 then give SAMPLE policies, and two of the samples do
-- not express it:
--
--   * §2.3.3's `chat_read` checks `is_banned = false and deleted_at is null` but NOT activation, so
--     an account that holds a valid token without ever redeeming a code could read the room.
--   * §2.4.3's `news_read` is `using (true)` — 「所有人可读」, i.e. the anon key alone, which is
--     weaker than §2.4.1's own table one page above it.
--   * §2.5.3's `feedback_insert` lets the client write the row directly.
--
-- ⇒ WHAT SHIPS: one predicate, `public.is_activated()`, shared by every read policy below, and NO
-- client-side INSERT on any of the three tables — `chat-send` / `feedback-submit` /
-- `admin-publish-news` / `admin-reply-feedback` (service role) are the only writers.
--
-- The reason for the second half is §2.3.5's own safeguards. 「频率限制 每分钟最多 10 条」 and
-- 「敏感词过滤 客户端 + 服务端双重」 cannot be enforced by a policy: RLS sees a row, not a history
-- and not a word list. A client able to INSERT directly can therefore post an 11th message, or a
-- filtered one, by skipping the Function — the limits would be decoration. This is the SAME line the
-- codebase already draws between `samples`/`archives` (private per-user data, written straight
-- through PostgREST under RLS, §11.1) and `badges`/`activation_codes` (shared or privileged data,
-- written only through Edge Functions). Chat and feedback are the second kind: they are PUBLIC
-- (every activated account reads them) and they are MODERATED.
--
-- Reads stay on PostgREST under RLS, because that is what §2.2 asks for and it is what makes the
-- room realtime: Realtime authorises a subscription with the same policies a SELECT uses, so the
-- INSERT push the client listens for arrives only if the client may read the row.

-- ---------------------------------------------------------------------------
-- is_activated() — the §2.1 predicate, in one place.
-- ---------------------------------------------------------------------------
-- Same shape and same reasoning as `public.is_admin()` (002_rls.sql): SECURITY DEFINER so it can
-- read the caller's own `users` row, STABLE so it is answered once per statement, and read from the
-- DATABASE rather than from any claim on the token. `activated_at` is the column both activation
-- paths stamp (`auth-activate`, and `auth-register` for the two-step flow), so this is the same
-- test `GMAuth.gateOpen()` makes on the client — and unlike the client's, this one is a gate.
create or replace function public.is_activated() returns boolean language sql stable security definer as $$
  select coalesce((
    select u.activated_at is not null and u.is_banned = false and u.deleted_at is null
    from public.users u where u.id = auth.uid()
  ), false)
$$;

-- ---------------------------------------------------------------------------
-- 1. chat_messages (§2.3.2)
-- ---------------------------------------------------------------------------
-- §2.3.2's columns verbatim. `user_id` is nullable in the spec's sample; here it is `not null`,
-- because a message nobody wrote cannot be attributed, deleted or rate-limited — and 0.5.x-era
-- archives are full of the alternative (a row that names a player but has no id), which is exactly
-- how 「同一个玩家两个昵称」 starts.
create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  username   text,
  avatar_url text,
  content    text not null,
  created_at timestamptz not null default now()
);

comment on table public.chat_messages is '公共聊天室 messages (§2.3.2). Written only by the chat-send Edge Function; read by every activated account.';

-- `username` / `avatar_url` are §2.3.2's deliberate DENORMALISATION, and the reason is worth
-- keeping: the room renders 500 rows at a time, and joining `users` for each one would both cost a
-- round trip per page and make a rename rewrite history (the message would claim a name its author
-- never used). They are a SNAPSHOT, not a cache — do not "fix" them by joining.

-- §2.3.2's index, verbatim.
create index if not exists idx_chat_messages_created on public.chat_messages (created_at desc);
-- Not in the spec: the 60-second rate limit counts one user's recent rows, and it runs on the
-- critical path of every send. Without this it is a sequential scan of the whole room.
create index if not exists idx_chat_messages_user_time on public.chat_messages (user_id, created_at desc);

alter table public.chat_messages enable row level security;

-- §2.3.3's `chat_read`, with §2.1's activation requirement folded in (see the header).
drop policy if exists chat_read on public.chat_messages;
create policy chat_read on public.chat_messages
  for select
  using (public.is_activated());

-- ⚠ DELIBERATELY NO `chat_insert`, `chat_update` OR `chat_delete` POLICY.
-- No insert: see the header — the rate limit and the word filter live in `chat-send`, and a policy
-- that lets the client write the row bypasses both. No update/delete: §2.3.5 puts 举报机制 out of
-- scope for the MVP and §六.2's default is 「不提供，只在服务端做敏感词过滤」, so there is no
-- moderation verb to grant. With RLS enabled and no policy, PostgREST refuses those verbs outright.
--
-- Admins read the room the same way everybody else does — there is nothing extra to see — so there
-- is no `is_admin()` policy here either. Adding one later for a moderation tool is a one-line
-- change; adding it now would grant a verb nothing in the UI performs.

-- ---------------------------------------------------------------------------
-- 2. news (§2.4.2)
-- ---------------------------------------------------------------------------
-- §2.4.2's columns verbatim, with `not null` on the four a card cannot be rendered without.
-- `translations` is JSONB keyed by language code (§2.4.4), and it stays nullable-but-defaulted so a
-- row written before its translations existed is still renderable.
create table if not exists public.news (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid references public.users(id) on delete set null,
  category     text not null default 'announcement',
  title        text not null,
  content      text not null,
  lang         text not null default 'zh-CN',
  translations jsonb not null default '{}'::jsonb,
  published_at timestamptz not null default now(),
  is_pinned    boolean not null default false
);

comment on table public.news is '更新日志 + 管理员公告 (§2.4). Published through admin-publish-news; read by every activated account.';

-- `author_id` is `on delete set null` rather than cascade: a news item outlives its author (§4.2
-- keeps a deleted account's row for 30 days, and a 更新日志 entry is history), and the projection
-- the client reads carries no author id anyway.

-- §2.4.2's index, plus `is_pinned` first because that is the ORDER BY the list actually uses —
-- pinned first, then newest, which is one index rather than a sort.
create index if not exists idx_news_published on public.news (published_at desc);
create index if not exists idx_news_feed on public.news (is_pinned desc, published_at desc);

alter table public.news enable row level security;

-- §2.4.3's `news_read` is `using (true)`; §2.4.1's table says the reader is 「所有已激活用户」.
-- The narrower of the two ships (see the header). It costs nothing visible — §2.1 shows the 社区
-- button to activated accounts only — and it keeps the anon key from being a content endpoint.
drop policy if exists news_read on public.news;
create policy news_read on public.news
  for select
  using (public.is_activated());

-- No INSERT/UPDATE/DELETE policy. §2.4.3's `news_insert` required `is_admin` in SQL; that check
-- already exists in `admin-publish-news` (and in `requireAdmin` behind it), and having it in one
-- place is the reason `users_admin_select_all` in 002_rls.sql is read-only too. Note that RLS
-- cannot express 「the title of a published entry may not change」 — the Function can.

-- ---------------------------------------------------------------------------
-- 3. feedback (§2.5.2)
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  username    text,
  email       text,
  category    text not null default 'other',
  title       text not null,
  content     text not null,
  status      text not null default 'open',
  admin_reply text,
  replied_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.feedback is 'Bug 与建议 with the admin reply (§2.5). Written by feedback-submit and admin-reply-feedback; a user reads their own rows.';

-- `username` / `email` are §2.5.2's denormalisation and serve a different purpose from the chat
-- room's: §2.5.6 recommends the admin reads this in Studio, where a join is possible but awkward,
-- and the reply mail (§2.5.7) needs an address even after the account is gone.

-- §2.5.2's index, verbatim.
create index if not exists idx_feedback_status on public.feedback (status, created_at desc);
-- Not in the spec: §2.5.5's 「我的提交」 is `where user_id = auth.uid()` ordered by time.
create index if not exists idx_feedback_user_time on public.feedback (user_id, created_at desc);
-- Not in the spec: §2.5.5's rate limit (feedback-submit's, see there) counts one user's recent rows.
create index if not exists idx_feedback_user_created on public.feedback (user_id, created_at desc);

alter table public.feedback enable row level security;

-- §2.5.3's `feedback_read_own` + `feedback_read_admin`, both verbatim: a user reads their own, an
-- admin reads all. Two policies rather than one `or` so the reason each exists stays legible.
drop policy if exists feedback_read_own on public.feedback;
create policy feedback_read_own on public.feedback
  for select
  using (auth.uid() = user_id);

drop policy if exists feedback_read_admin on public.feedback;
create policy feedback_read_admin on public.feedback
  for select
  using (public.is_admin());

-- ⚠ §2.5.3's `feedback_insert` and `feedback_update_admin` are NOT created — same reasoning as
-- chat_messages, plus one specific to this table:
--   * insert — `feedback-submit` validates the category, caps the lengths and rate-limits the
--     submitter. A direct insert posts an unbounded row straight into the admin's inbox, which is
--     the one table in this schema where 「垃圾进垃圾出」 costs a human being their morning.
--   * update — §2.5.3's policy let ANY admin update ANY column. The one legitimate write is a reply,
--     and `admin-reply-feedback` writes exactly the four columns a reply owns (`admin_reply`,
--     `replied_at`, `status`, `updated_at`) and mails the user. RLS would have permitted a status
--     change with no reply, which is a state §2.5.6's filter list cannot represent.
-- Note what does the work here: with RLS on and no policy, `authenticated` is refused even though
-- the table has a default grant.

-- ---------------------------------------------------------------------------
-- 4. housekeeping (§2.3.5 「历史保留 最近 7 天（定时清理）」)
-- ---------------------------------------------------------------------------
-- Shipped commented, exactly like 004_email_codes.sql's purge, and for the same reason: pg_cron has
-- to be enabled per project (Dashboard → Database → Extensions) and a migration that enables an
-- extension the operator has not opted into is not this file's call. `docs/DEPLOY.md` walks through
-- it. Until then the room is trimmed on READ — the chat history query filters on the same window —
-- so the visible behaviour is already §2.3.5's, and the rows are merely still on disk.
--
--   select cron.schedule('baishen-purge-chat', '30 4 * * *', $$
--     delete from public.chat_messages where created_at < now() - interval '7 days';
--   $$);
--
-- ⚠ The window is spelled twice by design and they must agree: this line and `CHAT_RETENTION_DAYS`
-- in `functions/_shared/community.ts`, which is what the read query uses.
