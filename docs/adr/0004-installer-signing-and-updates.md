# ADR-0004: Installer, code signing, and updates

- Status: Accepted
- Date: 2026-10-26

## Context

PRD §3 scopes version 1 to Windows 10/11 x64 with no separately installed runtime. PRD §9
requires a signed Windows installer and a documented update and uninstall flow, verified on a
clean machine for install, offline launch, upgrade, recovery, and data preservation. PRD §8
requires update checks that are visible and configurable, send no content, and verify signed
packages. PRD §5.1 and §13 criterion 17 require updates and uninstall to preserve workspaces by
default. PRD §14 asks for the installer/signing/update approach to be recorded before
implementation. PRD §12 places the signed installer and updates in Phase 5.

Phase 0 must already produce a packaged build so that native dependencies, migrations, and
offline launch are tested in the installed form (PRD §7.1, §11), but a code-signing
certificate and update hosting are not yet available.

## Decision

**Packaging.** Use electron-builder to produce an NSIS installer for Windows x64.

**Phase 0 to Phase 4: unsigned builds.** Development and CI builds are unsigned. They are for
internal testing only and must not be distributed as releases. CI builds the installer and runs
the packaged smoke test (`--smoke-test`) on every change.

**Phase 5 release gate: signing and verified updates.** Before the first release:

- Sign the installer and the application executables with an Authenticode certificate.
- Ship updates through electron-updater with signature verification enabled, so an update is
  installed only if its signature matches the expected publisher.
- Update checks are visible in Settings, can be turned off, and send no workspace content. A
  check transmits only what is needed to find a newer version.
- Document the update and uninstall flow in the packaging/signing/update runbook (PRD §10).

Any of the following blocks release: unsigned installer, update path without signature
verification, update checks that cannot be seen or disabled, or a failed clean-machine test of
install, offline launch, upgrade, and uninstall with data preserved.

**Data preservation.** Workspaces live outside the install directory (ADR-0005), so the
installer never owns user data. Uninstall and update must leave workspaces in place by
default. Assumption: if an option to remove user data at uninstall is ever offered, it will be
off by default and will name the folders affected, consistent with PRD §5.1 deletion rules.

## Consequences

- Packaging problems surface from Phase 0 instead of at release time.
- Unsigned Phase 0-4 builds trigger Windows SmartScreen warnings; testers must expect this.
- Phase 5 owns acquiring and storing the certificate, CI signing configuration, choosing the
  update feed host, and the clean-machine verification. These are open work items, not
  decided here.
- Assumption: the update feed host and certificate type (for example OV or EV, cloud-hosted
  key) will be chosen in Phase 5 and recorded as an amendment to this ADR.
- Keeping user data out of the install directory makes uninstall and update simple and safe.
- Other platforms need their own packaging, signing, filesystem, and restore checks (PRD §9).

## Alternatives considered

- **Sign from Phase 0.** Ideal, but blocked on certificate procurement; delaying foundation
  work for it gives no functional benefit to internal builds. Rejected.
- **MSI or MSIX installer.** MSIX imposes a container model that affects application data
  paths; MSI tooling is less integrated with electron-builder and electron-updater. Rejected.
- **Squirrel.Windows.** Older Electron installer path with weaker per-machine options and less
  active maintenance. Rejected.
- **Portable ZIP without installer.** No update path or Start menu integration; PRD §9 requires
  an installer. Rejected.
- **No auto-update, manual download only.** Simpler, but PRD §3 includes updates in version 1
  and users would run unpatched builds. Rejected.

## Amendment (2026-10-27, Phase 5)

**Done: signing configuration and release check.**

- `apps/desktop/electron-builder.yml` sets `win.signtoolOptions`: SHA-256 signatures
  (`signingHashAlgorithms: [sha256]`) with an RFC 3161 timestamp from
  `http://timestamp.digicert.com`, so signatures stay valid after the certificate expires.
  electron-builder signs the executables and the installer when a certificate is supplied
  through the environment variables `CSC_LINK` (the certificate file or its base64 content) and
  `CSC_KEY_PASSWORD`. Nothing secret is committed. Without these variables builds stay unsigned.
- `apps/desktop/scripts/verify-signature.ps1` is the release check: it fails unless both
  `release/mmap-setup-*.exe` and `release/win-unpacked/mmap.exe` have a `Valid` Authenticode
  signature with a timestamp.
- The executable, installer and uninstaller carry the mmap icon (`resources/icon.ico`).
- Procedure: [packaging runbook](../runbooks/packaging.md#code-signing).

**Still open.**

- **Certificate.** None is available, so every current build is unsigned, the check fails on it,
  and release stays blocked. The certificate type (for example OV or EV) and key storage (file,
  hardware token or cloud-hosted key) are still to be chosen. Assumption: a key that cannot be
  exported as a file (hardware token, cloud signing service) will need a different signing
  configuration than `CSC_LINK`; record it here when chosen.
- **Update feed host and electron-updater.** Not implemented, because no host for the update feed
  has been chosen; `publish` stays `null` and the app makes no update checks. The requirements
  above (signature verification, checks visible in Settings and possible to turn off, no workspace
  content sent) still apply when it is added.
- **Clean-machine verification** of install, offline launch, upgrade and uninstall with data
  preserved has not been done.

**Until then, updates are manual.** A user installs a newer version by running its installer over
the existing installation. Workspaces (under `%APPDATA%\mmap\workspaces` or a chosen folder),
`settings.json` and backups (`%APPDATA%\mmap\backups` by default) are outside the install
directory and are kept, because `deleteAppDataOnUninstall` is `false`. The first opening of an
older workspace by a newer build takes a pre-migration backup before upgrading it (ADR-0007).
