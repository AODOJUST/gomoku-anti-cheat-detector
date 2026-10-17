# 白身 (Baishen) 隐私政策 · Privacy Policy

> 本文件是隐私政策的**唯一权威版本**（source of truth）。面向浏览器访问的 HTML 版本在
> [`privacy.html`](privacy.html)（**在仓库根目录**，不在 `docs/`），它由本文件改写而来，托管方式见
> [`docs/DEPLOY.md`](docs/DEPLOY.md)。
> 扩展内「关于」面板指向该页面。
>
> This file is the authoritative source of the policy. The HTML page served to browsers is
> [`privacy.html`](privacy.html) (**at the repository root** — not in `docs/`); see
> [`docs/DEPLOY.md`](docs/DEPLOY.md) for hosting.
>
> 最后更新 / Last updated: **2026-10-05**（随 1.0.6 发布 / with the 1.0.6 release）

---

## 中文

### 一句话概括

**核心检测功能完全在本地运行，不需要账号，不上传任何数据。** 只有当你**主动填入激活码**并**主动开启云同步**之后，才会有数据离开你的电脑。

### 1. 不需要账号时：什么都不会上传

以下功能在完全离线的状态下工作，**不产生任何网络请求**：

- 读取棋盘落子序列、跑引擎复盘、计算风险分；
- 本地存档（Chrome 的 `chrome.storage.local`）与样本库；
- 学习机制（阈值自动搜索）与黑名单；
- 自定义模型（权重包存在本机 IndexedDB 里）。

### 2. 激活并登录后，会上传什么

| 项目 | 内容 | 目的 |
|---|---|---|
| 用户标识 | `username`、`email` | 账户本身 |
| 头像 | `avatar`（压缩到 256×256） | 主页显示 |
| 账户状态 | 激活状态、设备 ID、最后活跃时间 | 一码一账户、跨设备上限 3 台 |
| 样本库元数据 | 样本条数、AI 比例等**统计量** | §5.3 主页数字 |
| 徽章 / 成就 | 已授予的徽章类型 | §5.2 预留 |
| **平台痕迹**（1.0.6） | 你用的是**扩展版还是网页版**、每次登录的**时刻**，以及 `geo-update` 已推断出的**国家代码**（**IP 本身不落库**，见 §8） | 运维统计「谁在用哪个版本」，**只有管理员看得到** |
| **消息已读水位**（1.0.6） | 五个消息分区的**最后已读时间**（好友 / 分享 / 提及 / 系统 / 举报） | 红点：「自你上次进这个分区以来，有没有新的」 |

### 3. 不会上传什么

- **不会上传棋谱原始数据**——对局的逐手记录留在本机；
- **不会上传检测结果**——风险分、每一步的判定都只在本机计算并保存；
- **不会上传本地设置**——除非你自己打开云同步；
- **不会上传黑名单**——黑名单这一类的默认值是**不同步**：即使你打开了云同步，也只有你在
  「云账户与同步」里**单独勾选**黑名单，它才会离开本机。

#### 3.1 关于对手的数据

样本、回放存档与黑名单里带着**对手的显示名**（以及你给对手写的备注）。开启云同步并把这几类
勾上之后，这些名字会随之上传——它们是你自己采集到的内容，不是我们从服务端读来的。默认只同步
样本库（`samples`），而回放存档与黑名单的默认值都是「不同步」。

云同步**默认关闭**，且**逐类可选**：你可以只同步样本库而不同步设置。同步范围、开关位置与冲突策略见
[`CHANGELOG.md`](CHANGELOG.md) 的 1.0.0 条目与扩展内「设置 → 云账户与同步」面板。

### 4. 数据存放在哪里

Supabase（PostgreSQL + Storage）的托管区域，**建议选择新加坡（Southeast Asia, Singapore）**。实际区域以
你使用的部署为准；自建部署时由管理员决定。

### 5. 保留期

- **活跃账户**：数据一直保留，直到你删除；
- **注销账户**：本地数据**保留在原位**，云端数据在 **30 天**后彻底删除（给你反悔的窗口）；
- **激活码泄露**：管理员可批量撤销，撤销后**本地数据不受影响**；
- **平台登录流水**（`platform_logins`）：**目前没有单独的保留期**，随账户数据一并保留；注销账户后
  随云端数据在 30 天内删除；
- **聊天室消息**：对客户端可见的窗口是最近 **7 天**；撤回只移除展示，原文的服务端保留见 §13；
- **分享到聊天室的文件**：本机副本保留 **15 分钟**。

### 6. 你的权利

- **导出**：扩展的「导入与导出」面板可以导出你的全部本地数据；
- **删除**：「我的 → 注销账户」会申请删除云端数据（30 天后生效）；
- **更正**：「我的 → 修改资料」可以改用户名、邮箱、头像。

