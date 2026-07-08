# Adapter Boundary

The open source shell talks to a provider through `frontend/src/lib/tauri.ts`.

In the public shell, that file is a mock implementation. It returns demo data and never calls Douyin, uploads credentials, signs requests, or reads real cookies.

Private editions can implement the same frontend contract behind a different bridge.

## Public Contract

The UI expects functions for these broad areas:

- app configuration and update status
- account list and login status
- search, user detail, video detail, feed, liked, and collected lists
- comments, notices, friends, and AI suggestions
- download task state and local file actions

Public providers should return local demo data or connect only to services they are authorized to expose.

## Do Not Add

Do not add real platform endpoints, signing logic, encrypted parameter builders, Cookie upload/extraction, or media URL bypass logic to this public boundary.

