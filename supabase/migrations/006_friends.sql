-- 006_friends.sql — §一.2 好友系统: friendships / friend_shares / daily_quotas.
--
--   public.friendships   — §1.2.1, plus the pair ordering and the requester rule as CONSTRAINTS
--   public.friend_shares — §1.2.3 / §1.2.4, the 15-minute temporary share
--   public.daily_quotas  — §1.2.5, the per-user per-day send counters
--
-- ⚠ THE FILE NAME IS NOT THE SPEC'S. §实现清单 calls this `005_friends.sql`, but 005 was taken by
-- `005_community.sql` in 1.0.2 — the 定稿 was written against a tree where that migration did not
-- exist yet. All six of 1.0.3's migrations are shifted by one for the same reason (006..011 where
-- the spec says 005..010). Renumbering is the only option: the CLI orders by filename prefix. This
-- is the same 「公式 vs 示例」 case 005_community.sql records — the SHAPE is the requirement, the
-- NUMBER is an artefact of when the spec was written.
--
-- Idempotent, like every other migration here (`create table if not exists`, every `create policy`
-- preceded by `drop policy if exists`), because the operator's remote `supabase_migrations` table
-- holds only 001..005 pushed by us and a re-push replays the whole line.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THE SPEC'S SAMPLE SQL LEAVES OUT, AND WHY THE DATABASE ENFORCES IT INSTEAD
-- ---------------------------------------------------------------------------------------------
-- §1.2.1 writes 「约定：`user_a < user_b`（按 UUID 字符串排序），保证唯一性」 — as a CONVENTION, in
-- prose, under a table that then declares `unique(user_a, user_b)`. A unique index on an unordered
-- pair does not do that job: (A,B) and (B,A) are two different keys, so the same two people can
-- hold two live rows, and 「我和他是不是好友」 becomes a question with two answers depending on who
-- asked first. `check (user_a < user_b)` makes the prose a fact of the schema, and every writer is
-- a service-role Edge Function that normalises the pair before it inserts.
--
-- ⚠ It also makes `requester` meaningful: without the ordering, "who asked" could be recovered from
-- the column order, and the `check` below would be unnecessary. With it, `requester` is the only
-- record of direction and must be constrained to be one of the two.
--
-- The same treatment is applied to every enum the spec spells as a `-- comment`: `status`,
-- `friend_shares.kind`, `manual_status` (010). Each of these is compared by literal in a policy, in
-- an Edge Function or in the view, and a value outside the set does not error — it silently fails
-- every comparison, which is how a share becomes permanently undeliverable.

