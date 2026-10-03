# 白身后端部署指南（Supabase）

本目录是「白身 / Baishen」五子棋反作弊检测器的云端部分：PostgreSQL 库表 + RLS 策略 + Deno Edge Functions。
客户端（Chrome 扩展）只通过 Edge Functions 与库表通信，**永远不接触 activation_codes 表**。

```
supabase/
├─ config.example.toml        # CLI 配置示例，需复制为 config.toml
├─ migrations/
│  ├─ 001_init.sql            # 表 / 索引 / updated_at 触发器
│  └─ 002_rls.sql             # 默认拒绝的 RLS 策略 + is_admin()
└─ functions/
   ├─ _shared/                # cors / errors / client / codes 共享模块
   ├─ auth-*                  # 激活、续期、注销
   ├─ profile-*               # 资料读写
   └─ admin-*                 # 管理端（逐个都重新校验 is_admin）
```

---

## 0. 前置条件

```bash
npm install -g supabase          # 或 brew install supabase/tap/supabase
supabase --version               # 需要 >= 1.120
supabase login                   # 浏览器里登录你的 Supabase 账号
```

以下所有 CLI 命令都在 **本目录的上一级**（即 `detector/extension/`，也就是包含 `supabase/` 的那个目录）执行：

```bash
cd detector/extension
```

---

## 1. 创建项目（建议新加坡区域）

1. 打开 https://supabase.com/dashboard ，点 **New project**。
2. 名称建议 `baishen-detector`；数据库密码单独生成并妥善保存（CLI 迁移会用到）。
3. **Region 选 `Southeast Asia (Singapore)`** —— 目标用户在中文区，比默认的 `us-east-1` 延迟低得多，且数据留在亚太。
4. 创建后等待 1～2 分钟，直到 Status 变成 `Active`。

## 2. 找到三个关键值

进入 **Project Settings → API**：

| 需要的值 | 在 Dashboard 的位置 | 用途 |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL，形如 `https://abcdefghijkl.supabase.co` | 扩展与函数的基地址 |
| `SUPABASE_ANON_KEY` | Project API keys → `anon` `public` | **只给扩展**；公钥，可外发 |
| `SUPABASE_SERVICE_ROLE_KEY` | Project API keys → `service_role` `secret` | **只给 Edge Functions**，绝不下发到客户端 |
| `SUPABASE_JWT_SECRET` | Project Settings → API → **JWT Settings** → JWT Secret | 函数自签 JWT 用 |

> ⚠️ `service_role` key 与 `JWT Secret` 都属于最高权限凭据。它们只通过 `supabase secrets set` 写入服务端，**永远不要**写进扩展代码、提交到仓库或出现在任何响应里。

## 3. 关联项目

```bash
supabase link --project-ref <你的-project-ref>
```

`project-ref` 就是 Project URL 里的那串随机字母（`https://<project-ref>.supabase.co`）。按提示输入第 1 步设置的数据库密码。

## 4. 复制 CLI 配置

```bash
cp supabase/config.example.toml supabase/config.toml
```

打开 `config.toml`，把 `project_id` 改成你的实际项目名。里面每个函数的 `verify_jwt = false` **不要改**（原因见第 5 步）。

## 5. 推送数据库迁移

```bash
supabase db push
```

会依次执行 `migrations/001_init.sql` 和 `migrations/002_rls.sql`。两份脚本都写成幂等的（`if not exists` / `create or replace` / `drop ... if exists`），重复执行安全。执行完可在 **Table Editor** 里看到 `users / activation_codes / devices / samples / archives / badges` 六张表，且每张表的 row count 旁都标着 `RLS enabled`。

## 6. 部署 Edge Functions

逐个部署，并**统一加 `--no-verify-jwt`**：

```bash
for fn in \
  auth-activate auth-renew auth-delete-account \
  profile-get profile-update \
  admin-generate-code admin-list-users admin-ban-user \
  admin-unban-user admin-revoke-codes admin-grant-badge admin-reissue-jwt
do
  supabase functions deploy "$fn" --no-verify-jwt
done
```

**为什么必须 `--no-verify-jwt`**：这个开关只是关掉平台网关那一层 JWT 校验，并**不代表**函数不校验身份。每个函数内部都会自己做验证：

- `requireUser()` 会用 bearer token 调 `sb.auth.getUser()`；
- `requireAdmin()` 在此基础上再读一次数据库里的 `users.is_admin`，非管理员一律 403；
- `auth-renew` 需要接受「刚刚过期」的 token（客户端每 7 天续期一次，离线久了 token 可能已过 `exp`），而平台网关会在我们的代码运行之前就把过期 token 拒掉，所以这一层必须由函数自己掌握。

## 7. 设置函数环境变量（secrets）

```bash
supabase secrets set \
  SUPABASE_JWT_SECRET="<第2步的 JWT Secret>" \
  PUBLIC_AVATAR_PREFIX="https://<project-ref>.supabase.co/storage/v1/object/public/avatars/"
```

说明：

- `SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 平台**自动注入**到每个 Edge Function，通常无需手动设置。自托管或将函数跑在本机时需要显式设置，命令同样是：
  ```bash
  supabase secrets set SUPABASE_URL="https://<project-ref>.supabase.co" \
    SUPABASE_SERVICE_ROLE_KEY="<service_role key>"
  ```
- `SUPABASE_JWT_SECRET` **必须显式设置**，`signJwt()` 用它做 HS256 签名。
- `PUBLIC_AVATAR_PREFIX` 可选：不设时回退到 `https://<SUPABASE_URL>/storage/v1/object/public/avatars/`。若头像存在别的桶，按实际前缀改。`profile-update` 会把不以此前缀开头的 `avatarUrl` 判为 `BAD_REQUEST`。

