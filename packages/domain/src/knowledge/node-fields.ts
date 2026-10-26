/**
 * Validation and normalization for knowledge node titles and summaries (PRD §4.1).
 *
 * Titles are single-line and may repeat across nodes: identity is always the node ID, so no
 * uniqueness rule applies here. Summaries are optional short plain text.
 */

import { DomainError } from '../errors';

export const MAX_NODE_TITLE_LENGTH = 300;
export const MAX_NODE_SUMMARY_LENGTH = 2_000;

/** Control characters other than tab, line feed and carriage return. */
// eslint-disable-next-line no-control-regex -- detecting control characters is the purpose.
const DISALLOWED_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Returns the stored form of a title: NFC-normalized, line breaks and tabs folded into spaces,
 * trimmed.
 *
 * @throws DomainError `VALIDATION_FAILED` when empty, too long or containing control characters.
 */
export function normalizeNodeTitle(rawTitle: string): string {
  const title = rawTitle
    .normalize('NFC')
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
  if (title.length === 0) {
    throw new DomainError('VALIDATION_FAILED', 'A node needs a title.');
  }
  if (title.length > MAX_NODE_TITLE_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Titles can be at most ${MAX_NODE_TITLE_LENGTH} characters long.`,
    );
  }
  if (DISALLOWED_CONTROL_CHARACTER.test(title)) {
    throw new DomainError('VALIDATION_FAILED', 'Titles cannot contain control characters.');
  }
  return title;
}

/**
 * Returns the stored form of a summary, or `null` when it is empty after trimming.
 *
 * @throws DomainError `VALIDATION_FAILED` when too long or containing control characters.
 */
export function normalizeNodeSummary(rawSummary: string | null): string | null {
  if (rawSummary === null) {
    return null;
  }
  const summary = rawSummary.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (summary.length === 0) {
    return null;
  }
  if (summary.length > MAX_NODE_SUMMARY_LENGTH) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Summaries can be at most ${MAX_NODE_SUMMARY_LENGTH} characters long.`,
    );
  }
  if (DISALLOWED_CONTROL_CHARACTER.test(summary)) {
    throw new DomainError('VALIDATION_FAILED', 'Summaries cannot contain control characters.');
  }
  return summary;
}

/** Title for a duplicated node: "<title> (copy)", shortened if needed to stay within limits. */
export function duplicateTitle(title: string): string {
  const suffix = ' (copy)';
  const room = MAX_NODE_TITLE_LENGTH - suffix.length;
  const base = title.length > room ? title.slice(0, room).trimEnd() : title;
  return `${base}${suffix}`;
}
