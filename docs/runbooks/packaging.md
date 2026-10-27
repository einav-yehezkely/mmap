# Runbook: build, package and smoke-test

How to produce a packaged Windows build of mmap, check it, and what is still missing before a
public release. The decisions behind this are in
[ADR-0004](../adr/0004-installer-signing-and-updates.md).

> **Current builds are unsigned and for internal testing only. Do not distribute them.** Signing
> is configured but no certificate is available yet ([Code signing](#code-signing)).

## Prerequisites

A working development setup ([setup.md](../setup.md)) on Windows 10/11 x64. No native toolchain is
needed: the app has no native modules (`npmRebuild: false` in `electron-builder.yml`), because
SQLite comes from Electron's built-in `node:sqlite`. The first packaging run downloads the Electron
binary and electron-builder's NSIS tooling, so it needs network access once.

## Steps

All commands run from the repository root.

1. **Clean install and verify.**

   ```sh
   npm ci
   npm run verify
   ```

2. **Package.** Choose one:

   | Command                                                        | Produces                                    | Use when                          |
   | -------------------------------------------------------------- | ------------------------------------------- | --------------------------------- |
   | `npm run package:dir -w @mmap/desktop`                         | `apps/desktop/release/win-unpacked/` only   | Fast check; enough for smoke test |
   | `npm run package` (root) or `npm run package -w @mmap/desktop` | The unpacked folder plus the NSIS installer | Testing installation              |

   Both first run `electron-vite build`, so they always package the current source.

3. **Smoke test.**

   ```sh
   npm run smoke:packaged
   ```

   This runs `release/win-unpacked/mmap.exe --smoke-test` hidden, with network traffic sent to a
   dead proxy and a temporary profile (your real workspaces are never touched), and must end with
   `Packaged smoke test passed.` The 17 checks, including first-run workspace creation, node
   operations and mind maps through the bridge, opening a 200-item map in the real editor,
   rendering a 1,000-node graph, finding a review and a milestone on the visual timeline,
   exporting the workspace to ZIP and importing it back, taking and verifying a backup, and the
   automated WCAG 2.2 AA check of the primary views, are described in
   [testing.md](../testing.md#packaged-smoke-test). The script passes the path of `axe-core` (a
   development dependency, not shipped in the app) with `--smoke-axe=<path>`; without that flag
   the accessibility check is skipped and 16 checks run.

4. **Check the fuses** (after changing `electron-builder.yml` or upgrading Electron or
   electron-builder):

   ```sh
   npx @electron/fuses read --app apps/desktop/release/win-unpacked/mmap.exe
   ```

   Compare the output with the [table below](#electron-fuses).

5. **Manual installer check** (when packaging or installer settings change):
   - Run `apps/desktop/release/mmap-setup-0.1.0-x64.exe`. Expect a SmartScreen warning because the
     build is unsigned; choose "More info", then "Run anyway".
   - The installer is assisted (not one-click), installs per user, and lets you change the
     directory. It creates Start menu and desktop shortcuts.
   - The installer, the uninstaller, the Start menu entry, the taskbar and the window show the
     mmap icon.
   - Disconnect from the network and start mmap. On a machine without an earlier profile, the
     Home page of a new `My Knowledge` workspace opens, with "Get started". Open Settings: the
     workspace location should be under `%APPDATA%\mmap\workspaces`, the version should have no
     "(development)" suffix, "Full-text search (FTS5)" should read "Available", and Backups
     should show a backup taken today in `%APPDATA%\mmap\backups`.
   - Create a node with some note text, a tag and an attached image, quit, start again and
     confirm everything is still there.
   - Settings › Export and import: export the workspace to ZIP, import it again (the preview
     warns that it comes from this workspace), and check that the node now exists twice.
   - Uninstall from Windows Settings, Apps. Confirm the data folders below still exist.

   Note that an installed build uses the profile `%APPDATA%\mmap`, while `npm run dev` uses
   `%APPDATA%\mmap-dev`, so the two never share workspaces, settings or backups
   ([setup.md](../setup.md#development-builds-use-their-own-profile)).

6. **Signature check** (release builds only, after signing; see [Code signing](#code-signing)):

   ```powershell
   powershell -File apps/desktop/scripts/verify-signature.ps1
   ```

## Output locations

| Path                                                   | Contents                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `apps/desktop/out/`                                    | electron-vite bundles: `main/index.js`, `preload/index.cjs`, `renderer/`                 |
| `apps/desktop/release/win-unpacked/mmap.exe`           | Unpacked app, used by the smoke test                                                     |
| `apps/desktop/release/win-unpacked/resources/app.asar` | Application archive: `out/**` and `package.json` only; no `node_modules`, no source maps |
| `apps/desktop/release/mmap-setup-<version>-x64.exe`    | NSIS installer, e.g. `mmap-setup-0.1.0-x64.exe`                                          |
| `apps/desktop/release/*.blockmap`                      | Block map for future differential updates                                                |

Both `out/` and `release/` are git-ignored. The version in file names comes from
`apps/desktop/package.json`.

## Packaging configuration

`apps/desktop/electron-builder.yml`:

- `appId: app.mmap.desktop`, `productName: mmap`, executable `mmap.exe`.
- Target: NSIS, x64 only.
- `asar: true`; only `out/**/*` and `package.json` are included.
- `publish: null`: there is no update feed. Nothing is uploaded or checked online.
- NSIS: `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`,
  desktop and Start menu shortcuts, `deleteAppDataOnUninstall: false`, and the mmap icon for the
  installer, the uninstaller and the installer header (`installerIcon`, `uninstallerIcon`,
  `installerHeaderIcon`).
- `directories.buildResources: resources`. `icon: resources/icon.png` and
  `win.icon: resources/icon.ico` (see [App icon](#app-icon)).
- `win.signtoolOptions`: SHA-256 signatures with an RFC 3161 timestamp (see
  [Code signing](#code-signing)).

## App icon

The icon is drawn from `docs/mmap_icon.png`. After changing that image, regenerate the derived
files from the repository root and commit them:

```powershell
powershell -File apps/desktop/scripts/make-icons.ps1 -Root .
```

| Output                                               | Use                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/desktop/resources/icon.png`                    | 512 × 512; electron-builder's source icon and the window icon    |
| `apps/desktop/resources/icon.ico`                    | 16 to 256 px; the executable, taskbar, installer and uninstaller |
| `apps/desktop/src/renderer/src/assets/mmap-logo.png` | 96 × 96; the logo in the app's sidebar                           |

The script uses Windows' `System.Drawing`: it crops the source to a square around the drawing
(the source has a wide dark margin) and rounds the corners so the icon reads well at taskbar
sizes. The crop position is fixed in the script; adjust it if the source image changes layout.

## Code signing

A release must be Authenticode-signed ([ADR-0004](../adr/0004-installer-signing-and-updates.md)).
Signing is configured but not yet used, because no certificate is available.

**How signing works.** electron-builder signs `mmap.exe`, the other executables and the NSIS
installer during `npm run package` when these environment variables are set:

| Variable           | Value                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| `CSC_LINK`         | The code-signing certificate (`.pfx`/`.p12`): a file path or its base64 content |
| `CSC_KEY_PASSWORD` | The certificate's password                                                      |

`win.signtoolOptions` in `electron-builder.yml` asks for SHA-256 signatures and an RFC 3161
timestamp from `http://timestamp.digicert.com`, so signatures stay valid after the certificate
expires. Timestamping needs network access during packaging. Never commit the certificate or the
password; in CI they belong in repository secrets. Without the variables, packaging produces
unsigned builds as before.

**Signing a release.**

1. In a shell where `CSC_LINK` and `CSC_KEY_PASSWORD` are set, run `npm ci`, `npm run verify` and
   `npm run package`.
2. Run the signature check from the repository root:

   ```powershell
   powershell -File apps/desktop/scripts/verify-signature.ps1
   ```

   It checks `apps/desktop/release/mmap-setup-*.exe` and `release/win-unpacked/mmap.exe`, prints
   each file's signature status and signer, and fails unless every file has a `Valid` signature
   with a timestamp. `-Release <folder>` checks another release folder. On an unsigned build it
   prints `NotSigned` and fails; that is expected today.

3. Run `npm run smoke:packaged` on the signed build.

Still open: choosing and buying the certificate, its key storage (a hardware token or cloud
signing service may need a different configuration than `CSC_LINK`), and CI signing.

## Electron fuses

Fuses are switches compiled into the Electron binary at packaging time; they cannot be changed at
runtime. They close ways to turn the installed app into a general-purpose Node runtime or to run
modified code.

| Fuse                                    | Setting  | Effect                                                                    |
| --------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `RunAsNode`                             | Disabled | `ELECTRON_RUN_AS_NODE` cannot turn `mmap.exe` into a Node.js interpreter. |
| `EnableCookieEncryption`                | Enabled  | Chromium's cookie store is encrypted with OS facilities.                  |
| `EnableNodeOptionsEnvironmentVariable`  | Disabled | `NODE_OPTIONS` is ignored, so it cannot inject code or flags.             |
| `EnableNodeCliInspectArguments`         | Disabled | `--inspect` and similar flags cannot attach a debugger.                   |
| `EnableEmbeddedAsarIntegrityValidation` | Enabled  | The app archive is checked against a hash embedded in the executable.     |
| `OnlyLoadAppFromAsar`                   | Enabled  | The app code is loaded only from `app.asar`, not from a loose folder.     |
| `GrantFileProtocolExtraPrivileges`      | Disabled | `file://` gets no extra privileges; the UI uses `app://` instead.         |

`npx @electron/fuses read` also lists fuses not set in the configuration (for example
`LoadBrowserProcessSpecificV8Snapshot`, disabled). With the currently installed version of
`@electron/fuses`, one newer fuse prints as `undefined is Enabled` because the tool does not yet
know its name; this is expected and not a configuration error.

## Where user data lives, and uninstall

- The installer never owns user data. The NSIS uninstaller is configured with
  `deleteAppDataOnUninstall: false`, so uninstall and reinstall leave application data in place
  (PRD §5.1, acceptance criterion 17).
- Per-user data lives in Electron's profile, `%APPDATA%\mmap` (the folder name comes from
  `productName` in `apps/desktop/package.json`): `settings.json` (recent workspaces, attachment
  size limit, backup folder and retention), Chromium storage including unsaved-draft recovery
  copies, cache and the single-instance lock.
- Workspaces live in `%APPDATA%\mmap\workspaces\<name>` (the first one is `My Knowledge`) or in a
  folder the user chose ([ADR-0005](../adr/0005-workspace-location-and-supported-filesystems.md)).
  Each is a self-contained folder with its manifest, database, attachments and recovery folder.
  These are outside the install directory and are also preserved by uninstall.
- Backups live in `%APPDATA%\mmap\backups` or in a folder the user chose
  ([backup and restore runbook](backup-and-restore.md)), and are also preserved by uninstall.
- Deleting the app, a node or a workspace does not erase backups, exports or OS copies stored
  elsewhere (PRD §8); the [user guide](../user-guide.md#deleting-data-and-backups) says so.

## Updating an installation

There are no automatic updates yet (no update feed, `publish: null`;
[ADR-0004](../adr/0004-installer-signing-and-updates.md#amendment-2026-10-27-phase-5)). To update,
the user runs the newer installer over the existing installation; uninstalling first is not
needed. Workspaces, settings and backups are kept. The first time the newer version opens a
workspace whose database needs an upgrade, it writes a verified copy of the old database to
`<workspace>\recovery\` first; after the upgrade, older versions refuse that workspace as "too
new" and change nothing. Going back is described in the
[backup and restore runbook](backup-and-restore.md#if-an-upgrade-fails).

## Release checklist

Required by PRD §9 and ADR-0004. Any open item blocks a public release.

| Item                                                                                                                                                                                                                    | Status                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm ci && npm run verify` passes                                                                                                                                                                                       | Required for every release build                                                                           |
| `npm run smoke:packaged` passes all 17 checks, including the accessibility check                                                                                                                                        | Passes on the unsigned unpacked build (2026-10-27); run again on the signed release build                  |
| App, executable, installer and uninstaller icons                                                                                                                                                                        | Done ([App icon](#app-icon))                                                                               |
| Signing configured (`win.signtoolOptions`, `CSC_LINK`, `CSC_KEY_PASSWORD`) and `verify-signature.ps1`                                                                                                                   | Done ([Code signing](#code-signing))                                                                       |
| **Certificate obtained; installer and executables signed; `verify-signature.ps1` passes on the release build**                                                                                                          | **Open.** No certificate yet; current builds are unsigned.                                                 |
| **Verified updates:** electron-updater with signature verification, a `publish` feed, update checks visible in Settings and possible to turn off, no workspace content sent                                             | **Open.** No feed host chosen; updates are manual ([Updating an installation](#updating-an-installation)). |
| **Clean-machine verification:** on a clean Windows machine or VM, install, launch offline, upgrade from the previous version, restore a backup, and uninstall with workspaces and backups preserved; record the results | **Open.**                                                                                                  |
| **Reference-machine performance:** the PRD §9 targets with the installed build on the documented four-core, 16 GB, SSD computer; record the results                                                                     | **Open.** Only developer-machine numbers exist ([testing.md](../testing.md)).                              |
| **Manual accessibility pass:** keyboard-only and screen-reader check of the primary flows                                                                                                                               | **Open.** Only automated checks have run.                                                                  |
| Runbooks: packaging and signing (this page), [backup and restore](backup-and-restore.md)                                                                                                                                | Done; the update-publishing and rollback procedure waits for automatic updates.                            |
