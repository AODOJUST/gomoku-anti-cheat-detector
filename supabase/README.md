# 白身后端部署指南（Supabase）

本目录是「白身 / Baishen」五子棋反作弊检测器的云端部分：PostgreSQL 库表 + RLS 策略 + Deno Edge Functions。
客户端（Chrome 扩展）只通过 Edge Functions 与库表通信，**永远不接触 activation_codes 表**。

```
supabase/
├─ config.example.toml        # CLI 配置示例，需复制为 config.toml
├─ migrations/
│  ├─ 001_init.sql            # 表 / 索引 / updated_at 触发器
│  ├─ 002_rls.sql             # 默认拒绝的 RLS 策略 + is_admin()
│  ├─ 003_user_kv.sql         # 云同步的四类键值（黑名单 / 设置 / 自定义题库 / 学习参数）
│  └─ 004_email_codes.sql     # §2.4 邮箱验证码表 + §3.7 token_epoch + §2.3 用户名唯一索引
└─ functions/
   ├─ _shared/                # cors / errors / client / codes / email 共享模块
   ├─ auth-*                  # 激活三步（validate-code / register / activate）、登录、续期、
   │                          # 改密码 / 改邮箱 / 忘记密码 / 发验证码 / 查重名 / 注销
   ├─ profile-*               # 资料读写（含 §3.6 头像上传）
   └─ admin-*                 # 管理端（逐个都重新校验 is_admin）
```

> **1.0.1 新增的 8 个函数**：`auth-validate-code`、`auth-send-code`、`auth-check-available`、
> `auth-register`、`auth-login`、`auth-reset-password`、`auth-change-password`、`auth-change-email`。
> 它们与既有函数的调用约定完全一致（POST + `{error, message}` 信封），只是多了一个
> `RESEND_API_KEY` 依赖（见第 7 步）。

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
| `RESEND_API_KEY` | https://resend.com/api-keys （**1.0.1 新增**，见第 7 步） | 发送邮箱验证码（§2.4） |
| `MAIL_FROM` | 你已通过 Resend 验证的域名，形如 `白身 <noreply@yourdomain.com>` | 验证码邮件的发件人（可选，默认取 §2.4 的 `noreply@baishen.app`） |

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

会依次执行 `migrations/` 下的四个脚本。四份都写成幂等的（`if not exists` / `create or replace` / `drop ... if exists`），重复执行安全。执行完可在 **Table Editor** 里看到 `users / activation_codes / devices / samples / archives / badges / user_kv / email_codes` 八张表，且每张表的 row count 旁都标着 `RLS enabled`。

> ⚠ `004_email_codes.sql` 里的用户名唯一索引（`idx_users_username_lower`）**在已有重名用户时会创建失败**，这是刻意的：静默挑一个赢家等于偷偷改掉别人的账号名。1.0.0 从不分配用户名（它是编辑资料里的可选装饰），所以全新库不会有冲突；确实有的话先手工理清重名再跑。

## 6. 部署 Edge Functions

逐个部署，并**统一加 `--no-verify-jwt`**：

```bash
for fn in \
  auth-activate auth-renew auth-delete-account \
  auth-validate-code auth-send-code auth-check-available auth-register \
  auth-login auth-reset-password auth-change-password auth-change-email \
  profile-get profile-update \
  admin-generate-code admin-list-users admin-ban-user \
  admin-unban-user admin-revoke-codes admin-grant-badge admin-reissue-jwt
do
  supabase functions deploy "$fn" --no-verify-jwt
done
```

**为什么必须 `--no-verify-jwt`**：这个开关只是关掉平台网关那一层 JWT 校验，并**不代表**函数不校验身份。每个函数内部都会自己做验证：

- `requireUser()` 会校验 bearer token 的 **HS256 签名**（本项目自签，见 `_shared/client.ts`），再按
  `sub` 读 `public.users` 那一行；
- `requireAdmin()` 在此基础上再读一次数据库里的 `users.is_admin`，非管理员一律 403；
- `auth-renew` 需要接受「刚刚过期」的 token（客户端每 7 天续期一次，离线久了 token 可能已过 `exp`），而平台网关会在我们的代码运行之前就把过期 token 拒掉，所以这一层必须由函数自己掌握；
- 1.0.1 的 6 个「还没有账号 / 还没有会话」的入口（`auth-validate-code`、`auth-send-code`、`auth-check-available`、`auth-register`、`auth-login`、`auth-reset-password`）本来就是匿名可调的，它们各自校验自己的凭据（激活码 / 邮箱验证码 / 密码）。

