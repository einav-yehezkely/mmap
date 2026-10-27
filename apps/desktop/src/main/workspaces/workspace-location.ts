/**
 * Checks whether a folder is a supported place for a workspace (PRD §5.1, ADR-0005).
 *
 * SQLite's WAL mode and file locking are unreliable on network shares and inside folders that a
 * sync client rewrites in the background, which can corrupt a live database.
 * - Network (UNC) paths are rejected outright.
 * - Folders inside well-known cloud-sync roots are allowed but flagged with a warning, because
 *   detection is a name-based heuristic and can be wrong; the UI tells the user to move the
 *   workspace and use backups/export for transfer instead.
 * Mapped network drive letters cannot be detected without native code; for those, the WAL check
 * in `openDatabase` is the remaining safeguard.
 */

export type LocationAssessment =
  | { readonly kind: 'supported' }
  | { readonly kind: 'cloud-sync-warning'; readonly provider: string }
  | { readonly kind: 'unsupported-network' };

/** Folder names used by common sync clients as their root. Compared case-insensitively. */
const CLOUD_SYNC_FOLDER_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^onedrive( - .+)?$/i, 'OneDrive'],
  [/^dropbox( \(.+\))?$/i, 'Dropbox'],
  [/^google drive$/i, 'Google Drive'],
  [/^my drive$/i, 'Google Drive'],
  [/^icloud ?drive$/i, 'iCloud Drive'],
  [/^box( sync)?$/i, 'Box'],
];

export function assessWorkspaceLocation(absolutePath: string): LocationAssessment {
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return { kind: 'unsupported-network' };
  }

  for (const segment of absolutePath.split(/[\\/]/)) {
    for (const [pattern, provider] of CLOUD_SYNC_FOLDER_NAMES) {
      if (pattern.test(segment)) {
        return { kind: 'cloud-sync-warning', provider };
      }
    }
  }
  return { kind: 'supported' };
}