改完 secrets 需要**重新部署函数**才会生效：

```bash
supabase functions deploy auth-activate --no-verify-jwt
```

（逐一重跑第 6 步的循环即可。）

## 8. 标记第一位管理员（只能手动做一次）

管理员**没有注册接口**，也无法通过任何 Edge Function 提权——这是刻意设计，避免出现「自己把自己设成 admin」的洞。步骤：

1. 用一条激活码跑一次 `auth-activate`（见第 10 步的调用示例），这样 `public.users` 里才会出现你这一行（代码是 find-or-create）。
2. 打开 Dashboard → **SQL Editor**，执行下面这段，把邮箱换成你的：

```sql
update public.users
set is_admin = true
where email = 'you@example.com';
```

3. 用 `select id, email, is_admin from public.users where is_admin;` 确认。

> 这一步必须在 Dashboard 手工执行，且**永远不会**被包装成 HTTP 接口。`admin-*` 系列函数只负责「校验调用者是不是 admin」，不负责「把谁变成 admin」。

## 9. 开启 30 天清理（软删除账号的真正删除）

`auth-delete-account` 只是软删除（写 `deleted_at`、删设备行）；真正的物理删除交给定时任务。

**方式 A：SQL Editor**（推荐）

先在 Dashboard → **Database → Extensions** 里启用 `pg_cron`，然后执行：

```sql
create extension if not exists pg_cron;

select cron.schedule(
  'purge-deleted-users',
  '0 3 * * *',                                   -- 每天 03:00
  $$ delete from public.users
     where deleted_at is not null
       and deleted_at < now() - interval '30 days' $$
);
```

`devices / samples / archives / badges` 的外键都是 `on delete cascade`，所以删掉 `users` 那一行会原子地清掉所有附属数据。

查看 / 撤销任务：

```sql
select jobid, jobname, schedule, active from cron.job;

select cron.unschedule('purge-deleted-users');
```

**方式 B：Dashboard → Integrations → Cron**，新建 job 填同样的 SQL 与 `0 3 * * *`，效果一致。

---

## 10. 客户端（扩展 / cloud.js）需要粘贴的值

扩展只需要下面两个**公开**值，填进 `cloud.js` 的云配置里：

```js
// cloud.js
const CLOUD_URL      = 'https://<project-ref>.supabase.co';   // = SUPABASE_URL
const CLOUD_ANON_KEY = '<anon public key>';                    // = SUPABASE_ANON_KEY
```

函数调用地址统一是 `${CLOUD_URL}/functions/v1/<函数名>`，请求头固定：

```
apikey: <CLOUD_ANON_KEY>
Authorization: Bearer <登录后拿到的 jwt>
Content-Type: application/json
```

举例（激活一台设备）：

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/auth-activate" \
  -H "apikey: <anon key>" \
  -H "Content-Type: application/json" \
  -d '{"code":"BS-ABCD-EFGH-JKLM-NPQR","deviceId":"dev-abc-123","userAgent":"Chrome/140"}'
# => {"jwt":"...","expiresAt":"...","user":{...}}
```

再拿这个 `jwt` 调需要登录的接口：

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/profile-get" \
  -H "apikey: <anon key>" \
  -H "Authorization: Bearer <上一步的 jwt>"
```

> 扩展里**绝对不要**出现 `SUPABASE_SERVICE_ROLE_KEY` 或 JWT Secret。

---

## 11. 最终检查清单

- [ ] 项目区域为 Singapore，状态 Active。
- [ ] `supabase link` 成功，`config.toml` 已从示例复制并改好 `project_id`。
- [ ] `supabase db push` 成功；六张表存在且都显示 **RLS enabled**。
- [ ] `activation_codes` 表 **没有任何** policy（Dashboard → Authentication → Policies 里应为空）。
- [ ] 12 个函数全部部署成功：`supabase functions list`。
- [ ] 每个函数都带 `verify_jwt = false`，且代码内部有 `requireUser` / `requireAdmin`。
- [ ] secrets 已设置：`SUPABASE_JWT_SECRET`（必需）、`PUBLIC_AVATAR_PREFIX`（可选）；改完已重新部署。
- [ ] 已用激活码跑通一次 `auth-activate`，拿到 `jwt` 与 `expiresAt`。
- [ ] 已在 SQL Editor 手动把自己标记为 `is_admin = true`。
- [ ] 用管理员账号调一次 `admin-list-users` 返回 200；用普通账号调返回 403 `FORBIDDEN`。
- [ ] `pg_cron` 已启用且 `purge-deleted-users` 任务 active。
- [ ] 扩展 `cloud.js` 里只填了 `SUPABASE_URL` + anon key，没有任何 secret。
- [ ] 冒烟测试错误码：假码 → `INVALID_CODE`；撤销码 → `CODE_REVOKED`；已用码 → `CODE_ALREADY_USED`；第 4 台设备 → `DEVICE_LIMIT`；封禁账号 → `BANNED`。

---

## 附：本地开发（可选）

```bash
supabase start                 # 起本地 Postgres / Studio / Functions
supabase db reset              # 重放全部迁移到干净的本地库
supabase functions serve auth-activate --no-verify-jwt --env-file ./supabase/.env.local
supabase stop
```

本地调试时用 `supabase/.env.local` 放 secrets（该文件不要提交）。
