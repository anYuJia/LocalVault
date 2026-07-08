# Open Source Shell

better-douyin 的公开源码是一个可运行的 Open Shell，适合查看界面结构、体验交互流程、改进前端体验，并基于模拟数据参与协作。

完整可用应用请下载 GitHub Releases。公开源码不会包含真实平台连接器、签名、加密、真实接口、Cookie 处理、下载解析或发布密钥。

## Included

- React UI, theme, layout, stores, reusable components, and frontend contracts.
- Local mock bridge and mock backend with demo users, videos, comments, notices, downloads, accounts, and AI suggestions.
- Public documentation for adapter boundaries, contribution scope, screenshots, icons, and local development.

## Not Included

- Real platform API clients, endpoints, headers, or request signing.
- Credential extraction, upload, login automation, account verification, or real session handling.
- Media URL decryption, parser internals, upload flows, protocol details, or risk-control parameters.
- Release signing keys, update signing keys, workflow secrets, or build internals.

## Local Development

```bash
npm install
npm --prefix frontend install
npm run dev
```

The local preview uses mock data only. It does not access real platform services and does not require user credentials.

## Contribution Scope

Accepted public contributions:

- UI improvements, accessibility, layout, themes, and interaction polish.
- Mock data, demo flows, and frontend state improvements.
- Adapter interface improvements that keep the public boundary clean.
- Documentation, compliance language, and local-only safety improvements.
- Generic logging, error presentation, and developer tooling.

Not accepted in public:

- Real signing, encryption, credential handling, non-public endpoints, protocol details, or bypass behavior.
- Code that automates high-volume collection, credential extraction, or unauthorized access.
- Captured traffic, non-public implementation details, tokens, secrets, or platform-specific internals.
