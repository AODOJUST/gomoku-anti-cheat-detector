-- 019_email_code_attempts.sql — 1.0.5 安全审计 P1/P2: 邮件验证码的尝试次数上限.
--
-- THE AUDIT'S FINDING, VERBATIM: 「6 位数字 = 1,000,000 种可能。`wireSendCode()` 里只有 60 秒**发送**
-- 冷却……**没有验证尝试次数的客户端限制**。服务端的 `auth-register` / `auth-reset-password` 是否对错误
-- 验证码做了尝试次数限制，代码里没有证据。如果服务端不做，攻击者可以在 10 分钟有效期内以任意速率
-- 暴力尝试 6 位数字。」
--
-- 它的建议是「服务端做速率限制 + 失败计数」，这一份就是那个计数。三处验证入口
-- （`auth-register` / `auth-reset-password` / `auth-change-email`）都只走 `_shared/email.ts` 的
-- `claimEmailCode()` 一个漏斗，所以上限只有一份实现（「同一答案只准有一份」）。
--
-- ⚠ WHY THE COUNTER LIVES IN THE DATABASE, NOT IN THE FUNCTION. Edge Functions are one-shot
-- processes: an in-memory counter is back at zero on the first cold start, which for a brute-force
-- door is the same as no counter. This is 004's own reason for putting `token_epoch` on `users`
-- rather than in a denylist held by a function.

-- ---------------------------------------------------------------------------
-- 1. the column
-- ---------------------------------------------------------------------------
-- `if not exists`, like every migration here: `supabase db push` re-runs the whole set safely.
alter table public.email_codes add column if not exists attempts integer not null default 0;

comment on column public.email_codes.attempts is
  '1.0.5 审计 P1 — 这一行的失败验证次数。达到 EMAIL_CODE_MAX_ATTEMPTS 后 takeEmailCode() 不再匹配它，'
  '即「这个码已经废了，重新发一个」，有效期仍是 §2.4 的 10 分钟。';

-- The lookup index 004 built covers (email, used, expires_at); the counter adds no new predicate to
-- that query, so no second index is needed. (`attempts` is read off the row the index already
-- narrowed to one.)

-- ---------------------------------------------------------------------------
-- 2. the atomic increment
-- ---------------------------------------------------------------------------
-- ⚠ READ-MODIFY-WRITE WOULD UNDERCOUNT. Two wrong codes arriving together would both read
-- `attempts = 4`, both write 5, and one free guess would be handed out. `set attempts = attempts + 1`
-- is the database doing the addition, so simultaneity cannot lose a count — the same reason
-- `daily_quotas` is incremented by a function rather than by the client.
--
-- ⚠ AND IT DELIBERATELY DOES **NOT** SET `used = true`. Burning the row would make the NEXT call
-- find no live row at all, so its verdict would silently fall back to 「验证码错误」 — the count
-- would reach its limit and then stop being reported. Leaving the row alive (and merely
-- un-matchable, because `takeEmailCode` now requires `attempts < the limit`) keeps the verdict
-- monotone: 5 wrong guesses answer 「尝试次数过多」 forever after.
--
-- ⚠ NO `security definer`. `is_admin()` / `is_activated()` need it because an RLS POLICY calls them
-- on a client's behalf; this function is called only by Edge Functions holding the service role,
-- which already bypasses RLS. Writing `definer` here would be strictly worse: it would run as the
-- table owner for a caller that never needed the elevation.
create or replace function public.bump_email_code_attempt(p_email text)
returns integer
language sql
set search_path = public
as $$
  update public.email_codes
     set attempts = attempts + 1
   where id = (
     select id
       from public.email_codes
      where email = p_email
        and used = false
        and expires_at > now()
      order by created_at desc
      limit 1
   )
  returning attempts;
$$;

comment on function public.bump_email_code_attempt(text) is
  '1.0.5 审计 P1 — 原子地给「这个邮箱最新的有效验证码」记一次失败。0 行被更新时返回 NULL，'
  '表示根本没有可计数的码（过期了、从未发过、或已经用掉），调用方据此不能说「尝试次数过多」。';

-- ⚠ ONE DOOR, AND IT IS NOT THE CLIENT'S. 004 left `email_codes` with RLS on and zero policies, so
-- PostgREST already refuses every anon/authenticated request — including a call to this function
-- through /rpc. `revoke … from public` is what keeps that true if anyone ever adds a policy.
revoke all on function public.bump_email_code_attempt(text) from public;
grant execute on function public.bump_email_code_attempt(text) to service_role;
