# 部署指南 · Deployment

本文回答 1.0.0 定稿 **§十三「需要你补充的三件事」**，其余是照着做就能跑通的步骤。

> 前提：你已经有一个 Supabase 账号（免费档就够）。整个部署**不需要写 SQL**，所有脚本都在
> `supabase/migrations/` 里；也不需要改任何 TypeScript，除非你要加自己的业务逻辑。

---

## 零、三件事，一句话答案

| §十三 的问题 | 答案 | 要填在哪 |
|---|---|---|
| **Supabase 项目信息**（URL / anon / service role / region） | 建项目后从 **Project Settings → API** 抄；region **建议 Singapore** | `extension/cloud.js` 两个占位符（URL + anon）。**service role 只填进 Edge Function 的环境变量，永远不进扩展** |
| **第一个管理员怎么标记** | 部署完用**一次性 SQL** 把某个用户置 `is_admin = true`（见第四节） | Supabase Studio 的 SQL Editor |
| **隐私政策托管地址** | **默认用本仓库的 GitHub Pages**：仓库 Settings → Pages → Source 选 `main` 分支的 `/docs`，得到 `https://<用户>.github.io/<仓库>/privacy.html` | 填进 `extension/viewer.js` 的 `PRIVACY_URL` |

三件事都填完之后，扩展里「设置 → 云账户与同步」的三个状态字会从「未配置」变成可激活。

---

## 一、建项目（5 分钟）

