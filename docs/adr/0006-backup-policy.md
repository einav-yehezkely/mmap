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
