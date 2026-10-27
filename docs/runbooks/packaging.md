# Runbook: build, package and smoke-test

How to produce a packaged Windows build of mmap, check it, and what is still missing before a
public release. The decisions behind this are in
[ADR-0004](../adr/0004-installer-signing-and-updates.md).

> **Current builds are unsigned and for internal testing only. Do not distribute them.**

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
   `Packaged smoke test passed.` The twelve checks, including first-run workspace creation, node
   operations and mind maps through the bridge, and opening a 200-item map in the real editor,
   are described in
   [testing.md](../testing.md#packaged-smoke-test).

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
   - Disconnect from the network and start mmap. On a machine without an earlier profile, the
     Library of a new `My Knowledge` workspace opens. Open Settings: the workspace location should
     be under `%APPDATA%\mmap\workspaces`, the version should have no "(development)" suffix, and
     "Full-text search (FTS5)" should read "Available".
   - Create a node with some note text, a tag and an attached image, quit, start again and
     confirm everything is still there.
   - Uninstall from Windows Settings, Apps. Confirm the data folders below still exist.

   Note that an installed build and `npm run dev` share the same profile and workspaces
   ([setup.md](../setup.md#development-data-is-your-real-profile)).

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
  desktop and Start menu shortcuts, `deleteAppDataOnUninstall: false`.
- `directories.buildResources: resources`. `apps/desktop/resources/` is currently empty, so the
  app uses Electron's default icon.

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
  size limit), Chromium storage including unsaved-draft recovery copies, cache and the
  single-instance lock.
- Workspaces live in `%APPDATA%\mmap\workspaces\<name>` (the first one is `My Knowledge`) or in a
  folder the user chose ([ADR-0005](../adr/0005-workspace-location-and-supported-filesystems.md)).
  Each is a self-contained folder with its manifest, database, attachments and recovery folder.
  These are outside the install directory and are also preserved by uninstall.
- Deleting the app does not erase backups or exports stored elsewhere; this must be stated in the
  user guide when those features exist (PRD §8).

## Before a public release (Phase 5 gates)

The following are required by PRD §9 and ADR-0004 and are not done. Any one of them missing
blocks release.

- **Code signing.** Authenticode-sign the installer and executables. Choose the certificate type
  and key storage, and configure signing in CI. Record the choices as an amendment to ADR-0004.
- **Verified updates.** Add electron-updater with signature verification, configure a `publish`
  feed, and add a visible Settings control to turn update checks off. Update checks must send no
  workspace content.
- **Clean-machine verification.** On a clean Windows machine: install, launch offline, upgrade
  from the previous version, recover, and uninstall with workspaces preserved. Record the results.
- **Runbook update.** Extend this page with the signing, update-publishing and rollback
  procedures (PRD §10.5).

Also recommended before release, though not a PRD gate: add the application icon and installer
resources to `apps/desktop/resources/`.