### 7. 未成年人

本扩展面向在线五子棋的成年玩家。若你认为目标用户可能包含未成年人，请在使用前取得监护人同意。

### 8. 第三方

本服务会接触以下第三方，**除此之外不向任何第三方发送数据**：

- **Supabase** —— 托管与存储（见 §4）；
- **ipinfo.io** —— 在你登录时，**服务端**把你的 **IP 地址**发给它，用来推断国家代码（`§3.1.7`：
  **IP 本身不落库**，只保存推断出的国家代码）。扩展本身不直接接触它，是服务端代发的；
- **Resend**（`api.resend.com`）—— 投递注册 / 重置密码的**验证码邮件**，以及管理员回复举报时的
  邮件；因此**你的邮箱地址与邮件正文会经过它**。不发信时不接触；
- 检测引擎（Rapfi / KataGomo）在本机或**你自己配置的**地址运行；「自动提问」功能若启用会使用
  **你自己填写的** LLM 接口与密钥 —— 这两者都不经由我们。

⚠ 前两项是**基础设施**性质的第三方：它们能接触到你的 IP 或邮箱，但服务端刻意**不会**把你的棋谱、
每一步判定或风险分发给它们 —— 那些从不离开你的电脑。

### 9. 联系方式

管理员联系邮箱：**（待管理员补充 / to be filled in by the operator）**

### 10. 在你自己的电脑上：哪些东西是明文的

`chrome.storage.local` **本身不加密**。以下内容以明文存在你的浏览器配置目录里，任何能读到该目录的
程序（同机上的其他软件、备份、扩展调试端口）都能拿到：

- **「自动提问」用的 LLM API Key**（`settings.llm.apiKey`）——**导出的备份文件里会剥离它**，本机不剥离；
- **云账户的登录令牌（JWT）**——有效期 30 天，被读到即等同于被冒充登录。它被刻意放在 `settings`
  **之外**，所以导出/导入与云同步都不会带上它；注销、改密码或在管理员撤销后即失效。
- **聊天室的本机缓存**（IndexedDB 库 `baishen-cache`）——你进过的公共房间最近 **7 天**的消息、分享
  文件的一份副本（**15 分钟**）与同步元数据。撤回一条消息会把它从**这个缓存**里删掉；卸载扩展或
  清除扩展数据会清空它。

如果你不信任本机上的其他程序，请不要启用「自动提问」，也不要登录云账户——**核心检测功能两者都不需要**。

### 11. 在线状态与国籍的可见范围

「最后活跃时间」在你每次带认证的请求中更新（约每 60 秒一次）。它的可见范围是**你自己 + 你的好友**：
对其他账户一律返回**空值**，客户端据此显示「离线」。这是**数据层**的约束，不是渲染约定——其他账户直接调
`GET /rest/v1/users?select=last_seen_at` 得到的是空值，国籍同理：勾选「隐藏国籍」之后，其他用户读到的是
**空值**加一个「已隐藏」标记，客户端据此画白旗；原始 `country_code` 对非好友**根本不返回**。

**「隐身」改变的是别人看到的状态**，而不是这个判定：其他客户端拿不到你的时间戳，因此既算不出你
何时在线，也无法从原始字段里恢复出来。

⚠ **一处例外，需要说明：Realtime 的在线状态频道。** 客户端之间还有一个 `presence` 频道，用于让好友列表
在对方上线时立刻更新（而不是等到下一次刷新）。这个频道是**全产品共用的一个**，不是按好友关系分片的，
因此**任何已登录账户**订阅它都能看到「现在有哪些账户在线、状态是「在线 / 忙碌」」。能看到的只有
**当前是否在场**这一个事实（以及**加入频道的时刻**），**看不到**历史活跃时间——那个时间戳仍然只对
你自己和你的好友可见，见上一段。

- 把状态设为「隐身」会让其他人看到你**离线**；
- 但它**不会**让你从频道的成员列表里消失。我们选择把这个事实写在这里，而不是假装它不存在。

如果你认为「谁现在在线」本身也不该被其他已登录用户看到，请不要使用社区功能——核心检测功能完全不需要登录。

### 12. 谁能看到什么（含管理员）

- **其他用户**：只能看到你公开的资料——用户名、头像，以及**未隐藏时**的国籍与「最后活跃」（见 §11）；
- **管理员**：能看到你的**邮箱**、**国家代码**、**平台使用痕迹与登录流水**，以及**激活码的使用者**
  ——即「这个码是谁兑换的（用户名 + 邮箱 + 兑换时间）」。这是邮箱在服务端**唯一**会被读取的地方；
  除此之外，邮箱只返回给**你自己**；
