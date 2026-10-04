# 白身 (Baishen) 隐私政策 · Privacy Policy

> 本文件是隐私政策的**唯一权威版本**（source of truth）。面向浏览器访问的 HTML 版本在
> [`docs/privacy.html`](docs/privacy.html)，它由本文件改写而来，托管方式见
> [`docs/DEPLOY.md`](docs/DEPLOY.md)。
> 扩展内「关于」面板指向该页面。
>
> This file is the authoritative source of the policy. The HTML page served to browsers is
> [`docs/privacy.html`](docs/privacy.html); see [`docs/DEPLOY.md`](docs/DEPLOY.md) for hosting.
>
> 最后更新 / Last updated: **2026-10-04**（随 1.0.5 发布 / with the 1.0.5 release）

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
- **激活码泄露**：管理员可批量撤销，撤销后**本地数据不受影响**。

### 6. 你的权利

- **导出**：扩展的「导入与导出」面板可以导出你的全部本地数据；
- **删除**：「我的 → 注销账户」会申请删除云端数据（30 天后生效）；
- **更正**：「我的 → 修改资料」可以改用户名、邮箱、头像。

### 7. 未成年人

本扩展面向在线五子棋的成年玩家。若你认为目标用户可能包含未成年人，请在使用前取得监护人同意。

### 8. 第三方

除上文列出的 Supabase 之外，扩展**不向任何第三方发送数据**。检测引擎（Rapfi / KataGomo）在本机或
你自己配置的地址运行；「自动提问」功能若启用会使用**你自己填写的** LLM 接口与密钥。

### 9. 联系方式

管理员联系邮箱：**（待管理员补充 / to be filled in by the operator）**

### 10. 在你自己的电脑上：哪些东西是明文的

`chrome.storage.local` **本身不加密**。以下内容以明文存在你的浏览器配置目录里，任何能读到该目录的
程序（同机上的其他软件、备份、扩展调试端口）都能拿到：

- **「自动提问」用的 LLM API Key**（`settings.llm.apiKey`）——**导出的备份文件里会剥离它**，本机不剥离；
- **云账户的登录令牌（JWT）**——有效期 30 天，被读到即等同于被冒充登录。它被刻意放在 `settings`
  **之外**，所以导出/导入与云同步都不会带上它；注销、改密码或在管理员撤销后即失效。

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
  touch your local data**.

### 6. Your rights

- **Export**: the extension's 「导入与导出」 panel exports everything stored locally;
- **Delete**: 「我的 → 注销账户」 requests deletion of the cloud data (effective after 30 days);
- **Rectify**: 「我的 → 修改资料」 edits your username, email and avatar.

### 7. Minors

This extension targets adult players of online gomoku. If you believe the intended audience may
include minors, obtain guardian consent before use.

### 8. Third parties

Apart from the Supabase instance named above, the extension sends data to **no third party**. The
detection engines (Rapfi / KataGomo) run locally or at an address *you* configure; the optional
「自动提问」 feature uses the LLM endpoint and key that *you* provide.

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
