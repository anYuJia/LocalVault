# Security Boundary

The public repository is intentionally limited to a runnable UI shell, mock bridge, mock backend, public assets, and documentation. Anything related to real platform access or release infrastructure is outside the public boundary.

## Public Surface

The public shell may include:

- Frontend UI, state, styles, public assets, and local development configuration.
- Mock bridge and mock backend that return demo data only.
- Public README, open source notes, adapter boundary notes, license, screenshots, and community documentation.

## Private Boundary

Do not add or request:

- Real platform endpoints, headers, signing, encryption, fingerprinting, or risk-control logic.
- Cookie extraction, credential upload, account verification, real session handling, or login automation.
- Media URL resolution, download parsing internals, upload flows, IM protocol details, or bypass behavior.
- Release signing keys, update keys, repository tokens, workflow secrets, or build internals.
- Captured traffic, production credentials, undocumented API details, or non-public implementation snippets.

## Review Checklist

Before public changes are merged, check that:

- The app runs using mock data only.
- No real credentials, tokens, secrets, endpoint paths, signing logic, or non-public protocol details are present.
- Documentation describes the public shell from a user and contributor perspective only.
- Public files do not describe internal maintenance, repository layout, or publishing workflow.