1. 到 [supabase.com](https://supabase.com) 新建项目；
2. **Region 选 Singapore**（§9.1 的「数据存放位置」写的就是它；离中国大陆玩家最近，延迟最低）；
3. 记下数据库密码（Supabase 会问，只有你自己用得到）；
4. **Project Settings → API** 抄三样东西：

   | 名字 | 长什么样 | 进哪里 |
   |---|---|---|
   | **Project URL** | `https://xxxxxxxx.supabase.co` | `cloud.js` 的 `SUPABASE_URL` |
   | **anon public key** | 很长的 JWT，`role: anon` | `cloud.js` 的 `SUPABASE_ANON_KEY` |
   | **service_role key** | 更长的 JWT，`role: service_role` | ⚠ **只进 Edge Function 环境变量**，见第三节 |

**anon 和 service_role 的区别就是本项目的安全边界**（§2.2）：

- **anon 可打包**——它是公开密钥，所有写操作都走 RLS（行级安全策略），拿到它也只能做策略允许的事；
- **service_role 绝不进扩展**——它**绕过所有 RLS**。一旦打进扩展，任何人解压 zip 就能读写你的整库。
  扩展里唯一允许出现它的地方是 Edge Function 源码里的 `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`。

---

## 二、建表与策略（2 分钟）

装好 [Supabase CLI](https://supabase.com/docs/guides/cli) 后，在仓库根目录（也就是 `extension/`）执行：

```bash
supabase link --project-ref <你的 project ref>
supabase db push          # 跑 migrations/001..004
```

四个迁移文件都是**幂等**的（`create table if not exists` / `drop policy if exists` 后再建），
所以重复执行、或对已经建好的项目补跑，都是安全的——这一点由 `verify-062` §8 断言。

| 文件 | 建了什么 |
|---|---|
| `001_init.sql` | `users` / `activation_codes` / `devices` / `samples` / `archives` / `badges`，加上 §3.3 的乐观锁唯一索引 `idx_code_redeemed` 和三个 `updated_at` 触发器 |
| `002_rls.sql` | 六张表全部 `enable row level security` + 每张表的策略 + `is_admin()` 辅助函数 |
| `003_user_kv.sql` | `user_kv` —— §7.2 里「黑名单 / 设置 / 自定义问题 / 学习参数」四个同步类别的存放处（§11.1 没给它们表，这个文件补上；`key` 是白名单而不是自由文本） |
| `004_email_codes.sql`（1.0.1） | `email_codes`（§2.4 邮箱验证码，**RLS 开着且没有任何 policy**，只有服务端能碰）、`users.token_epoch`（§3.7 撤销所有设备 JWT 的计数器）、`idx_users_username_lower`（§2.3 用户名唯一，大小写不敏感） |

> ⚠ `004` 的**用户名唯一索引**在库里已有重名用户时会创建失败，这是刻意的（静默挑一个赢家等于偷偷改掉
> 别人的账号名）。1.0.0 从不分配用户名，全新库不会有冲突；确实有的话先手工理清。
> `004` 还会往 `users` 加一列 `token_epoch default 0`：**1.0.1 之前签发的 token 读作 0，继续有效**，
> 所以这次升级不会把任何人踢下线。

手动建也可以：把四个文件依次粘进 Studio 的 SQL Editor 跑一遍。

---

## 三、部署 Edge Functions（5 分钟）

```bash
supabase functions deploy auth-activate auth-renew auth-delete-account \
                        auth-validate-code auth-send-code auth-check-available \
                        auth-register auth-login auth-reset-password \
                        auth-change-password auth-change-email \
                        profile-get profile-update \
                        admin-generate-code admin-list-users admin-ban-user \
                        admin-unban-user admin-revoke-codes admin-grant-badge \
                        admin-reissue-jwt
```

### 需要设置的环境变量

Supabase 会**自动注入** `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 两个变量，通常不用手动设。
需要你自己设的有三个：

```bash
# 1) 签发 JWT 的密钥（必需）
supabase secrets set SUPABASE_JWT_SECRET=<Project Settings → API → JWT Settings 里的 JWT Secret>

# 2) 发邮箱验证码的 Resend 密钥（1.0.1 必需，§2.4）
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxxxxxx

# 3) 验证码邮件的发件人（1.0.1 建议设，必须是你在 Resend 里已验证的域名）
supabase secrets set MAIL_FROM='白身 <noreply@yourdomain.com>'
```

> ⚠ `SUPABASE_JWT_SECRET` 必须和项目自身的 JWT Secret **一致**——`auth-*` 函数用 WebCrypto 的 HS256
> 签自己的 30 天令牌（§0 #8），签完之后客户端拿它去访问 PostgREST 时要被同一个密钥验签。
>
> ⚠ 不设 `MAIL_FROM` 时函数会照 §2.4 的字面值从 `noreply@baishen.app` 发信，而那个域名不属于你——
> Resend 会拒收，客户端拿到 `EMAIL_FAILED`（Resend 的原话在函数日志里）。这不是 bug，是 Resend 的
> 域名验证机制。

### 还要建一个 Storage 桶（1.0.1，§3.6 头像）

Dashboard → **Storage** → **New bucket** → 名字 **`avatars`**、勾 **Public**。不需要写 storage policy：
写入发生在 `profile-update` 里（service-role），读取走公开桶的 public URL，客户端全程没有 Storage 写权限。

`config.example.toml` 是 `supabase/config.toml` 的模板；本地开发（`supabase start`）时把它复制成
`config.toml`，里面 `[functions.<name>] verify_jwt = false` 是**故意**的：这些函数的鉴权是自己在
代码里做的（anon 调 `auth-activate` / `auth-register` 时还没有令牌），让平台再验一次会把激活这一步堵死。

---

## 四、标记第一个管理员（1 分钟）

1. 先用扩展激活一个账号（或直接在 Studio 的 `users` 表里插一行）；
2. 到 **SQL Editor** 跑：

```sql
-- 把某个邮箱标记为管理员。这就是 §十三 第 2 条的答案：一次性 SQL，不做第二个后台。
update public.users
   set is_admin = true
 where email = 'you@example.com';
```

3. 让该用户**重新登录一次**（扩展「我的」页刷新会重新拉 `profile-get`，`is_admin` 随 JWT 声明一起下来）。

> ⚠ 管理员判定**只在服务端生效**（§6.1）。扩展里的 `GMAdmin.isAdmin()` 只决定「管理员」标签页
> 显不显示；每个 `admin-*` 函数都会重新校验 JWT 与 `is_admin`，所以把标签页显示出来也做不了任何事。
> 这一点由 `verify-062` §3 与 §7 断言。

---

## 五、把地址填进扩展

打开 `extension/cloud.js`，改开头两个常量：

```js
var SUPABASE_URL = 'https://xxxxxxxx.supabase.co';   // Project URL
var SUPABASE_ANON_KEY = 'eyJhbGciOi...';             // anon public key
```

**只改这两个。** 填完在 `edge://extensions` 点一次「重新加载」，扩展的设置页会显示「已配置」。
留空（出厂状态）时扩展是**纯本地**的：检测、存档、样本库、学习、黑名单全部照常，只是没有云功能——
这正是 §1.2 「不破坏已有用户的本地使用」的实现方式，由 `verify-062` §1 断言。

### 关于网络权限

`manifest.json` 的 `host_permissions` 里有 `https://*.supabase.co/*`，所以托管版**开箱可用**。
本地开发栈（`http://127.0.0.1:54321`）走的是 `optional_host_permissions` 里的
`http://*/*`——首次调用会弹权限请求，同意一次即可。用自建域名时同理：把域名加进
`host_permissions`，或在运行时授权。

---

## 六、隐私政策页（3 分钟）

1. 仓库 **Settings → Pages**；
2. Source 选 **Deploy from a branch**，分支 `main`，目录 **`/docs`**；
3. 保存后等一两分钟，`https://<用户>.github.io/<仓库>/privacy.html` 就能打开；
4. 把这个地址填进 `extension/viewer.js` 的 `PRIVACY_URL`（留空时「关于」面板显示「尚未提供」而不是一个死链）。

页面是**中英双语**、零外部资源（§9.3），`PRIVACY.md` 是它的文字来源，两者一起改。

---

## 七、本地开发（可选）

```bash
supabase start                    # 起本地栈，地址 http://127.0.0.1:54321
supabase db reset                 # 重跑 migrations
supabase functions serve          # 本地起 Edge Functions
```

然后把 `SUPABASE_URL` 填成 `http://127.0.0.1:54321`、`SUPABASE_ANON_KEY` 填本地输出的 anon key。
`cloud.js` 的 URL 校验**故意接受** `127.0.0.1` 与 `localhost`（含端口），因为这是开发时的正常地址。

---

## 八、部署后自检

| 检查 | 期望 |
|---|---|
| 设置页「云账户与同步」 | 「已配置」 |
| 用 `admin-generate-code` 生成一个码，`curl` 调 `auth-activate` | 返回 `{ ok: true, jwt: ... }` |
| 同一个码再激活一次 | `409 CODE_ALREADY_USED`（§3.3 乐观锁：`.is('redeemed_by', null)`） |
| 不激活时用全部本地功能 | 全部正常，无网络请求 |
| 撤销激活码后再续期 | `401`，扩展清 JWT 回到未激活，本地数据不动（§3.6） |
| **两步注册**（1.0.1）：`auth-validate-code` → `auth-send-code` → `auth-register` | `{valid:true}` → 收到邮件 → `{jwt, user}` |
| 60 秒内重复调 `auth-send-code` | `409 RATE_LIMITED` |
| `auth-check-available` 查一个已占用的用户名 | `{available:false}` |
| **改密码**（1.0.1）：`auth-change-password` 成功后再用同一个 `jwt` 调 `profile-get` | `401 UNAUTHORIZED`（`token_epoch` 已自增，所有旧 token 作废） |
| **头像**（1.0.1）：`profile-update` 传 `avatarData` | Storage 的 `avatars` 桶里出现 `<user_id>.jpg`，`user.avatar_url` 带 `?v=` |
| 全部本地功能在**未激活**时 | 浮层完全不创建、回放/样本库/黑名单「我的」标签不出现（§1.2 / §1.3） |

---

## 九、常见坑

- **函数没部署 / URL 写错**：扩展报的是 `HTTP_404` 而不是某个业务错误码——这是**故意**的（见
  `cloud.js` 的错误信封注释），免得「函数没部署」被误读成「激活码无效」。
- **`manifest.description` 有 132 字符上限**（Web Store 规定），改描述前先数长度。
- **不要往 `permissions` 里加 `identity`**。§11.2 把它标成「（可选）」，而本项目的激活走的是
  「邮箱 + 激活码」，不用 `chrome.identity` 的 OAuth——加一个没人用的权限只会让安装时的权限提示变长。
- **`supabase/` 和 `docs/` 不进发布包**（`build/copy-static.js` 的排除清单）。这不是保密——
  仓库是公开的，表结构与 RLS 策略本来就在 GitHub 上看得见；排除它们是因为它们**不是客户端的一部分**，
  一个用户解压出来看到 PostgreSQL 迁移文件，有理由怀疑扩展在做没说的事。
