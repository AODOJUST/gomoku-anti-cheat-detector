-- 026_wanted.sql — 1.0.7 §2.1 缉捕墙: wanted_players / wanted_followers / wanted_evidence.
--
--   public.wanted_players   — §2.1.2's table + the two columns a LIST cannot do without
--   public.wanted_followers — §2.1.2 verbatim
--   public.wanted_evidence  — §2.1.2 verbatim
--   public.wanted_visible() — §2.1.8's read predicate, ONCE, for all three
--   notifications_kind_known += 'wanted'  (§2.1.7's 「跟踪者收到通知」)
--
-- (The spec numbers this 019. The tree is at 025, so it is 026 — see the header of 006_friends.sql.)
--
-- ---------------------------------------------------------------------------------------------
-- ⚠⚠ §2.1.8's THREE POLICIES ARE NOT CREATED AS WRITTEN, AND THIS IS THE MOST IMPORTANT PARAGRAPH
-- ---------------------------------------------------------------------------------------------
-- §2.1.8 asks for a client-visible INSERT policy (`wanted_insert`) and an UPDATE policy for admins
-- (`wanted_update_admin`). Neither is created, here or anywhere, and the argument is 011's, which is
-- worth restating because a 缉捕墙 looks like the one feature where "the database should enforce it"
-- is obviously right:
--
--   * §2.1.4's 一致性检查 (「提交的 username 必须与 URL 中提取的一致」) and §2.1.6's 去重 (「同一
--     suspect_username 只允许一条 approved 记录，重复提交合并到已有条目」) are judgements about a
--     HISTORY — does a row already exist for this name — and RLS sees one row and no history. A
--     `with check` can test the URL's shape; it cannot test 「这个用户名已经有一条了」.
--   * §2.1.6 「所有提交进入 status = 'pending'，只有管理员审核通过才公开」 is the moderation gate, and
--     a `with check (auth.uid() = submitter_id)` INSERT policy would let a client write
--     `status = 'approved'` directly — i.e. publish an accusation against a real person with no
--     human in the loop, on the one table where that is the whole product.
--   * `wanted_followers.follower_count` is a counter, and a counter cannot be incremented by a policy.
--
-- ⇒ All three tables get SELECT policies only. Every write goes through `wanted-submit` /
-- `wanted-approve` / `wanted-follow` / `wanted-add-evidence` (service role), each of which re-reads
-- the account row and refuses on `activated_at is null` / `is_banned` / `muted_until > now()`.
-- `authenticated` is granted NO INSERT/UPDATE/DELETE at all, so a cracked client reaches a 401 rather
-- than a hole — the same shape `reports` / `votes` / `friend_shares` already ship.
--
-- ---------------------------------------------------------------------------------------------
-- THE FOUR DEVIATIONS FROM §2.1.2's CREATE TABLE, AND WHY EACH ONE IS NEEDED
-- ---------------------------------------------------------------------------------------------
-- 1. `submitter_id` IS NULLABLE AND `on delete set null` — NOT the spec's bare `references users(id)`,
--    whose default is NO ACTION (i.e. RESTRICT): a single submission would make its author's account
--    undeletable, and 1.0.5's audit already paid for that shape once (「RESTRICT 外键让注销永远删不掉」).
--    The entry outlives the account that filed it — a moderator's record of an accusation is not the
--    submitter's property — and the client renders the missing name as 「提交者已注销」.
--    ⚠ NOT `cascade`: deleting an account must not erase the wall's own history, silently, from
--    under the other people who submitted evidence.
-- 2. `submitter_name` IS ADDED. The wall renders 「提交者：张三」 on every card (§2.1.3), and the
--    authoritative name lives on `users` — which the wall cannot use, because the directory that
--    resolves an id to a name is loaded by the ROOM and this is a different view: fifty entries would
--    cost fifty reads. A snapshot is this project's established answer to exactly this (see
--    `chat_messages.username` in 005_community.sql, same argument), and `wanted-submit` writes it.
--    ⚠ A renamed account therefore reads stale here until it submits again — accepted, and the same
--    trade the room already makes, because the alternative is a join per card on a public list.
-- 3. `updated_at` IS REAL (the spec defaults it and nothing moves it). §2.1.7 lets anyone append
--    evidence, and 「有新增证据的排在前面」 is what makes the wall's ordering useful rather than
--    merely chronological — so `wanted-add-evidence` and `wanted-approve` touch this column.
-- 4. `approved_by` / `admin_note` ARE **NOT** GRANTED TO `authenticated` (§5). §2.1.9 is explicit
--    about what is public on this wall: 「公开的信息只有：用户名、显示名、理由、证据摘要」. The
--    moderator's own note is NOT in that list, and a column grant is per-ROLE, not per-row — so the
--    note is kept out of the table's grant and handed to the console by §5b's `wanted_admin` view,
--    whose predicate is `is_admin()` (the shape 1.0.5's audit documented for views).
--
-- ---------------------------------------------------------------------------------------------
-- THE DEDUPE RULE (§2.1.6), AND WHY IT IS AN INDEX RATHER THAN A CHECK IN ONE FUNCTION
-- ---------------------------------------------------------------------------------------------
-- 「同一 suspect_username 只允许一条 approved 记录」 is a property of the TABLE, so it is written as a
-- partial UNIQUE index and not as a SELECT-then-INSERT inside `wanted-submit` — two racing submissions
-- for the same name would both find nothing and both insert, and the wall would show one person twice.
-- ⚠ `lower(...)`: gomoku usernames are the same account whatever the case, and §2.1.1 calls this
-- column 「gonoku 用户名（唯一 ID）」. The COMPARISON in §2.1.4's consistency check is deliberately
-- case-SENSITIVE (a submitter must name the account exactly as the profile does); this index is about
-- one ACCOUNT having one entry, where case is noise.
-- ⚠ The index is PARTIAL (`where status = 'approved'`) because a rejected submission must not block
-- the next person who reports the same account — otherwise one bad first submission closes the wall
-- for that name forever.
--
-- ---------------------------------------------------------------------------------------------
-- WHY `follower_count` IS ALLOWED TO BE A REDUNDANT COLUMN
-- ---------------------------------------------------------------------------------------------
-- §2.1.2 asks for it and §2.1.7 says why: 「👥 12 人跟踪」 is drawn on every card, and a count per card
-- is a query per card. Two answers to one question is the shape this project has paid for six times,
-- so the rule is stated here and obeyed in the one writer: **`wanted_followers` is the authority and
-- `follower_count` is derived** — `wanted-follow` re-reads it with `count(*)` over the table after
-- every change rather than incrementing/decrementing a number. A counter maintained by arithmetic
-- drifts the first time two requests interleave; one recomputed from the rows cannot.
--
-- Idempotent: `create table if not exists`, `create or replace function`, guarded `drop policy`,
-- `drop constraint … if exists`.

-- ---------------------------------------------------------------------------
-- 1. wanted_players (§2.1.2)
-- ---------------------------------------------------------------------------
create table if not exists public.wanted_players (
  id                  uuid primary key default gen_random_uuid(),
  -- NULLABLE on purpose — see the header's deviation 1.
  submitter_id        uuid references public.users(id) on delete set null,
  submitter_name      text,
  -- §2.1.2's 「gomoku 用户名（唯一 ID）」 and 「gomoku 主页链接」, both NOT NULL: an entry that names
  -- nobody, or that cannot be looked up, is not something a reader can act on. §2.1.9's first two
  -- constraints (「必须只能提交 gomoku.com 的注册玩家」 / 「不能提交匿名/游客」) are exactly this pair.
  suspect_username    text not null,
  suspect_profile_url text not null,
  suspect_display_name text,
  reason              text,
  -- §2.1.2's 「{ archive_ids: [], sample_ids: [], notes: [] }」. jsonb for the same reason
  -- `reports.evidence` is: the shape belongs to the contract both ends read.
  evidence            jsonb,
  status              text not null default 'pending',
  -- Server-side only — see deviation 4. `wanted-approve` writes it; the submitter reads it as the
  -- notification body (§2.1.6's 「驳回 → 通知提交者」), never as a column.
  admin_note          text,
  approved_at         timestamptz,
  approved_by         uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  -- deviation 3.
  updated_at          timestamptz not null default now(),
  -- §2.1.2's 「跟踪人数（冗余字段）」 — derived, never arithmetically maintained. See the header.
  follower_count      int not null default 0,
  constraint wanted_status_known
    check (status in ('pending', 'approved', 'rejected', 'resolved')),
  constraint wanted_follower_count_sane check (follower_count >= 0)
);

-- ⚠ NO `wanted_not_self` CONSTRAINT, AND ITS ABSENCE IS A DECISION. The tempting one — 「a submitter
-- cannot file against themselves」 — compares names in two different namespaces: `submitter_name` is a
-- 白身 account, `suspect_username` is a gomoku.com account, and the same person legitimately has two
-- different names there. The check would therefore refuse honest entries and allow the attack it
-- means to stop. §2.1.9's real defence is the one `wanted-submit` implements: an accusation has to
-- carry something a moderator can read (a reason, or evidence).

-- §2.1.2's two indexes verbatim — `(status, created_at desc)` is the wall's default view and
-- `(suspect_username)` is the duplicate lookup.
create index if not exists idx_wanted_status on public.wanted_players (status, created_at desc);
create index if not exists idx_wanted_suspect on public.wanted_players (suspect_username);
-- The dedupe guarantee (§2.1.6). See the header for why it is partial and why it is `lower()`.
create unique index if not exists idx_wanted_one_approved
  on public.wanted_players (lower(suspect_username)) where status = 'approved';
-- 「我提交的」 — the one filter a member can use that returns rows an admin also sees.
create index if not exists idx_wanted_submitter
  on public.wanted_players (submitter_id, created_at desc);

alter table public.wanted_players enable row level security;

comment on table public.wanted_players is
  '1.0.7 §2.1.2 — the 缉捕墙. Written ONLY by wanted-submit / wanted-approve (service role): §2.1.8''s '
  'INSERT policy is deliberately not created (see this file''s header) and `authenticated` holds no '
  'write grant at all. Read by members under `wanted_visible()` + the column grant in §5.';

-- ---------------------------------------------------------------------------
-- 2. wanted_followers (§2.1.2)
-- ---------------------------------------------------------------------------
create table if not exists public.wanted_followers (
  id         uuid primary key default gen_random_uuid(),
  -- ⚠ CASCADE, unlike the two `submitter_id`/`approved_by` columns above, and the difference is the
  -- row's MEANING: a follow row is a subscription to one entry and means nothing without it. Leaving
  -- it behind would be a row that counts toward nothing (there is no entry to attach to) and that
  -- `follower_count` — a `count(*)` over this table — would keep counting.
  wanted_id  uuid not null references public.wanted_players(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- §2.1.2's `unique(wanted_id, user_id)`, which is the whole of §2.1.7's 「跟踪」 semantics: a second
  -- press is not a second follower, so the button is idempotent at the database level even before
  -- `wanted-follow` gets to look.
  unique (wanted_id, user_id)
);

create index if not exists idx_wanted_followers_user
  on public.wanted_followers (user_id, created_at desc);

alter table public.wanted_followers enable row level security;

comment on table public.wanted_followers is
  '1.0.7 §2.1.2/§2.1.7 — 跟踪关系. Written ONLY by wanted-follow (service role). This table is the '
  'AUTHORITY for `wanted_players.follower_count`, which wanted-follow recomputes with count(*) — a '
  'counter maintained by arithmetic drifts the first time two requests interleave.';

-- ---------------------------------------------------------------------------
-- 3. wanted_evidence (§2.1.2)
-- ---------------------------------------------------------------------------
create table if not exists public.wanted_evidence (
  id         uuid primary key default gen_random_uuid(),
  wanted_id  uuid not null references public.wanted_players(id) on delete cascade,
  -- NULLABLE: an account that is purged leaves its evidence on the wall (§2.1.9's 「管理员审核是第一
  -- 道闸门」 — the moderator judged what is here, and it is not the author's to withdraw).
  user_id    uuid references public.users(id) on delete set null,
  kind       text not null,
  payload    jsonb,
  created_at timestamptz not null default now(),
  constraint wanted_evidence_kind_known
    check (kind in ('archive', 'sample', 'comment'))
);

create index if not exists idx_wanted_evidence_wanted
  on public.wanted_evidence (wanted_id, created_at desc);

alter table public.wanted_evidence enable row level security;

comment on table public.wanted_evidence is
  '1.0.7 §2.1.2/§2.1.7 — 证据补充. Written ONLY by wanted-add-evidence (service role). Read by '
  'members when the parent entry is visible; the parent''s `updated_at` is bumped on every insert so '
  'the wall can sort 「有新证据的在前」.';

-- ---------------------------------------------------------------------------
-- 4. wanted_visible() — §2.1.8's read predicate, in ONE place
-- ---------------------------------------------------------------------------
-- §2.1.8's sample policy writes the predicate out inline:
--
--     status = 'approved' or submitter_id = auth.uid()
--       or exists (select 1 from users where id = auth.uid() and is_admin = true)
--
-- Three TABLES need that same sentence (the entry, its followers, its evidence), and a predicate
-- written three times is this project's most expensive recurring defect — the copies stay
-- self-consistent and stop agreeing. So it is a function, and every read policy below calls it.
--
-- Same shape and reasoning as `is_member()` / `is_activated()` / `is_admin()`: SECURITY DEFINER (it
-- reads `wanted_players`, whose own RLS would otherwise make the policy query itself), STABLE
-- (answered once per statement), and read from the DATABASE rather than from a claim on the token.
--
-- ⚠ THE THIRD ARM IS `public.is_admin()`, NOT A SECOND `exists (select … from users …)`. §2.1.8's
-- sample spells the admin test out inline; 002_rls.sql already defines it, and 1.0.6 三号's lesson is
-- that 「管理员与否一律服务端判」 means ONE server-side answer — a second spelling would be the copy
-- that stops agreeing the day the role column gains a third value.
--
-- ⚠ `submitter_id = auth.uid()` IS THE HALF THAT MAKES THE FEATURE USABLE. §2.1.6 puts every
-- submission in `pending` and only an admin can approve it, so without this arm the author of a
-- pending entry could not see their own submission — the form would say 「已提交」 and the wall would
-- show nothing, which reads as a failed submit.
--
-- ⚠ AN UNKNOWN ID ANSWERS FALSE (the `coalesce`), rather than null. A policy that evaluates to NULL
-- is a policy that refuses, but it refuses with a NULL that a future `not` would turn into a pass.
create or replace function public.wanted_visible(wanted uuid) returns boolean
  language sql stable security definer as $$
  select coalesce((
    select w.status = 'approved'
        or w.submitter_id = auth.uid()
        or public.is_admin()
    from public.wanted_players w
    where w.id = wanted
  ), false)
$$;

comment on function public.wanted_visible(uuid) is
  '1.0.7 §2.1.8 — may the caller read this 缉捕墙 entry (and its followers / evidence)? Approved, or '
  'their own submission, or an administrator. The ONE spelling of that predicate; the three read '
  'policies below call it and nothing restates it.';

-- ---------------------------------------------------------------------------
-- 5. the read policies (+ the two missing grants 1.0.5's audit made mandatory)
-- ---------------------------------------------------------------------------
-- Read-only, like every moderated table here. See the header for why §2.1.8's INSERT and UPDATE
-- policies are not created.
drop policy if exists wanted_read on public.wanted_players;
create policy wanted_read on public.wanted_players
  for select to authenticated
  using (public.is_member() and public.wanted_visible(id));

-- A follower reads the rows on entries they can see, and their OWN row on any entry — the second half
-- is what lets a wall card draw 「已跟踪」 for a member whose follow was recorded against an entry that
-- has since been resolved away from them. Only rows; the count is never read from here.
drop policy if exists wanted_followers_read on public.wanted_followers;
create policy wanted_followers_read on public.wanted_followers
  for select to authenticated
  using (public.is_member() and (public.wanted_visible(wanted_id) or user_id = auth.uid()));

drop policy if exists wanted_evidence_read on public.wanted_evidence;
create policy wanted_evidence_read on public.wanted_evidence
  for select to authenticated
  using (public.is_member() and public.wanted_visible(wanted_id));

-- ⚠⚠ THE GRANTS ARE THE REAL DOOR, AND 1.0.5's AUDIT IS WHY THEY ARE WRITTEN OUT.
-- Supabase's default privileges give `anon` AND `authenticated` ALL on every new table, so a migration
-- that creates three tables and writes policies for one role has published the other. `anon` holds the
-- extension's own key, so `anon` + no revoke = the wall is readable by the whole internet, including
-- every pending accusation against a named person. This is the same defect 1.0.5 found on
-- `user_directory` (「视图没有 RLS、grant 就是唯一的门」), one release later, on a table that is worse.
revoke all on public.wanted_players from anon;
revoke all on public.wanted_players from authenticated;
-- Column-level, and the COLUMN LIST IS §2.1.9's PUBLIC LIST: 用户名 / 显示名 / 理由 / 证据摘要, plus
-- the bookkeeping a card needs (who filed it, when, how many follow it, what state it is in).
-- ⚠ `admin_note` and `approved_by` ARE ABSENT ON PURPOSE. A grant is per-ROLE, not per-row, so
-- including them would publish the moderator's own note on every approved entry — and §2.1.9 lists
-- what is public in as many words. The note reaches exactly one reader: the submitter, as the body of
-- the notification `wanted-approve` sends.
grant select (id, submitter_id, submitter_name, suspect_username, suspect_profile_url,
              suspect_display_name, reason, evidence, status, approved_at, created_at,
              updated_at, follower_count)
  on public.wanted_players to authenticated;

revoke all on public.wanted_followers from anon;
revoke all on public.wanted_followers from authenticated;
grant select on public.wanted_followers to authenticated;

revoke all on public.wanted_evidence from anon;
revoke all on public.wanted_evidence from authenticated;
grant select on public.wanted_evidence to authenticated;

-- ---------------------------------------------------------------------------
-- 5b. wanted_admin — the moderator's own view of the same rows
-- ---------------------------------------------------------------------------
-- §2.1.6 「管理员审核」 needs to read `admin_note` (what was decided last time, and why) and `approved_by`
-- (who decided) — the two columns §2.1.9's public list excludes and §5 therefore does not grant.
--
-- ⚠ A COLUMN GRANT IS PER-ROLE, NOT PER-ROW, so 「只有管理员读得到备注」 cannot be expressed as a grant
-- on the table: `authenticated` IS the role an admin holds. It CAN be expressed as a view, because a
-- view carries a row predicate — and 1.0.5's audit wrote the rule for exactly this shape: 「视图没有
-- RLS，grant 就是唯一的门」. The door is the grant below; the predicate is `public.is_admin()` INSIDE the
-- view, so a non-admin who holds the grant reads zero rows rather than somebody else's notes.
--
-- ⚠ `security_invoker = false` IS LOAD-BEARING. With the default the view would run as the CALLER, and
-- the caller's RLS on `wanted_players` admits only approved entries — so a pending submission's note
-- would be invisible to the very admin who wrote it. `false` runs the view as its owner (the migration
-- role), which is what lets the predicate be the ONLY gate. That is also why the grant must be
-- explicit: this view reads the table with no RLS at all.
--
-- ⚠ `w.*` IS DELIBERATE, unlike every other select list in this project. This view exists to hand a
-- moderator the whole row — including columns added later — and there is no client-side projection to
-- keep in step, because nothing but the admin console reads it.
create or replace view public.wanted_admin with (security_invoker = false) as
  select w.*, u.username as approved_by_name
  from public.wanted_players w
  left join public.users u on u.id = w.approved_by
  where public.is_admin();

comment on view public.wanted_admin is
  '1.0.7 §2.1.6 — the 管理员审核 console''s read of wanted_players, including `admin_note` / '
  '`approved_by` (which §2.1.9 keeps off the public wall). The grant is the only door and the '
  '`is_admin()` predicate is inside the view — see §5b''s note.';

revoke all on public.wanted_admin from anon;
revoke all on public.wanted_admin from authenticated;
grant select on public.wanted_admin to authenticated;

-- ---------------------------------------------------------------------------
-- 6. §2.1.7 「被跟踪的嫌疑人若新增证据，跟踪者收到通知」
-- ---------------------------------------------------------------------------
-- ⚠ A NEW `kind`, ADDED TO THE WHITELIST RATHER THAN REUSED. `notifications` already exists
-- (009_reports.sql) and 024's header states the rule this obeys: 「如果一个 kind 缺失，就加进白名单；
-- 不要新建一张表」. The tempting alternative is `'system'` — and it is wrong for the reason 1.0.6 §1.1
-- gives for the recall code: `'system'` already means 「系统通知」 (an admin-authored announcement),
-- and a follower notification that shares its code cannot be filtered, counted or worded separately.
-- Same ALTER, same naming as the constraint 009 created.
alter table public.notifications drop constraint if exists notifications_kind_known;
alter table public.notifications add constraint notifications_kind_known
  check (kind in ('warn', 'mute', 'ban', 'report_result', 'feedback_reply', 'mention', 'system',
                  'wanted'));

comment on constraint notifications_kind_known on public.notifications is
  '009_reports.sql''s whitelist; 1.0.7 adds ''wanted'' (§2.1.7''s 「跟踪者收到通知」 — an approval, a '
  'rejection or a new piece of evidence on an entry the recipient follows). `data` carries '
  '{ wanted_id, event }, and the client words the sentence per `event`.';
