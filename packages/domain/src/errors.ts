/**
 * Domain error model.
 *
 * Services report expected failures (invalid input, conflicts, rule violations) by throwing a
 * `DomainError` with a stable machine-readable code. Transport layers (IPC today, HTTP in a
 * future server phase) translate these codes into their own envelopes; they never expose stack
 * traces or note content to the caller.
 */

export const DOMAIN_ERROR_CODES = [
  /** Input failed validation (shape, length, format). */
  'VALIDATION_FAILED',
  /** The referenced record does not exist in the active workspace. */
  'NOT_FOUND',
  /** An optimistic revision check failed: someone saved a newer version first. */
  'REVISION_CONFLICT',
  /** A uniqueness rule was violated, e.g. a duplicate relationship or tag. */
  'DUPLICATE',
  /** A business invariant was violated, e.g. a self-link or a hierarchy cycle. */
  'INVARIANT_VIOLATION',
  /** A record from another workspace was referenced. */
  'WORKSPACE_MISMATCH',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  public readonly code: DomainErrorCode;

  /**
   * @param code Stable error code that callers may branch on.
   * @param message English description for developers and logs. It must not contain note
   *   content or other private user data (PRD §8: keep content out of logs).
   */
  public constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
