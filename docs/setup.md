# Local setup

This page covers everything needed to build, run and test mmap on a development machine.
People who only install the packaged app need nothing beyond the installer: Electron bundles its
own Node.js runtime and SQLite engine.

## Prerequisites

| Tool    | Version                                    | Notes                                                               |
| ------- | ------------------------------------------ | ------------------------------------------------------------------- |
| Windows | 10 or 11, x64                              | The only supported platform in version 1 (PRD §3).                  |
| Node.js | 24.x, at least 24.11.0 (`.nvmrc`: 24.21.0) | Enforced: `.npmrc` sets `engine-strict=true`. Node 25 is rejected.  |
| npm     | 10 or newer (npm 11, bundled with Node 24) | npm 11 honours the `allowScripts` field in the root `package.json`. |
| git     | Any recent version                         | `.gitattributes` normalizes line endings.                           |

Not needed: Python, Visual Studio, C++ build tools, Docker, or a database server. SQLite comes
from Node's built-in `node:sqlite` module, so there are no native modules to compile. Node 24 and
Electron 44.9.3 both ship SQLite 3.53.4, so tests run against the same engine as the installed
app ([ADR-0002](adr/0002-sqlite-driver-node-sqlite.md)).

If you use nvm-windows: `nvm install 24.21.0` then `nvm use 24.21.0`.

## First-time setup

```sh
git clone <repository-url> mmap
cd mmap
npm ci
npm run verify
```

- `npm ci` installs the exact versions from `package-lock.json`. `.npmrc` sets `save-exact=true`,
  so new dependencies are also pinned exactly.
- The root `package.json` contains `"allowScripts": { "electron-winstaller": false }`. npm 11 then
  skips that package's install script. It is only needed for Squirrel.Windows installers, which
  mmap does not build ([ADR-0004](adr/0004-installer-signing-and-updates.md)).
- `npm run verify` runs `format:check`, `lint`, `typecheck`, `test` and `build` in that order and
  stops at the first failure. A clean `npm ci && npm run verify` is a Phase 0 exit criterion.

### The Electron binary

The `electron` package does not download its binary during `npm ci`. The first command that needs
it (`npm run dev`, `npm run preview -w @mmap/desktop`, or packaging) prints
`Downloading Electron binary...` and fetches it once. This is the only step after installation
that needs network access. Later runs use the cached copy.

## Daily commands

| Command                                | Purpose                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `npm run dev`                          | Start the app with hot reload (see below)                                 |
| `npm test`                             | Run all tests once ([testing.md](testing.md))                             |
| `npm run test:watch`                   | Re-run tests on change                                                    |
| `npm run lint`                         | ESLint, zero warnings allowed                                             |
| `npm run typecheck`                    | Strict TypeScript for the root project and every workspace package        |
| `npm run format`                       | Rewrite files with Prettier                                               |
| `npm run verify`                       | CI checks except packaging; run before opening a pull request             |
| `npm run build`                        | Bundle main, preload and renderer into `apps/desktop/out`                 |
| `npm run preview -w @mmap/desktop`     | Run the built bundle unpackaged, served from `app://mmap` as in release   |
| `npm run package:dir -w @mmap/desktop` | Unpacked packaged app; see [the packaging runbook](runbooks/packaging.md) |

### How `npm run dev` works

`npm run dev` runs `electron-vite dev` in `apps/desktop`. It builds the main and preload bundles,
starts a Vite dev server for the renderer on a loopback address, and launches Electron with
`ELECTRON_RENDERER_URL` pointing at that server. The main process accepts the URL only when the
app is not packaged and the URL is `http://localhost` or `http://127.0.0.1`
(`apps/desktop/src/main/security/trusted-origins.ts`). In development the Content Security Policy
also allows the inline React Fast Refresh preamble and the dev server's WebSocket; packaged
builds never get these exceptions.

Developer tools and the default application menu are available only in unpackaged builds.

## Environment variables

mmap needs no environment variables, secrets, API keys or `.env` file. The app makes no network
calls, so there is nothing to configure. `.gitignore` excludes `.env` files as a precaution.

