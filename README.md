# Gomoku Anti-Cheat Detector

基于 [Rapfi](https://github.com/dhbloo/rapfi) WASM 引擎的在线五子棋对战反作弊检测浏览器扩展。支持 **gomoku.com** 与 **papergames.io**。

## 它做什么

在观战或对弈时，扩展自动读取棋盘落子序列，对局结束后离线运行 Rapfi 引擎复盘每一手，输出黑白双方的 AI 嫌疑度评分：

- **风险分**（0–100）：Top-1/Top-5 贴合度、ACPL、outTop5、将胜乱扔、规律性逃避手等多维指标
- **RIF 开局识别**：支持中途加入的对局，能根据盘面反推已下的开局
- **冲四豁免**：唯一防守手不计入统计，人工可校验引擎自动豁免规则
- **AI 分层**：低阶 AI / 逃避型 AI / 强逃避型 AI / 疑似 AI / 职业 / 高手 / 普通玩家
- **对局归档与回放**：每局自动存档，内置查看器可逐手复盘
- **人工标注与学习**：逐步打标（AI步骤/判断准确/冲四/豁免等），样本库自动训练阈值
- **13 语言界面**：简中 / 繁中 / 日 / 韩 / 英 / 俄 / 法 / 德 / 越 / 西 / 马来 / 阿拉伯 / 蒙古
- **自动搭话与提问**（可选）：开局发一句反作弊提示，对手上 65% 嫌疑线后自动提问验证
- **可选 LLM 端点**：本地存 key，走 service worker 转发，未配置时完全不启用

> 仅用于观战学习与 suspicious hand 提示，不替代官方判罚。

## 安装

扩展未上架商店，需以"开发者模式"加载本地文件。不同网络环境走不同路径：

### 方式 A：海外 / 可直接访问 GitHub

1. 打开本仓库 [Releases](../../releases)，下载最新版 `gomoku-detector-vX.Y.Z.zip`
2. 解压到一个**不会删除**的文件夹（例如 `D:\gomoku-detector\`）
3. 浏览器地址栏输入 `edge://extensions/`（Edge）或 `chrome://extensions/`（Chrome）
4. 打开右上角 **开发者模式**
5. 点 **加载已解压的扩展程序**，选择刚解压的文件夹
6. 打开 `https://www.gomoku.com/` 或 `https://papergames.io/` 观战页，右上角出现浮层即成功

### 方式 B：中国大陆 / 无法直连 GitHub

直接从 GitHub Releases 下载可能很慢或失败，任选其一：

- **镜像加速**：把下载链接前缀换成镜像站，例如
  - `https://ghproxy.com/https://github.com/AODOJUST/gomoku-anti-cheat-detector/releases/latest`
  - 或 `https://mirror.ghproxy.com/...`
  - （镜像站有时效，若失效自行搜索 "github 加速下载"）
- **手机/其他网络下载**：用手机浏览器下载 zip，通过微信/QQ/数据线传回电脑
- **让已安装的朋友直接打包**：把对方扩展目录整个 zip 发给你

下载解压后，安装步骤同方式 A 的第 3–6 步。

### 加载后必做

1. 扩展图标右键 → **网站访问权限** → 选 **在所有网站上**（或至少允许 `www.gomoku.com` 和 `papergames.io`）
2. 打开对战/观战页，按 **Ctrl+Shift+R** 硬刷新
3. 右上角出现"检测器已启动"即正常

## 使用

- 观战或对弈时自动记录每一手
- 对局结束后自动跑引擎分析（首次约 10–30 秒加载引擎）
- 结果浮层显示黑白双方风险分与 AI 分层，可一键复制/导出 JSON
- 点扩展图标打开查看器，可回看历史归档对局、人工标注、训练阈值

## 目录结构

```
extension/
  manifest.json      MV3 配置
  background.js      service worker（引擎调度、LLM 转发）
  offscreen.html/js  offscreen document（跑 WASM）
  hook.js            注入页面 MAIN world，拦截 WebSocket
  sites.js           站点适配表（gomoku.com / papergames.io）
  content.js         隔离世界 UI 与读盘逻辑
  chat.js / questions.js / llm.js  自动搭话、提问、可选 LLM
  app.js             分析核心
  worker.js          WASM 桥
  engine/            Rapfi 引擎文件（.wasm / .data）
  locale/            13 语言翻译
  viewer.html/js     对局归档查看器
  learn.js / storage.js  样本库与阈值学习
  openings.js        RIF 开局库
```

## 技术说明

- 引擎通信协议：YXBOARD + YXNBEST，解析 INFO PV/EVAL/WINRATE
- 坐标：15×15，x=字母-a（0=最左），y=15-数字（0=最上）
- 仅在本地浏览器运行，棋谱与个人数据不上传任何服务器；LLM 端点由用户自行配置、默认关闭

## 免责

本扩展为独立研究项目，与 gomoku.com / papergames.io 官方无关。误报难免，风险分仅供参考。
