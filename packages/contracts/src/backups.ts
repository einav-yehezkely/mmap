/**
 * Backup and restore contracts (PRD §9).
 *
 * Security: folders are chosen in native dialogs opened by the main process, never sent by the
 * renderer. Restoring the open workspace refers to a snapshot by its ID from the status list.
 */

import { z } from 'zod';

import { operationIdField } from './operations';

import { MAX_DAILY_SNAPSHOTS, MAX_WEEKLY_SNAPSHOTS } from '@mmap/domain';

import { workspaceStateSchema } from './workspace';

export const backupStatusSchema = z.strictObject({
  destination: z.string(),
  isDefaultDestination: z.boolean(),
  /** Backups on the workspace's own drive do not survive a failure of that drive. */
  sameDriveAsWorkspace: z.boolean(),
  /**
   * The sync program whose folder holds the backups (for example "OneDrive"), or null. Its copies
   * in the cloud survive a failure of this computer's drive.
   */
  cloudSyncProvider: z.string().nullable(),
  retention: z.strictObject({
    daily: z.number().int().nonnegative(),
    weekly: z.number().int().nonnegative(),
  }),
  running: z.boolean(),
  lastSuccessAt: z.string().nullable(),
  lastFailure: z.strictObject({ at: z.string(), message: z.string() }).nullable(),
  snapshots: z
    .array(
      z.strictObject({
        id: z.string(),
        createdAt: z.string(),
        attachmentCount: z.number().int().nonnegative(),
        missingAttachments: z.number().int().nonnegative(),
        databaseBytes: z.number().int().nonnegative(),
      }),
    )
    .readonly(),
});

export type BackupStatusDto = z.infer<typeof backupStatusSchema>;

const noRequest = z.strictObject({});

export const backupContracts = {
  getStatus: { request: noRequest, response: backupStatusSchema },
  createNow: { request: z.strictObject({ ...operationIdField }), response: backupStatusSchema },
  /** Native folder dialog; cancelling returns the unchanged status. */
  chooseDestination: { request: noRequest, response: backupStatusSchema },
  useDefaultDestination: { request: noRequest, response: backupStatusSchema },
  setRetention: {
    request: z.strictObject({
      daily: z.number().int().min(0).max(MAX_DAILY_SNAPSHOTS),
      weekly: z.number().int().min(0).max(MAX_WEEKLY_SNAPSHOTS),
    }),
    response: backupStatusSchema,
  },
  /** Replaces the open workspace's content with a snapshot (after a safety backup). */
  restore: {
    request: z.strictObject({ snapshotId: z.string().min(1).max(64), ...operationIdField }),
    response: z.strictObject({ state: workspaceStateSchema }),
  },
  /** Native folder dialog for a snapshot folder; restores it as a new workspace. */
  restoreFromFolder: {
    request: z.strictObject({ ...operationIdField }),
    response: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('cancelled') }),
      z.strictObject({ status: z.literal('restored'), state: workspaceStateSchema }),
    ]),
  },
} as const;
