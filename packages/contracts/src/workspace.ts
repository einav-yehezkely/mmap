/**
 * Workspace lifecycle contracts (PRD §5.1).
 *
 * Security: the renderer never sends filesystem paths. Choosing a folder happens in a native
 * dialog opened by the main process (PRD §8: "Native dialogs authorize selected import/export
 * locations only"), and recent workspaces are referenced by ID. Paths are only sent *to* the
 * renderer for display (Settings shows the workspace location, PRD §5.1).
 */

import { z } from 'zod';

export const WORKSPACE_ERROR_CODES = [
  /** The folder (or drive) no longer exists. */
  'WORKSPACE_MISSING',
  /** The folder is not an mmap workspace. */
  'WORKSPACE_INVALID',
  /** The workspace was written by a newer mmap version. */
  'WORKSPACE_TOO_NEW',
  /** Another process or computer has the workspace open. */
  'WORKSPACE_LOCKED',
  /** A new workspace was requested in a folder that already has files. */
  'WORKSPACE_FOLDER_NOT_EMPTY',
  /** Network shares are not supported (ADR-0005). */
  'WORKSPACE_UNSUPPORTED_LOCATION',
  /** Files inside the workspace are damaged or inconsistent; recovery is required. */
  'WORKSPACE_DAMAGED',
] as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

const workspaceIdSchema = z.uuid();

export const workspaceSummarySchema = z.strictObject({
  id: workspaceIdSchema,
  name: z.string(),
  folderPath: z.string(),
  timezone: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  /** Set when the folder looks like a cloud-sync folder (heuristic, ADR-0005). */
  cloudSyncProvider: z.string().nullable(),
});

export const workspaceStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('open'), workspace: workspaceSummarySchema }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(WORKSPACE_ERROR_CODES),
    message: z.string(),
    lastWorkspace: z.strictObject({ name: z.string(), folderPath: z.string() }).nullable(),
  }),
  z.strictObject({ status: z.literal('none') }),
]);

export const recentWorkspaceSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  name: z.string(),
  folderPath: z.string(),
  lastOpenedAt: z.string(),
  isAvailable: z.boolean(),
  isCurrent: z.boolean(),
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export type RecentWorkspace = z.infer<typeof recentWorkspaceSchema>;

/** Result of an action that may open a native dialog the user can cancel. */
export const dialogActionResultSchema = z.strictObject({
  cancelled: z.boolean(),
  state: workspaceStateSchema,
});

export const recentWorkspaceListSchema = z.strictObject({
  items: z.array(recentWorkspaceSchema),
});

const workspaceNameInput = z.string().max(200);

export const workspaceContracts = {
  getState: { request: z.undefined(), response: workspaceStateSchema },
  listRecent: { request: z.undefined(), response: recentWorkspaceListSchema },
  create: {
    request: z.strictObject({
      name: workspaceNameInput,
      location: z.enum(['default', 'choose-folder']),
    }),
    response: dialogActionResultSchema,
  },
  openFolder: { request: z.undefined(), response: dialogActionResultSchema },
  openRecent: {
    request: z.strictObject({ workspaceId: workspaceIdSchema }),
    response: workspaceStateSchema,
  },
  forgetRecent: {
    request: z.strictObject({ workspaceId: workspaceIdSchema }),
    response: recentWorkspaceListSchema,
  },
  rename: {
    request: z.strictObject({ name: workspaceNameInput }),
    response: workspaceStateSchema,
  },
  revealFolder: {
    request: z.undefined(),
    response: z.strictObject({ revealed: z.boolean() }),
  },
} as const;
