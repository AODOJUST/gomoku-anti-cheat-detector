-- 007_votes.sql — §一.4 投票: votes / vote_ballots, plus the aggregate view that keeps it anonymous.
--
--   public.votes        — §1.4.3, the poll attached to one cloud-shared archive or sample
--   public.vote_ballots — §1.4.3, one row per voter, `unique(vote_id, user_id)`
--   public.vote_tally   — DERIVED. The four counts, and nothing else. See the long note below.
--
-- (Renumbered from the spec's 006 — see the header of 006_friends.sql.)
--
-- ---------------------------------------------------------------------------------------------
-- WHY THERE IS A VIEW, AND WHY §1.4.5'S INSERT POLICY IS NOT HERE
-- ---------------------------------------------------------------------------------------------
-- Two things in §1.4 cannot both be taken literally, and the resolutions are the two structures
-- below rather than two omissions.
--
-- ① §1.4.4 draws 「[双方AI] 8 票」 — the reader must see counts. §七.3 settles the other half:
--    「本稿按「匿名投票，仅显示票数」落地」. An RLS policy is row-level, so the only policy that
--    lets a client COUNT ballots is one that also lets it READ them — and reading them is exactly
--    what 「匿名」 forbids. The counts therefore have to arrive as a projection that cannot be
--    un-aggregated, which is what `public.vote_tally` is: `security_invoker = false` (the default)
--    means the view evaluates as its owner and is not filtered by the ballots policy, and what it
--    exposes is `(vote_id, choice, n)`.
--
--    ⚠ WHY NOT A DENORMALISED `votes.tally jsonb` COLUMN, which would be simpler to read: because
--    it can drift. Two concurrent casts read-modify-write the same jsonb, or a cast that is later
--    deleted leaves its count behind, and the board silently reports a number no ballot supports.
--    A group-by cannot disagree with the rows it counts. `vote-cast` returns the fresh tally from
--    this view so the caster sees their own vote land without a second round trip.
--
-- ② §1.4.5 gives an `insert` policy on `vote_ballots` checking activation, mute and the poll's
--    window. It is NOT created — not because the checks are wrong (they are copied into
--    `vote-cast`, see there) but because of what a client-side INSERT would ALSO skip: §1.4.3's
--    `unique(vote_id, user_id)` becomes a 409 the client has to interpret rather than an answerable
--    「你已经投过了」, and the ballot's `choice` would be whatever the caller typed. Every write in
--    this schema goes through an Edge Function (005_community.sql states the rule), and a table
--    whose rows are counted by a view is no place for the one exception.
--
-- Note what still does the work: RLS is ENABLED on both tables with no INSERT/UPDATE/DELETE policy
-- at all, so `authenticated` is refused outright even though it holds a default grant. Declared
-- writes are the Functions; undeclared writes are nobody.

-- ---------------------------------------------------------------------------
-- 1. votes (§1.4.3)
-- ---------------------------------------------------------------------------
create table if not exists public.votes (
  id               uuid primary key default gen_random_uuid(),
  -- §1.4.3's 「'archive' | 'sample'」. §1.4 / §七.5 confine polls to CLOUD-SHARED items —
  -- 「仅对云端分享的存档/样本生效，本地存档不参与」 — so `target_cloud_id` names a row that a
  -- reader can reach, not a local id that means nothing on another machine.
  target_kind      text not null,
  -- ⚠ DECLARED `uuid`, WHERE §1.4.3's SKETCH SAYS `text`. The referent is `cloud_shares.id`, which is
  -- a uuid, and a text column could hold a string that matches no row — so the liveness check in
  -- `vote-create` would be the ONLY thing standing between a poll and a target nobody can open. The
  -- spec's sketch types every id in this section as text (`reports.reporter_id` too); the column
  -- that has a referent is typed to match it, and the FOREIGN KEY itself is added at the end of
  -- 008_community_ext.sql because `cloud_shares` is created there — one migration later.
  target_cloud_id  uuid not null,
  creator_id       uuid not null references public.users(id) on delete cascade,
  created_at       timestamptz not null default now(),
  -- §1.4.2 「持续时间：24 小时」. Defaulted by the DATABASE for the same reason
  -- `friend_shares.expires_at` is: a window computed in JavaScript is off by the request duration.
  closes_at        timestamptz not null default (now() + interval '24 hours'),
  -- §1.4.2 「或 发布者手动关闭」 — an early close is a flag, not a rewrite of `closes_at`, so
  -- 「距离投票结束」 stays a fact about when it was meant to close.
  closed_manually  boolean not null default false,
  constraint votes_kind_known check (target_kind in ('archive', 'sample'))
);

-- One poll per target. §1.4.1 opens a poll when the publisher sends an item; a second poll on the
-- same archive would make 「这个存档的投票」 ambiguous every time it is displayed.
create unique index if not exists idx_votes_target on public.votes (target_kind, target_cloud_id);
-- The 他人主页 / community feed lists open polls newest-first.
create index if not exists idx_votes_open on public.votes (closes_at desc) where closed_manually = false;

alter table public.votes enable row level security;

-- ---------------------------------------------------------------------------
-- 2. vote_ballots (§1.4.3)
-- ---------------------------------------------------------------------------
create table if not exists public.vote_ballots (
  id         uuid primary key default gen_random_uuid(),
  vote_id    uuid not null references public.votes(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  -- §1.4.2's four options verbatim: 黑方 AI / 白方 AI / 双方 AI / 双方人类.
  choice     text not null,
  created_at timestamptz not null default now(),
  -- §1.4.3 「一人一票」. Declared here as well as in the spec, because this is the constraint the
  -- Function's error message is ABOUT: `vote-cast` probes for an existing row first so the caller
  -- is told 「你已经投过了」, and 23505 on this index is the backstop for the race the probe misses.
  constraint vote_ballots_once unique (vote_id, user_id),
  constraint vote_ballots_choice_known
    check (choice in ('black-ai', 'white-ai', 'both-ai', 'both-human'))
);

-- The view below groups by (vote_id, choice); this is its index.
create index if not exists idx_vote_ballots_vote on public.vote_ballots (vote_id, choice);
-- 「我投过哪些票」 on the community feed. Also what makes the one-ballot-per-vote probe cheap.
create index if not exists idx_vote_ballots_user on public.vote_ballots (user_id, created_at desc);

alter table public.vote_ballots enable row level security;

-- ---------------------------------------------------------------------------
-- 3. vote_tally — the counts, without the voters
-- ---------------------------------------------------------------------------
-- `security_invoker = false` is the point, not a default we forgot to change: the view must see the
-- ballots even though `vote_ballots` has no SELECT policy for the general reader. It projects
-- three columns and no identity, so 「谁投了什么」 cannot be recovered from it — which is §七.3's
-- 「匿名投票，仅显示票数」 expressed as a shape rather than as a promise.
--
-- ⚠ It is deliberately NOT `select ..., array_agg(user_id)`: an aggregate that carries identities
-- is a ballot table with extra steps.
create or replace view public.vote_tally
  with (security_invoker = false) as
  select
    b.vote_id,
    b.choice,
    count(*)::integer as n
  from public.vote_ballots b
  group by b.vote_id, b.choice;

comment on view public.vote_tally is
  '1.0.3 §1.4.4 / §七.3 — the four counts per poll and nothing else. security_invoker=false so it '
  'is not filtered by vote_ballots RLS; it exposes no voter identity, which is what makes the poll '
  'anonymous while still showing 「[双方AI] 8 票」.';

-- Reading the counts is not a write and needs no account state beyond being in the community. A
-- view has no RLS of its own, so the grant above is the whole gate; `votes` itself (which rows
-- exist, who created them, when they close) is governed by a policy in 011_rls_community.sql, so
-- that the entire read surface can be reviewed in one file.
grant select on public.vote_tally to authenticated;

-- ⚠⚠ 1.0.5（审计 P0-1 的视图版）— `grant select … to authenticated` 是**追加**，不是**唯一**的门。
-- Supabase 的 `ALTER DEFAULT PRIVILEGES` 把 `public` 里**新建对象**的全部权限授予
-- `anon` / `authenticated` / `service_role`，而这个 `create or replace view` 正是以 `postgres`
-- 身份执行的 ⇒ 上面那一句 `grant` 之前，`anon` 已经拿着这张视图的 `arwdDxtm` 了。表靠 RLS 兜底
-- （这就是「每个 create table 都必须开 RLS」那条规则的工作方式），**视图没有 RLS**，所以少一句
-- `revoke` 就等于把整张视图公开给未登录调用者。
--
-- 这张视图里没有身份信息，所以后果比 `user_directory` 轻；但规则是同一个，而且这里曾经就是漏的
-- —— 实测 `has_table_privilege('anon','public.vote_tally','select')` 在本迁移之后为 `true`。
-- 1.0.5 把它补上：**读票数仍然只对已登录账户开放**。
revoke all on public.vote_tally from anon;
