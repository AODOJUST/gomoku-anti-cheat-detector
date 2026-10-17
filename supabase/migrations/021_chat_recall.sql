-- 021_chat_recall.sql — 1.0.6 §1.11 「消息撤回（2 分钟内）」.
--
--   recalled       §1.11.2 「撤回后灰色斜体「该消息已被撤回」」
--   recalled_at    §1.11.1 「可选 recall_reason」 的时间戳那一半
--   recall_reason  §1.11.1 的「可选」
--
-- (The 定稿 calls this `013_recall.sql`. Renumbered here to 021 — 013 is 1.0.4's realtime migration,
-- the same 「公式 vs 示例」 case 005's header describes: the spec's SHAPE is the requirement, the
-- NUMBER is an artefact of when it was written.)
--
-- ---------------------------------------------------------------------------------------------
-- THE COLUMNS ARE THE EASY HALF. THE PREMISE IS THE OTHER ONE.
-- ---------------------------------------------------------------------------------------------
-- `013_realtime.sql` subscribed `chat_messages` **INSERT-only**, and it wrote down exactly why:
-- 「a message is never edited」. That is why the room is the one published table without
-- `replica identity full` — the file says so in as many words, and adds that it is the table that
-- grows to millions of rows, so the WAL saving is real.
--
-- §1.11 makes a message editable. A recall is an `update`, and **there is no reader on the other
-- side that would ever notice it**:
--
--   * the live socket asks for `INSERT` only (`REALTIME_TABLES`), so an UPDATE is never delivered;
--   * the polling fallback (`rtPollOnce` in community.js) asks the room for `created_at > RT.since`
--     — it is a forward scan for NEW rows and by construction never re-reads an old one;
--
-- ⇒ the reader keeps drawing 「你好」 for a message its author withdrew, until they reload the page.
-- A flag nobody can see is not a withdrawn message, and this is the same shape as 1.0.4's
-- 「订阅成功 ≠ 会收到」: a feature that looks shipped and delivers nothing.
--
-- So this file does two things beyond the columns, and both are consequences of §1.11 rather than
-- decorations on it:
--
--   1. `replica identity full` on `chat_messages` — WITHOUT IT REALTIME SILENTLY DROPS THE UPDATE.
--      Realtime evaluates the table's RLS against the row it is about to send; on an UPDATE the row
--      carrying the predicate is the OLD one, and the default identity ships only the primary key.
--      013's header states the rule for the other six tables; this is the seventh, arriving late.
--      The cost is real (the old row goes into the WAL) and it is the price of the feature.
--   2. the client subscription list gains `chat_messages: '*'` — a migration cannot change that (it
--      is `_shared/community.ts`'s `REALTIME_TABLES`), but the two halves have to move TOGETHER:
--      publishing more than the client asks for changes nothing, and asking for more than the
--      publication carries delivers nothing. `verify-066` §1 pins them equal for this reason.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE 定稿'S `chat_recall` POLICY IS NOT SHIPPED
-- ---------------------------------------------------------------------------------------------
-- §1.11 proposes:
--
--   create policy ... for update using (auth.uid() = user_id and created_at > now() - interval '2 minutes')
--                              with check (recalled = true and auth.uid() = user_id);
--
-- `005_community.sql` and `011_rls_community.sql` give `chat_messages` **no INSERT, UPDATE or
-- DELETE policy at all**, on purpose, and the reason is written there: RLS sees a row, not a
-- history and not a word list, so §2.3.5's rate limit and §1.6.4's resolved mentions cannot be
-- expressed as a predicate. Recall is the same shape one step further on — a `check (recalled = true)`
-- cannot say that `recalled_at` matches, cannot stop a direct client from also rewriting `content`
-- in the same UPDATE, and cannot refresh the `reply_preview` snapshots §1.11.4 needs (see below).
--
-- ⇒ The write goes through the `chat-recall` Edge Function (service role) like every other write to
-- this table, `auth.uid() = user_id` is checked there, and `RECALL_WINDOW_MS` (the one home of 「2
-- minutes」, mirrored to the client) is imposed as a cutoff on the UPDATE itself. Adding a policy
-- here would be a SECOND write path to one table, which is the thing 011 spends its header refusing.

-- ---------------------------------------------------------------------------
-- 1. the three columns (§1.11.1)
-- ---------------------------------------------------------------------------
-- ⚠ `not null default false` for `recalled`, not a nullable flag: 「撤回了吗」 is asked once per
-- message by every reader, and a tri-state answer (absent / false / true) puts that one question in
-- two places. The default also back-fills: every row 1.0.2–1.0.5 wrote becomes `false` without an
-- UPDATE, which is both cheaper and the truthful value.
alter table public.chat_messages
  add column if not exists recalled boolean not null default false;

alter table public.chat_messages
  add column if not exists recalled_at timestamptz;

alter table public.chat_messages
  add column if not exists recall_reason text;

-- 「已撤回的必须带撤回时间」. Cheap, and it makes the half-state unreachable: a row drawn as
-- 「该消息已被撤回」 with no record of when its author withdrew it is a row nobody can audit, and the
-- two columns are written by the same statement in `chat-recall` — a constraint here is what keeps
-- that true for the writer nobody has written yet.
alter table public.chat_messages
  drop constraint if exists chat_messages_recall_consistent;
alter table public.chat_messages
  add constraint chat_messages_recall_consistent
  check (recalled = false or recalled_at is not null);

comment on column public.chat_messages.recalled is
  '§1.11 — 「该消息已被撤回」. Written only by the chat-recall Edge Function, within RECALL_WINDOW_MS '
  'of created_at. The row is KEPT (§1.11.3 「会留下撤回记录」): a withdrawal marks the place, it does '
  'not make the conversation close up around it.';
comment on column public.chat_messages.recalled_at is
  '§1.11 — when the author withdrew it. Not rendered by the room; an audit fact, kept on the row '
  'because the row is the record.';
comment on column public.chat_messages.recall_reason is
  '§1.11.1 「可选 recall_reason」. Always NULL today: the only caller is the author withdrawing their '
  'own message, and a form in the way of an undo is not a feature. Accepted (and capped) by '
  'chat-recall so that a future 管理员 action can say why.';

-- ---------------------------------------------------------------------------
-- 2. the index §1.11.4 needs
-- ---------------------------------------------------------------------------
-- `chat-recall` refreshes the `reply_preview` snapshot of every message that QUOTES the withdrawn
-- one (§1.11.4: 「被引用时引用卡片显示 [该消息已被撤回]」). Without this the patch is a sequential
-- scan of the room's whole table — the one table here that grows without bound.
--
-- ⚠ Partial, because a quote is the minority of rows. `db push` runs migrations inside a
-- transaction, so `create index concurrently` is not available and would fail outright.
create index if not exists idx_chat_messages_reply_to
  on public.chat_messages (reply_to) where reply_to is not null;

-- ---------------------------------------------------------------------------
-- 3. the replica identity 013 could not set, because its own premise forbade it
-- ---------------------------------------------------------------------------
-- See the header. `replica identity full` is what lets Realtime deliver the UPDATE at all on an
-- RLS-protected table, and `chat_messages` is the last of the seven to get it.
alter table public.chat_messages replica identity full;

-- ---------------------------------------------------------------------------
-- 4. the comment 013 left behind
-- ---------------------------------------------------------------------------
-- 013 wrote 「a message is never edited」 into the table comment, and §1.11 makes that sentence false.
-- A migration cannot re-run an old file, but it can correct the sentence a reader will grep for —
-- the same correction 011 and 013 each made to their predecessor.
comment on table public.chat_messages is
  '公共聊天室 messages (§2.3.2). Written only by the chat-send / chat-recall Edge Functions; read by '
  'every member (§1.8.1: 未激活只读, so is_member() rather than is_activated()). 1.0.4: published to '
  'supabase_realtime (INSERT). 1.0.6 §1.11: also UPDATE — a message CAN now be edited, by its own '
  'author withdrawing it inside RECALL_WINDOW_MS — and it therefore also carries replica identity '
  'full. See 021_chat_recall.sql.';
