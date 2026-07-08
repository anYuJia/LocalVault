<div align="center">

<img src="frontend/public/animated_icon.svg" width="128" height="128" alt="better-douyin Logo">

# better-douyin

抖音内容下载、预览与本地归档工具。公开源码保留前端 UI、mock bridge、mock backend 和协作边界；完整可用应用请下载 Releases。

<p>
  <a href="https://github.com/anYuJia/better-douyin/releases/latest"><img src="https://img.shields.io/github/v/release/anYuJia/better-douyin?style=flat-square" alt="Release"></a>
  <a href="https://github.com/anYuJia/better-douyin/releases"><img src="https://img.shields.io/github/downloads/anYuJia/better-douyin/total?style=flat-square" alt="Downloads"></a>
  <a href="https://github.com/anYuJia/better-douyin/stargazers"><img src="https://img.shields.io/github/stars/anYuJia/better-douyin?style=flat-square" alt="Stars"></a>
  <img src="https://img.shields.io/badge/Source-Open%20Shell-2ea44f?style=flat-square" alt="Open Shell">
  <img src="https://img.shields.io/badge/Frontend-React%20%7C%20Vite%20%7C%20TypeScript-3178c6?style=flat-square" alt="Frontend">
  <img src="https://img.shields.io/badge/Backend-Node.js%20Mock-555?style=flat-square" alt="Mock Backend">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License"></a>
</p>

