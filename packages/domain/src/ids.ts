/**
 * Stable identifiers.
 *
 * Every persisted entity is identified by a locally generated UUID (PRD §7.2). Titles and labels
 * may repeat, so identity must never be derived from user-visible text (PRD §4.1).
 *
 * IDs are "branded" strings: at runtime they are plain strings, but the type system prevents
 * accidentally passing, for example, a map ID where a node ID is expected.
 */

declare const brand: unique symbol;

/** Nominal typing helper: `Brand<string, 'NodeId'>` is a string that only a `NodeId` source can produce. */
export type Brand<Base, Name extends string> = Base & { readonly [brand]: Name };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type RelationshipTypeId = Brand<string, 'RelationshipTypeId'>;
export type RelationshipId = Brand<string, 'RelationshipId'>;
export type TagId = Brand<string, 'TagId'>;
export type MapId = Brand<string, 'MapId'>;
export type PlacementId = Brand<string, 'PlacementId'>;
export type MapConnectionId = Brand<string, 'MapConnectionId'>;
export type TimelineEventId = Brand<string, 'TimelineEventId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type TransferJobId = Brand<string, 'TransferJobId'>;

/**
 * Canonical lowercase UUID text form (8-4-4-4-12 hex digits).
 *
 * We store IDs lowercase so that byte-wise comparison, which SQLite uses for TEXT, matches
 * the canonical ordering rules for undirected relationships (see `relationship-rules.ts`).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns true when `value` is a UUID in canonical lowercase form. */
export function isCanonicalUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Port for generating new identifiers. The desktop adapter uses `crypto.randomUUID()`;
 * tests use a deterministic sequence so results are reproducible.
 */
export interface IdGenerator {
  /** Returns a new canonical lowercase UUID. */
  newId(): string;
}
