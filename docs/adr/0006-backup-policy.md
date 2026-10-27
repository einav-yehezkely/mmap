# ADR-0006: Backup policy

- Status: Accepted
- Date: 2026-10-26

## Context

PRD §9 requires consistent backups using SQLite's backup mechanism plus verified attachments,
never a raw copy of a live database that ignores WAL. Backups run on first launch each day and
before migrations, with a default retention of seven daily and four weekly snapshots, a
configurable destination and retention, and a visible last-success status. Same-drive backups
do not protect against drive failure, so a separate-drive destination must be supported.
Restore must work offline, with a 15-minute target on the validation dataset (PRD §9: 10,000
nodes, 30,000 relationships, 100 maps) and recorded measured results. PRD §8 requires
documenting that deletion does not erase independent backups, exports, or OS snapshots. PRD §12
places backup/restore in Phase 5; PRD §14 requires the policy to be recorded before
implementation.

A workspace database runs in WAL mode (ADR-0005). Copying `mmap.sqlite` while the app is
running can produce a file missing recent commits or an inconsistent state.

## Decision

**Snapshot method.** Create each snapshot with the SQLite online backup API through
`node:sqlite` `backup()` (ADR-0002). Never copy the live database, WAL, or SHM files directly.
Copy attachments alongside and verify each copy by SHA-256 checksum against the value recorded
in the database. A snapshot is reported successful only after the database backup completes
and every attachment checksum matches.

**Schedule.** Take a snapshot on the first launch of each day and before every schema
migration.

**Retention.** Keep 7 daily and 4 weekly snapshots by default. Destination and retention are
configurable in Settings, which also shows the time and result of the last successful backup.

**Destination guidance.** The UI recommends a destination on a separate drive and states that
backups on the same drive do not protect against drive failure.

**Restore.** Restore works fully offline and is verified against the 15-minute target on the
validation dataset; measured results are recorded.

**Deletion.** User documentation states that deleting a node or workspace does not erase
independent backups, exports, or OS snapshots.

**Phasing.** The full backup feature (daily schedule, retention, settings, restore UI) is
implemented in Phase 5. However, from Phase 1 onward every schema migration must take a
pre-migration backup with the same online backup API before changing the schema (see ADR-0007).
A migration that cannot take its backup must not run.

## Consequences

- Backups are consistent even while the app is running, because the backup API reads a
  transactionally consistent view.
- Checksum verification costs time proportional to attachment size; it runs off the renderer
  (PRD §7.2) and may take noticeable time for large attachment sets.
- Disk usage grows with retention; the default of 11 snapshots may be significant for large
  attachment sets. Assumption: attachment storage across snapshots is a full copy per snapshot
  unless Phase 5 introduces deduplication, which would need its own ADR.
- Release is blocked (Phase 5) if any of these is missing: backup on first daily launch,
  pre-migration backup, retention, visible last-success status, separate-drive support, offline
  restore of all entities and attachment checksums (PRD §13 criterion 17), or a recorded
  restore measurement on the validation dataset.
- Backups are a local safety net, not sync; transfer between machines uses export/import or
  backup restore.

## Alternatives considered

- **Raw file copy of `mmap.sqlite`.** Simple but unsafe with WAL; explicitly forbidden by
  PRD §9. Rejected.
- **`VACUUM INTO`.** Produces a consistent compacted copy, but the PRD names SQLite's backup
  mechanism and using one method keeps restore testing simple. Not used.
- **Checkpoint then copy while blocking writes.** Pauses the app and is easy to get wrong.
  Rejected.
- **Rely on OS tools (File History, System Restore).** Not under app control, no consistency
  guarantee for a live WAL database, no visible status. Rejected as the primary mechanism.
- **Cloud backup.** Outside version 1 scope (PRD §3). Rejected.

## Implementation (Phase 5)

