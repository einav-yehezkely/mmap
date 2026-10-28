# Runbook: backup and restore

How mmap backs up a workspace, where the backups are, how to change where they go, and how to
restore: the open workspace from one of its backups, or a lost workspace on another drive or
computer. The policy behind this is in [ADR-0006](../adr/0006-backup-policy.md); the code is
described in [architecture.md](../architecture.md#backups-and-restore). End-user wording of the
same steps is in the [user guide](../user-guide.md#backups).

Backups work fully offline and need no account. They are a local safety net, not sync: to move a
workspace to another computer, use a backup folder (below) or the ZIP export
([user guide](../user-guide.md#export-and-import)).

## What is backed up, and when

- **Daily backup.** The first time a workspace is opened on a calendar day (in the workspace's
  timezone), mmap takes a backup in the background. While the app runs it checks again every
  hour, so a session left open overnight still gets the next day's backup. Only the open
  workspace is backed up; a workspace that is not opened on a day gets no backup that day.
- **Back up now.** Settings › Backups › **Back up now** takes one immediately.
- **Before a restore.** Restoring the open workspace first backs up its current state, so the
  restore can be undone by restoring that backup.
- **Before a database upgrade.** Separately, when a newer mmap version upgrades a workspace's
  database, a verified copy of the old database is written to `<workspace>\recovery\` as
  `pre-migration-v<from>-to-v<to>-<timestamp>.sqlite`. These copies are not listed in Settings and
  are not pruned; see [If an upgrade fails](#if-an-upgrade-fails).

Each backup (a **snapshot**) contains a consistent copy of the database, made with SQLite's
online backup API while the app keeps running, and every attachment file. Locks, logs, machine
settings and the `recovery` folder are not part of it.

## Where backups are

The default backup folder is `%APPDATA%\mmap\backups` (usually
`C:\Users\<you>\AppData\Roaming\mmap\backups`). Settings › Backups shows the folder in use.
Inside it:

```
<backup folder>\
  <workspace ID>\                       one folder per workspace
    snapshots\
      2026-10-27T09-15-00-123Z\         one folder per snapshot, named by its UTC time
        backup.json                     what the snapshot contains, with checksums
        mmap.sqlite                     the database copy
    files\<ab>\<sha256>                 attachment files, stored once and shared by snapshots
```

The workspace ID is the `workspaceId` in the workspace's `mmap-workspace.json`. A folder whose
name starts with `.partial-` is a backup that was interrupted; it is never offered for restore,
and pruning deletes it after a day. Do not edit or rename anything inside the backup folder: a
snapshot whose files do not match `backup.json` is refused on restore.

**How many are kept.** By default the newest backup of each of the last 7 days that have one, and
of each of the last 4 weeks, and always the newest backup. Change the numbers in Settings ›
Backups › **How many backups to keep** (0–60 daily, 0–104 weekly) and click **Save**; older
backups are deleted at once, and attachment files that no remaining backup uses are removed.

## Checking that backups work

Settings › Backups shows:

- **Last backup**: the time of the newest snapshot in the backup folder, or "No backup yet."
- **The last backup failed (…)** with a reason (disk full, no permission, folder or drive not
  available), when the most recent attempt since mmap started failed. The Home page shows "The
  last backup failed — check Settings" in the same case.
- **Backups of this workspace**: every snapshot with its size and number of attachments. "(N
  missing at backup time)" means N attachment files were missing from the workspace folder, or
  had been changed outside mmap, when the snapshot was taken; they are not in that snapshot.
- A warning when the backup folder is on the same drive as the workspace.

To test a restore without touching the workspace, use
[Restore from a backup folder](#restore-after-losing-the-workspace-or-on-a-new-computer) on
another computer, or under another Windows user, and open the restored copy.

## Changing the backup folder

Backups on the same drive as the workspace do not survive a failure of that drive, and the
default folder is on the same drive as the default workspace folder. To protect against a drive
failure:

1. Connect the other drive (for example an external disk).
2. Settings › Backups › **Change folder…**, and choose a folder on that drive.
3. Click **Back up now** and check that **Last backup** shows the current time.

The setting is stored for this computer only (in `%APPDATA%\mmap\settings.json`). Backups already
in the old folder stay there; they are not moved. **Use the default folder** switches back.

If the chosen drive is disconnected, backups fail with "the backup folder or drive is not
available" until it is connected again. Network folders work: SQLite never writes there (the
database copy is made and checked on this computer, then copied and verified by checksum). Folders
synced by OneDrive, Dropbox and similar programs work too and are the recommended way to keep a
copy off the computer: a snapshot is complete before it gets its final name and never changes
afterwards, restore verifies every file, and shared attachment files are not pruned while any
snapshot cannot be read (for example an online-only file while offline). Mark the folder "Always
keep on this device" so backups can be listed and restored offline.

## What is verified

When a backup is taken:

- The database copy passes SQLite's `integrity_check`.
- The list of attachments is read from the database copy, so the files always match it, and each
  file is checked against its SHA-256 before it is stored.
- A snapshot appears under its final name only when it is complete.

When a backup is restored, before anything in the workspace changes:

- `backup.json` has the expected format, and the backup is not from a newer mmap version.
- The database file matches its recorded SHA-256, passes `integrity_check`, and belongs to the
  workspace named in `backup.json`.
- Every attachment file matches its SHA-256.
- Every stored attachment path has the form mmap generates, so a tampered `backup.json` cannot
  write outside the restored folder.

If any check fails, the restore stops with "The backup database is damaged", "A file in the backup
does not match its checksum" or a similar message, and the workspace is unchanged. Try an older
snapshot.

## Restore the open workspace

Use this to go back to an earlier state of the workspace that is open.

1. Settings › Backups › **Backups of this workspace**, find the backup by its time, and click
   **Restore…**.
2. Confirm **Restore**. Changes made after that backup will no longer be in the workspace.

What mmap does:

1. Builds and verifies the restored workspace in a new folder next to the workspace folder, while
   the workspace stays open.
2. Backs up the current state (a new entry in the list), so you can return to it.
3. Closes the workspace, moves its folder aside, moves the restored folder into its place and
   opens it. If the backup is from an older mmap version, the database is upgraded as usual, with
   a pre-migration copy in `recovery\`.
4. Moves the old folder to the Recycle Bin, and reloads the window.

If step 3 fails (for example because another program has a file in the workspace folder open),
the original folder is put back and opened again, and the message says what went wrong. Close the
other program and try again. If only step 4 fails, the restore has worked and a folder named
`<workspace>.before-restore-<id>` is left next to the workspace; delete it yourself when you no
longer need it.

## Restore after losing the workspace or on a new computer

Use this when the workspace folder is gone (deleted, drive failed) or you are setting up another
computer. You need the backup folder, for example on an external disk.

1. Install mmap and start it. A new `My Knowledge` workspace opens on a new computer; that is
   fine, the backup is restored next to it.
2. Settings › Backups › **Restore from a backup folder…**.
3. In the folder dialog, open `<backup folder>\<workspace ID>\snapshots\` and choose one snapshot
   folder (named by its time, for example `2026-10-27T09-15-00-123Z`). The newest one is
   normally the right choice. If there are several workspace ID folders, `backup.json` in a
   snapshot names its workspace (`workspaceName`).
4. mmap verifies the backup, restores it as a new workspace named `<name> (restored)` in
   `%APPDATA%\mmap\workspaces\`, opens it and reloads the window.

The restored workspace keeps its original workspace ID, so its next backups go into the same
`<workspace ID>` folder as before (when the backup folder setting points there). mmap refuses this
kind of restore for a backup of the workspace that is currently open, because two folders would
then claim the same workspace; use [Restore the open workspace](#restore-the-open-workspace)
instead. To keep the restored workspace somewhere else, use Settings › Workspace › **Move
workspace…** afterwards.

## If an upgrade fails

If a newer mmap cannot upgrade a workspace, it reports the workspace as damaged and opens nothing.
Each upgrade step runs in its own transaction, so the database is left at the last step that
completed, and the copy in `<workspace>\recovery\` holds the database exactly as it was before the
first step. mmap has no button to restore that copy. To go back to the previous mmap version by
hand:

1. Quit mmap and copy the whole workspace folder somewhere safe.
2. In the workspace folder, rename `mmap.sqlite` (for example to `mmap.sqlite.failed`), delete
   `mmap.sqlite-wal` and `mmap.sqlite-shm` if they exist, and copy the newest
   `recovery\pre-migration-…sqlite` to `mmap.sqlite`.
3. Open the workspace with the mmap version that last used it.

Alternatively, restore a snapshot taken before the upgrade, with that version. A snapshot made by
a newer mmap cannot be restored by an older one ("Update mmap to restore it").

## Restore time

Measured on 2026-10-27 with `portability.benchmark.test.ts` ([testing.md](../testing.md#portability-benchmark))
on the PRD §9 validation dataset (10,000 nodes, 30,000 relationships, 100 maps with 50 placements
and one with 500, 10,000 timeline events, 50 attachments of 200 KB), on a developer machine with
system Node:

| Operation                                         | Time  |
| ------------------------------------------------- | ----- |
| Backup                                            | 1.6 s |
| Restore of the open workspace, with safety backup | 2.7 s |

The PRD target is 15 minutes. The measurement on the documented reference machine (four cores,
16 GB, SSD) with the installed build is still open. Restore time grows with the database size and
the total size of attachment files, which are copied and hashed.

## Deleting data does not delete backups

Deleting a node, or moving a workspace to the Recycle Bin, does not change existing backups,
exports or operating-system copies (File History, System Restore, copies you made yourself). The
deleted data stays in snapshots until they are pruned by the retention rules. Uninstalling mmap
leaves the backup folder in place. To remove backups, delete the workspace's folder inside the
backup folder by hand.
