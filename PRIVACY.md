# 白身 (Baishen) 隐私政策 · Privacy Policy

> 本文件是隐私政策的**唯一权威版本**（source of truth）。面向浏览器访问的 HTML 版本在
> [`docs/privacy.html`](docs/privacy.html)，它由本文件改写而来，托管方式见
> [`docs/DEPLOY.md`](docs/DEPLOY.md)。
> 扩展内「关于」面板指向该页面。
>
> This file is the authoritative source of the policy. The HTML page served to browsers is
> [`docs/privacy.html`](docs/privacy.html); see [`docs/DEPLOY.md`](docs/DEPLOY.md) for hosting.
>
> 最后更新 / Last updated: **2026-10-03**（随 1.0.0 发布 / with the 1.0.0 release）

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
- **不会上传黑名单**——同样除非你自己打开云同步。

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
- **Your blacklist is not uploaded** — again, unless you enable cloud sync.

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
