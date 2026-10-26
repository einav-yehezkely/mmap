/**
 * `app:get-info` — runtime and storage diagnostics shown in Settings › About.
 *
 * Contains only versions and capability flags, never paths or user content, so it is safe to
 * include in an exported diagnostics bundle (PRD §8).
 */

import { z } from 'zod';

export const appInfoRequestSchema = z.undefined();

export const appInfoSchema = z.strictObject({
  appVersion: z.string(),
  isPackaged: z.boolean(),
  platform: z.string(),
  arch: z.string(),
  electronVersion: z.string(),
  chromeVersion: z.string(),
  nodeVersion: z.string(),
  storage: z.strictObject({
    sqliteVersion: z.string(),
    /** True when the bundled SQLite build supports FTS5 full-text search. */
    fts5Available: z.boolean(),
    /** Highest schema version this build can migrate to. */
    latestSchemaVersion: z.number().int().nonnegative(),
  }),
});

export type AppInfo = z.infer<typeof appInfoSchema>;
