/**
 * Label normalization shared by tags and relationship types (PRD §5.8: "Normalize tag uniqueness
 * within a workspace while preserving a display label").
 *
 * The display label keeps exactly what the user typed (trimmed). The normalized label is used only
 * for uniqueness and lookup, so `Physics`, ` physics ` and `PHYSICS` are the same tag.
 */

import { DomainError } from '../errors';

export const MAX_LABEL_LENGTH = 60;

// eslint-disable-next-line no-control-regex -- detecting control characters is the purpose.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validates a user-entered label and returns its display form: NFC-normalized, trimmed, with
 * internal whitespace runs collapsed to one space.
 *
 * @param what Noun used in error messages, e.g. `'Tag'`.
 * @throws DomainError `VALIDATION_FAILED`
 */
export function toDisplayLabel(rawLabel: string, what: string): string {
  const label = rawLabel.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (label.length === 0) {
    throw new DomainError('VALIDATION_FAILED', `${what} names cannot be empty.`);
  }
  if (label.length > MAX_LABEL_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `${what} names can be at most ${MAX_LABEL_LENGTH} characters long.`,
    );
  }
  if (CONTROL_CHARACTER.test(label)) {
    throw new DomainError('VALIDATION_FAILED', `${what} names cannot contain control characters.`);
  }
  return label;
}

/**
 * Uniqueness key for a display label. NFKC folds compatibility forms (full-width letters,
 * ligatures) and `toLowerCase` is locale-independent, so the key is stable across machines.
 */
export function toNormalizedLabel(displayLabel: string): string {
  return displayLabel.normalize('NFKC').toLowerCase();
}
