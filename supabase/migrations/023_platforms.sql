-- 023_platforms.sql — 1.0.6 四号 §一: 平台痕迹 (which client an account actually uses).
--
--   users.platforms         text[] not null default '{}'  — the SET of platforms this account has used
--   users.last_platform     text                          — the most recent one
--   users.last_platform_at  timestamptz                   — when that was
--   public.platform_logins  (id, user_id, platform, logged_in_at, ip_country)  — the LOG
--
-- (The spec calls this file `016_platforms.sql`. The tree is at 022 — see the header of
-- 006_friends.sql for the renumbering convention; 016 is already `016_avatars_bucket.sql`.)
--
-- ---------------------------------------------------------------------------------------------
-- STATE vs LOG, AND WHY BOTH EXIST WHEN EITHER COULD ANSWER THE TITLE QUESTION
-- ---------------------------------------------------------------------------------------------
-- §1.1's question is 「谁用网页版、谁用扩展版、谁两者都用」, and a purist reading says the set is
-- DERIVABLE from the log: `select distinct platform from platform_logins where user_id = …`. Keeping
-- `users.platforms` as well therefore looks like the shape this project has paid for six times — one
-- answer written twice, self-consistent, silently drifting.
--
-- ⇒ IT IS DELIBERATE, AND THE SPLIT IS STATED HERE SO NOBODY "UNIFIES" IT LATER:
--
--   `users.platforms`      THE STATE. Read once per ROW on the admin user list — 50 rows, no join,
--                          no aggregation. It is written by the same UPDATE that writes
--                          `last_platform`, so it cannot lag the log.
--   `platform_logins`      THE HISTORY. Answers 「首次 / 最近 / 多少次」, which the set cannot, and it
--                          is the only place a TIME WINDOW can be applied at all (§1.5.3's 「近 7 天
--                          登录次数」).
--
-- ⚠ THE RULE THAT KEEPS THEM APART: **the platform TAG never comes from the log.** Every renderer of
-- 「扩展 / 网页 / 两者」 reads `users.platforms`; `platform_history()` below is only ever used for
-- 首次/最近. A future contributor who derives the tag by `exists (select 1 from platform_logins …)`
-- has created the second answer — and created it in the one place where the two can disagree (a log
-- that gets pruned, or a report whose log INSERT failed, would change the tag).
--
-- ⚠ AND THE SAME REASONING COVERS `last_platform` / `last_platform_at`, WHICH ARE `max(logged_in_at)`
-- SPELLED AS COLUMNS. Same justification as `users.last_seen_at` (010_users_ext.sql): it is a
-- per-row read on a list that renders fifty of them, and 「查一遍这个人的日志」 per row is the thing
-- the column exists to avoid. They are not a second OPINION — they are stamped by the same UPDATE.
--
-- ---------------------------------------------------------------------------------------------
-- ⚠ `both` IS NOT STORED. §1.2 is explicit («BOTH 是派生值») and this is the one place the spec's own
-- model is worth restating as a rule: a fourth array value `['both']` would make `['both']` and
-- `['extension','web']` two spellings of one state, and every reader would have to handle both.
-- `PLATFORM.BOTH` exists on the client as a DERIVED label — see `platformTag()` in the shared block —
-- and `users_platforms_known` below refuses anything but the two real values.
--
-- ---------------------------------------------------------------------------------------------
-- ⚠ WHY NO CLIENT CAN READ OR WRITE ANY OF THIS. Two independent reasons, and the first is the one
-- that matters:
--
--   * 平台痕迹 IS AN OPERATOR'S DATASET. §1.5 puts it on the admin console and nowhere else: it is
--     not on §1.3's 他人主页, not on `toPublicUser`, and the account's own settings screen does not
--     show it. So no SELECT grant reaches it — 011 §3's column-level grant stays a closed list, and
--     these columns are simply not on it. (A column not listed in a `grant select (…)` is not
--     readable over PostgREST — that is what makes the list a gate rather than a convenience.)
--   * NOTHING MAY WRITE IT FROM A CLIENT EITHER. `platform` is an OBSERVATION of which binary the
--     account signed in from, in exactly the sense 010 §4 refuses a client-writable `country_code`:
--     a client that could claim `'web'` would make §1.5's whole panel a set of client claims. The
--     only writer is the `platform-report` Edge Function (service role), which reads the platform out
--     of a whitelist and ignores anything else the body says.
--
-- ⚠ `platform_logins` HAS RLS ON AND **NO POLICY AT ALL**, which is a decision rather than an
-- oversight: no policy means `authenticated` is refused outright, so the table is service-role-only
-- by construction. (009_reports.sql learned the other half of this the hard way — a table whose RLS
-- is OFF is guarded by nothing, because Supabase's default privileges already granted `anon` and
-- `authenticated` everything. RLS-on-with-no-policy and RLS-off look identical in a grep and are
-- opposites in production; `verify-065` §16 pins 「every table created after 001 enables RLS」.)
--
-- ---------------------------------------------------------------------------------------------
-- ⚠ `ip_country` IS THE COUNTRY CODE, NOT THE IP, AND THERE IS STILL ONLY ONE INFERENCE. §1.3's
-- comment says 「可选：与 geo-update 同源」 and that is implemented literally: `platform-report` copies
-- `users.country_code` — the value `geo-update` already inferred from the login IP — and stores it
-- beside the login. The IP itself is never seen by this feature, never stored and never logged
-- (§3.1.7: 「IP 本身不存储，只存储推断出的国家代码」).
--
-- ⇒ `platform-report` DOES NOT CALL IPINFO. A second inference would be a second answer to 「这个账号
-- 在哪」, would double the token spend, and would be free to disagree with the profile's flag. The
-- copy can be `null` for exactly one case — an account whose very first report raced its very first
-- `geo-update` — and null is the honest value there.
--
-- Idempotent: every column is `add column if not exists`, every drop is guarded, the table and its
-- indexes are `if not exists`, and both functions are `create or replace`. `db push` replays this
-- file over a database that may already have it.