[下载完整应用](#下载完整应用) · [功能能力](#功能能力) · [界面预览](#界面预览) · [源码说明](#源码说明) · [协作边界](#协作边界)

</div>

---

## 项目定位

better-douyin 是 Python 版抖音桌面工具，面向内容预览、本地归档、下载管理和桌面端使用体验。

需要直接使用完整功能的用户，请从 [Releases](https://github.com/anYuJia/better-douyin/releases/latest) 下载发行版。发行版是完整应用；当前公开源码是 **Open Shell**，用于展示 UI、组件结构、mock 流程和协作边界。

公开源码适合：

- 了解产品界面、交互和前端架构
- 改进 UI / UX、主题、组件、响应式和可访问性
- 给其他 AI 或协作者提供安全上下文
- 基于同一前端契约接入你自己有权维护的服务

公开源码不包含真实平台连接器、签名、Cookie、加密、真实接口、下载解析或发布密钥。

## 下载完整应用

完整应用在 [Releases](https://github.com/anYuJia/better-douyin/releases/latest) 发布。普通用户建议直接下载 Release，不需要从源码构建。

## 功能能力

完整发行版包含以下能力：

- 搜索用户，查看主页作品、收藏、点赞等内容
- 解析分享链接，支持视频、图集和部分 Live Photo 内容
- 批量下载用户作品、搜索结果、推荐流、收藏列表和点赞列表
- 推荐流预览、沉浸式播放器、一键下载和下载任务管理
- 播放器支持多媒体切换、进度控制、音量控制、自动播放下一条和失败重试
- 支持下载视频原声 / BGM，并写入下载任务和下载记录
- “我的下载”支持任务进度、文件视图、作品视图、搜索、播放、定位和删除
- Cookie、配置、下载历史和本地文件均保存在本机

公开源码中的 mock bridge 和 mock backend 会返回演示数据，方便运行 UI，但不会访问真实平台。

## 界面预览

<p align="center">
  <a href="img/preview/index.jpg"><img src="img/preview/index.jpg" width="100%" alt="主界面"></a>
  <br>
  <strong>主界面</strong>
</p>

<p align="center">
  <a href="img/preview/get_user.jpg"><img src="img/preview/get_user.jpg" width="100%" alt="搜索用户"></a>
  <br>
  <strong>搜索用户</strong>
</p>

<p align="center">
  <a href="img/preview/user_detail.jpg"><img src="img/preview/user_detail.jpg" width="100%" alt="用户主页"></a>
  <br>
  <strong>用户主页 / 批量下载</strong>
</p>

<p align="center">
  <a href="img/preview/recommend.jpg"><img src="img/preview/recommend.jpg" width="100%" alt="推荐视频流"></a>
  <br>
  <strong>推荐视频流</strong>
</p>

<p align="center">
  <a href="img/preview/playvideo.jpg"><img src="img/preview/playvideo.jpg" width="100%" alt="沉浸式播放器"></a>
  <br>
  <strong>沉浸式播放器</strong>
</p>

## 源码说明

本仓库源码是公开壳子，用于运行 UI demo 和协作改进。完整可用应用请下载 Releases：

```bash
npm --prefix frontend install
npm run dev
```

构建前端：

```bash
npm run build
```

启动安全 mock 后端并预览构建产物：

```bash
npm run server
```

一条命令构建并启动公开 demo：

```bash
npm run demo
```

## 示例后端

`backend/server.mjs` 是无第三方依赖的 Node.js mock 后端，只提供本地演示 API：

- `GET /api/health`
- `GET /api/config`
- `GET /api/account`
- `GET /api/videos`
- `GET /api/downloads`
- `POST /api/ai/suggest`
- `GET /` 静态预览 `dist/` 构建产物

它不会读取 Cookie，不会访问真实平台，不会生成签名，不会上传凭据，也不包含任何真实接口信息。

## 项目结构

```text
.
├── frontend/                 # React UI shell
│   ├── src/                  # 页面、组件、stores、hooks、类型契约
│   └── public/               # 图标和静态资源
├── backend/
│   └── server.mjs            # 安全 mock 后端和 dist 静态预览
├── docs/
│   └── adapter-boundary.md   # 前端适配器边界
├── OPEN_SOURCE.md            # 开源壳发布策略
├── SECURITY_BOUNDARY.md      # 永不公开的内容边界
└── README.md
```

## 技术栈

| 模块 | 技术 |
|:---|:---|
| 前端界面 | React, Vite, TypeScript, Tailwind CSS |
| 状态与交互 | Zustand, Radix UI, lucide-react, framer-motion |
| 公开后端 | Node.js mock server |
| 完整发行版后端 | Python 桌面运行时 |
| 打包分发 | Releases 提供完整应用 |

## 协作边界

欢迎贡献：

- UI / UX 改进
- 组件拆分、主题、响应式、可访问性
- mock 数据和本地 demo 流程
- 示例后端的健康检查、日志格式、错误返回等通用工程能力
- 文档、截图、开发体验和安全边界说明

不接受：

- 真实接口、签名、加密、Cookie、风控、逆向或绕过逻辑
- 抓包数据、真实凭据、账号数据或非公开实现片段
- 高并发采集、自动化批量请求或任何可能违反平台规则的功能

更多说明见：

- [OPEN_SOURCE.md](OPEN_SOURCE.md)
- [SECURITY_BOUNDARY.md](SECURITY_BOUNDARY.md)
- [docs/adapter-boundary.md](docs/adapter-boundary.md)

## 给 AI 协作者

如果你是 AI 助手，请优先在公开边界内工作：

1. 先阅读 `SECURITY_BOUNDARY.md` 和 `docs/adapter-boundary.md`。
2. 只修改前端 UI、mock bridge、mock backend、文档和通用开发体验。
3. 遇到真实平台接口、Cookie、签名、加密、下载解析、发布密钥等需求时，停止并说明该内容不属于公开源码范围。
4. 不要凭空补全真实接口，不要生成绕过逻辑，不要把示例 mock 改成真实平台请求。

## 加入交流群

<p align="center">
  <img src="img/community/qq-group.jpg" width="220" alt="QQ 群二维码">
  <br>
  <strong>QQ群：438407379</strong>
</p>

## 免责声明

本项目按“现状”提供。使用者应自行确认使用目的、改动内容和运行环境符合所在地法律法规、平台规则、版权规则和数据保护要求。请只在合法、授权、非商业、无害的场景中使用。

<p align="center">如果这个项目对你有帮助，欢迎 Star 支持。</p>
