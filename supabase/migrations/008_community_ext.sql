-- 008_community_ext.sql — §一.1.3 / §一.6.4 / §一.7.4: the three columns chat_messages gains.
--
--   attachment      §1.1.3 — a 分享消息 carries { kind, cloud_id, name, summary, expires_at }
--   mentioned_users §1.6.4 — `uuid[]`, the accounts an @用户名 resolved to
--   reply_to        §1.7.4 — the message being quoted
--   reply_preview   §1.7.4 — 「冗余存储，避免每次 join」
--
-- (Renumbered from the spec's 007 — see the header of 006_friends.sql.)
--
-- ⚠ EVERY COLUMN IS NULLABLE, and that is the compatibility statement: every row 1.0.2 wrote is a
-- plain text message, and after this migration it still reads as one. The client's renderer decides
-- between 「普通消息」 and 「分享消息」 on `attachment is not null`, not on `type` — see below.
--
-- ---------------------------------------------------------------------------------------------
-- WHERE §1.1.3's `type` FIELD WENT
-- ---------------------------------------------------------------------------------------------
-- §1.1.3's sample object carries both `type: 'text' | 'archive-share' | 'sample-share'` and
-- `attachment.kind: 'archive' | 'sample'`. Those are the same fact twice: `type` is exactly
-- 'text' when there is no attachment, and `kind + '-share'` when there is. A column that is a
-- function of another column is the shape this project has paid for six times — the two stay
-- self-consistent and stop agreeing, and nothing goes red.
--
-- ⇒ Only the fact is stored (`attachment`), and `type` is DERIVED where it is needed. The client
-- has one helper for it (`cmMsgType` in viewer.js) and the acceptance tests assert the derivation
-- rather than a stored copy. `content` is still stored on a share row: §1.1.3 gives it
-- 「分享了一个存档」, which is the line the room shows and the line the censor and the length limit
-- applied to.

-- ---------------------------------------------------------------------------
-- 1. the three columns (§1.1.3 / §1.6.4 / §1.7.4)
-- ---------------------------------------------------------------------------
alter table public.chat_messages
  add column if not exists attachment jsonb;

alter table public.chat_messages
  add column if not exists mentioned_users uuid[];

-- `on delete set null` rather than `cascade`: deleting a message must not delete the replies that
-- quote it. §1.7.3's card keeps rendering from `reply_preview` after the original is gone, which is
-- the whole reason that column is redundant storage — a broken quote is worse than a dangling one.
alter table public.chat_messages
  add column if not exists reply_to uuid references public.chat_messages(id) on delete set null;

alter table public.chat_messages
  add column if not exists reply_preview jsonb;

-- §1.6.3 「被 @ 的用户收到通知」 — the 消息 list asks 「哪些消息提到了我」, which is a containment
-- test on the array and therefore a GIN index, not a btree.
create index if not exists idx_chat_messages_mentions
  on public.chat_messages using gin (mentioned_users);

-- ---------------------------------------------------------------------------
-- 2. what the shape of `attachment` / `reply_preview` is pinned to
-- ---------------------------------------------------------------------------
-- ⚠ THE JSONB SHAPES ARE VALIDATED IN `chat-send`, NOT BY A CHECK CONSTRAINT, and the reason is
-- that a CHECK cannot be shared. §1.1.3's attachment is written by one Function and read by the
-- client, so the shape is a contract between two realms; a constraint here would be a third
-- spelling of it that neither realm can see, and it would reject rows for a shape the client had
-- already learned to render. The contract lives in `_shared/community.ts` (`shareAttachment` /
-- `replyPreview`) and is mirrored into `extension/community-shared.js` by the generator, so both
-- ends and the test suite read one definition.
--
-- What the database DOES guarantee is the part that is a fact about this schema rather than about
-- the payload: `mentioned_users` is a uuid[], `reply_to` points at a real message of this table,
-- and `attachment` is either absent or a JSON object (never a bare string or an array — a client
-- that renders `attachment.cloud_id` on a string gets `undefined` and draws an empty card, which is
-- the kind of failure that looks like a rendering bug for a week).
alter table public.chat_messages
  drop constraint if exists chat_messages_attachment_is_object;
alter table public.chat_messages
  add constraint chat_messages_attachment_is_object
  check (attachment is null or jsonb_typeof(attachment) = 'object');

alter table public.chat_messages
  drop constraint if exists chat_messages_reply_preview_is_object;
alter table public.chat_messages
  add constraint chat_messages_reply_preview_is_object
  check (reply_preview is null or jsonb_typeof(reply_preview) = 'object');

-- ---------------------------------------------------------------------------
-- 3. cloud_shares — the artefact a 分享消息 points at (§1.1.2 / §1.1.3)
-- ---------------------------------------------------------------------------
-- ⚠ THIS TABLE IS NOT IN §实现清单, AND §1.1.3 CANNOT WORK WITHOUT IT.
--
-- §1.1.3's attachment carries `cloud_id: 'cloud-xxx'  // 云端 ID` and §1.1.2 says the picker emits
-- 「一条分享消息（含附件 ID + 云端链接）」. That is a second artefact with its own identity: the
-- message is in the room for 7 days, and the thing it points at has to be readable by every member
-- for as long as the message is. `public.archives` / `public.samples` cannot be it — both are
-- per-user under `archives_select_self` / `samples_select_self` (002_rls.sql), so a reader other
-- than the owner sees an empty list. A share therefore needs a COPY that lives under a
-- community-wide policy, and that copy is this table.
--
-- ⚠ WHY NOT REUSE `friend_shares` WITH A NULL RECIPIENT: the two lifetimes are the point of the
-- feature and they are not compatible. §1.2.4 gives a friend share 15 minutes and §1.1.2 gives a
-- room share 7 days (「保留时间与普通消息一致」); a reader policy, a purge job and a countdown all
-- branch on the deadline, so one table would carry a flag that every query has to respect — and the
-- day one of them forgets it, a friend's private replay becomes public. Two tables, two policies,
-- two lifetimes, no flag.
--
-- `owner_id` is who shared it: §1.4.1 makes them the poll's creator (§1.4.1's `creator_id`), and
-- §1.4.4's 「[关闭投票]（发布者可见）」 is decided by comparing it with the caller.
create table if not exists public.cloud_shares (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.users(id) on delete cascade,
  -- §1.1.2's two pickers: 发送回放 / 发送样本.
  kind        text not null,
  -- §1.1.3's `name`: 「张三 VS 李四 黑72/白85」 — the label the card shows.
  name        text,
  -- §1.1.3's `summary`: 「简化的元数据」. The card's 「黑 72 / 白 85 · 全局 · 42 手 · 直止·寒星」
  -- line, so the room does not have to download a whole replay to draw a preview.
  summary     jsonb,
  -- Same two-column arrangement as friend_shares, and the same 500 KB threshold: small items ride
  -- in the row, large ones go to the `temp-shares` bucket.
  payload     jsonb,
  storage_url text,
  size_bytes  integer,
  created_at  timestamptz not null default now(),
  -- §1.1.2 「保留时间与普通消息一致（7 天）」. Defaulted from the same window the chat read query
  -- uses (`CHAT_RETENTION_DAYS`), so a share cannot outlive the message that carries it.
  expires_at  timestamptz not null default (now() + interval '7 days'),
  constraint cloud_shares_kind_known check (kind in ('archive', 'sample')),
  constraint cloud_shares_has_body check (payload is not null or storage_url is not null),
  -- §1.1.3 「name: '张三 VS 李四 黑72/白85'」 — a share with no label draws an empty card, so it is
  -- required rather than merely expected.
  constraint cloud_shares_name_present check (name is not null and length(btrim(name)) > 0)
);

