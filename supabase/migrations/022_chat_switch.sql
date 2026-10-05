-- 022_chat_switch.sql — 1.0.6 三号 §二.2：「允许发言」与「全体禁言」合并为单一开关。
--
-- WHAT IT DOES
-- ---------------------------------------------------------------------------------------------
--   delete from public.global_settings where key = 'global_mute';
--
-- and nothing else. One row, one line, no schema change — which is exactly why it needs this
-- header: the row it deletes is the whole feature.
--
-- ---------------------------------------------------------------------------------------------
-- WHY TWO ROWS WERE TWO ANSWERS TO ONE QUESTION
-- ---------------------------------------------------------------------------------------------
-- 009_reports.sql seeded BOTH §2.3.2 names as two independent booleans (`chat_enabled` = true,
-- `global_mute` = false), on the reading that 「关闭聊天室」 and 「全体禁言」 are two different
-- operator intentions. They are not. Both mean 「所有人不能发消息」, `chat-send` refused on either
-- one, and the console drew them as two checkboxes that can be ticked together — a state whose
-- answer to 「那聊天室到底能不能发」 existed nowhere but in the reader's head. Whichever of the two
-- an operator pressed, the effect was identical, so the second control was a second way to say the
-- same thing and a first way to get it wrong.
--
-- ⇒ ONE flag, ONE meaning, stated once here so the client and the Function cannot drift:
--
--     chat_enabled = true   → 所有已激活用户可以发言
--     chat_enabled = false  → 全体禁言，仅可查看历史消息（输入框禁用 + 顶部横幅）
--
-- The single READER is `chat-send` (`select("key, value").eq("key", "chat_enabled")`), and the
-- single WRITER is the `admin-global-chat` Edge Function (service role) — `admin-global-mute` was
-- deleted from the project in the same release, so no endpoint can move `global_mute` any more.
--
-- ⚠ DELETED, NOT DEPRECATED. Leaving the row behind with no reader would have produced the worst of
-- both worlds: a value that looks like a live switch to anyone reading the table, that the console
-- no longer shows, that no code consults, and that a future contributor would "restore" by adding
-- a reader for it.
--
-- ⚠ 009's seed no longer inserts it either (edited in the same release), so a fresh install and an
-- upgraded one converge on the same single row. This DELETE is what makes the ALREADY-APPLIED
-- database converge — 009 cannot be re-run, which is the general reason a data change gets its own
-- numbered migration rather than a edit to the file that created the row.
--
-- ⚠ WHAT DOES *NOT* CHANGE, AND THE ONE THING WORTH RE-READING BEFORE TOUCHING THIS TABLE:
--
--   · RLS stays exactly as 011/012 wrote it — on, with `global_settings_read_all` (select, to
--     authenticated, using (true)). The client needs that read path: §二.2 asks the ROOM to draw
--     「聊天室已关闭，仅可查看历史消息」 and to disable the input box, and a banner whose flag the
--     reader cannot fetch would be a feature that only works for admins. The EFFECTIVE gate remains
--     the server (`chat-send`); the client copy is a courtesy, and it is allowed to be wrong for a
--     few seconds after an admin flips the switch.
--   · §2.3.2's 「「关闭聊天室」不影响历史回放与样本互动」 is untouched — `friend-share` /
--     `vote-cast` / `report-submit` still never consult this table. Read 009's §4 before "making
--     the mute global"; it says in as many words that it must not be.
--
-- Idempotent: deleting a row that is already absent is a no-op, and the INSERT below only fires on
-- a deployment that somehow never got 009's seed.

delete from public.global_settings where key = 'global_mute';

-- Belt as well as braces: 009 seeds `chat_enabled`, and 009 is already applied everywhere this
-- migration will run. This makes the file self-contained for a database restored from a partial
-- dump, where `global_settings` exists but is empty — in which case every reader's default (true)
-- is right until an admin says otherwise, and no client read would return a row at all.
insert into public.global_settings (key, value) values ('chat_enabled', 'true'::jsonb)
on conflict (key) do nothing;

comment on table public.global_settings is
  '1.0.6 三号 §二.2 — product-wide switches. ONE key: `chat_enabled`, written only by the '
  'admin-global-chat Edge Function (service role) and read by chat-send, which enforces §2.3.2''s '
  '「所有人不能发消息」 by failing CHAT_DISABLED. `global_mute` was removed by 022: it was a second '
  'row saying the same thing, and two switches that can contradict each other have no answer to '
  '「那到底能不能发」. The SELECT policy in 011/012 exists so the room can draw its 「聊天室已关闭」 '
  'banner without a new endpoint; the EFFECTIVE gate is the server, not the client.';
