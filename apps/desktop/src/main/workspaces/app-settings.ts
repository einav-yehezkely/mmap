/**
 * Machine-specific application settings stored in Electron's `userData` folder (not in any
 * workspace, and never exported: PRD §5.11 excludes machine-specific settings from exports).
 *
 * Holds the last opened workspace and a short list of recent workspaces (PRD §5.1: "remember the
 * last location"). A damaged settings file must never stop the app from starting: it is moved
 * aside for inspection and defaults are used.
 */

import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_BACKUP_RETENTION, MAX_DAILY_SNAPSHOTS, MAX_WEEKLY_SNAPSHOTS } from '@mmap/domain';
import { z } from 'zod';

import { writeFileAtomically } from './workspace-folder';

export const SETTINGS_FILE_NAME = 'settings.json';
export const MAX_RECENT_WORKSPACES = 10;

const recentWorkspaceSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  folderPath: z.string(),
  lastOpenedAt: z.string(),
});

/** PRD §5.10: 20 MB per attachment by default, configurable on this computer. */
export const DEFAULT_MAX_ATTACHMENT_MEGABYTES = 20;

/**
 * Where and how many backups are kept (PRD §9: "configurable destination/retention"). A null
 * destination means the default folder in the app's data folder.
 */
const backupSettingsSchema = z.object({
  destination: z.string().max(4_096).nullable(),
  daily: z.number().int().min(0).max(MAX_DAILY_SNAPSHOTS),
  weekly: z.number().int().min(0).max(MAX_WEEKLY_SNAPSHOTS),
});

export type BackupSettings = z.infer<typeof backupSettingsSchema>;

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  destination: null,
  ...DEFAULT_BACKUP_RETENTION,
};

const settingsSchema = z.object({
  version: z.literal(1),
  lastWorkspacePath: z.string().nullable(),
  recentWorkspaces: z.array(recentWorkspaceSchema).max(MAX_RECENT_WORKSPACES),
  // Defaulted so settings files written before this preference existed stay valid.
  maxAttachmentMegabytes: z
    .number()
    .int()
    .min(1)
    .max(1_024)
    .default(DEFAULT_MAX_ATTACHMENT_MEGABYTES),
  backups: backupSettingsSchema.default(DEFAULT_BACKUP_SETTINGS),
});

export type AppSettings = z.infer<typeof settingsSchema>;
export type RecentWorkspaceEntry = z.infer<typeof recentWorkspaceSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  lastWorkspacePath: null,
  recentWorkspaces: [],
  maxAttachmentMegabytes: DEFAULT_MAX_ATTACHMENT_MEGABYTES,
  backups: DEFAULT_BACKUP_SETTINGS,
};

export interface SettingsStore {
  load(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}

export function createFileSettingsStore(userDataDirectory: string): SettingsStore {
  const path = join(userDataDirectory, SETTINGS_FILE_NAME);

  return {
    async load() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        return DEFAULT_SETTINGS;
      }
      try {
        const parsed = settingsSchema.safeParse(JSON.parse(text));
        if (parsed.success) {
          return parsed.data;
        }
      } catch {
        // Falls through to quarantine below.
      }
      await rename(path, `${path}.damaged-${Date.now()}`).catch(() => undefined);
      return DEFAULT_SETTINGS;
    },

    save: (settings) =>
      writeFileAtomically(path, `${JSON.stringify(settingsSchema.parse(settings), null, 2)}\n`),
  };
}

/**
 * Returns settings with `entry` moved to the front of the recent list and recorded as the last
 * workspace. Entries are matched by folder path (case-insensitive on Windows paths) and by ID.
 */
export function rememberWorkspace(settings: AppSettings, entry: RecentWorkspaceEntry): AppSettings {
  const others = settings.recentWorkspaces.filter(
    (recent) =>
      recent.workspaceId !== entry.workspaceId &&
      recent.folderPath.toLowerCase() !== entry.folderPath.toLowerCase(),
  );
  return {
    ...settings,
    lastWorkspacePath: entry.folderPath,
    recentWorkspaces: [entry, ...others].slice(0, MAX_RECENT_WORKSPACES),
  };
}

export function forgetWorkspace(settings: AppSettings, workspaceId: string): AppSettings {
  const removed = settings.recentWorkspaces.find((recent) => recent.workspaceId === workspaceId);
  return {
    ...settings,
    lastWorkspacePath:
      removed !== undefined && settings.lastWorkspacePath === removed.folderPath
        ? null
        : settings.lastWorkspacePath,
    recentWorkspaces: settings.recentWorkspaces.filter(
      (recent) => recent.workspaceId !== workspaceId,
    ),
  };
}