-- The purge job's scan, and the read policy's `expires_at > now()`.
create index if not exists idx_cloud_shares_expires on public.cloud_shares (expires_at);
-- 「我还分享了什么」 + the poll lookup by (owner, target).
create index if not exists idx_cloud_shares_owner on public.cloud_shares (owner_id, created_at desc);

alter table public.cloud_shares enable row level security;

comment on table public.cloud_shares is
  '1.0.3 §1.1.2/§1.1.3 — the cloud copy of an archive/sample a member shared into the room, and the '
  'target `votes.target_cloud_id` points at (§七.5: 投票仅对云端分享的存档/样本生效). Written only by '
  '`chat-send`, which uploads and posts the message in ONE call so a stored copy can never be '
  'orphaned by a failed message; read by every member while it is live (see 011).';

-- ---------------------------------------------------------------------------
-- 3. the poll's link to its target — §1.4.3's `target_cloud_id`
-- ---------------------------------------------------------------------------
-- ⚠ ADDED HERE, ONE MIGRATION AFTER `votes`, BECAUSE THE REFERENT IS THIS FILE'S. 007 defines the
-- column and its type; the constraint has to wait until `cloud_shares` exists. A `references` clause
-- in 007 would fail with 42P01 on a fresh database.
--
-- ⚠ `on delete cascade`, AND THAT IS THE POINT OF ADDING IT AT ALL. `friend-share-purge` deletes
-- expired `cloud_shares` rows on a clock (§1.1.2 gives a room share 7 days). Without this, the poll
-- would survive its own subject: §1.4.4's card would still draw four buttons and a tally, and every
-- 「查看」 on it would fail — a broken card that reads as a rendering bug. Cascade also clears the
-- ballots, through `vote_ballots`' own `on delete cascade`, so no tally outlives the thing it was
-- about.
--
-- Idempotent by probe rather than by `if not exists` — Postgres has no such clause for constraints.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'votes_target_cloud_fk'
      and conrelid = 'public.votes'::regclass
  ) then
    alter table public.votes
      add constraint votes_target_cloud_fk
      foreign key (target_cloud_id) references public.cloud_shares(id) on delete cascade;
  end if;
end $$;
