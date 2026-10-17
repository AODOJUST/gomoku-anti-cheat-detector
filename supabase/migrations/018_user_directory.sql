-- 018_user_directory.sql — 1.0.5 安全审计 P0（§1.0.5.txt 第二、三条）
--
-- ---------------------------------------------------------------------------------------------
-- THE TWO FINDINGS THIS FILE CLOSES
-- ---------------------------------------------------------------------------------------------
--   P0-2  「隐藏国籍只是显示层，原始数据仍对所有已登录用户可读」
--         `users_select_public` (011 §3) admits every non-banned row, and the 011 §3 column grant
--         hands out `country_code` itself. So `get /rest/v1/users?select=country_code,id` returned
--         the real code for an account whose owner had ticked 「隐藏国籍」, and `hide_country`
--         controlled nothing but which glyph `countryFlagChinaUnified` drew. The promise in
--         PRIVACY.md was a rendering convention, not a fact about the data.
--
--   P0-3  「`last_seen_at` 的可见范围没有约束」
--         Same grant, same policy: any authenticated account could read any other account's
--         timestamp. A user who chose 「隐身」 was reported `offline` by `presenceState` while the
--         raw column still said exactly when they were last active — and `last_seen_at` is stamped
--         every 60 s (`PRESENCE_BEAT_MS`), so the leaked timestamp is finer than the dot it feeds.
--
-- ⚠ WHY A VIEW AND NOT A PER-ROW POLICY. RLS is ROW level and column GRANTS are TABLE level; neither
-- can express 「this column, for these rows, depending on the reader」. That is exactly the shape of
-- both findings — 国籍 是 `hide_country` 的函数，时间戳是「是不是好友」的函数 — so the projection has
-- to live somewhere that can compute per (row, column, reader). A view is that place.
--
-- ⚠ WHY IT IS A **DEFINER** VIEW (the default), AND WHY THE ROW PREDICATE IS REPEATED INSIDE IT.
-- A `security_invoker` view would evaluate the base table's RLS and column grants as the CALLER —
-- i.e. it would still need `select` on `country_code` to read it, which is the grant this file is
-- removing. So the view runs as its owner, and because the owner bypasses RLS on `users` it must
-- restate 「which rows are public」 itself: `deleted_at is null and is_banned = false`, copied
-- verbatim from `users_select_public`. ⚠ THAT IS A SECOND SPELLING OF A ROW PREDICATE and it is
-- pinned: `verify-067` reads both this file and 011_rls_community.sql and asserts the two predicates
-- are the same text. The alternative — trusting the policy to apply through a definer view — is the
-- 「策略存在 ≠ 策略生效」 trap 1.0.3 already lost a P0 to.
--
-- Idempotent: `create or replace view`, guarded `drop function`, re-issued grants.

-- ---------------------------------------------------------------------------
-- 1. 「这两个人是好友吗」 — one definition, shared by the view and by `profile-get`
-- ---------------------------------------------------------------------------
-- §1.2.1's relationship lives in `friendships` as an un-ordered pair (`user_a`, `user_b`) plus a
-- status; 006 explains why it is stored that way. The symmetric lookup is written once here rather
-- than twice (the view needs it, and `profile-get`'s 他人主页 needs the same answer to decide whether
-- the timestamp travels) — this repo has paid six times for a predicate living in two places.
--
-- §1.2.1's accepted value is `'accepted'`; `'pending'` and `'blocked'` are NOT friendship, so a
-- blocked user does not get to watch somebody's presence.
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select a is not null and b is not null and a <> b and exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.user_a = a and f.user_b = b) or (f.user_a = b and f.user_b = a))
  );
$$;