-- ---------------------------------------------------------------------------
-- 1. the columns — §1.3 verbatim
-- ---------------------------------------------------------------------------
-- ⚠ `not null default '{}'` RATHER THAN §1.3's NULLABLE `default array[]::text[]`. The spec's model
-- leaves a third state (empty / null / "never reported") where the only real distinction is
-- 「报过没有」, and that is already answered by the array being empty. A NULL would additionally make
-- every `platforms @> …` predicate evaluate to NULL rather than false — i.e. the rows this file cares
-- about most (accounts that have never reported) would be dropped by any filter instead of counted.
-- Postgres backfills existing rows from the default, so every current account starts as `'{}'`.
alter table public.users add column if not exists platforms text[] not null default '{}'::text[];

alter table public.users add column if not exists last_platform text;
alter table public.users add column if not exists last_platform_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. the constraints that make the columns facts
-- ---------------------------------------------------------------------------
-- Same treatment the spec's `-- comment` enums get everywhere else in this tree (006, 007, 009, 010):
-- a value outside the set does not error, it silently fails every comparison — and here that means a
-- typo'd `'extention'` produces an account that is counted in NO bucket of §1.5.3's panel, is tagged
-- with nothing on the user list, and looks like a reporting outage rather than a bad row.
--
-- `<@` is 「is contained by」: the array may hold either value, both, or neither, and nothing else.
-- ⚠ IT DOES NOT ENFORCE ORDER OR UNIQUENESS — the writer normalises (`platform-report` builds a
-- `Set`, then sorts), and every READER is set-shaped (`@>`, per §1.2's derived `both`), so a
-- hypothetical `'{"web","web","extension"}'` would still be counted correctly. The constraint is here
-- to stop UNKNOWN VALUES, which no reader can survive.
alter table public.users drop constraint if exists users_platforms_known;
alter table public.users
  add constraint users_platforms_known
  check (platforms <@ array['extension', 'web']::text[]);

-- `last_platform` is the same enum with a null (「还没报过」) allowed. Kept separate from the array
-- check because the two are read by different code: the array decides the TAG, this decides §1.5.2's
-- 「最后平台：网页（2026-10-04 15:32）」 line.
alter table public.users drop constraint if exists users_last_platform_known;
alter table public.users
  add constraint users_last_platform_known
  check (last_platform is null or last_platform in ('extension', 'web'));

-- ---------------------------------------------------------------------------
-- 3. platform_logins — the log §1.3 asks for
-- ---------------------------------------------------------------------------
-- ⚠ `on delete cascade`, NOT the default `no action`. `auth-delete-account` and the 30-day purge
-- (`PURGE_AFTER_DAYS`) delete a user row, and a `RESTRICT`-shaped foreign key makes that fail — which
-- is the 1.0.5 audit's finding in as many words: 「`RESTRICT` 外键让注销永远删不掉，失败长得像「这个月没人
-- 注销」」. Every per-user table in this tree cascades for that reason.
create table if not exists public.platform_logins (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  -- §1.3's 「'extension' | 'web'」. The check is here as well as on `users.platforms` because this
  -- column is GROUPed BY (§1.5.3's two counts) and an unknown value would add a third bucket nobody
  -- renders — silently, since the panel iterates `PLATFORM` rather than the rows.
  platform     text not null,
  logged_in_at timestamptz not null default now(),
  -- §1.3's optional country, and see the header: this is the CODE `geo-update` inferred, never an IP.
  ip_country   text,
  constraint platform_logins_platform_known check (platform in ('extension', 'web')),
  constraint platform_logins_ip_country_shape
    check (ip_country is null or ip_country ~ '^[A-Z]{2}$')
);

-- §1.3's two indexes verbatim. `user_id, logged_in_at desc` is `platform_history()`'s access path and
-- the per-account 首次/最近 read; `platform, logged_in_at desc` is §1.5.3's windowed count, which
-- scans ONE platform over a time range and would otherwise read the table for a week of the other
-- platform's rows too.
create index if not exists idx_platform_logins_user
  on public.platform_logins (user_id, logged_in_at desc);
create index if not exists idx_platform_logins_platform
  on public.platform_logins (platform, logged_in_at desc);

alter table public.platform_logins enable row level security;

comment on table public.platform_logins is
  '1.0.6 四号 §一.3 — one row per client report: 「这个账号在这个时刻以这个平台出现」. Written only by '
  'the platform-report Edge Function (service role). NO SELECT POLICY AT ALL: §1.5 puts 平台痕迹 on '
  'the admin console and nowhere else, so the table is service-role-only by construction. '
  '`ip_country` is the code geo-update already inferred (never the IP — §3.1.7). ⚠ THE LOG IS HISTORY, '
  'NOT STATE: the platform TAG always comes from users.platforms — see 023''s header for why, and do '
  'not derive 「他用过哪些平台」 from this table.';

-- RLS-on-with-no-policy already refuses both client roles; these two lines make the intent readable
-- from the GRANTS as well, which is where a reviewer looks first. `service_role` keeps what it has
-- (Supabase's default privileges) — stated explicitly rather than assumed, because the whole feature
-- is unreadable if that one grant is missing.
revoke all on public.platform_logins from anon, authenticated;
grant select, insert on public.platform_logins to service_role;

-- ---------------------------------------------------------------------------
-- 4. the two aggregates — 「计数必须在数据库」 (1.0.5 audit)
-- ---------------------------------------------------------------------------
-- ⚠ NEITHER OF THESE CAN BE A POSTGREST CALL, AND THAT IS THE POINT OF THEM EXISTING. §1.5.3's panel
-- counts ACROSS ALL USERS (仅扩展 / 仅网页 / 两者) and windows the log by 7 days; PostgREST can return
-- a `count` of a filter, but it cannot GROUP, and `admin-list-users` returns a PAGE of fifty — so a
-- count assembled from that page is a count of the page. The 1.0.5 audit found exactly this shape
-- (「计数必须在数据库」) and it is the reason these are `sql` functions rather than loops in Deno.

/** §1.2's derived tag, as a wire value: `'extension'` / `'web'` / `'both'` / `'none'`.
 *
 *  ⚠ THIS IS THE ONE SPELLING OF THE DERIVATION ON THE DATABASE SIDE, and it is `immutable` so the
 *  `filter (where public.platform_tag(…))` clauses below and any future index can both use it.
 *  `'none'` is not in §1.2's `PLATFORM` object — it is the honest remainder, and §1.5.3's panel needs
 *  it: without a fourth bucket the three numbers do not sum to the account total and the first person
 *  to notice will "fix" it by counting something else. See the note in `platform_stats()` below. */
create or replace function public.platform_tag(p text[])
returns text
language sql
immutable
as $$
  select case
    when p @> array['extension'] and p @> array['web'] then 'both'
    when p @> array['extension'] then 'extension'
    when p @> array['web'] then 'web'
    else 'none'
  end;
$$;

/** §1.5.3's 平台统计, as one jsonb object.
 *
 *  `users` counts ACCOUNTS by derived tag; `logins7d` counts LOG ROWS in the last seven days, per
 *  platform. Two different questions, two different sources — deliberately not a third 「活跃用户」
 *  number, which would be `last_platform_at > now() - 7 days` and would answer §1.5.3's 「当前活跃用户」
 *  with a different population than its own three lines above it.
 *
 *  ⚠ `deleted_at is null`: a soft-deleted account is on its way out (§4.2's 30-day retention) and
 *  must not be counted in an operator's census. Banned accounts ARE counted — they are still accounts,
 *  and hiding them would make the totals disagree with the user list the operator is looking at. */
create or replace function public.platform_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users', (
      select jsonb_build_object(
        'extension', count(*) filter (where public.platform_tag(u.platforms) = 'extension'),
        'web',       count(*) filter (where public.platform_tag(u.platforms) = 'web'),
        'both',      count(*) filter (where public.platform_tag(u.platforms) = 'both'),
        'none',      count(*) filter (where public.platform_tag(u.platforms) = 'none'),
        'total',     count(*)
      )
      from public.users u
      where u.deleted_at is null
    ),
    'logins7d', (
      select jsonb_build_object(
        'extension', count(*) filter (where l.platform = 'extension'),
        'web',       count(*) filter (where l.platform = 'web')
      )
      from public.platform_logins l
      where l.logged_in_at > now() - interval '7 days'
    ),
    'generated_at', now()
  );
$$;

/** 首次 / 最近 / 次数, per platform, for the accounts named.
 *
 *  Takes an ARRAY because the caller is §2.3.2's user list: one call per page of fifty, not fifty
 *  calls. That is also why it is not a view — a view cannot be filtered by 「这一页的人」 without a
 *  join on the outside, and the alternative (fetch the page's log rows and reduce in Deno) ships
 *  every row of every login to answer a question with four values per platform.
 *
 *  ⚠ `max(logged_in_at)` HERE IS NOT A SECOND OPINION ABOUT `users.last_platform_at`. This function
 *  answers 「这个人用这个平台的首末次」; the column answers 「他最后一次是从哪个平台来的」, and it is read
 *  per row without touching this table. They agree because the same UPDATE stamps both. */
create or replace function public.platform_history(uuids uuid[])
returns table (user_id uuid, platform text, first_at timestamptz, last_at timestamptz, logins bigint)
language sql
stable
security definer
set search_path = public
as $$
  select l.user_id, l.platform, min(l.logged_in_at), max(l.logged_in_at), count(*)
  from public.platform_logins l
  where l.user_id = any(uuids)
  group by l.user_id, l.platform
  order by l.user_id, l.platform;
$$;

-- ⚠ BOTH ARE SERVICE-ROLE ONLY, AND THE REVOKE IS THE HALF THAT MAKES THEM SO. Supabase's
-- `ALTER DEFAULT PRIVILEGES` hands `anon` and `authenticated` EXECUTE on every newly created function
-- in `public` — the 1.0.5 audit measured this on a VIEW and found an unauthenticated request
-- answering with real rows. `security definer` makes it worse rather than better: these functions run
-- as their owner, so the base tables' RLS does not apply to them. The grant IS the gate.
revoke all on function public.platform_tag(text[]) from public, anon, authenticated;
revoke all on function public.platform_stats() from public, anon, authenticated;
revoke all on function public.platform_history(uuid[]) from public, anon, authenticated;
grant execute on function public.platform_tag(text[]) to service_role;
grant execute on function public.platform_stats() to service_role;
grant execute on function public.platform_history(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 5. what this file deliberately does NOT do
-- ---------------------------------------------------------------------------
-- ⚠ NO RETENTION WINDOW ON `platform_logins`, AND THAT IS A MISSING PRODUCT DECISION RATHER THAN A
-- DEFAULT. §1.3 gives none. The table grows by one row per client report (login success, browser
-- startup, and the day's first activity — see `platform-report`), i.e. a few rows per account per day;
-- pruning by age is a one-line `delete` the day somebody decides what 「平台历史」 should span.
--
-- ⚠ THE 「近 7 天」 IN §1.5.3 IS A READ WINDOW, NOT A RETENTION WINDOW, and conflating the two here
-- would be the mistake to avoid: deleting older rows would silently shorten §1.5.2's 「首次 2026-10-01」
-- line, which is read from the same table. (The repo's one shipped retention rule — chat's
-- `CHAT_RETENTION_DAYS` — is applied on READ as well as by a purge job precisely because the job
-- ships disabled. There is no equivalent here because there is nothing to keep.)
--
-- ⚠ NO `is_admin`-style read policy for the console. The console reaches this data through
-- `admin-list-users` / `admin-platform-stats` with the SERVICE ROLE, which bypasses both the grants
-- and the RLS; adding a client-visible policy would widen the surface to no purpose. Compare
-- `admin.js`, which reads `reports` / `feedback` / `global_settings` / `news` over PostgREST and
-- deliberately never reads `users`.