-- ---------------------------------------------------------------------------
-- 1. friendships (§1.2.1)
-- ---------------------------------------------------------------------------
create table if not exists public.friendships (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid not null references public.users(id) on delete cascade,
  user_b     uuid not null references public.users(id) on delete cascade,
  -- §1.2.1's three values verbatim: 「'pending' | 'accepted' | 'blocked'」.
  status     text not null default 'pending',
  -- ⚠ NOT IN §1.2.1's SKETCH, AND THE FEATURE DOES NOT WORK WITHOUT IT. §1.5.2's 拉黑 is defined by
  -- its effect 「不再接收对方消息」 — but `status` is ONE column for ONE pair, so without recording
  -- WHICH side blocked, the blocked account is a party to the row and can simply call 「解除拉黑」.
  -- The block would then be a suggestion the blocked party can lift, and §1.5.2's 「对方发来的消息/
  -- 分享自动拒绝」 would be enforced only for as long as the blocked user cooperates.
  -- ⇒ one nullable column, and `friend-accept` answers `unblock` only to the account named here.
  -- The spec's own columns are untouched; this is additive, exactly like §1.5.2's 备注 columns.
  blocked_by uuid references public.users(id) on delete set null,
  -- §1.2.2 「requester = A」 — who sent the request. The pair is ordered, so this is the only
  -- column that records direction; without it an incoming request could not be told from an
  -- outgoing one on the recipient's 消息 screen.
  requester  uuid not null references public.users(id) on delete cascade,
  -- §1.2.1 「remark_a — A 对 B 的备注」. Which remark belongs to whom is decided by the pair order,
  -- not by who asked: A's remark is about B and lives in `remark_a` regardless of direction.
  remark_a   text,
  remark_b   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_pair_ordered check (user_a < user_b),
  constraint friendships_distinct check (user_a <> user_b),
  constraint friendships_requester_in_pair check (requester in (user_a, user_b)),
  constraint friendships_status_known check (status in ('pending', 'accepted', 'blocked')),
  -- The two halves of 「谁拉黑」 cannot disagree: a blocker exists exactly when the status is
  -- 'blocked', and a row that says 'blocked' with nobody to blame is not a state any code path can
  -- produce. Written as one biconditional rather than two one-way checks so a partial update fails
  -- loudly (23514) instead of leaving the pair half-marked.
  constraint friendships_block_consistent
    check ((status = 'blocked') = (blocked_by is not null)),
  -- The blocker is a party to the row. `blocked_by` is `on delete set null`, so this admits NULL
  -- (a deleted blocker un-marks the block) but never a stranger.
  constraint friendships_blocker_in_pair
    check (blocked_by is null or blocked_by in (user_a, user_b))
);

-- §1.2.1's two indexes verbatim. Each is (side, status) because every query this table serves is
-- 「和我有关的、且处于某状态的」 — the friend list, the pending-request badge, the block check.
create index if not exists idx_friendships_a on public.friendships (user_a, status);
create index if not exists idx_friendships_b on public.friendships (user_b, status);

alter table public.friendships enable row level security;

-- ---------------------------------------------------------------------------
-- 2. friend_shares (§1.2.3 / §1.2.4)
-- ---------------------------------------------------------------------------
-- ⚠ THIS TABLE IS THE ONE PLACE THE PRODUCT DELETES USER DATA ON A CLOCK. §1.2.4: 「每条
-- friend_shares 的 expires_at = created_at + 15 分钟」, the row is gone (and the Storage object with
-- it) if the recipient does not take it. Two consequences are built into the shape:
--
--   * `payload` is nullable and `storage_url` is nullable, and exactly one of them is used: §1.2.3
--     「数据本体（< 500KB 时）；超出则用 storage_url」. A row with neither is not a share, and the
--     CHECK below says so rather than leaving a reader to guess which column to look in.
--   * `consumed` is NOT what expires the row. §1.2.4 「若选「导入」，立即写入，并标记 consumed =
--     true」 — the flag records that the recipient took it, and the row still expires on the clock
--     (「若 15 分钟内未操作，数据过期」). Expiry is `expires_at`, and only `expires_at`.
create table if not exists public.friend_shares (
  id          uuid primary key default gen_random_uuid(),
  from_user   uuid not null references public.users(id) on delete cascade,
  to_user     uuid not null references public.users(id) on delete cascade,
  -- §1.2.3's three kinds verbatim: 「'archive' | 'sample' | 'config'」.
  kind        text not null,
  payload     jsonb,
  storage_url text,
  size_bytes  integer,
  created_at  timestamptz not null default now(),
  -- §1.2.4 「created_at + 15 分钟」, evaluated by the DATABASE rather than by the function that
  -- inserts: a share whose window was computed in JavaScript would be off by however long the
  -- request took, and two writers could disagree about the same row.
  expires_at  timestamptz not null default (now() + interval '15 minutes'),
  consumed    boolean not null default false,
  constraint friend_shares_kind_known check (kind in ('archive', 'sample', 'config')),
  constraint friend_shares_has_body check (payload is not null or storage_url is not null),
  constraint friend_shares_not_self check (from_user <> to_user)
);

