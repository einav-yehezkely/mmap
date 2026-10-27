/**
 * Workspace naming rules (PRD §5.1).
 *
 * A workspace has a display name chosen by the user and, when created in the default location, a
 * folder named after it. The display name may contain any Unicode text; the folder name must be
 * valid and unambiguous on Windows, which is stricter than other platforms (PRD §3: keep
 * platform-specific rules isolated, so this module only provides the Windows-safe variant used by
 * all platforms).
 */

import { DomainError } from '../errors';

export const MAX_WORKSPACE_NAME_LENGTH = 80;

/** C0/C1 control characters: invisible in the UI and invalid in Windows file names. */
// eslint-disable-next-line no-control-regex -- detecting control characters is the purpose.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex -- see above.
const ALL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Characters Windows forbids in file names. */
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"/\\|?*]/g;

/** Device names Windows reserves regardless of extension (e.g. `CON`, `con.txt`). */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Validates and normalizes a display name: trims surrounding whitespace, rejects empty names,
 * names that are too long, and names containing control characters.
 *
 * @throws DomainError `VALIDATION_FAILED`
 */
export function normalizeWorkspaceName(rawName: string): string {
  const name = rawName.normalize('NFC').trim();
  if (name.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'Enter a workspace name.');
  }
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Workspace names can be at most ${MAX_WORKSPACE_NAME_LENGTH} characters long.`,
    );
  }
  if (CONTROL_CHARACTER.test(name)) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'Workspace names cannot contain control characters.',
    );
  }
  return name;
}

/**
 * Derives a folder name from a normalized display name. The result is safe to join to a parent
 * directory: it contains no path separators, no reserved characters, does not end with a dot or
 * space (which Windows silently strips), and is never a reserved device name or `.`/`..`.
 * Falls back to `Workspace` when nothing usable remains (for example a name made only of `?`).
 */
export function toWorkspaceFolderName(displayName: string): string {
  let folderName = displayName
    .replace(ALL_CONTROL_CHARACTERS, '')
    .replace(WINDOWS_FORBIDDEN_CHARACTERS, '-')
    .replace(/[. ]+$/u, '')
    .trim();

  if (folderName.length === 0 || /^[.-]+$/.test(folderName)) {
    folderName = 'Workspace';
  }
  if (WINDOWS_RESERVED_NAMES.test(folderName)) {
    folderName = `${folderName}-workspace`;
  }
  return folderName;
}
