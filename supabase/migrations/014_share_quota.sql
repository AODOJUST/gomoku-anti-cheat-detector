-- 014_share_quota.sql — 1.0.4 §P2: §1.2.5's counter becomes atomic.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------------------------
-- `friend-share` read `daily_quotas`, compared, and then wrote `used + 1` back — and the header of
-- that Function says so in as many words (「a read-then-write … Two sends in the same instant can
-- both read 19 and both write 20, so the 21st gets through」). 1.0.3 shipped it that way on purpose:
-- the quota is a courtesy against a stuck retry loop, not a billing system.
--
-- 1.0.4 §P2 keeps the courtesy reading and removes the *lost update*. Those are not in conflict:
-- the ceiling only has to be honest, and a lost update is a bookkeeping bug that also makes the
-- client's own 「今日还可发送 7 个」 wrong — the number a user sees should not depend on whether two
-- presses raced.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE FIX IS A FUNCTION AND NOT A LONGER COMMENT
-- ---------------------------------------------------------------------------------------------
-- The increment has to be ONE statement, because the check and the write must happen under the same
-- row lock. Written in SQL it is a single `insert … on conflict do update … where <under the cap>`,
-- which takes the row lock for the pair (user_id, date) and therefore serialises two concurrent
-- senders: the second one re-evaluates the predicate against the FIRST one's committed value.
-- Written in TypeScript over PostgREST it cannot be, at any level of care — PostgREST sends one
-- statement per request, and there is no way to make 「read the row」 and 「write it back」 share a
-- transaction from a Function that has to talk HTTP to reach the database.
--
-- ⚠ THE FUNCTION IS `security definer` AND THE GRANT IS `service_role` ONLY. It writes a table the
-- caller may read but not write (`daily_quotas` has SELECT policies and no UPDATE policy — see
-- 011_rls_community.sql §6), and it takes the user id as a PARAMETER. A caller who could execute it
-- as themselves could spend somebody else's allowance; the only legitimate caller is `friend-share`,
-- which passes the id off its own verified token. `revoke … from public` below is what makes
-- 「definer」 safe rather than a privilege escalation, and it is the line a future reader is most
-- likely to delete by accident.
--
-- ⚠ THE RELEASE IS NOT SYMMETRIC, AND THAT IS FINE. `claim` reserves before the share row exists so
-- the ceiling holds; `release` gives the reservation back when the write fails afterwards. If two
-- requests interleave claim/release, the counter can end up one LOW — i.e. one extra share gets
-- through, which is the pre-existing failure mode, not a new one. It can never end up HIGH, which
-- is the direction that locks a user out of their own allowance.
--
-- Idempotent: `create or replace function`, and the revoke/grant pair is absolute.

-- ---------------------------------------------------------------------------
-- 1. claim — reserve one unit, or answer NULL when the day's allowance is spent
-- ---------------------------------------------------------------------------
-- Returns the NEW count (1 for the first share of the day), or NULL when the ceiling refused it.
-- NULL rather than 0 or -1 because 「没有拿到」 and 「拿到了第 0 个」 must not be confusable at the
-- call site, and `friend-share` tests `=== null`.
create or replace function public.claim_share_quota(
  p_user   uuid,
  p_column text,
  p_max    integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- The column name is interpolated into a CASE expression rather than into SQL text, so this check
  -- is about refusing a typo early with a readable message — not about injection. It is also the
  -- closed set §1.2.5 defines: two counters, 回放/样本 as one class and 配置 as the other.
  if p_column is null or p_column not in ('shares_archive', 'shares_config') then
    raise exception 'claim_share_quota: unknown quota column "%"', p_column
      using errcode = '22023';
  end if;
  if p_max is null or p_max < 1 then
    raise exception 'claim_share_quota: p_max must be a positive integer'
      using errcode = '22023';
  end if;

  -- ONE statement. `(now() at time zone 'utc')::date` spells the same key the column DEFAULT in
  -- 006_friends.sql spells and the same one `serverDate()` computes in _shared/community.ts — the
  -- three must agree or the cap would be checked against one day and stored on another.
  --
  -- The WHERE on the DO UPDATE is the whole point: when the stored count has already reached
  -- `p_max` the update is skipped, no row is returned, and `v_count` keeps its NULL.
  insert into public.daily_quotas as q (user_id, date, shares_archive, shares_config)
  values (
    p_user,
    (now() at time zone 'utc')::date,
    case when p_column = 'shares_archive' then 1 else 0 end,
    case when p_column = 'shares_config'  then 1 else 0 end
  )
  on conflict (user_id, date) do update
     set shares_archive = q.shares_archive
                          + case when p_column = 'shares_archive' then 1 else 0 end,
         shares_config  = q.shares_config
                          + case when p_column = 'shares_config'  then 1 else 0 end
   where (case when p_column = 'shares_archive' then q.shares_archive else q.shares_config end)
         < p_max
  returning case when p_column = 'shares_archive' then q.shares_archive else q.shares_config end
       into v_count;

  return v_count;
end;
$$;

comment on function public.claim_share_quota(uuid, text, integer) is
  '1.0.4 §P2 — §1.2.5''s daily counter, claimed in ONE statement so two concurrent sends cannot '
  'both read 19. Returns the new count, or NULL when the ceiling refused it. service_role only: it '
  'takes the user id as a parameter, so an authenticated caller would be able to spend somebody '
  'else''s allowance.';

-- ---------------------------------------------------------------------------
-- 2. release — give a reservation back when the write after it failed
-- ---------------------------------------------------------------------------
-- `greatest(…, 0)` rather than a bare subtraction: a release that arrives twice (a retry, a double
-- catch) must not turn the counter negative, because a negative count is an allowance LARGER than
-- the day's and it would never be corrected — every later claim adds to it.
create or replace function public.release_share_quota(
  p_user   uuid,
  p_column text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_column is null or p_column not in ('shares_archive', 'shares_config') then
    raise exception 'release_share_quota: unknown quota column "%"', p_column
      using errcode = '22023';
  end if;

  update public.daily_quotas q
     set shares_archive = greatest(q.shares_archive
                           - case when p_column = 'shares_archive' then 1 else 0 end, 0),
         shares_config  = greatest(q.shares_config
                           - case when p_column = 'shares_config'  then 1 else 0 end, 0)
   where q.user_id = p_user
     and q.date = (now() at time zone 'utc')::date
  returning case when p_column = 'shares_archive' then q.shares_archive else q.shares_config end
       into v_count;

  return v_count;
end;
$$;

comment on function public.release_share_quota(uuid, text) is
  '1.0.4 §P2 — the undo half of claim_share_quota, called when friend-share fails AFTER reserving. '
  'Floored at 0 so a repeated release cannot mint allowance. service_role only.';

-- ---------------------------------------------------------------------------
-- 3. the grants — this is the line that makes `security definer` safe
-- ---------------------------------------------------------------------------
-- A new function is EXECUTE-able by PUBLIC by default, which would let any authenticated caller
-- spend another account's daily quota by passing their uuid. Revoking from PUBLIC (which is what
-- `authenticated` and `anon` inherit) and granting only `service_role` leaves exactly one caller:
-- `friend-share`, running with the service key.
revoke all on function public.claim_share_quota(uuid, text, integer) from public;
revoke all on function public.claim_share_quota(uuid, text, integer) from anon, authenticated;
grant execute on function public.claim_share_quota(uuid, text, integer) to service_role;

revoke all on function public.release_share_quota(uuid, text) from public;
revoke all on function public.release_share_quota(uuid, text) from anon, authenticated;
grant execute on function public.release_share_quota(uuid, text) to service_role;