-- §1.2.4's index verbatim — it is what the purge job scans.
create index if not exists idx_friend_shares_expires on public.friend_shares (expires_at);
-- §1.5.3's 消息 list: 「发给我、我还没接收、并且还没过期」. Without this the inbox is a sequential
-- scan of everybody's shares.
create index if not exists idx_friend_shares_inbox on public.friend_shares (to_user, consumed, expires_at);
-- The daily-quota check counts what one user SENT today, so it needs the other direction.
create index if not exists idx_friend_shares_sent on public.friend_shares (from_user, created_at);

alter table public.friend_shares enable row level security;

-- ---------------------------------------------------------------------------
-- 3. daily_quotas (§1.2.5)
-- ---------------------------------------------------------------------------
-- §1.2.5's table verbatim, with one resolution stated rather than left implicit:
--
-- 「样本 | 无明确限制（按「回放」类处理，暂定 20 / 天）」 — the table lists two columns and the
-- prose says samples are handled as the replay class. ⇒ `shares_archive` counts BOTH `archive` and
-- `sample` shares against the same 20/day. Adding a third column would have been a nicer shape and
-- a worse contract: the spec's own 「按「回放」类处理」 says these are one class, and splitting them
-- would produce two quotas that the acceptance list (§六.5 「回放 20 / 配置 10」) does not describe.
--
-- `date` is the SERVER's UTC day, and the default spells the expression out
-- (`(now() at time zone 'utc')::date`) rather than using `current_date` so that it cannot depend on
-- the database's `TimeZone` setting. The reader is `_shared/community.ts:serverDate()`, which
-- computes the same key from a JavaScript timestamp — and the quota is a read-then-write, so a
-- function that computed its own day differently from this default would check one day and bill
-- another. ⚠ A counter keyed on a CLIENT-supplied day is a counter the client resets by changing its
-- clock.
create table if not exists public.daily_quotas (
  user_id        uuid not null references public.users(id) on delete cascade,
  date           date not null default ((now() at time zone 'utc')::date),
  shares_archive integer not null default 0,
  shares_config  integer not null default 0,
  primary key (user_id, date)
);

alter table public.daily_quotas enable row level security;

-- ---------------------------------------------------------------------------
-- 4. housekeeping (§1.2.4 「Supabase Cron 每 1 分钟扫描并删除过期记录 + Storage 文件」)
-- ---------------------------------------------------------------------------
-- Shipped commented, exactly like 004_email_codes.sql's purge and 005_community.sql's chat purge,
-- and for the same reason: pg_cron has to be enabled per project (Dashboard → Database →
-- Extensions) and a migration that enables an extension the operator has not opted into is not this
-- file's call. `docs/DEPLOY.md` walks through it.
--
-- ⚠ The purge CANNOT be pure SQL, which is why it calls a Function rather than doing the DELETE
-- here: `delete from storage.objects` removes the metadata row and leaves the object's bytes in the
-- bucket's backend untouched. §1.2.4 promises 「数据消失」, so the deletion has to go through the
-- Storage API — that is `friend-share-purge` (the tenth function of this release; §实现清单 lists
-- nine and this rule needs a tenth, see its header).
--
--   select cron.schedule('baishen-purge-shares', '* * * * *', $$
--     select net.http_post(
--       url     := 'https://<project-ref>.supabase.co/functions/v1/friend-share-purge',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--                                     'x-purge-secret', '<PURGE_SECRET>'),
--       body    := '{}'::jsonb
--     );
--   $$);
--
-- Until the operator enables it, the window is enforced on READ (every query this table serves
-- filters `expires_at > now()`), so the visible behaviour of §1.2.4 already holds and the expired
-- rows are merely still on disk — the same arrangement 005_community.sql made for the 7-day chat
-- window. ⚠ The window itself is spelled twice by design and the two must agree: the DEFAULT on
-- `expires_at` above and `SHARE_TTL_MS` in `functions/_shared/community.ts`.
