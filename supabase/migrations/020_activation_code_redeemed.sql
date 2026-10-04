-- 020_activation_code_redeemed.sql — 1.0.5 审计 P2 的前置条件：让注销账户真的能被删除.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS WRONG (this is the audit's P2, one layer down)
-- ---------------------------------------------------------------------------------------------
-- 审计 P2 说「注销账户后的云端数据清理没有闭环」，并指出 `auth-delete-account` 只写 `deleted_at`、把物理删除
-- 留给一个「应该有人会去部署」的 cron。补 cron 的时候发现**光有 cron 还是删不掉**：
--
--   `delete from public.users where id = X` 会被外键挡住。001 给三列建了**没有 ON DELETE 子句**的外键
--   （即 RESTRICT）：
--
--     activation_codes.issued_by    ← 管理员发码时写入
--     activation_codes.redeemed_by  ← 用户激活时写入
--     badges.granted_by             ← 管理员发徽章时写入
--
--   而 **`auth-register` / `auth-activate` 都会写 `redeemed_by`** —— 也就是说**每一个激活过的账户**都至少
--   有一个 RESTRICT 引用指向自己。于是清理任务会以 `23503 foreign_key_violation` 失败，而它的失败看起来
--   和「这个月没人注销」一模一样：表里始终有行，日志里只有一句 delete 失败。这正是 1.0.5 反复学到的那个形状
--   ——**缺陷不在某一行代码里，而在两个各自都正确的地方之间**。
--
-- ---------------------------------------------------------------------------------------------
-- WHY `set null` ALONE IS NOT ENOUGH: `redeemed_by` HAS TWO MEANINGS
-- ---------------------------------------------------------------------------------------------
-- `issued_by` / `granted_by` 只有一种意思（「谁发的」），`on delete set null` 就够了：码和徽章是**业务记录**，
-- 比人呢命长，发码人注销了不该把库存删掉，也不该把别人已经拿到的徽章回收。
--
-- ⚠ `redeemed_by` 却是**两个意思叠在一列上**：
--   (a) 「谁用的」——一个历史事实；
--   (b) 「这个码用掉了没有」——`auth-validate-code` / `auth-register` / `auth-activate` 三个读者都在判
--       `redeemed_by is not null`，`admin-revoke-codes` 也在用它挑「还没被用的码」。
-- 所以如果只是把外键改成 `set null`：账户一注销，它的那个码就**看起来从没被用过**，可以再被别人的新账号
-- 激活一次。**一个字段两个意思是这个项目已经吃过五次的形状**，这里又出现了一次，所以修法是先把两个意思拆开：
-- 新增 `redeemed` 布尔列承担 (b)，`redeemed_by` 退回只承担 (a)。
--
-- ⚠ 三个读者的改法与这一份迁移必须同时上线：`redeemed` 列在迁移跑完之前不存在，而旧函数读 `redeemed_by`
-- 判「用过」在迁移之后仍然正确（回填保证两者一致）。所以顺序是**先 db push 再部署函数**，与 runbook 一致。

-- ---------------------------------------------------------------------------
-- 1. the new home for 「用掉了没有」
-- ---------------------------------------------------------------------------
alter table public.activation_codes add column if not exists redeemed boolean not null default false;

comment on column public.activation_codes.redeemed is
  '1.0.5 审计 P2 — 这个码是否已被使用。与 `redeemed_by`（谁用的）分开：`redeemed_by` 是 on delete set null '
  '的历史引用，注销账户会被置空，而「用掉了」必须活得更久，否则注销者用过的码会被回收。';

-- The backfill is the whole consistency proof: every existing row had `redeemed_by is not null` as its
-- only signal, so this is a rename of the predicate rather than a guess. It is idempotent (a re-run
-- finds the same rows), which `db push` needs.
update public.activation_codes set redeemed = true where redeemed_by is not null and redeemed = false;

-- ---------------------------------------------------------------------------
-- 2. the three foreign keys may now let the row outlive the person
-- ---------------------------------------------------------------------------
-- ⚠ DROP + ADD RATHER THAN `alter column`: Postgres has no `alter constraint ... on delete`; the
-- constraint has to be replaced. The default names are `<table>_<column>_fkey` (001 declared these
-- as column constraints), so `drop constraint` matches what the database actually built.
alter table public.activation_codes drop constraint if exists activation_codes_issued_by_fkey;
alter table public.activation_codes add constraint activation_codes_issued_by_fkey
  foreign key (issued_by) references public.users(id) on delete set null;

alter table public.activation_codes drop constraint if exists activation_codes_redeemed_by_fkey;
alter table public.activation_codes add constraint activation_codes_redeemed_by_fkey
  foreign key (redeemed_by) references public.users(id) on delete set null;

alter table public.badges drop constraint if exists badges_granted_by_fkey;
alter table public.badges add constraint badges_granted_by_fkey
  foreign key (granted_by) references public.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 3. the redundant partial index, deliberately NOT touched
-- ---------------------------------------------------------------------------
-- 001 quoted §「a redeemed code must map to at most one user」 as a partial unique index on
-- `(code) where redeemed_by is not null`. `code` is the PRIMARY KEY, so the uniqueness it enforces was
-- always implied, and after this migration its predicate reads as 「有主」 rather than 「已用」 — which is
-- now exactly what `redeemed_by` means. It stays correct and stays redundant, so it is LEFT ALONE:
-- re-creating a unique index takes a real lock on a real table, and this migration has no reason to
-- touch it. From 1.0.5 on, what makes a code single-use is `redeemed` — and `verify-067 §10` is what
-- holds that claim.
