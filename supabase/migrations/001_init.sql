-- 001_init.sql -- schema for the "白身 / Baishen" gomoku anti-cheat detector backend.
-- Every statement is written to be idempotent so this migration can be re-run safely
-- (`supabase db push` is additive; re-applying never destroys data).
--
-- Table purposes (one line each, per the product spec):
--   users            -- one row per person who activated an activation code.
--   activation_codes -- single-use redeemable codes that grant account access.
--   devices          -- device bindings per user, used to enforce the 3-device limit.
--   samples          -- cloud mirror of the extension's local sample records.
--   archives         -- cloud mirror of the extension's local archive records.
--   badges           -- admin-granted cosmetic/status badges on a user.

-- gen_random_uuid() lives in core PostgreSQL 13+; Supabase runs 15+. The extension
-- line below is a harmless no-op guard for older / self-hosted deployments.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id           uuid primary key default gen_random_uuid(),
  email        text unique,
  username     text,
  avatar_url   text,
  bio          text,
  activated_at timestamptz,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  is_admin     boolean default false,
  is_banned    boolean default false,
  deleted_at   timestamptz
);

comment on table public.users is 'One row per person who activated an activation code.';

-- ---------------------------------------------------------------------------
-- activation_codes
-- ---------------------------------------------------------------------------
create table if not exists public.activation_codes (
  code        text primary key,
  issued_by   uuid references public.users(id),
  issued_at   timestamptz default now(),
  redeemed_by uuid references public.users(id),
  redeemed_at timestamptz,
  revoked     boolean default false,
  note        text
);

comment on table public.activation_codes is 'Single-use redeemable codes that grant account access.';

-- Quoted verbatim from the product spec: a redeemed code must map to at most one user.
create unique index if not exists idx_code_redeemed
  on public.activation_codes (code)
  where redeemed_by is not null;

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.users(id) on delete cascade,
  device_id  text not null,
  last_seen  timestamptz default now(),
  user_agent text
);

comment on table public.devices is 'Device bindings per user, used to enforce the 3-device limit.';

create unique index if not exists idx_devices_user_device
  on public.devices (user_id, device_id);

-- ---------------------------------------------------------------------------
-- samples  (mirrors the extension's local sample record shape)
-- ---------------------------------------------------------------------------
create table if not exists public.samples (
  id         text primary key,
  user_id    uuid references public.users(id) on delete cascade,
  created_at timestamptz,
  updated_at timestamptz default now(),
  deleted_at timestamptz,
  payload    jsonb not null
);

comment on table public.samples is 'Cloud mirror of the extension''s local sample records.';

-- "updated_at-friendly" index: incremental sync always asks for
-- "my rows changed since T", so order by (user_id, updated_at).
create index if not exists idx_samples_user_updated
  on public.samples (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- archives  (same shape as samples)
-- ---------------------------------------------------------------------------
create table if not exists public.archives (
  id         text primary key,
  user_id    uuid references public.users(id) on delete cascade,
  created_at timestamptz,
  updated_at timestamptz default now(),
  deleted_at timestamptz,
  payload    jsonb not null
);

comment on table public.archives is 'Cloud mirror of the extension''s local archive records.';

create index if not exists idx_archives_user_updated
  on public.archives (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- badges
-- ---------------------------------------------------------------------------
create table if not exists public.badges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.users(id) on delete cascade,
  badge_type text not null,
  granted_at timestamptz default now(),
  granted_by uuid references public.users(id)
);

comment on table public.badges is 'Admin-granted cosmetic/status badges on a user.';

create unique index if not exists idx_badges_user_type
  on public.badges (user_id, badge_type);

-- ---------------------------------------------------------------------------
-- set_updated_at() -- keeps updated_at honest on every UPDATE.
-- `create or replace` + `drop trigger if exists` makes re-running this file safe.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists trg_samples_updated_at on public.samples;
create trigger trg_samples_updated_at
  before update on public.samples
  for each row execute function public.set_updated_at();

drop trigger if exists trg_archives_updated_at on public.archives;
create trigger trg_archives_updated_at
  before update on public.archives
  for each row execute function public.set_updated_at();
