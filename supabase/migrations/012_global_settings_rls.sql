-- 012_global_settings_rls.sql — 1.0.3 安全修订：global_settings 漏开 RLS。
--
-- WHY THIS FILE EXISTS AT ALL
-- ---------------------------------------------------------------------------------------------
-- 009_reports.sql creates `public.global_settings` and never runs
-- `alter table ... enable row level security` on it, while 011_rls_community.sql writes a SELECT
-- policy for the same table. **A policy on a table whose RLS is off is not a weak guard, it is NO
-- guard** — PostgREST enforces nothing, and `anon` holds INSERT/UPDATE/DELETE through Supabase's
-- default privileges. The anon key ships inside the extension on purpose (§2.2 「Anon Key 可打包」),
-- so the shipped key was enough to:
--
--     curl -X PATCH 'https://<ref>.supabase.co/rest/v1/global_settings?key=eq.chat_enabled' \
--          -H "apikey: <anon>" -H 'Content-Type: application/json' -d '{"value":false}'
--
-- Measured against production before the fix: HTTP 200 and a fresh `updated_at`. i.e. any anonymous
-- caller could 「关闭聊天室」 or 「全体禁言」 — the two switches §2.3.2/§2.3.3 promise only
-- `admin-global-mute` (service role) can move.
--
-- ⚠ 1.0.6 三号 §二.2 — THAT FUNCTION IS NOW `admin-global-chat`, and 「全体禁言」 is no longer a
-- switch of its own: the two keys were one answer written twice, and 022_chat_switch.sql deletes
-- `global_mute`. This paragraph is left as the post-mortem it is — it is a record of what 1.0.3
-- shipped and what could be done to it, so it names the slug that existed then.
--
-- 009 is already applied remotely, so the fix is also stated there (fresh installs get it inline)
-- AND here as a migration. Both are idempotent; `enable row level security` on a table that already
-- has it is a no-op.
--
-- ⚠ This is the second time in this project that a MISSING LINE was invisible to every static
-- assertion: the SQL reads as if the table is protected (there is a policy right there for it), and
-- the only thing that shows the difference is a real request. verify-065 §16 pins the class —
-- 「every table created after 001 must enable RLS」 — rather than this one table.

alter table public.global_settings enable row level security;

-- The read gate stays exactly as 011 wrote it: 「已登录」, not 「是社区成员」 (`is_member()`), because a
-- banned or unactivated account still has to be told WHY the chat input is disabled. There is no
-- private data in two booleans. Re-stated here (idempotent) so this file is self-contained.
drop policy if exists global_settings_read_all on public.global_settings;
create policy global_settings_read_all on public.global_settings
  for select to authenticated
  using (true);
