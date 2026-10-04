-- 017_super_admin.sql — 1.0.5 §二.2 超级管理员
--
-- §2.2 asks for a role ABOVE `is_admin`, usable only by the original developer, that can appoint and
-- demote ordinary administrators. §2.2.2 recommends `users.role` over a separate `user_roles` table
-- (「简单直接」) and this file follows it. §2.2.2 also sketches the migration as `011_super_admin.sql`;
-- that number was taken long before 1.0.5 started, so it is 017 — the SpecIsRightAboutTheNumber
-- exception this project writes down instead of silently renumbering (see 010's and 016's headers).
--
-- ---------------------------------------------------------------------------------------------
-- ONE AUTHORITY, ONE DERIVED FLAG
-- ---------------------------------------------------------------------------------------------
-- `is_admin` is referenced by eight RLS policies (002 §2, 011 §3/§5/§6/§7), by `requireAdmin`, and by
-- the client's tab visibility. Rewriting all of those to read `role` would be a large, risky diff for
-- no behavioural gain, and keeping BOTH as independent columns is precisely the 「同一答案有两份」 defect
-- this repo has paid for six times. So the pair is made mechanical instead: **`role` is the authority
-- and `is_admin` is a TRIGGER-DERIVED column.** Nothing may set `is_admin` by hand any more — the
-- trigger overwrites it on every write — and the CHECK constraint below refuses a value that
-- disagrees, so a row written by a path that bypasses the trigger (a manual Studio UPDATE with
-- `session_replication_role=replica`) is rejected rather than left inconsistent.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THERE IS NO `create policy … super_admin_demote`
-- ---------------------------------------------------------------------------------------------
-- §2.2.4 sketches an UPDATE policy letting a super admin demote an admin. It is NOT implemented, and
-- deliberately: 011 §3 already does `revoke select` + `revoke update` on `users` and re-grants
-- exactly `update (hide_country, manual_status)`, so no authenticated client can write `role` at all —
-- a policy for it would be a door with no handle. Promotion and demotion therefore go through ONE
-- Edge Function (`admin-set-role` — §2.2.3's 任命 and 罢免 rows are the same write with opposite
-- signs, so they are one endpoint; see that file's header), which is the rule the whole project
-- follows: 「写只走 service-role Edge Functions」. What the sketch
-- was really protecting — 不能把自己降级 / 不能降级另一个超级管理员 — is enforced in the Function, in
-- TypeScript, where it can also return a sentence.
--
-- Idempotent like every other migration here: every `add column` / `add constraint` is guarded, the
-- trigger is `create or replace`, and the backfill is a no-op on a database that is already correct.

-- ---------------------------------------------------------------------------
-- 1. the column
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists role text not null default 'user';

-- The three values are the spec's own (§2.2.2's comment). A fourth value would silently fail every
-- comparison — the same reasoning 010 gives for `manual_status` and `country_code`.
alter table public.users drop constraint if exists users_role_known;
alter table public.users
  add constraint users_role_known
  check (role in ('user', 'admin', 'super_admin'));

-- ---------------------------------------------------------------------------
-- 2. backfill: every existing admin is a plain `admin`
-- ---------------------------------------------------------------------------
-- ⚠ THE ORDER MATTERS AND SO DOES THE `where`. `role` defaults to `'user'`, so a bare
-- `update users set role = 'admin' where is_admin` would also catch rows an earlier run already
-- promoted to `super_admin` and DEMOTE them. Narrowing on `role = 'user'` makes the statement
-- idempotent and non-destructive: it only ever promotes the never-classified rows.
update public.users set role = 'admin' where is_admin is true and role = 'user';

-- ---------------------------------------------------------------------------
-- 3. `is_admin` becomes derived
-- ---------------------------------------------------------------------------
-- A BEFORE trigger rather than a generated column: a generated column cannot be written at all, and
-- `is_admin` is still written by Studio recipes (and by nothing else — `grep is_admin supabase/` finds
-- readers only). The trigger keeps the old writers working while making `role` the only place the
-- value is decided.
create or replace function public.sync_is_admin_from_role()
returns trigger
language plpgsql
as $$
begin
  new.is_admin := (new.role in ('admin', 'super_admin'));
  return new;
end;
$$;

drop trigger if exists trg_users_sync_is_admin on public.users;
create trigger trg_users_sync_is_admin
  before insert or update of role, is_admin on public.users
  for each row execute function public.sync_is_admin_from_role();

-- The consistency CHECK runs AFTER the trigger, so it only ever fires on a path that bypassed the
-- trigger. It is the belt to the trigger's braces, and it is what makes 「两份不一致」 impossible
-- rather than merely unlikely.
alter table public.users drop constraint if exists users_role_is_admin_consistent;
alter table public.users
  add constraint users_role_is_admin_consistent
  check ((role in ('admin', 'super_admin')) = (is_admin is true));

-- ---------------------------------------------------------------------------
-- 4. NOT granted, and why
-- ---------------------------------------------------------------------------
-- ⚠ `role` is NOT added to the column-level SELECT grant 011 §3 writes, so `select role from users`
-- answers 401 for `authenticated` — including for an admin reading the user list. That is on purpose:
-- §2.2.5 requires 超级管理员 to be INDISTINGUISHABLE from an ordinary one, and a client that could
-- read everybody's `role` would make that promise a rendering convention rather than a fact. The
-- caller learns its OWN role only, from the session projection (`toPublicUser` → `role`), which is
-- what §2.2.5's conditional button needs and is the only role fact the client is entitled to.
--
-- ⚠ `admin-list-users` therefore does NOT return other people's roles either — see its own note.
-- The one remaining way to know is `select role from users` in Supabase Studio, which is the
-- super admin's own tool.
