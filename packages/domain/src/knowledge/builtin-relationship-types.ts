/**
 * Relationship types every new workspace starts with (PRD §4.2). Users can add, rename and
 * archive types later; these are marked built-in only so the UI can explain where they came from.
 */

import type { RelationshipDirectionality } from './relationship-rules';

export interface BuiltinRelationshipType {
  readonly label: string;
  readonly directionality: RelationshipDirectionality;
}

export const BUILTIN_RELATIONSHIP_TYPES: readonly BuiltinRelationshipType[] = [
  { label: 'related to', directionality: 'undirected' },
  { label: 'depends on', directionality: 'directed' },
  { label: 'part of', directionality: 'directed' },
  { label: 'example of', directionality: 'directed' },
  { label: 'contradicts', directionality: 'undirected' },
];
