-- 009_reports.sql — §二 举报与落实: reports / global_settings.
--
--   public.reports         — §2.2 verbatim, the report that lands in the 管理员信箱
--   public.global_settings — §2.3.3 verbatim, the two product-wide switches
--
-- (Renumbered from the spec's 008 — see the header of 006_friends.sql.)
--
-- ---------------------------------------------------------------------------------------------
-- WHAT 「落实」 NEEDS THAT §2.2'S TABLE DOES NOT HAVE
-- ---------------------------------------------------------------------------------------------
-- §2.3.1's table says what each admin action DOES — 警告 sends a notice, 禁言 sets
-- `users.muted_until`, 封禁 sets `users.is_banned` — but a `reports` row only records which action
-- was chosen. Nothing in the spec says where the EFFECT of 「禁言 24 小时」 is written, and there are
-- two candidates: the users row (010_users_ext.sql) or this table.
--
-- ⇒ The users row is the authority. `muted_until` on the account is what 「不能发消息/投票/互动」
-- reads, because a mute is a property of a PERSON and outlives the report that caused it — a second
-- report about the same user must not have to find the first one to know whether they are still
-- muted. This table's `admin_action` / `admin_note` / `handled_at` then record the DECISION, which
-- is what the 信箱's 「已处理」 filter and any future appeal need.
--
-- ⚠ That split is why there is no `reports.user_state` snapshot column: it would be a second answer
-- to 「他现在被禁言了吗」 and would go stale the moment an admin acts on a different report.
--
-- §2.3.2's two product-wide switches live in `global_settings` rather than in a one-row table,
-- because they are read on every send and a key/value table can grow a third switch (§2.3.2's own
-- 「关闭聊天室」 and 「全体禁言」 are one row each) without a migration.

-- ---------------------------------------------------------------------------
-- 1. reports (§2.2)
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  -- ⚠ Both directions are `not null`: a report nobody filed cannot be reviewed, and a report about
  -- nobody cannot be acted on. §2.2 leaves them nullable; the whole point of the table is that an
  -- operator can open it and see two named people.
  reporter_id  uuid not null references public.users(id) on delete cascade,
  reported_id  uuid not null references public.users(id) on delete cascade,
  -- §2.1's four radio buttons, as wire values: 「作弊 / 辱骂骚扰 / 广告刷屏 / 其他」.
  category     text not null,
  detail       text,
  -- §2.2's 「{ message_ids: [], screenshot_urls: [] }」. Kept as jsonb for the same reason
  -- `chat_messages.attachment` is: the shape belongs to the one contract both ends read, not to a
  -- constraint neither end can see.
  evidence     jsonb,
  -- §2.2's four states verbatim: 「'open' | 'reviewing' | 'resolved' | 'dismissed'」.
  status       text not null default 'open',
  -- §2.3.1's five actions verbatim: 「'none' | 'warn' | 'mute-24h' | 'mute-7d' | 'ban'」.
  admin_action text,
  admin_note   text,
  handled_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint reports_category_known check (category in ('cheat', 'abuse', 'spam', 'other')),
  constraint reports_status_known check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  constraint reports_action_known
    check (admin_action is null or admin_action in ('none', 'warn', 'mute-24h', 'mute-7d', 'ban')),
  -- A report cannot be about its own author. Same rule `friend_shares_not_self` makes, and for a
  -- blunter reason: §2.3.1 lets a resolved report mute or ban its subject, so a self-report would
  -- be a button that bans the person pressing it.
  constraint reports_not_self check (reporter_id <> reported_id)
);