-- Reachable only from inside the database: no client can call it over /rest/v1/rpc, which keeps
-- 「谁是好友」 off the client's list of things it can ask about arbitrary pairs.
revoke all on function public.are_friends(uuid, uuid) from public;
grant execute on function public.are_friends(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. the projection every client read of other people goes through
-- ---------------------------------------------------------------------------
-- The column list is 011 §3's, MINUS `country_code` / `last_seen_at` as stored, PLUS both of them
-- as rules:
--
--   country_code  → null when the owner ticked 隐藏国籍 and the reader is somebody else.
--                   §3.1.5 keeps the mapping 港澳台→五星红旗 in the CLIENT (`countryFlagChinaUnified`)
--                   and this file keeps the code REAL for self and friends; it only refuses to hand
--                   a hidden code to a stranger. The reader still gets `hide_country`, so the flag it
--                   draws is 白旗 rather than 国旗 — the same glyph it drew before, arrived at
--                   honestly.
--   last_seen_at  → null unless the reader is the account itself or an accepted friend.
--
-- `manual_status` is untouched on purpose: it is the user's own DECLARATION (在线 / 忙碌中 / 隐身),
-- and 隐身 already means 「对所有人报离线」. Withholding it would leave the client unable to render
-- 忙碌中 at all, and it leaks no timestamp.
--
-- ⚠ `id` IS THE JOIN KEY and stays. A reader who may see the row may see who it is; what this view
-- withdraws is the two facts the findings are about.
drop view if exists public.user_directory;
create view public.user_directory as
  select
    u.id,
    u.username,
    u.avatar_url,
    u.bio,
    u.created_at,
    u.activated_at,
    u.is_admin,
    u.manual_status,
    u.muted_until,
    u.hide_country,
    case
      when u.id = auth.uid() then u.country_code
      when u.hide_country is true then null
      else u.country_code
    end as country_code,
    case
      when u.id = auth.uid() then u.last_seen_at
      when public.are_friends(auth.uid(), u.id) then u.last_seen_at
      else null
    end as last_seen_at
  from public.users u
  where u.deleted_at is null and u.is_banned = false;

comment on view public.user_directory is
  '1.0.5 — the public user projection, with 隐藏国籍 and last_seen_at applied per reader. The row predicate is users_select_public restated (definer view bypasses RLS).';

-- ---------------------------------------------------------------------------
-- 3. close the raw door
-- ---------------------------------------------------------------------------
-- ⚠ THIS IS THE HALF THAT MAKES THE VIEW MORE THAN DECORATION. Without it the view is simply a nicer
-- way to ask a question whose answer is still available directly — which is precisely the state
-- PRIVACY.md was describing as 「隐藏」 while `get …?select=country_code` answered anyway.
--
-- `revoke select (col)` narrows the column grant 011 §3 wrote; everything else it granted stays.
revoke select (country_code, last_seen_at) on public.users from authenticated;

grant select on public.user_directory to authenticated;

-- ⚠⚠ 1.0.5 — `grant select … to authenticated` IS NOT ENOUGH, AND THIS ONE MATTERS. Supabase's
-- `ALTER DEFAULT PRIVILEGES` grants **ALL** on every newly created object in `public` to
-- `anon` / `authenticated` / `service_role`, and `create view` above ran as `postgres` — so before
-- these two lines `anon` already held `arwdDxtm` on this view. Measured: an unauthenticated
-- `GET /rest/v1/user_directory?select=id,country_code` returned a row.
--
-- ⚠ THAT IS THE WHOLE AUDIT'S P0-2 IN A NEW PLACE, and it is worse here than on the table: a TABLE
-- is protected by RLS (which is what makes 「每个 create table 都要开 RLS」 sufficient), while a VIEW
-- has no RLS of its own — and this one is a DEFINER view, so the base table's RLS is bypassed by
-- construction. The grant IS the gate. `anon` has no session, so inside the view `auth.uid()` is
-- null and `u.id = auth.uid()` can never be true: the 隐藏国籍 branch would never fire for the
-- reader's own row, and other people's non-hidden codes would travel to a caller who is not signed
-- in at all. The stateless promise 018 is making only holds if the unauthenticated role cannot ask.
--
-- The second line is the other half of the same reasoning: a view is a READ surface, and Supabase's
-- default also handed `authenticated` INSERT/UPDATE/DELETE on it (harmless only because a
-- CASE-containing view is not auto-updatable — i.e. safe by accident, which is not a reason).
revoke all on public.user_directory from anon;
revoke insert, update, delete, truncate, references, trigger on public.user_directory from authenticated;

-- ---------------------------------------------------------------------------
-- 4. what this file does NOT change
-- ---------------------------------------------------------------------------
-- ⚠ `profile-get` still reads `users` with the SERVICE ROLE for both the own-profile and the 他人主页
-- branches — it has to, because it also counts another account's `samples`, which RLS forbids to a
-- client. The service role bypasses BOTH the grants and this view, so the 他人主页 gets its two rules
-- from `toForeignUser` in `_shared/client.ts`, which is the TypeScript half of exactly this file.
-- ⚠ THAT PAIR IS A SECOND SPELLING AND IT IS PINNED — `verify-067` asserts both halves exist (this
-- view blanks `country_code` on `hide_country`, and `toForeignUser` does the same) and `behave-067`
-- drives the TS half in a browser harness. The alternative, routing the 他人主页 through this view,
-- would cost a second PostgREST round trip inside a Function that already has the row in hand.
--
-- ⚠ `admin-list-users` (service role) is unaffected, and `admin.js`'s console reads go through
-- PostgREST — see `admin.js`: it reads `reports` / `feedback` / `global_settings` / `news`, never
-- `users`, precisely so that the narrowed grant has one answer.