| Variable                | Required | Read by             | Purpose and behaviour                                                                                                                                                                                                                 |
| ----------------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ELECTRON_RENDERER_URL` | No       | mmap main process   | Set automatically by `electron-vite dev`; do not set it yourself. Used only when the app is unpackaged and the value is an `http://localhost` or `http://127.0.0.1` URL. Otherwise ignored, and the renderer loads from `app://mmap`. |
| `electron_config_cache` | No       | Electron downloader | Optional directory for the cached Electron binary download. Tooling only; the app never reads it.                                                                                                                                     |
| `ELECTRON_MIRROR`       | No       | Electron downloader | Optional alternative download mirror, documented in the `@electron/get` README. Tooling only.                                                                                                                                         |

Packaged builds also ignore `NODE_OPTIONS` and `ELECTRON_RUN_AS_NODE`, because the corresponding
Electron fuses are switched off ([packaging runbook](runbooks/packaging.md#electron-fuses)).

CI (`.github/workflows/ci.yml`) uses two GitHub secrets, only in the secret-scan job and never in
the app: `GITHUB_TOKEN` (provided automatically by GitHub Actions) and `GITLEAKS_LICENSE` (needed
only if the repository is owned by an organization). Packaging needs no secrets while builds are
unsigned.

The app accepts two command-line flags, used only by the packaged smoke test: `--smoke-test` and
`--smoke-report=<file>` (`apps/desktop/src/main/smoke-test.ts`).

## Where things are written

- Build output: `apps/desktop/out` (bundles) and `apps/desktop/release` (packaged app and
  installer). Both are git-ignored.
- Tests create temporary SQLite files under the OS temp directory (`mmap-test-*`) and delete them
  afterwards.
- Phase 0 creates no workspace. Electron keeps its own profile (Chromium cache and the
  single-instance lock) in `%APPDATA%\mmap`, named after `productName` in
  `apps/desktop/package.json`. Workspaces will live in `%APPDATA%\mmap\workspaces\<name>`
  from Phase 1 ([ADR-0005](adr/0005-workspace-location-and-supported-filesystems.md)).

## Troubleshooting

### `npm ci` fails with `EBADENGINE`

Your Node or npm version is outside the `engines` range in the root `package.json`
(`node >=24.11.0 <25`, `npm >=10`). `engine-strict=true` turns this into an error on purpose, so
that tests and builds always use a Node with the expected SQLite. Switch to Node 24 (see
`.nvmrc`), confirm with `node --version`, and run `npm ci` again.

### The Electron download fails or hangs

The download happens on first use, not during `npm ci` (see above). If it fails (proxy, firewall,
interrupted download), Electron reports:
`Electron failed to install correctly. Please delete node_modules/electron and run "npx install-electron --no" manually.`
Do that, then retry. If your network requires a mirror, set `ELECTRON_MIRROR` for that one
command.

### First launch is slow

Microsoft Defender scans `electron.exe`, `mmap.exe` and the many files under `node_modules` the
first time they are used. The first `npm ci`, the first `npm run dev` and the first launch of a
fresh packaged build can take noticeably longer than later runs. This is expected. If it is a
persistent problem, a Defender exclusion for the repository folder helps; only add one if your
organisation's policy allows it.

### `npm run dev` shows a blank window

Check the terminal for a Vite error first. If the dev server URL is not a loopback `http` URL, the
main process ignores it and loads `app://mmap`, which needs a previous `npm run build`. Running
`npm run build` once, or fixing the dev server address, resolves this.

### The packaged smoke test fails

`npm run smoke:packaged` prints one `PASS` or `FAIL` line per check, with a reason for failures.

- `Packaged app not found ... Run "npm run package:dir" first.`: there is no
  `apps/desktop/release/win-unpacked/mmap.exe` yet. Build it.
- `The app exited without writing a smoke test report.`: the app crashed before the checks ran.
  The main process logs `[mmap] startup failed: <ErrorName>` to the console. Packaged builds omit
  stack traces, so reproduce with `npm run preview -w @mmap/desktop` to see the full error.
- A single check fails: the check name says which layer is broken (SQLite and migrations,
  `app://` loading, React rendering under the CSP, the preload bridge, renderer isolation, or CSP
  enforcement). See [testing.md](testing.md#packaged-smoke-test) for what each check proves.
- `Smoke test timed out after 120 s.`: often Defender scanning a freshly built binary. Run it
  again; if it keeps timing out, investigate the renderer load.

Remember to rebuild (`package:dir`) after code changes; the smoke test runs whatever is in
`release/win-unpacked`.
