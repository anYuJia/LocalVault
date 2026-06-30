<div align="center">

<img src="animated_icon.svg" width="128" height="128" alt="better-douyin Logo">

# better-douyin

抖音内容下载、预览与本地归档工具。使用 Python + React 构建，适合源码阅读、二次开发、桌面运行和浏览器 / 无界面模式部署。

<p>
  <a href="README.md">简体中文</a> | <a href="README_EN.md">English</a>
</p>

<p>
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python"></a>
  <a href="https://github.com/anYuJia/better-douyin/releases/latest"><img src="https://img.shields.io/github/v/release/anYuJia/better-douyin?style=flat-square" alt="Release"></a>
  <a href="https://github.com/anYuJia/better-douyin/releases"><img src="https://img.shields.io/github/downloads/anYuJia/better-douyin/total?style=flat-square" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-555?style=flat-square" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Non--Commercial-red?style=flat-square" alt="License"></a>
</p>

[下载发行版](#下载安装) · [功能能力](#功能能力) · [界面预览](#界面预览) · [源码运行](#源码运行) · [加入交流群](#加入交流群)

</div>

---

## 项目定位

better-douyin 是 Python 版抖音桌面工具，保留了完整的本地服务、浏览器访问和源码可改造能力。它适合想要研究实现、扩展接口、定制下载流程或在浏览器模式下运行的用户。

如果你主要是日常桌面使用，更推荐 Rust / Tauri 版：[better-douyin-R](https://github.com/anYuJia/better-douyin-R)。

## 许可协议

本项目已采用 **[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)** 许可协议授权。当前版本仅允许个人用于非商业的学习、研究、学术探讨和测试等目的。禁止任何形式的商业分发、商业集成、收费代下、托管服务、数据销售或任何直接、间接的营利性活动。详见项目根目录下的 [LICENSE](LICENSE) 文件。

## 法律与合规

本项目仅作为辅助用户进行合法公开数据浏览及研究的**非破坏性客户端工具（PoC 研究型项目）**。本项目不提供任何绕过防线、破解加解密技术、撞库、自动化采集、网络攻击或非授权获取非公开数据的功能。所有操作均严格遵循浏览器标准通信协议和抖音公开 API，完全等同于用户在本机浏览器上的合法、常规查阅行为。

使用本项目即表示您理解并同意以下条款：

- **合规场景**：仅在个人学习、研究、接口机制探究或备份自己有权访问的合法内容等非商业、无害场景中使用。
- **责任自担**：您必须自行确认您的使用行为符合您所在地法律法规、平台用户协议、版权法规、网络安全法规以及数据保护规则。
- **权利红线**：只能处理您本人发布、拥有版权、获得明确授权，或平台规则明示允许您查阅并保存的**公开内容**。
- **商业禁令**：严禁将本项目用于商业数据抓取、商业舆情分析、付费分发、SaaS 挂载、收费代下服务、内容搬运、账号营销获客或任何营利性活动。
- **安全红线**：严禁使用本项目进行恶意的高频网络请求、大规模自动化爬虫采集、账号滥用、绕过访问控制与人机风控、规避平台限流或以任何方式干扰、负担或阻碍平台服务器的正常运行。
- **隐私与凭据**：严禁将您的登录凭证（如 Cookie 等）暴露给未经信任的第三方或公开网络。如在本地局域网或服务器环境运行，必须自行配置访问控制和网络防火墙等安全措施。

如果您不确定您的使用目的或场景是否符合上述法律法规，请立即删除本软件并停止使用。

## 功能能力

- 搜索抖音用户，查看主页作品、收藏、点赞等内容
- 粘贴分享链接解析单条作品，支持视频、图集和部分 Live Photo 内容
- 批量下载用户作品、搜索结果、推荐流、收藏列表和点赞列表
- 批量下载任务支持以用户、合集、列表等名称归档
- 推荐流预览、沉浸式播放器和一键下载
- 播放器支持多媒体左右切换、进度控制、音量控制、自动播放下一条和失败重试
- 支持下载视频原声 / BGM，并写入下载任务和下载记录
- “我的下载”支持任务进度、文件视图、作品视图、搜索、播放、定位和删除
- 支持桌面窗口模式，也支持浏览器 / 无界面模式
- Cookie、配置、下载历史和本地文件均保存在本机

## 界面预览

<p align="center">
  <a href="img/index.jpg"><img src="img/preview/index.jpg" width="100%" alt="主界面"></a>
  <br>
  <strong>主界面</strong>
</p>

<p align="center">
  <a href="img/get_user.jpg"><img src="img/preview/get_user.jpg" width="100%" alt="搜索用户"></a>
  <br>
  <strong>搜索用户</strong>
</p>

<p align="center">
  <a href="img/user_detail.jpg"><img src="img/preview/user_detail.jpg" width="100%" alt="用户主页"></a>
  <br>
  <strong>用户主页 / 批量下载</strong>
</p>

<p align="center">
  <a href="img/recommend.jpg"><img src="img/preview/recommend.jpg" width="100%" alt="推荐视频流"></a>
  <br>
  <strong>推荐视频流</strong>
</p>

<p align="center">
  <a href="img/playvideo.jpg"><img src="img/preview/playvideo.jpg" width="100%" alt="沉浸式播放器"></a>
  <br>
  <strong>沉浸式播放器</strong>
</p>

## 下载安装

从 [Releases](https://github.com/anYuJia/better-douyin/releases/latest) 下载对应平台文件，解压或安装后运行。

| 平台 | 推荐下载 |
|:---|:---|
| Windows 安装版 | `better-douyin-v*-windows-x64-installer.exe` |
| Windows 便携版 | `better-douyin-v*-windows-x64-portable.zip` |
| macOS Apple Silicon / M 系列 | `better-douyin-v*-macos-arm64.dmg` |
| macOS Intel | `better-douyin-v*-macos-x64.dmg` |
| Linux Debian / Ubuntu | `better-douyin-v*-linux-x64.deb` |
| Linux Fedora / openSUSE / RHEL | `better-douyin-v*-linux-x64.rpm` |
| Linux 通用便携 | `better-douyin-v*-linux-x64.tar.gz` |

`.sig`、`latest.json`、`windows.json`、`darwin.json`、`linux.json` 主要用于自动更新和签名校验，普通用户通常不需要手动下载。

macOS 首次运行如提示无法验证开发者：

```bash
sudo xattr -rd com.apple.quarantine /path/to/better-douyin.app
```

## 首次使用

1. 打开设置，配置 Cookie 和下载目录。
2. 通过内置登录、浏览器读取或手动粘贴完成登录态配置。
3. 使用搜索用户、解析链接、推荐流、收藏或点赞列表获取内容。
4. 下载单个作品，或进入列表执行批量下载。
5. 在底部任务面板查看进度，在“我的下载”管理本地文件。

## 源码运行

```bash
git clone https://github.com/anYuJia/better-douyin.git
cd better-douyin

python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

pip install -r requirements.txt
npm --prefix frontend install
npm --prefix frontend run build
python main.py
```

浏览器 / 无界面模式：

```bash
python -m src.web.web_app
```

前端开发模式：

```bash
npm --prefix frontend run dev
```

## Cookie 与隐私

- Cookie 仅用于本机请求抖音相关接口，不会上传到本项目服务器
- 下载历史、配置、账号信息和缓存数据均保存在本机
- 推荐、收藏、点赞、评论和部分批量能力依赖有效 Cookie
- 浏览器 / 无界面模式如果对外暴露，请自行配置访问控制和反向代理安全策略
- 如果接口异常，优先检查 Cookie、账号验证状态、网络环境和目标内容权限

## 常见问题

### Cookie 失效或无法获取作品？

重新登录或重新读取 Cookie，并确认账号在浏览器中可以正常访问目标内容。

### 下载慢或失败？

通常与网络、资源可用性、平台响应或 Cookie 状态有关。可以减少并发、刷新 Cookie，或稍后重试。

### 为什么已下载作品会被跳过？

应用会记录下载历史并检查本地文件，避免重复下载。若移动过文件，请在“我的下载”中确认当前目录。

### 可以在 Linux 服务器上运行吗？

可以，建议使用浏览器 / 无界面模式。远程访问时请自行处理访问控制、反向代理和 Cookie 暴露风险。

## 开发栈

| 模块 | 技术 |
|:---|:---|
| 桌面窗口 | pywebview |
| 本地服务 | Flask, Flask-SocketIO |
| 下载能力 | asyncio, aiohttp, requests |
| 前端界面 | React, Vite, TypeScript, Tailwind CSS |
| 打包分发 | PyInstaller |

## 加入交流群

欢迎加入 QQ 群交流使用体验、问题反馈与功能建议。

<p align="center">
  <img src="img/community/qq-group.jpg" width="220" alt="QQ 群二维码">
  <br>
  <strong>QQ群：438407379</strong>
</p>

## 免责声明

1. 本项目按“现状”提供，不包含任何明示或暗示的担保（包括但不限于可用性、稳定性、准确性、完整性或对特定用途的适用性）。
2. 作者不鼓励、不支持也不授权任何违反法律法规、侵犯第三方合法权益、违反平台服务条款或商业化使用本项目的行为。
3. 本项目完全由用户在本地自主下载、编译、配置并运行。因运行本软件而导致的使用者本人的账号限制、账号封禁、数据丢失、网络阻断、或者因不当传播、再分发下载内容而引起的任何版权侵权、民事诉讼或行政处罚等法律后果与经济损失，**均由使用者本人承担，本项目开发者不承担任何直接或间接的法律责任。**

## Star History

<p align="center">
  <a href="https://star-history.com/#anYuJia/better-douyin&Date">
    <img src="https://api.star-history.com/svg?repos=anYuJia/better-douyin&type=Date" width="100%" alt="better-douyin Star History Chart">
  </a>
</p>

---

<p align="center">如果这个项目对你有帮助，欢迎 Star 支持。</p>