> **1.0.1 起 `requireUser` 不再调用 `sb.auth.getUser()`**。原因很具体：GoTrue 的 `/auth/v1/user` 除了验签还要在 `auth.users` 里找得到这个 `sub`，而 1.0.0 的 `auth-activate` 只往 `public.users` 插行、从不建 `auth.users` 行（激活码本身就是凭据，没有密码可存）——继续依赖 GoTrue 会让**这批老用户**在 `profile-*` 与 `auth-change-*` 上全部 401，正是 1.0.1 承诺不锁死的那批人。签名校验与 `auth-renew` 用的是同一份实现，GoTrue 仍然是**密码**的权威（`auth-login` / `auth-change-password` 把密码交给它判）。

## 7. 设置函数环境变量（secrets）

```bash
supabase secrets set \
  SUPABASE_JWT_SECRET="<第2步的 JWT Secret>" \
  PUBLIC_AVATAR_PREFIX="https://<project-ref>.supabase.co/storage/v1/object/public/avatars/" \
  RESEND_API_KEY="re_xxxxxxxxxxxxxxxx" \
  MAIL_FROM="白身 <noreply@yourdomain.com>"
```

说明：

- `SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 平台**自动注入**到每个 Edge Function，通常无需手动设置。自托管或将函数跑在本机时需要显式设置，命令同样是：
  ```bash
  supabase secrets set SUPABASE_URL="https://<project-ref>.supabase.co" \
    SUPABASE_SERVICE_ROLE_KEY="<service_role key>"
  ```
- `SUPABASE_JWT_SECRET` **必须显式设置**，`signJwt()` 用它做 HS256 签名。
- `PUBLIC_AVATAR_PREFIX` 可选：不设时回退到 `https://<SUPABASE_URL>/storage/v1/object/public/avatars/`。若头像存在别的桶，按实际前缀改。`profile-update` 会把不以此前缀开头的 `avatarUrl` 判为 `BAD_REQUEST`。
- **`RESEND_API_KEY` 必需（1.0.1）**：`auth-send-code` 没有它就只能回 `EMAIL_FAILED`。
  **`MAIL_FROM` 强烈建议设置**：Resend 只允许从**你已验证的域名**发信，而 §2.4 的示例发件人
  `noreply@baishen.app` 是你（部署者）不一定拥有的域名 —— 不设置时会照 §2.4 的字面值发，然后被
  Resend 拒掉；`EMAIL_FAILED` 的 message 里会带回 Resend 的原话，日志里一眼能看出是域名没验证。

改完 secrets 需要**重新部署函数**才会生效：

```bash
supabase functions deploy auth-activate --no-verify-jwt
```

（逐一重跑第 6 步的循环即可。）

### 7.1 创建 `avatars` 存储桶（§3.6 头像上传）

1. Dashboard → **Storage** → **New bucket**，名字填 **`avatars`**，勾上 **Public bucket**。
2. 不需要写任何 storage policy：头像的写入发生在 `profile-update` 里，用的是 service-role key
   （绕过 RLS），而读取走公开桶的 public URL —— 客户端从头到尾没有 Storage 的写权限，
   这正是 §3.6「路径 `avatars/{user_id}.jpg` 由服务端决定」的落地方式。
3. 桶名和路径都不是可配置项：`avatarPrefix()` 与 `AVATAR_BUCKET` 是同一个事实的两半，
   换桶要同时改（`profile-update` 会把指向别处的 `avatarUrl` 判为 `BAD_REQUEST`）。

> 桶不存在时 `profile-update` 会返回 `INTERNAL` 并写明「Storage bucket 'avatars' does not exist」，
> 而不是一个无从下手的 500。

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

### 9.1 清理过期邮箱验证码（§2.4，可选）

`004_email_codes.sql` 末尾把这条语句**注释着**发布了（是否启用 pg_cron 是部署者的决定，不是迁移脚本
的）。启用了 pg_cron 之后执行：

```sql
select cron.schedule(
  'baishen-purge-email-codes',
  '0 4 * * *',                                   -- 每天 04:00
  $$ delete from public.email_codes where expires_at < now() - interval '1 day' $$
);
```

