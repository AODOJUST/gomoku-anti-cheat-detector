# 白身 / Baishen

基于 [Rapfi](https://github.com/dhbloo/rapfi) WASM 引擎的在线五子棋反作弊检测浏览器扩展。支持 **gomoku.com** 与 **papergames.io**。

> 名字取自棋盘上最难看清的那一方。

## 它做什么

观战或对弈时，扩展自动读取棋盘落子序列，对局结束后在本地跑引擎逐手复盘，输出黑白双方的 AI 嫌疑度：

- **风险分**（0–100）：综合 Top-1/Top-3/Top-5 贴合度、胜率差、候选分差、ACPL、唯一手连串、好点池、活三池、回避手规律性、将胜乱下、无用冲四等多维指标
- **多引擎回退链**：本地 Rapfi WASM（单/多线程）为主，远程 KataGomo HTTP 为辅，支持自行上传 Rapfi `.data` 权重包
- **形状识别**：跳四/冲四/反四终局判定，修正跳四误判为四三杀导致对局中断
- **RIF 开局识别**：中途加入的对局可反推已下开局
- **强制防守豁免**：唯一防守手不计入统计，人工可校验
- **对局归档与回放**：每局自动存档，内置查看器逐手复盘、导出 CSV
- **人工标注与自学习**：逐步打标，样本库自动搜索阈值；特征库余弦相似度匹配历史 AI 指纹
- **13 语言界面**：简中 / 繁中 / 日 / 韩 / 英 / 俄 / 法 / 德 / 越 / 西 / 马来 / 阿拉伯 / 蒙古
- **自动搭话与提问**（可选）：开局发反作弊提示，对手上嫌疑线后自动提问；支持自定义问题与风险档位
- **一键更新**：自动从 GitHub 下载新版 zip 并通知重载
- **面板外观自定义**：背景图、透明度、模糊度、拖动位置
- **云账户（可选，1.0.0 新增）**：填入激活码后可解锁云同步 / 用户主页 / 徽章 / 跨设备同步（最多 3 台）。
  **不激活完全不影响上面任何一项**——上面全部是本机功能，永久免费、离线可用

> 仅用于观战学习与可疑手提示，不替代官方判罚。

## 安装

扩展未上架商店，需以"开发者模式"加载本地文件。不同网络环境走不同路径。

### 方式 A：海外 / 可直接访问 GitHub

1. 打开 [Releases](../../releases)，下载最新版 `gomoku-detector-vX.Y.Z.zip`
2. 解压到一个**不会删除**的文件夹（例如 `D:\gomoku-detector\`）
3. 地址栏输入 `edge://extensions/`（Edge）或 `chrome://extensions/`（Chrome）
4. 打开右上角 **开发者模式**
5. 点 **加载已解压的扩展程序**，选择刚解压的文件夹
6. 打开 `https://www.gomoku.com/` 或 `https://papergames.io/` 观战页，右上角出现浮层即成功

### 方式 B：中国大陆 / 无法直连 GitHub

直接下载可能很慢或失败，任选其一：

- **镜像加速**：把下载链接前缀换成镜像站，例如
  - `https://ghproxy.net/https://github.com/AODOJUST/gomoku-anti-cheat-detector/releases/latest`
  - 或 `https://gh-proxy.com/...`
  - （镜像站有时效，若失效自行搜索 "github 加速下载"）
- **手机/其他网络下载**：用手机浏览器下载 zip，通过微信/QQ/数据线传回电脑
- **让已安装的朋友直接打包**：把对方扩展目录整个 zip 发给你

下载解压后，安装步骤同方式 A 的第 3–6 步。

### 方式 C：Chrome 网上应用店 / Edge 外接程序商店

暂未上架。若未来上架，会在此说明。

### 加载后必做

1. 扩展图标右键 → **网站访问权限** → 选 **在所有网站上**（或至少允许 `www.gomoku.com` 和 `papergames.io`）
2. 打开对战/观战页，按 **Ctrl+Shift+R** 硬刷新
3. 右上角出现"检测器已启动"即正常

## 使用

- 观战或对弈时自动记录每一手
- 对局结束后自动跑引擎分析（首次约 10–30 秒加载引擎）
- 结果浮层显示黑白双方风险分与 AI 分层，可一键复制/导出 JSON
- 点扩展图标打开查看器，回看历史归档、人工标注、训练阈值
- 在"引擎设置"里可切换 Rapfi / KataGomo / 自定义权重包

## 云账户与激活（1.0.0）

**核心检测永远免费、纯本地。** 激活码解锁的是云功能，不是检测功能。

- 拿到激活码后，在 **设置 → 云账户与同步** 里填入即可；格式 `BS-XXXX-XXXX-XXXX-XXXX`，大小写与横杠随便打，扩展会自己规整；
- 首次激活会问你是否把本地已有数据上传，**默认不传**，且逐类可勾；
- 云同步**默认关闭**，八个同步类别逐类可选；
- 离线宽限 30 天：令牌过期后云功能受限或锁定，**本地功能在任何状态下都可用**；
- 同一个码最多 **3 台**设备同时在线。

完整说明见 [`docs/ACTIVATION.md`](docs/ACTIVATION.md)；隐私政策见 [`PRIVACY.md`](PRIVACY.md)（扩展「关于」面板有链接）。

> 未配置后端时（出厂状态）扩展里没有云端地址，所有云功能显示「未配置」并且**不发任何网络请求**——这时它就等于 0.5.7.1 减去两个导航按钮。

## 技术说明

- 引擎通信：Rapfi 走 YXBOARD + YXNBEST，解析 INFO PV/EVAL/WINRATE；KataGomo 走 KataGo analysis JSON
- 坐标：15×15，x=字母-a（0=最左），y=15-数字（0=最上）
- **默认状态下**（未激活 / 未开云同步）数据只在本地浏览器里：棋谱、检测结果、设置、黑名单都不上传任何服务器；自定义权重包存在本浏览器 IndexedDB
- **激活并主动开启云同步之后**，只有你勾选的类别会上传到云端；棋谱原始数据与检测结果**永远不上传**。范围见 [`PRIVACY.md`](PRIVACY.md) 第 2、3 节
- KataGomo 地址为可选 host 权限，由操作者首次使用时授权
- 云端使用 Supabase：扩展里只有**公开的 anon key**（写操作走 RLS），service role key 只存在于服务端 Edge Functions

## 构建（开发者）

扩展**以源码目录直接加载**，日常开发不需要构建，也不要做构建。混淆只在发布前进行（§8.4）：

```bash
npm install          # 只装 javascript-obfuscator，一个依赖
npm run build        # copy-static → obfuscate → package
```

- `build/obfuscate.js` 逐文件分层：`app.js`/`learn.js` 重度，开局表/数据结构/翻译表/站点配置中度，UI 轻度；
  `hook.js`、`worker.js`、`manifest.json` **不混淆**（MAIN world 入口 / `importScripts` 路径 / Chrome 自己先读）；
- MV3 硬约束由脚本自己把关：关 `rc4` / `selfDefending` / `debugProtection` / `eval`，保留
  `renameGlobals: false` 与 `disableConsoleOutput: false`，并断言产物里没有 `eval`、没有消息类型被改名；
- 产物在 `build/release/`（已在 `.gitignore`），sourcemap 写进 `build/sourcemaps/` 且**不进发布包**；
- `supabase/` 与 `docs/` 不随发布包分发，见 `build/copy-static.js` 的排除清单。

> 诚实说明（§8.5）：Rapfi 是开源的，混淆防的是随手看懂后处理算法的人，不是下决心的逆向者。**它不是安全边界，只是提高门槛。**

## 免责

本扩展为独立研究项目，与 gomoku.com / papergames.io 官方无关。误报难免，风险分仅供参考。
