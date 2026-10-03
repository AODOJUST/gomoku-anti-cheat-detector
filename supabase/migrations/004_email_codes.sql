-- 004_email_codes.sql — the storage §2.4 needs, plus the two constraints §2.3 and §3.7 imply.
--
-- Three changes, all of them prerequisites of the 1.0.1 two-step registration:
--
--   1. public.email_codes  — §2.4's table, verbatim in shape, with the lookup index it names.
--   2. users.token_epoch   — §3.7's 「撤销所有设备 JWT」. See below for why a column and not a
--                            denylist.
--   3. a unique username   — §2.3's table says 「唯一约束」 for 用户名 and §2.5's `users` insert
--                            assumes it. 001_init.sql declares `username text` with no index,
--                            because in 1.0.0 a username was optional cosmetic data nobody signed
--                            up with. 1.0.1 makes it a login handle, so it becomes unique.
--
-- Idempotent, like every other migration here: `supabase db push` re-runs safely.

-- ---------------------------------------------------------------------------
-- 1. email_codes (§2.4)
-- ---------------------------------------------------------------------------
-- Shape is §2.4's, unchanged. Two columns are `not null` where the spec left them bare (`email`,
-- `code`, `expires_at`): a row without them is unreadable by every query in this file, so allowing
-- it would only create rows that can never be matched — and 「验证码错误」 for a row that was never
-- usable is a bug report nobody can act on.
create table if not exists public.email_codes (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  code       text not null,
  expires_at timestamptz not null,
  used       boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.email_codes is 'Short-lived email verification codes for registration / password reset (§2.4).';

-- §2.4's index, verbatim. `auth-send-code` filters on (email, created_at) for the 60-second rate
-- limit and `auth-register` on (email, code, used, expires_at); this covers both.
create index if not exists idx_email_codes_lookup on public.email_codes (email, used, expires_at);

-- RLS is ENABLED and NO POLICY IS CREATED, which is deliberate rather than an omission: this table
-- is only ever touched by Edge Functions holding the service role (which bypasses RLS). With RLS on
-- and no policy, PostgREST refuses every anon/authenticated request, so a leaked anon key cannot
-- read a pending code or enumerate addresses — 「RLS 默认拒绝」 (§2.2) applied to a table the client
-- has no business reaching.
alter table public.email_codes enable row level security;

-- ---------------------------------------------------------------------------
-- 2. users.token_epoch (§3.7)
-- ---------------------------------------------------------------------------
-- §3.7's password change asks whether to 「撤销所有设备 JWT」 and answers itself: 「建议撤销」.
--
-- The tokens this backend mints are stateless HS256 verified by GoTrue, whose only freshness test
-- is `exp` — so there is nothing to delete on the server when a password changes. A counter makes
-- them revocable anyway: every token carries the epoch it was issued under, and `requireUser`
-- (the one place all 21 functions already pass through) refuses a token from an older epoch.
--
-- `default 0` is what makes the upgrade safe: a token minted before 1.0.1 has no `epoch` claim,
-- reads as 0, and stays valid until something actually bumps the counter.
alter table public.users add column if not exists token_epoch integer not null default 0;

comment on column public.users.token_epoch is 'Bumped to invalidate every previously issued JWT (§3.7 撤销所有设备 JWT).';

-- ---------------------------------------------------------------------------
-- 3. unique username (§2.3)
-- ---------------------------------------------------------------------------
-- Case-insensitive, and scoped to rows that are neither username-less nor soft-deleted: 「Alice」
-- and 「alice」 are the same handle to a human, and a cancelled account should not hold its name
-- hostage for the 30 days §4.2 keeps the row.
--
-- ⚠ This index will FAIL to create on a database that already holds duplicate usernames. That is
-- the intended behaviour — silently picking a winner would rename somebody's account without
-- telling them. 1.0.0 never assigned usernames (they were optional cosmetics typed in 编辑资料), so
-- a fresh deployment has none; a database that does needs the duplicates resolved by hand first.
create unique index if not exists idx_users_username_lower
  on public.users (lower(username))
  where username is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 4. housekeeping (§2.4 「Supabase Cron 每天清理过期验证码」)
-- ---------------------------------------------------------------------------
-- Shipped as a commented statement rather than an executable one: creating a cron job requires the
-- pg_cron extension to be enabled on the project (Dashboard → Database → Extensions), and a
-- migration that enables an extension the operator has not opted into is not this file's call.
-- `docs/DEPLOY.md` walks through it. In the meantime expired rows are harmless — every read filters
-- on `expires_at`, and the table is small (one row per attempt).
--
--   select cron.schedule('baishen-purge-email-codes', '0 4 * * *', $$
--     delete from public.email_codes where expires_at < now() - interval '1 day';
--   $$);