不清理也不影响正确性：每一处读取都带 `expires_at` / `used` 条件，过期行永远匹配不到任何人，
表又只有每次发码一行。清理只是保持整洁。

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

1.0.1 的两步注册是同一套约定，分两次调用：

```bash
# 第一步：这个码能用吗（200 里的 valid/reason，不是错误信封）
curl -X POST "https://<project-ref>.supabase.co/functions/v1/auth-validate-code" \
  -H "apikey: <anon key>" -H "Content-Type: application/json" \
  -d '{"code":"BS-ABCD-EFGH-JKLM-NPQR"}'
# => {"valid":true}   或   {"valid":false,"reason":"ALREADY_USED"}

# 第二步：发验证码 → 注册（emailCode 是刚收到的那 6 位数字）
curl -X POST "https://<project-ref>.supabase.co/functions/v1/auth-send-code" \
  -H "apikey: <anon key>" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
# => {"ok":true}

curl -X POST "https://<project-ref>.supabase.co/functions/v1/auth-register" \
  -H "apikey: <anon key>" -H "Content-Type: application/json" \
  -d '{"code":"BS-ABCD-EFGH-JKLM-NPQR","username":"alice","email":"you@example.com",
       "password":"hunter2hunter2","emailCode":"123456","deviceId":"dev-abc-123"}'
# => {"jwt":"...","expiresAt":"...","user":{...}}
```

---

## 11. 最终检查清单

- [ ] 项目区域为 Singapore，状态 Active。
- [ ] `supabase link` 成功，`config.toml` 已从示例复制并改好 `project_id`。
- [ ] `supabase db push` 成功；**八张表**存在且都显示 **RLS enabled**。
- [ ] `activation_codes` 表 **没有任何** policy（Dashboard → Authentication → Policies 里应为空）。
- [ ] **20 个函数**全部部署成功：`supabase functions list`。
- [ ] 每个函数都带 `verify_jwt = false`，且代码内部有 `requireUser` / `requireAdmin` 或明确的匿名理由。
- [ ] secrets 已设置：`SUPABASE_JWT_SECRET`（必需）、`RESEND_API_KEY`（1.0.1 必需）、`MAIL_FROM`（建议）、`PUBLIC_AVATAR_PREFIX`（可选）；改完已重新部署。
- [ ] Storage 里存在 **public 的 `avatars` 桶**（第 7.1 步）。
- [ ] 已用激活码跑通一次 `auth-activate`，拿到 `jwt` 与 `expiresAt`。
- [ ] 已在 SQL Editor 手动把自己标记为 `is_admin = true`。
- [ ] 用管理员账号调一次 `admin-list-users` 返回 200；用普通账号调返回 403 `FORBIDDEN`。
- [ ] `pg_cron` 已启用且 `purge-deleted-users` 任务 active。
- [ ] 扩展 `cloud.js` 里只填了 `SUPABASE_URL` + anon key，没有任何 secret。
- [ ] 冒烟测试错误码：假码 → `INVALID_CODE`；撤销码 → `CODE_REVOKED`；已用码 → `CODE_ALREADY_USED`；第 4 台设备 → `DEVICE_LIMIT`；封禁账号 → `BANNED`。
- [ ] **两步注册冒烟**（1.0.1）：`auth-validate-code` → `{valid:true}`；`auth-send-code` 收到邮件；60 秒内再发 → `RATE_LIMITED`；`auth-check-available` 对已占用的用户名 → `{available:false}`；`auth-register` → `{jwt,user}`。
- [ ] **账号设置冒烟**（1.0.1）：`auth-change-password` 用错当前密码 → `BAD_CREDENTIALS`；成功后同一 token 再调 `profile-get` → `UNAUTHORIZED`（`token_epoch` 已自增）；`profile-update` 传 `avatarData` → 桶里出现 `avatars/<user_id>.jpg`。

---

## 附：本地开发（可选）

```bash
supabase start                 # 起本地 Postgres / Studio / Functions
supabase db reset              # 重放全部迁移到干净的本地库
supabase functions serve auth-activate --no-verify-jwt --env-file ./supabase/.env.local
supabase stop
```

本地调试时用 `supabase/.env.local` 放 secrets（该文件不要提交）。
