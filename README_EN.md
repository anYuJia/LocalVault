<div align="center">

<img src="animated_icon.svg" width="128" height="128" alt="better-douyin Logo">

# better-douyin

A local Douyin downloader, previewer, and archive manager built with Python and React. It is suitable for source-level customization, desktop usage, and browser / headless workflows.

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

[Download](#download) · [Features](#features) · [Screenshots](#screenshots) · [Run From Source](#run-from-source) · [FAQ](#faq)

</div>

---

## Project Positioning

better-douyin is the Python edition of the Douyin desktop toolkit. It keeps the local Flask service, browser access mode, and Python source structure easy to inspect and extend.

For daily desktop use, the Rust / Tauri edition is recommended: [better-douyin-R](https://github.com/anYuJia/better-douyin-R).

## License

This project is licensed under the **[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)** license. Current versions are available only for personal, non-commercial learning, research, academic discussion, and testing. Commercial distribution, commercial integration, paid download services, hosted services, data resale, and any direct or indirect revenue-generating activity are prohibited. See the [LICENSE](LICENSE) file in the project root.

## Legal Compliance and Acceptable Use

This project is a non-destructive client-side tool and proof-of-concept research project intended to help users browse and study lawful public data. It does not provide bypasses, cryptographic cracking, credential stuffing, automated attacks, or unauthorized access to non-public data. Its network behavior follows standard browser communication patterns and public Douyin APIs, equivalent to ordinary local browser access by the user.

By using this project, you understand and agree to the following terms:

- **Compliant use**: Use this project only for personal learning, research, interface-mechanism study, or non-commercial backup of lawful content you are allowed to access.
- **Your responsibility**: You are solely responsible for ensuring that your use complies with applicable laws, platform terms, copyright law, cybersecurity rules, and data protection requirements.
- **Rights boundary**: Process only public content that you published, own, have explicit permission to use, or are clearly allowed by platform rules to view and save.
- **Commercial prohibition**: Do not use this project for commercial data collection, commercial analytics, paid distribution, SaaS hosting, paid download services, content republishing, account marketing, lead generation, or any revenue-generating activity.
- **Security boundary**: Do not use this project for malicious high-frequency requests, large-scale automated crawling, account abuse, access-control or risk-control bypass, rate-limit evasion, or any activity that interferes with or burdens platform services.
- **Privacy and credentials**: Do not expose your login credentials, including Cookies, to untrusted third parties or public networks. If you run this project on a LAN or server, you must configure access control and network firewall protections yourself.

If you are unsure whether your purpose or scenario complies with these laws and rules, delete this software immediately and stop using it.

## Features

- Search Douyin creators and browse profile works, collected works, and liked works
- Parse shared links and download individual works
- Download videos, image posts, and some Live Photo assets
- Batch download creator works, search results, recommended feeds, collected lists, and liked lists
- Name batch tasks by creator, mix, or list context for easier local archiving
- Preview recommended feeds with immersive playback and one-click download
- Player support for multi-media navigation, progress control, volume, auto-play next work, and retry states
- Download original audio / BGM and keep it visible in download tasks and history
- Manage local downloads in task, file, and work views
- Run as a desktop app or as a browser / headless service
- Keep Cookie, settings, history, and downloaded files on your own machine

## Screenshots

<p align="center">
  <a href="img/index.jpg"><img src="img/preview/index.jpg" width="100%" alt="Main interface"></a>
  <br>
  <strong>Main interface</strong>
</p>

<p align="center">
  <a href="img/get_user.jpg"><img src="img/preview/get_user.jpg" width="100%" alt="User search"></a>
  <br>
  <strong>User search</strong>
</p>

<p align="center">
  <a href="img/user_detail.jpg"><img src="img/preview/user_detail.jpg" width="100%" alt="Creator profile"></a>
  <br>
  <strong>Creator profile / batch download</strong>
</p>

<p align="center">
  <a href="img/recommend.jpg"><img src="img/preview/recommend.jpg" width="100%" alt="Recommended feed"></a>
  <br>
  <strong>Recommended feed</strong>
</p>

<p align="center">
  <a href="img/playvideo.jpg"><img src="img/preview/playvideo.jpg" width="100%" alt="Immersive player"></a>
  <br>
  <strong>Immersive player</strong>
</p>

## Download

Download the package for your platform from [Releases](https://github.com/anYuJia/better-douyin/releases/latest), then install or extract it.

| Platform | Recommended file |
|:---|:---|
| Windows installer | `better-douyin-v*-windows-x64-installer.exe` |
| Windows portable | `better-douyin-v*-windows-x64-portable.zip` |
| macOS Apple Silicon | `better-douyin-v*-macos-arm64.dmg` |
| macOS Intel | `better-douyin-v*-macos-x64.dmg` |
| Linux Debian / Ubuntu | `better-douyin-v*-linux-x64.deb` |
| Linux Fedora / openSUSE / RHEL | `better-douyin-v*-linux-x64.rpm` |
| Linux portable | `better-douyin-v*-linux-x64.tar.gz` |

`.sig`, `latest.json`, `windows.json`, `darwin.json`, and `linux.json` are mainly used for update metadata and signature checks. Most users do not need to download them manually.

If macOS says the developer cannot be verified:

```bash
sudo xattr -rd com.apple.quarantine /path/to/better-douyin.app
```

## First Use

1. Open Settings and configure Cookie and download directory.
2. Set Cookie through built-in login, browser Cookie import, or manual paste.
3. Search a creator, parse a shared link, or open recommended / collected / liked lists.
4. Download a single work or start a batch download from a list.
5. Monitor progress in the bottom task panel and manage saved files in "My Downloads".

## Run From Source

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

Browser / headless mode:

```bash
python -m src.web.web_app
```

Frontend development:

```bash
npm --prefix frontend run dev
```

## Cookie, Data, and Privacy

- Cookie is only used for local requests to Douyin-related APIs
- Cookie, settings, history, cache, and downloaded files stay on your machine
- Recommended feed, collected works, liked works, comments, and some batch features require a valid Cookie
- If browser / headless mode is exposed remotely, configure your own access control and reverse proxy security
- If APIs suddenly stop working, check Cookie validity, account verification, network access, and target content permissions

## FAQ

### What if Cookie expires or works cannot be fetched?

Refresh Cookie and confirm that the account can access the target content in a normal browser session.

### What if downloads are slow or fail?

Speed depends on network conditions, resource availability, platform responses, and Cookie state. Try reducing concurrency, refreshing Cookie, switching network, or retrying later.

### Why are already-downloaded works skipped?

The app records downloaded works and checks local files to avoid duplicate downloads. If you moved files manually, verify the active directory in "My Downloads".

### Can it run on a Linux server?

Yes. Browser / headless mode is more suitable than desktop mode. If you expose it remotely, handle access control, reverse proxying, and Cookie exposure risks yourself.

## Development Stack

| Area | Technology |
|:---|:---|
| Desktop window | pywebview |
| Local service | Flask, Flask-SocketIO |
| Downloading | asyncio, aiohttp, requests |
| Frontend | React, Vite, TypeScript, Tailwind CSS |
| Packaging | PyInstaller |

## Disclaimer

1. This project is provided "as is", without any express or implied warranty, including availability, stability, accuracy, completeness, or fitness for a particular purpose.
2. The authors do not encourage, support, or authorize any violation of laws, infringement of third-party rights, violation of platform terms, or commercial use of this project.
3. This project is downloaded, built, configured, and run locally by users at their own discretion. Any account restrictions, account bans, data loss, network blocking, copyright disputes, civil claims, administrative penalties, or economic losses arising from running this software or improperly distributing downloaded content are solely the user's responsibility. The project developers assume no direct or indirect legal liability.

## Star History

<p align="center">
  <a href="https://star-history.com/#anYuJia/better-douyin&Date">
    <img src="https://api.star-history.com/svg?repos=anYuJia/better-douyin&type=Date" width="100%" alt="better-douyin Star History Chart">
  </a>
</p>

---

<p align="center">If this project helps you, a Star is appreciated.</p>
