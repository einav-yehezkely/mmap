/**
 * Local recovery copies of unsaved node drafts (PRD §9: "retain recoverable drafts on
 * failure/crash").
 *
 * Stored in the renderer's localStorage, which Electron keeps in the user's profile folder
 * (machine-specific, never exported). A copy exists only while a draft is unsaved and is removed
 * as soon as the save is confirmed. Storage failures are ignored: recovery is a safety net, and
 * failing to write it must not block editing.
 */

import type { NodeFields } from './node-draft-saver';

export interface RecoveredDraft {
  readonly fields: NodeFields;
  readonly baseRevision: number;
  readonly savedAt: string;
}

function key(workspaceId: string, nodeId: string): string {
  return `mmap.draft.${workspaceId}.${nodeId}`;
}

export function writeRecoveredDraft(
  workspaceId: string,
  nodeId: string,
  draft: { fields: NodeFields; baseRevision: number } | null,
): void {
  try {
    if (draft === null) {
      localStorage.removeItem(key(workspaceId, nodeId));
    } else {
      const value: RecoveredDraft = { ...draft, savedAt: new Date().toISOString() };
      localStorage.setItem(key(workspaceId, nodeId), JSON.stringify(value));
    }
  } catch {
    // Quota exceeded or storage unavailable: editing continues without a recovery copy.
  }
}

export function readRecoveredDraft(workspaceId: string, nodeId: string): RecoveredDraft | null {
  try {
    const raw = localStorage.getItem(key(workspaceId, nodeId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<RecoveredDraft>;
    if (
      typeof parsed.baseRevision === 'number' &&
      typeof parsed.savedAt === 'string' &&
      typeof parsed.fields?.title === 'string'
    ) {
      return parsed as RecoveredDraft;
    }
  } catch {
    // A damaged entry is treated as absent.
  }
  return null;
}
