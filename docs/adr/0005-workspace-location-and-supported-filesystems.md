# ADR-0005: Workspace location and supported filesystems

- Status: Accepted
- Date: 2026-10-26

## Context

PRD §5.1 requires a workspace folder containing a version manifest, a SQLite database, a
managed attachments directory, and recovery metadata. The default location is a dedicated mmap
folder under OS application data; users may choose other local folders. Network shares and live
cloud-sync folders are unsupported, and backup/export is the transfer mechanism. The app uses
one writer coordinator and a per-workspace process lock with safe stale-lock recovery, and must
not silently replace a missing folder or drive with an empty workspace. PRD §7.3 requires WAL on
supported local disks. PRD §14 requires the workspace location and supported filesystems to be
recorded before implementation.

SQLite in WAL mode relies on shared memory (`-shm` file) and byte-range file locking that
behave correctly only on local filesystems. Network filesystems and cloud-sync clients can
break those locks or upload a database file while its WAL is only partly checkpointed, which
can corrupt the workspace.

## Decision

**Default location.** `%APPDATA%\mmap\workspaces\<name>`, computed as Electron
`app.getPath('appData')` joined with `mmap\workspaces\<name>`. Users may choose another local
folder through a native folder dialog. The app remembers the last opened workspace and shows the
actual path and an Open Folder action in Settings.

**Workspace folder layout.**

| Entry                            | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `mmap-workspace.json`            | Version manifest (format and schema version, workspace identity) |
| `mmap.sqlite` (+ `-wal`, `-shm`) | SQLite database in WAL mode                                      |
| `attachments/`                   | Managed attachment copies with generated names                   |
| `recovery/`                      | Recovery metadata and drafts                                     |
| `.lock`                          | Process lock for the single writer                               |

**Supported filesystems.** Local NTFS or ReFS volumes on fixed or removable drives.

**Unsupported.** Network shares (UNC paths and mapped network drives) and folders managed by
live cloud-sync clients (OneDrive, Dropbox, Google Drive, iCloud). When creating or opening a
workspace the app detects these where feasible (for example UNC paths, network drive type, or a
path inside a known sync-client root) and shows a warning that recommends a local folder and
backup/export for transfer. Assumption: detection is best-effort; it may block creation or only
warn, to be settled in Phase 1, but it never silently proceeds without telling the user.

**Missing location.** If the folder or drive is absent, report it and offer to locate it; never
create an empty workspace in its place.

## Consequences

- Workspaces are outside the install directory, so updates and uninstall do not touch them
  (ADR-0004, PRD §13 criterion 17).
- `%APPDATA%` is per Windows user, matching PRD §8 (use current OS-user permissions).
- Users who keep files in a synced Documents folder must pick a different location or accept a
  warning; this is a deliberate trade for database integrity and must be explained in the user
  guide.
- Removable drives can disappear while open; Phase 1 must handle missing-drive errors without
  discarding edits (PRD §9).
- Phase 1 owns the manifest, lock with stale-lock recovery, filesystem detection, and verified
  move of a closed, checkpointed workspace. Backups are covered by ADR-0006.

## Alternatives considered

- **Default under Documents.** More visible to users, but Documents is often redirected to
  OneDrive on Windows 11, which is exactly the unsupported case. Rejected.
- **`%LOCALAPPDATA%`.** Also local and per-user; `appData` (Roaming) was chosen to match
  Electron's standard `userData` parent. Assumption: roaming profiles are rare for the target
  users; if they matter, revisit, since a roaming profile is a form of sync.
- **Support network and cloud folders with rollback journal mode.** Still relies on file
  locking that these filesystems do not guarantee. Rejected.
- **Single global database for all workspaces.** Breaks workspace isolation and portability
  (PRD §5.1, §13 criterion 2). Rejected.