-- §2.2's index verbatim — it is the 信箱's default view.
create index if not exists idx_reports_status on public.reports (status, created_at desc);
-- 「我提交的举报」 (§1.5.3's 系统通知 can surface the outcome to the reporter).
create index if not exists idx_reports_reporter on public.reports (reporter_id, created_at desc);
-- The 信箱's per-user view: 「这个人的历史举报」 is what an admin reads before choosing an action,
-- because §2.3.1's 警告→禁言→封禁 ladder only makes sense against a history.
create index if not exists idx_reports_reported on public.reports (reported_id, created_at desc);

alter table public.reports enable row level security;

-- ---------------------------------------------------------------------------
-- 2. global_settings (§2.3.3)
-- ---------------------------------------------------------------------------
create table if not exists public.global_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.global_settings is
  '1.0.3 §2.3.3 — product-wide switches. Written only by admin-global-mute (service role); read by '
  'every authenticated account through a SELECT policy in 011_rls_community.sql.';

-- §2.3.3's seed, idempotent. `'true'::jsonb` rather than the bare `'true'` the spec writes: the
-- bare literal happens to parse as JSON boolean too, but relying on that is how a value ends up
-- stored as the four-character string "true" and every `== true` comparison is false forever.
insert into public.global_settings (key, value) values
  ('chat_enabled', 'true'::jsonb),
  ('global_mute', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. notifications — §2.3.1's 警告 and §1.5.3's 「系统通知」
-- ---------------------------------------------------------------------------
-- ⚠ NOT IN §实现清单, AND TWO SECTIONS OF THE SPEC NEED IT.
--
-- §2.3.1 gives 警告 the effect 「发送通知」 and §1.5.3 draws a 「系统通知」 section in 消息 with
-- 「管理员回复了你的反馈 [查看]」 in it.
--
-- ============================ WHAT IS DERIVED, AND WHAT HAS A ROW ============================
-- §1.5.3's screen has four sections. TWO of them are read straight off a table that already exists,
-- because the row IS the notification — it is created when the event happens and deleted when the
-- event is dealt with, so a badge counted from it cannot disagree with the list:
--
--   * 好友请求 — `friendships` where `status = 'pending' and requester <> me`     (§1.2.2)
--   * 分享     — `friend_shares` where `to_user = me and not consumed
--                 and expires_at > now()`                                          (§1.2.4)
--
-- ⚠ THE OTHER TWO ARE NOT DERIVABLE, AND FOR DIFFERENT REASONS EACH:
--
--   * 系统通知 — a 警告 is a decision an admin made about an account, recorded in `reports`.
--     Deriving it would mean showing every user the reports filed about them, which is the opposite
--     of what §2.3.4 keeps private. There is nothing to read it from.
--   * @提及   — §1.6.3 asks for TWO things: the 「@提及」 list AND 「头像上小红点」. A mention is not
--     a row of its own — it is one name inside `chat_messages.mentioned_users` — so where the list
--     could be queried, the UNREAD MARKER has nowhere to live. The alternatives were a new
--     `users.mention_seen_at` column (a second read-marker beside this table's `read` flag, i.e. two
--     answers to 「这条通知读过没有」) or a row here. A row here reuses the flag and the partial
--     unread index that already exist.
--
-- ⇒ THE RULE: a section whose source row dies when the event is dealt with is DERIVED; a section
-- that needs an unread marker, or whose source is not a row at all, gets a row here. That is why
-- 分享 has no notification and @提及 does, even though both are 「somebody did something to you」.
--
-- ⚠ ONE ROW PER RECIPIENT, not one row with a recipient list: this is a per-user inbox with its own
-- read flag, and a broadcast shape would need a join table to mark anything read.
--
-- ⚠ A 'mention' ROW CAN OUTLIVE ITS MESSAGE. Chat is purged after `CHAT_RETENTION_DAYS` and this
-- row is not, so the list must render a mention whose `message_id` no longer resolves — the client
-- keeps the sender name and the preview IN `data` for exactly that reason, the same trick §1.7.4
-- uses for `reply_preview`.
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  -- The closed set of things that can arrive here. §1.5.3 draws exactly these, and the client
  -- switches on this value to pick an icon and a destination.
  kind       text not null,
  -- Rendered text. ⚠ Stored as DATA rather than as a translation key: the admin writes the wording
  -- of a 警告 by hand (§2.2's `admin_note`), and a key-based scheme could only carry canned
  -- sentences. Where a canned sentence IS right (「你收到一个警告」) the client substitutes its own
  -- translation keyed on `kind` and ignores `title` — the two paths are distinguished by whether
  -- `data` carries a `report_id`.
  title      text,
  body       text,
  -- What the 「[查看]」 button opens: `{ report_id }` / `{ feedback_id }` / `{ message_id, from_user,
  -- username, content }` / nothing.
  data       jsonb,
  read       boolean not null default false,
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  constraint notifications_kind_known
    check (kind in ('warn', 'mute', 'ban', 'report_result', 'feedback_reply', 'mention', 'system'))
);

-- §1.5.3's badge: 「未读的系统通知」. Partial, because read rows are never counted and the list is
-- ordered by recency.
create index if not exists idx_notifications_unread
  on public.notifications (user_id, created_at desc) where read = false;
create index if not exists idx_notifications_user
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

comment on table public.notifications is
  '1.0.3 §2.3.1/§1.5.3 — the per-user 系统通知 inbox. Written only by admin-handle-report (service '
  'role); a user reads and marks-read their own rows (see 011).';

-- ---------------------------------------------------------------------------
-- 4. what 「关闭聊天室」 does NOT touch (§2.3.2)
-- ---------------------------------------------------------------------------
-- 「「关闭聊天室/全体禁言」不影响历史回放与样本互动——这两个是独立的`数据表`，与聊天室无关」.
-- (The spec's own line carries stray markdown backticks around 数据表; read it as 「独立的数据表」.)
-- ⇒ `admin-global-mute` writes this table and nothing else, and the two switches are read by
-- exactly one thing: whether `chat-send` accepts a message. They are deliberately NOT consulted by
-- `friend-share` / `vote-cast` / `report-submit`, because §2.3.2 says in as many words that
-- silencing the room must not silence the archive and sample features. A future reader tempted to
-- "make the mute global" should read that sentence first.
