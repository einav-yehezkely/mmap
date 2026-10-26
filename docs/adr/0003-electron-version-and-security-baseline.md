# ADR-0003: Electron version and security baseline

- Status: Accepted
- Date: 2026-10-26

## Context

PRD §14 requires the Electron version to be recorded before implementation. PRD §7.1 requires
pinned versions and lockfiles and forbids requiring users to install Node.js or a database.
PRD §8 sets the security baseline: no renderer Node integration, context isolation, sandboxing,
validated IPC requests and sender, a narrow preload API, restricted navigation and window
creation, a CSP, OS-mediated opening of approved HTTP(S) links only after user action, no
arbitrary file access, and no telemetry. PRD §3 forbids CDN dependencies and requires full
offline operation. PRD §11 and §13 criterion 2 require hostile-IPC and navigation tests.

At the time of this decision Electron 45.0.0 had been released only days earlier. Electron
supports the latest three major lines.

## Decision

**Version.** Pin Electron 44.9.3 exactly in `package.json` and `package-lock.json`. It bundles
Node 24.22.0 and Chromium, and provides SQLite 3.53.4 through `node:sqlite` (see ADR-0002).
Stay on the 44 line until Electron 45 has had several patch releases, then upgrade through a
new ADR or an update to this one. Upgrades must keep Electron within the supported window.

**Security baseline,** built into the Phase 0 shell rather than added later:

- `BrowserWindow` web preferences: `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`, `webSecurity: true`.
- In production the renderer is served from a custom privileged `app://` scheme, not `file://`.
  The protocol handler serves only files from the packaged renderer bundle.
- Strict Content Security Policy: no remote origins and no `unsafe-eval`. All fonts, KaTeX, and
  editor assets are bundled by Vite.
- Deny every `window.open` and new-window request. Block navigation away from the app origin.
- Deny all permission requests (camera, microphone, notifications, geolocation, and so on).
- Every IPC handler validates the sender frame URL/origin before doing anything, then validates
  the payload with the zod schema from `packages/contracts`. Invalid input returns a typed error.
- The preload script exposes only named methods through `contextBridge`. It does not expose
  `ipcRenderer`, filesystem, shell, or SQL access.
- External HTTP(S) links open through `shell.openExternal` only after an explicit user action
  and only if the scheme is on an allow-list (`http:`, `https:`). Other schemes are rejected.
  Not implemented in Phase 0: until that IPC channel exists, every new-window request is denied.
- IPC senders must be the main frame of the trusted origin; same-origin sub-frames are rejected.
  Responses are validated against the contract schema too, so a service bug cannot leak extra
  fields (for example a filesystem path) to the renderer.
- Electron fuses in the packaged binary (`apps/desktop/electron-builder.yml`): `RunAsNode`,
  `NODE_OPTIONS` and CLI inspect arguments disabled; embedded ASAR integrity validation and
  `onlyLoadAppFromAsar` enabled; no extra `file://` privileges. Verified in Phase 0 with
  `npx @electron/fuses read` and by confirming `ELECTRON_RUN_AS_NODE=1` has no effect.
- The packaged smoke test (`--smoke-test`) checks inside the real runtime that CSP blocks an
  injected inline script and that the renderer has no `require`, `process` or `module`.
- Acquire Electron's single-instance lock; a second launch focuses the existing window.
- No telemetry or crash-reporting upload. Diagnostics stay local (PRD §8).

## Consequences

- Each new IPC channel needs a contract schema, sender validation, a handler test, and a
  documentation entry (implementation plan §4).
- Renderer code cannot use Node APIs; anything needing the filesystem or database goes through
  a typed main-process handler. This keeps PRD §13 criterion 2 testable.
- The `app://` scheme avoids `file://` origin quirks and makes origin checks precise, but needs
  a protocol handler that must itself be tested for path traversal.
- Strict CSP rules out some libraries that rely on `eval` or remote assets; such libraries must
  be replaced or configured before adoption.
- Electron 44 leaves the supported window once Electron 47 is released. Assumption: that is
  several months away; the upgrade to a newer line must be scheduled before Phase 5 release.
- Phase 5 owns the security test suite (hostile IPC, navigation, unsafe notes); missing tests
  block release.

## Alternatives considered

- **Electron 45.0.0.** Newest line, but too new to have patch-level fixes. Rejected for now.
- **Older Electron line (43).** Shorter remaining support with no benefit. Rejected.
- **Loading the renderer via `file://`.** Simpler, but gives a weak origin and broader file
  access. Rejected in favour of `app://`.
- **Generic `invoke(channel, payload)` bridge.** Less code, but exposes unrestricted IPC, which
  PRD §7.2 forbids. Rejected.
- **Tauri or another shell.** PRD §7.1 requires Electron. Not considered further.