- ⚠ **平台痕迹与登录流水只给管理员看**：它们不出现在你的设置页，也不出现在他人主页。承载它们的
  `platform_logins` 表**连一条读取策略都没有**——只有服务端角色读得到；
- **服务端看不到的**：你的 IP 地址从不出现在平台统计里（只存 `geo-update` 已推断的国家代码），
  棋谱、每一步判定与风险分从不离开你的电脑。

### 13. 聊天室的「撤回」不等于服务端删除

在聊天室撤回一条消息，**只是把它从其他人（以及你自己）的界面上移除**，并标记为「该消息已被撤回」。
**原文与附件仍然留在服务端**，用于举报复核。这是有意的：一个能让发言者随时抹掉记录的房间，等于给
滥用者一个「说完就跑」的按钮。

- 你的客户端会把它从**本机缓存**里删掉（见 §10）；
- 服务端保留原文，供管理员处理举报时查看；客户端能读到的窗口是最近 **7 天**；
- 如果你不希望任何发言被服务端保留，请不要使用聊天室——**核心检测功能完全不需要登录**。

---

## English

### In one sentence

**The core detection runs entirely on your machine, needs no account, and uploads nothing.** Data
leaves your computer only after you *choose* to enter an activation code **and** you *choose* to
turn cloud sync on.

### 1. With no account: nothing is uploaded

These work fully offline and make **no network request at all**:

- reading the move sequence, running the engine, computing the risk score;
- local archives (`chrome.storage.local`) and the sample library;
- the learning mechanism (automatic threshold search) and the blacklist;
- custom models (weight packages stay in local IndexedDB).

### 2. What is uploaded once you activate and sign in

| Item | Contents | Why |
|---|---|---|
| Identity | `username`, `email` | the account itself |
| Avatar | `avatar` (compressed to 256×256) | shown on your profile |
| Account state | activation status, device ID, last-seen | one code per account, 3-device limit |
| Sample metadata | counts and ratios — **aggregates only** | the numbers on the profile tab |
| Badges | which badge types were granted | reserved for a future release |
| **Platform traces** (1.0.6) | whether you use the **extension or the web build**, the **time** of each sign-in, and the **country code** `geo-update` already inferred (**the IP itself is never stored** — see §8) | the operator's 「which build is in use」 census, **visible to administrators only** |
| **Message read watermarks** (1.0.6) | the **last-read time** of the five partitions (friends / shares / mentions / system / reports) | the red dot: 「anything new since you last opened this partition?」 |

### 3. What is NOT uploaded

- **Your game records are not uploaded** — the per-move data stays local;
- **Your detection results are not uploaded** — scores and per-move verdicts are computed and
  stored locally;
- **Your settings are not uploaded** — unless you enable cloud sync;
- **Your blacklist is not uploaded** — its default is NOT SYNCED: even with cloud sync on, it leaves
  this machine only if you tick 黑名单 itself in 「云账户与同步」.

#### 3.1 Data about your opponents

Samples, replay archives and blacklist rows carry your opponent's **display name** (and whatever note
you wrote about them). With cloud sync on and those categories ticked, those names travel too — they
are content you collected, not something we read off a server. The sample library is the only one of
the three that is on by default; archives and the blacklist are both off.

Cloud sync is **off by default** and **per-category**: you can sync the sample library without
syncing your settings. See the 1.0.0 entry in [`CHANGELOG.md`](CHANGELOG.md) and the extension's
「设置 → 云账户与同步」 panel.

### 4. Where the data lives

A Supabase region (PostgreSQL + Storage). **Singapore (Southeast Asia) is recommended.** The actual
region depends on the deployment you use; with a self-hosted deployment, the administrator decides.

### 5. Retention

- **Active accounts**: kept until you delete them;
- **Deleted accounts**: your local data stays where it is, and the cloud data is permanently
  removed **30 days** after you ask (the window exists so a mistake is recoverable);
- **Leaked activation codes**: an administrator can revoke them in bulk, and revocation **does not
  touch your local data**;
- **Platform login log** (`platform_logins`): there is **no separate retention window** yet — it is
  kept alongside the account and deleted with the rest of the cloud data within 30 days of account
  deletion;
- **Chat messages**: the window a client can read is the last **7 days**; recall removes the display
  only — the server-side retention is described in §13;
- **Files shared into the chat**: the local copy is kept for **15 minutes**.

### 6. Your rights

- **Export**: the extension's 「导入与导出」 panel exports everything stored locally;
- **Delete**: 「我的 → 注销账户」 requests deletion of the cloud data (effective after 30 days);
- **Rectify**: 「我的 → 修改资料」 edits your username, email and avatar.

### 7. Minors

This extension targets adult players of online gomoku. If you believe the intended audience may
include minors, obtain guardian consent before use.

### 8. Third parties

The service touches the following third parties, and **sends data to no one else**:

