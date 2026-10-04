-- 010_users_ext.sql — §二.3.1 + §三.1.2 + §三.2.3: the columns `users` gains.
--
--   muted_until      §2.3.1 — 禁言 24 小时 / 7 天, and the authority for §2.4's 「不能发言」
--   country_code     §3.1.2 — ISO 3166-1 alpha-2, inferred server-side from the login IP
--   country_updated_at §3.1.2 — when that inference last ran
--   hide_country     §3.1.6 — the user's own 「隐藏国籍」 switch
--   manual_status    §3.2.3 — 「在线 / 忙碌中 / 隐身」
--   last_seen_at     §3.2.1 — what 在线/离线 is actually computed from
--
-- (Renumbered from the spec's 009 — see the header of 006_friends.sql.)
--
-- ⚠ EVERY COLUMN IS `add column if not exists` AND EVERY DROP IS GUARDED, because `db push`
-- replays 001..011 against a remote whose `supabase_migrations` table was empty until 1.0.2. This
-- file is `alter table`, which is the one statement class that is NOT idempotent by default.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THERE IS NO `is_muted` COLUMN, EVEN THOUGH TWO OF THE SPEC'S POLICIES TEST ONE
-- ---------------------------------------------------------------------------------------------
-- §1.4.5 and §1.8.2 both write `and users.is_muted = false`, and §2.3.1 then defines 禁言 as
-- `users.muted_until = now() + 24h`. §五's implementation list mentions only `muted_until`. Those
-- cannot all be literal: `is_muted` would be a SECOND answer to 「他现在被禁言了吗」, and the two
-- would disagree the moment a mute expires — `muted_until` becomes past, `is_muted` stays true
-- until something remembers to clear it, and a user who served a 24-hour mute is silenced forever.
--
-- ⇒ Only the DURATION is stored, and 「是否在禁言中」 is derived as `muted_until > now()`. One
-- implementation, and it cannot go stale: the ceiling expires itself. The predicate is written once
-- on each side that needs it — `isMuted(row)` in `_shared/community.ts` (mirrored into
-- `community-shared.js` for the client's 「你已被禁言至 …」 line) — rather than in a policy, because
-- this release ships no INSERT policy (005_community.sql's rule): the write path is `chat-send` and
-- its siblings, and they read the column directly.
--
-- `null` muted_until means 「从未被禁言」, and it is the default for every existing row.

-- ---------------------------------------------------------------------------
-- 1. the columns
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists muted_until timestamptz;

alter table public.users add column if not exists country_code text;
alter table public.users add column if not exists country_updated_at timestamptz;

-- §3.1.6's switch. `not null default false` rather than nullable: the column is a tri-state trap
-- otherwise (`false` / `true` / "never set"), and §3.1.6's only two behaviours are 「显示真实国家」
-- and 「显示白旗」. Defaulting to false also means the feature ships visible, which is what
-- 「提供用户「隐藏国籍」选项」 asks for — it is an OPTION, not a default.
alter table public.users add column if not exists hide_country boolean not null default false;

-- §3.2.3's three values verbatim: 「在线 / 忙碌中 / 隐身（显示为离线）」. `null` reads as 在线, so
-- existing rows need no backfill and 「没有手动设置过」 is not a fourth state.
alter table public.users add column if not exists manual_status text;

alter table public.users add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. the constraints that make the columns facts
-- ---------------------------------------------------------------------------
-- Same treatment the spec's `-- comment` enums get everywhere else in this release (006, 007, 009):
-- a value outside the set does not error, it silently fails every comparison, and here that means
-- §3.2.3's radio renders with nothing selected while the account is actually in a state none of the
-- three branches handles.
alter table public.users drop constraint if exists users_manual_status_known;
alter table public.users
  add constraint users_manual_status_known
  check (manual_status is null or manual_status in ('online', 'busy', 'hidden'));

-- §3.1.2 「ISO 3166-1 alpha-2」. Two upper-case letters, enforced rather than hoped for: the flag
-- helper turns each character into a regional-indicator code point, so a lower-case or
-- three-letter code does not render wrong — it renders as garbage glyphs, or as nothing.
alter table public.users drop constraint if exists users_country_code_shape;
alter table public.users
  add constraint users_country_code_shape
  check (country_code is null or country_code ~ '^[A-Z]{2}$');

-- ---------------------------------------------------------------------------
-- 3. indexes
-- ---------------------------------------------------------------------------
-- §3.2.4 puts the status dot on the friend list, on other people's profiles and on chat avatars.
-- The friend list is 「这些 id 的状态」, so this is a covering-ish lookup by primary key with a
-- filter on recency; the index is on `last_seen_at` because that is what 「在线」 is derived from.
create index if not exists idx_users_last_seen on public.users (last_seen_at desc)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 4. what is deliberately NOT here
-- ---------------------------------------------------------------------------
-- ⚠ NO `users.country_code` write grant, and no `hide_country` / `manual_status` grant either —
-- for a moment. `hide_country` and `manual_status` are USER-OWNED settings, so §2 of
-- 011_rls_community.sql extends the existing column-level UPDATE grant (002_rls.sql granted
-- `username, bio, avatar_url`) with these two. `country_code` / `country_updated_at` /
-- `last_seen_at` are NEVER client-writable: they are the output of `geo-update` and of the presence
-- heartbeat, and a client that could set its own country could claim any flag it liked — which
-- would make §3.1's whole feature a client-side claim rather than an observation.
--
-- ⚠ NO `muted_until` grant either, obviously, and no `is_banned`-style "unmute myself": §2.3.1's
-- ladder is an administrative action, and the only writer is `admin-handle-report` (service role).
