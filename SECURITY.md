# Security Policy

## Scope

Guppy is a **local-first desktop app**. It spawns local processes in PTYs and
reads/writes files under directories you register. Its in-app hook server uses a
local pipe and an HTTP broker bound only to `127.0.0.1` on an ephemeral port. Every
HTTP hook URL carries a fresh per-spawn token, checked in constant time; there is no
remote listener or remote surface by design.

## Supported versions

This is an early prototype. Security fixes target the `main` branch only.

| Version | Supported |
|---|---|
| `main` | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's **private vulnerability reporting**: the *Security → Report a
  vulnerability* tab on https://github.com/Prozzta/guppyos, with a description,
  reproduction steps, and impact.

You can expect an acknowledgement within a few days. Once a fix is available we'll
credit you (unless you prefer to stay anonymous).

## Notes for reviewers

- Renderer ↔ main IPC goes through a typed `contextBridge` (`window.cth`); the renderer
  has no direct Node access (`nodeIntegration: false`, `contextIsolation: true`).
- All `fs:*` / `git:*` IPC calls are sandboxed and path-validated in the main process,
  rooted at an agent's working directory.
- The hive is persisted as local files; since 1.1.53 the app neither initialises nor commits a
  hive git repository, and leaves any existing `hive/.git` untouched.
