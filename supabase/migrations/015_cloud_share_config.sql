-- 015_cloud_share_config.sql — a ROOM share may be a 配置包 too (§1.2.3's third kind).
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS FILE EXISTS
-- ---------------------------------------------------------------------------------------------
-- §1.2.3 gives the 发送选择器 three kinds verbatim: 「'archive' | 'sample' | 'config'」, and
-- `SHARE_KINDS` in `_shared/community.ts` is that list in one place. `friend_shares` accepts all
-- three (006_friends.sql). `cloud_shares` accepted only two: 008's constraint was
-- `check (kind in ('archive', 'sample'))`, with the comment 「§1.1.2's two pickers: 发送回放 /
-- 发送样本」.
--
-- ⚠ THAT WAS TRUE OF §1.1.2's PROSE AND FALSE OF THE SHIPPED PICKER. `cmPaintShare()` builds its
-- 类型 row from `SHARE_KINDS`, so 回复/样本/配置 have always been three buttons in BOTH
-- destinations, and 配置 + 聊天室 reached `chat-send` — whose `ATTACHMENT_KINDS` was the same
-- two-element list — and came back 400 `attachment.kind must be one of: archive, sample`. The
-- operator saw 「未知错误（BAD_REQUEST）」 for pressing a button the UI offered. 1.0.4 §P1 closes
-- it at the source: the vocabulary is `SHARE_KINDS`, in one place, for both tables and both
-- functions.
--
-- ⚠ A 配置包 IN THE ROOM IS NOT A POLL TARGET, AND THAT IS STILL TRUE. `vote_tally` /
-- `vote_ballots` are about a replay or a sample; `vote-create` keeps its deliberately NARROWER
-- `TARGET_KINDS = ['archive','sample']`, which is now a statement about POLLS rather than a copy of
-- this constraint. The client already disables the 投票 checkbox for 配置 (`cmPaintShare`).
--
-- Dropping and re-adding the constraint in one statement keeps it idempotent and keeps the name
-- (`cloud_shares_kind_known`), which `verify-0xx` and the 008 comments refer to.

alter table public.cloud_shares
  drop constraint if exists cloud_shares_kind_known;

alter table public.cloud_shares
  add constraint cloud_shares_kind_known check (kind in ('archive', 'sample', 'config'));

comment on column public.cloud_shares.kind is
  '§1.2.3''s three kinds, verbatim: archive | sample | config. See SHARE_KINDS in '
  '_shared/community.ts — the room picker, friend_shares and this table share that one list.';

comment on table public.cloud_shares is
  '§1.1.2 / §1.1.3 — the cloud copy a room 分享消息 points at. Public to the community by design '
  '(011 §4''s read policy), 7-day lifetime like the message that carries it (008). Reads go '
  'through the `cloud-share` Edge Function, which signs when the body lives in Storage; the row '
  'itself is also readable over PostgREST for the card and the poll, and `payload` therefore must '
  'never hold anything the whole community may not see — it is a replay, a sample or a 配置包, '
  'each of which is what the sender chose to publish.';