- **Supabase** — hosting and storage (see §4);
- **ipinfo.io** — at sign-in the *backend* sends it **your IP address** to infer a country code
  (§3.1.7: **the IP itself is never stored**, only the inferred code). The extension never contacts
  it directly;
- **Resend** (`api.resend.com`) — delivers the **verification-code email** for registration and
  password reset, and the email an administrator sends when replying to a report; **your address and
  the message body pass through it**. It is not contacted when no mail is sent;
- the detection engines (Rapfi / KataGomo) run locally or at an address *you* configure, and the
  optional 「自动提问」 feature uses the LLM endpoint and key *you* provide — neither passes through us.

⚠ The first two are *infrastructure* third parties: they can see your IP or your email, but the
backend deliberately does **not** send them your game records, per-move verdicts or risk scores —
those never leave your machine at all.

### 9. Contact

Administrator contact email: **(to be filled in by the operator)**

### 10. On your own machine: what is stored in the clear

`chrome.storage.local` is **not encrypted**. These live as plain text in your browser profile
directory, readable by any process that can read that directory (other software on the same machine,
backups, a debugging port):

- **the LLM API key used by 「自动提问」** (`settings.llm.apiKey`) — an exported backup file *strips*
  it; the local store does not;
- **the cloud account's login token (JWT)** — valid for 30 days, and reading it is equivalent to
  impersonating the account. It is deliberately kept **outside** `settings`, so neither
  export/import nor cloud sync carries it; logging out, changing the password or an administrator's
  revocation invalidates it.
- **the chat room's local cache** (IndexedDB database `baishen-cache`) — the last **7 days** of
  messages from the public rooms you have entered, one copy of any shared file (**15 minutes**) and
  the sync metadata. Recalling a message deletes it from **this cache**; uninstalling the extension
  or clearing its data empties it.

If you do not trust the other programs on this machine, do not enable 「自动提问」 and do not sign in
to a cloud account — **the core detection needs neither**.

### 11. Who can see your online status and country

Your last-seen timestamp is refreshed by every authenticated request (about once per 60 s). It is
visible to **you and your accepted friends only**: every other account is answered with **null**, and
the client draws 「offline」 from that. That is enforced in the DATA, not in the rendering — another
account calling `GET /rest/v1/users?select=last_seen_at` directly gets null, and the raw
`country_code` is not returned to a non-friend at all.

「隐身」 changes what others are *told*, not how the answer is computed — other clients never receive
the timestamp, so they can neither work out when you were last online nor recover it from the raw
field. The same holds for nationality: with 「隐藏国籍」 ticked, other users read **null** plus a
「hidden」 flag, which is what makes the client draw a white flag.

⚠ **One exception, stated plainly: the Realtime presence channel.** Clients also share a `presence`
channel so a friend list updates the moment somebody arrives rather than at the next refresh. That
channel is **one channel for the whole product, not sharded per friendship**, so **any signed-in
account** that subscribes to it can see which accounts are currently present and whether they are
「online」 or 「busy」. What it reveals is **presence only** (and the moment a client joined the
channel); it does **not** reveal the historical last-seen timestamp, which stays friends-only as
described above.

- Setting your status to 「隐身」 makes others see you as **offline**;
- it does **not** remove you from the channel's member list. We would rather write that here than
  pretend otherwise.

If you consider 「who is online right now」 itself too much to share with other signed-in users, do
not use the community features — the core detection needs no account at all.

### 12. Who can see what (administrators included)

- **Other users** see only your public profile — username, avatar, and (unless hidden) your country
  and last-seen, as described in §11;
- **Administrators** can see your **email**, your **country code**, your **platform traces and login
  log**, and **who redeemed an activation code** — i.e. the redeemer's *username + email + time*.
  That is the **only** place the backend reads an email address; everywhere else it is returned to
  **you** alone;
- ⚠ **Platform traces and the login log are shown to administrators only.** They are not on your own
  settings screen and not on anyone's profile. The table that holds them, `platform_logins`, has
  **no read policy at all** — only the service role can reach it;
- **What the backend never sees**: your IP address never appears in the platform census (only the
  country code `geo-update` already inferred is stored), and your game records, per-move verdicts and
  risk scores never leave your machine.

### 13. Recalling a chat message is not a server-side delete

Recalling a message in the chat room **only removes it from other people's screens (and yours)** and
marks it 「该消息已被撤回」. **The original text and any attachment stay on the server** so a report can
be reviewed. That is deliberate: a room where a speaker can erase the record at will hands an abuser a
「say it and run」 button.

- Your client deletes it from the **local cache** (see §10);
- the server keeps the original for an administrator reviewing a report; the window a client can read
  is the last **7 days**;
- if you would rather no message be retained server-side, do not use the chat — **the core detection
  needs no account at all**.
