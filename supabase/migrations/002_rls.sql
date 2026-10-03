-- 002_rls.sql -- Row Level Security for the "白身 / Baishen" backend.
--
-- Principle (one line): RLS is default-deny; the anon/authenticated roles never reach
-- activation_codes, and every admin write goes through an Edge Function that re-checks
-- users.is_admin -- the policies below only ever *widen* reads, never grant privilege.
--
-- Every table gets `enable row level security`. With RLS enabled and no matching policy,
-- access is denied, so anything not written below is intentionally unreachable.

alter table public.users            enable row level security;
alter table public.activation_codes enable row level security;
alter table public.devices          enable row level security;
alter table public.samples          enable row level security;
alter table public.archives         enable row level security;
alter table public.badges           enable row level security;

-- ---------------------------------------------------------------------------
-- is_admin() -- the single reusable admin gate.
-- SECURITY DEFINER so it can read users.is_admin even though the caller's own RLS
-- policy would not otherwise expose other rows. STABLE: same answer within a statement.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin() returns boolean language sql stable security definer as $$ select coalesce((select u.is_admin from public.users u where u.id = auth.uid()), false) $$;

-- ---------------------------------------------------------------------------
-- users: self-service read/update only. No INSERT / DELETE policy => denied.
--
-- The UPDATE policy scopes the *rows* a user may touch to their own; on top of that,
-- column-level grants below stop a user from flipping their own is_admin / is_banned.
-- (RLS WITH CHECK cannot see the old row, so the column GRANT is what actually
-- prevents privilege escalation here -- the service_role used by Edge Functions
-- keeps full column access and is unaffected.)
-- ---------------------------------------------------------------------------
drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users
  for select
  using (auth.uid() = id);

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Admin-gate pattern demo (from the product spec): admins may read every row.
-- Note this is read-only; admin *writes* still go through Edge Functions so the
-- is_admin check is re-run on every call rather than trusted from the client.
drop policy if exists users_admin_select_all on public.users;
create policy users_admin_select_all on public.users
  for select
  using (public.is_admin());

-- Users may only write the three profile columns they own. This runs after the
-- point where `authenticated` would otherwise inherit blanket UPDATE from the
-- table-level default grant.
revoke update on public.users from authenticated;
grant update (username, bio, avatar_url) on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- activation_codes: NO client policy at all. RLS is enabled with zero policies, so
-- anon and authenticated can neither read nor write this table. Only the service_role
-- (used exclusively inside Edge Functions) can reach it. Do not add a policy here --
-- code lookup/validation must stay server-side so codes can never be enumerated.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- devices: a user sees and manages only their own device bindings.
-- ---------------------------------------------------------------------------
drop policy if exists devices_select_self on public.devices;
create policy devices_select_self on public.devices
  for select
  using (auth.uid() = user_id);

drop policy if exists devices_insert_self on public.devices;
create policy devices_insert_self on public.devices
  for insert
  with check (auth.uid() = user_id);

drop policy if exists devices_delete_self on public.devices;
create policy devices_delete_self on public.devices
  for delete
  using (auth.uid() = user_id);

drop policy if exists devices_admin_select_all on public.devices;
create policy devices_admin_select_all on public.devices
  for select
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- samples: full self-service CRUD scoped to the caller's own rows.
-- ---------------------------------------------------------------------------
drop policy if exists samples_select_self on public.samples;
create policy samples_select_self on public.samples
  for select
  using (auth.uid() = user_id);

drop policy if exists samples_insert_self on public.samples;
create policy samples_insert_self on public.samples
  for insert
  with check (auth.uid() = user_id);

drop policy if exists samples_update_self on public.samples;
create policy samples_update_self on public.samples
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists samples_delete_self on public.samples;
create policy samples_delete_self on public.samples
  for delete
  using (auth.uid() = user_id);

drop policy if exists samples_admin_select_all on public.samples;
create policy samples_admin_select_all on public.samples
  for select
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- archives: same shape and same rules as samples.
-- ---------------------------------------------------------------------------
drop policy if exists archives_select_self on public.archives;
create policy archives_select_self on public.archives
  for select
  using (auth.uid() = user_id);

drop policy if exists archives_insert_self on public.archives;
create policy archives_insert_self on public.archives
  for insert
  with check (auth.uid() = user_id);

drop policy if exists archives_update_self on public.archives;
create policy archives_update_self on public.archives
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists archives_delete_self on public.archives;
create policy archives_delete_self on public.archives
  for delete
  using (auth.uid() = user_id);

drop policy if exists archives_admin_select_all on public.archives;
create policy archives_admin_select_all on public.archives
  for select
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- badges: a user reads their own badges. There is deliberately NO insert/update/delete
-- policy -- grants are service-role only and happen through admin-grant-badge, which
-- re-verifies is_admin on every call.
-- ---------------------------------------------------------------------------
drop policy if exists badges_select_self on public.badges;
create policy badges_select_self on public.badges
  for select
  using (auth.uid() = user_id);

drop policy if exists badges_admin_select_all on public.badges;
create policy badges_admin_select_all on public.badges
  for select
  using (public.is_admin());
