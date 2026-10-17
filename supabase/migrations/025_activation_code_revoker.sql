-- 025_activation_code_revoker.sql — 1.0.6 四号 §二.4.3: who revoked a code, and when.
--
--   activation_codes.revoked_at  timestamptz
--   activation_codes.revoked_by  uuid  references public.users(id) on delete set null
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS IS NEEDED AT ALL, GIVEN §二.4 IS ABOUT THE *REDEEMER*
-- ---------------------------------------------------------------------------------------------
-- §2.4 asks the 激活码 list to show who used a code (§2.4.2's join on `redeemed_by`) — and §2.4.3
-- draws THREE expanded states, not one. The 已撤销 one is:
--
--     状态：已撤销
--     生成时间：2026-10-02 10:15
--     撤销时间：2026-10-03 09:00
--     撤销者：开发者
--
-- 001_init.sql gave `activation_codes` a single `revoked boolean`. That answers 「这个码作废了吗」 and
-- nothing else: the moment a code is revoked, WHO did it and WHEN are gone, and an operator looking at
-- a revoked code has no way to tell 「昨天我撤的」 from 「三个月前别人批量撤的」. That is a real gap in a
-- table whose whole job is to be an audit trail of credential issuance — and it is the same shape 020
-- untangled on the other column, where one field was carrying two meanings.
--
-- ⚠ `revoked` (the boolean) STAYS AND STAYS AUTHORITATIVE FOR 「作废了吗」. It is what
-- `admin-revoke-codes`'s two UPDATEs filter on (`.eq("revoked", false)`), what the list's three-state
-- filter reads, and what `auth-validate-code` consults. Deriving 「已撤销」 from `revoked_at is not null`
-- would be a second answer to that question — and a wrong one for every row revoked before this file
-- ran, because those timestamps are unknown (see §3).
--
-- ---------------------------------------------------------------------------------------------
-- ⚠ `on delete set null`, LIKE `issued_by` AND UNLIKE `redeemed_by`
-- ---------------------------------------------------------------------------------------------
-- 020's reasoning applies unchanged and this column is on the simple side of it: 「谁撤销的」 has ONE
-- meaning, exactly like `issued_by`'s 「谁发的」. The code outlives the admin who retired it, and an
-- account being purged must not be blocked by, or take with it, the record that a code was withdrawn.
-- ⚠ NOT `cascade` — that would delete a live code because an admin's account was deleted.
--
-- Idempotent: `add column if not exists`, guarded `drop constraint`.

-- ---------------------------------------------------------------------------
-- 1. the two columns
-- ---------------------------------------------------------------------------
alter table public.activation_codes add column if not exists revoked_at timestamptz;
alter table public.activation_codes add column if not exists revoked_by uuid;

-- The foreign key is dropped-and-added by name rather than declared inline, so a re-run replaces
-- whatever the database built the first time rather than failing with 「constraint already exists」.
alter table public.activation_codes drop constraint if exists activation_codes_revoked_by_fkey;
alter table public.activation_codes add constraint activation_codes_revoked_by_fkey
  foreign key (revoked_by) references public.users(id) on delete set null;

comment on column public.activation_codes.revoked_at is
  '1.0.6 四号 §2.4.3 — when this code was retired (「撤销时间」). ⚠ NULL for every code revoked before '
  '025 ran, and NOT backfilled: the timestamp is genuinely unknown, and `now()` at migration time would '
  'be a fabricated date on an audit field. `revoked` remains the authority for 「作废了吗」.';
comment on column public.activation_codes.revoked_by is
  '1.0.6 四号 §2.4.3 — which admin retired this code (「撤销者」). Same NULL story as `revoked_at`. '
  'on delete set null: the code outlives the admin, and a purge must not be blocked by this row.';

-- ---------------------------------------------------------------------------
-- 2. what the writer does now
-- ---------------------------------------------------------------------------
-- `admin-revoke-codes` stamps both columns in the same UPDATE that sets `revoked = true`, so the three
-- cannot disagree — one write, one moment, one actor. ⚠ A code revoked BEFORE this migration keeps
-- `null` in both, which the console draws as 「—」 rather than guessing; see §3.
--
-- Nothing else writes `revoked`, so there is nothing else to update. (Checked: `.from("activation_codes")
-- .update({ revoked` appears in exactly two statements, both in `admin-revoke-codes`.)

-- ---------------------------------------------------------------------------
-- 3. why the old rows are left without a timestamp
-- ---------------------------------------------------------------------------
-- Backfilling `revoked_at = now()` would put a date on the migration run and label it as the date the
-- code was withdrawn — an audit field stating something false, which is worse than an empty one. Setting
-- it to `issued_at` (the only other instant the row knows) would be a different fabrication.
--
-- ⇒ The console renders 「撤销时间：—」 / 「撤销者：—」 for those rows. There is no way to recover the fact,
-- and inventing one would make the column untrustworthy for every row added after it, which is the half
-- that actually matters.
