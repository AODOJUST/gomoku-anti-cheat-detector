-- 003_user_kv.sql — the four sync categories §7.2 names but §11.1 gives no table to.
--
-- WHY THIS FILE EXISTS
--   1.0.0 §7.2 puts 黑名单 / 设置 / 自定义问题 / 学习参数 in the sync set:
--
--     | 黑名单       | ✅ | 体积小，跨设备价值高 |
--     | 设置         | ⚠️ 可选 | 可能含设备特定配置（线程数） |
--     | 自定义问题   | ✅ | 体积小 |
--     | 学习参数     | ✅ | 体积小 |
--
--   ...and §11.1's `001_init.sql` defines tables for `users` / `activation_codes` / `devices` /
--   `samples` / `archives` / `badges` — none of them for those four. A requirement with no storage
--   is not implementable, so this migration adds it.
--
-- WHY ONE TABLE AND NOT FOUR
--   The 定稿 itself explains the difference: the four are 「体积小」 single documents, where
--   `samples`/`archives` are record sets that a user accumulates and edits one row at a time. Four
--   tables each holding one jsonb column would be four copies of the same shape, and this project
--   has paid five times for a fact that existed in more than one spelling. The client's mapping is
--   one line per category in `extension/sync.js`'s `CATS`, so the four remain visibly the same
--   mechanism as the two record categories rather than a special case.
--
-- THE KEY IS A WHITELIST, NOT FREE TEXT
--   `key` is constrained to the four categories rather than left open, because a free-form key here
--   would be a second, un-reviewed place to store per-user data — and one that RLS cannot reason
--   about. Adding a category means editing this constraint, which is exactly the friction a new
--   sync surface should have.

create table if not exists public.user_kv (
  user_id    uuid not null references public.users(id) on delete cascade,
  key        text not null check (key in ('blacklist', 'settings', 'customQuestions', 'learnedParams')),
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

comment on table public.user_kv is
  'Small single-document per-user data for the cloud-sync categories that are not record sets.';
comment on column public.user_kv.key is
  'Whitelisted to the four §7.2 categories; see the header for why it is not free text.';

-- The sync engine reads the whole document and compares `updated_at` (§7.3), so the only access
-- path that needs an index is the primary key, which already serves it.

-- `updated_at` maintains itself through the same trigger function 001_init.sql installs, so a sync
-- push cannot forget to stamp it — and §7.3's whole conflict policy is a comparison of that column.
drop trigger if exists trg_user_kv_updated_at on public.user_kv;
create trigger trg_user_kv_updated_at
  before update on public.user_kv
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- RLS — default deny, then exactly the four operations the owner of the row may perform.
-- ---------------------------------------------------------------------------------------------
alter table public.user_kv enable row level security;

drop policy if exists user_kv_select_own on public.user_kv;
create policy user_kv_select_own on public.user_kv
  for select using (user_id = auth.uid());

-- `with check` is what stops a client from INSERTing a row for somebody else. The USING clause on
-- its own would only filter what is visible, not what may be written — the same trap 002_rls.sql
-- documents for `users`.
drop policy if exists user_kv_insert_own on public.user_kv;
create policy user_kv_insert_own on public.user_kv
  for insert with check (user_id = auth.uid());

drop policy if exists user_kv_update_own on public.user_kv;
create policy user_kv_update_own on public.user_kv
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_kv_delete_own on public.user_kv;
create policy user_kv_delete_own on public.user_kv
  for delete using (user_id = auth.uid());