Added 2026-10-27, branch `phase-5-portability`. Code:
`apps/desktop/src/main/backups/snapshot-store.ts`, `apps/desktop/src/main/backups/backup-service.ts`,
`packages/domain/src/backups/retention.ts`, `packages/storage-sqlite/src/backup.ts`, the restore
steps in `apps/desktop/src/main/workspaces/workspace-manager.ts`. Details:
[architecture.md](../architecture.md#backups-and-restore); procedures:
[backup and restore runbook](../runbooks/backup-and-restore.md).

**Layout and deduplication.** Snapshots of a workspace live under
`<destination>/<workspace ID>/snapshots/<UTC time>/` (`backup.json` manifest and `mmap.sqlite`).
Attachment bytes are stored once per content in `<destination>/<workspace ID>/files/<ab>/<sha256>`
and shared by every snapshot that needs them, so a snapshot costs roughly one database copy plus
new or changed attachments. This replaces the "full copy per snapshot" assumption under
Consequences; it is recorded here rather than in a new ADR because it changes only the storage
layout, not the policy. Pruning deletes attachment files that no remaining snapshot uses.

**Snapshot method.** As decided: the online backup API (through the workspace's writer
connection, so concurrent saves are part of the image and the copy never restarts), then
`PRAGMA integrity_check` on the copy. The attachment list is read from the copied database, so a
snapshot's files always match its database. A snapshot is written under a temporary name and
renamed only when complete; a second snapshot in the same millisecond gets the next free
millisecond as its name.

**Deviation: missing attachments do not fail a snapshot.** An attachment whose file is missing,
or no longer matches its recorded checksum, is not stored and is counted in the manifest's
`missingAttachments`; the snapshot still succeeds and Settings shows the count. Failing the whole
backup would leave the user with no recent backup at all because of one file that mmap cannot
recover anyway. Every file that is stored has been verified against its checksum.

**Schedule.** The snapshot is taken on the first opening of a workspace each local day (calendar
day in the workspace timezone), with an hourly check while the app runs, so a session left open
overnight still gets its daily backup; Settings also has **Back up now**. Only the open workspace
is backed up: a workspace that is not opened on a given day gets no snapshot that day, which is
correct because it did not change. Pre-migration backups to `<workspace>/recovery` are unchanged
(ADR-0007).

**Retention.** Default 7 daily and 4 weekly, configurable up to 60 and 104. Days and ISO weeks
are counted in the workspace timezone; the newest snapshot of each kept period is kept, and the
newest snapshot overall is never deleted, even with a retention of zero. Partial folders older
than a day are removed when pruning.

**Destination and status.** Default `<userData>/backups` (`%APPDATA%\mmap\backups`), or any folder
chosen in a native dialog. Settings shows the last success (the newest snapshot on disk), the last
failure (kept in memory until the next success or restart), and a warning when the destination is
on the same volume as the workspace. Network folders are not refused as destinations (workspaces
on network shares are).

**Restore.** Every byte is verified before a restored folder is used (manifest schema, database
checksum and integrity, workspace identity, every attachment checksum, generated-form stored
paths). Restoring the open workspace takes a safety backup of the current state first, swaps the
folders, opens the restored copy (running migrations if it is older) and moves the old folder to
the Recycle Bin; any failure puts the original back (`RESTORE_FAILED`). A backup folder can also be
restored as a new workspace "`<name> (restored)`", for a new computer or a lost drive; restoring
the open workspace's own backup that way is refused.

**Measured.** On the validation dataset (10,000 nodes, 30,000 relationships, 100 maps plus one of
500 placements, 10,000 timeline events, 50 attachments of 200 KB): backup 1.6 s, restore 2.7 s
including the safety backup, against the 15-minute target (`portability.benchmark.test.ts`,
developer machine and system Node; the reference-machine measurement is still open).

**Release-blocking items from Consequences.** Done: backup on first daily opening, pre-migration
backup, retention, visible last-success status, separate-drive support, offline restore of all
entities with attachment checksums, a recorded restore measurement. Still open: the measurement on
the reference machine with the installed build.
