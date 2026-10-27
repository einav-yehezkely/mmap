/**
 * Plans an import of archive data into a workspace (PRD §5.11), without touching storage.
 *
 * Rules:
 * - **New records, new IDs.** Every node, relationship, map, placement, connector, timeline
 *   event and attachment gets a new ID, and every internal reference is rewritten through an
 *   explicit ID mapping: relationship endpoints, map hierarchy, connectors, tags, timeline events,
 *   graph positions, and the wikilinks and attachments inside note JSON. Archive IDs are never
 *   written, so an archive cannot address or overwrite records that already exist here.
 * - **Tags and relationship types merge by label.** A tag whose label already exists is reused.
 *   A relationship type is reused when its label and direction match; when only the label
 *   matches, the imported type is renamed ("… (imported)") so the direction is preserved, and a
 *   warning says so.
 * - **Everything is validated first.** The archive must be internally consistent (unique IDs,
 *   references that resolve, no self-relationships, no duplicate relationships, no hierarchy
 *   cycles, connectors whose linked relationship joins the same two nodes), and every field goes
 *   through the same normalization as user input. Any problem throws before anything is written.
 * - **Imported history is marked.** Timeline events are stored with `isImported` and the given
 *   origin, so they are never mistaken for new learning (PRD §5.9).
 * - **Links outside the archive stay unresolved.** A wikilink whose target is not in the archive
 *   gets a fresh, unused target ID: it shows as an unresolved link with its label, and can never
 *   point at an unrelated node of this workspace.
 *
 * The result lists records in insertion order (for example parents before children).
 */

import { isUtcTimestamp, type UtcTimestamp } from '../clock';
import { DomainError } from '../errors';
import type {
  AttachmentId,
  IdGenerator,
  MapConnectionId,
  MapId,
  NodeId,
  PlacementId,
  RelationshipId,
  RelationshipTypeId,
  TagId,
  TimelineEventId,
  WorkspaceId,
} from '../ids';
import { normalizeMapTitle, normalizeConnectorLabel } from '../application/map-service';
import { normalizeRelationshipDescription } from '../application/relationship-service';
import { normalizeMilestoneTitle, normalizeReflection } from '../application/timeline-service';
import { normalizeNodeSummary, normalizeNodeTitle } from '../knowledge/node-fields';
import {
  toStoredEndpoints,
  type RelationshipDirectionality,
} from '../knowledge/relationship-rules';
import { NOTE_SCHEMA_VERSION, parseNoteDocument, type NoteDocument } from '../notes/note-document';
import { extractPlainText } from '../notes/plain-text';
import type { GraphNodePosition } from '../ports/graph';
import {
  PLACEMENT_COLORS,
  type MapConnectionRecord,
  type MindMapRecord,
  type PlacementColor,
  type PlacementRecord,
} from '../ports/map-repository';
import type { NodeTagRecord } from '../ports/portability';
import type {
  KnowledgeNodeRecord,
  RelationshipRecord,
  RelationshipTypeRecord,
  TagRecord,
  TimelineEventRecord,
} from '../ports/repositories';
import { MAX_LABEL_LENGTH, toDisplayLabel, toNormalizedLabel } from '../text/labels';
import type { ArchiveData } from './archive-format';

export interface ImportContext {
  readonly workspaceId: WorkspaceId;
  /** Relationship types and tags already in the destination workspace. */
  readonly existingTypes: readonly RelationshipTypeRecord[];
  readonly existingTags: readonly TagRecord[];
  readonly ids: IdGenerator;
  /** Stored on every imported timeline event, e.g. `Physics (exported 2026-10-27)`. */
  readonly importOrigin: string;
  /**
   * Archive attachments that passed the attachment policy, by archive attachment ID, with the
   * display name and type the policy derived from the actual bytes (the archive's own name and
   * type are not trusted). Attachments not in this map are not imported.
   */
  readonly approvedAttachments: ReadonlyMap<string, ApprovedAttachment>;
}

export interface ApprovedAttachment {
  readonly displayName: string;
  readonly mimeType: string;
}

/** An attachment to copy from the archive; the storage path is assigned when its file is stored. */
export interface PlannedAttachment {
  readonly id: AttachmentId;
  readonly archiveAttachmentId: string;
  readonly nodeId: NodeId;
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface ImportSummary {
  readonly nodes: number;
  readonly newTags: number;
  readonly reusedTags: number;
  readonly newRelationshipTypes: number;
  readonly reusedRelationshipTypes: number;
  readonly relationships: number;
  readonly maps: number;
  readonly placements: number;
  readonly connections: number;
  readonly timelineEvents: number;
  readonly attachments: number;
}

export interface ImportPlan {
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly tags: readonly TagRecord[];
  readonly nodeTags: readonly NodeTagRecord[];
  readonly relationshipTypes: readonly RelationshipTypeRecord[];
  readonly relationships: readonly RelationshipRecord[];
  readonly maps: readonly MindMapRecord[];
  /** Parents come before their children. */
  readonly placements: readonly PlacementRecord[];
  readonly connections: readonly MapConnectionRecord[];
  readonly timelineEvents: readonly TimelineEventRecord[];
  readonly attachments: readonly PlannedAttachment[];
  readonly graphPositions: readonly GraphNodePosition[];
  /** Archive node ID to new node ID. */
  readonly nodeIdMap: ReadonlyMap<string, NodeId>;
  readonly summary: ImportSummary;
  /** Things the user should know before importing; English, shown in the preview. */
  readonly warnings: readonly string[];
}

/**
 * Validates `data` and plans its import.
 *
 * @throws DomainError `VALIDATION_FAILED` when the archive is inconsistent or a field is invalid.
 */
export function planImport(data: ArchiveData, context: ImportContext): ImportPlan {
  const { workspaceId, ids } = context;
  const newId = () => ids.newId();
  const warnings: string[] = [];

  // --- Nodes and their notes -------------------------------------------------------------------
  const nodeIdMap = mapIds<NodeId>(data.nodes, 'node', newId);
  const attachmentIdMap = new Map<string, AttachmentId>();
  for (const attachment of data.attachments) {
    if (attachmentIdMap.has(attachment.id)) inconsistent(`attachment ${attachment.id} repeats`);
    if (context.approvedAttachments.has(attachment.id)) {
      attachmentIdMap.set(attachment.id, newId() as AttachmentId);
    }
  }
  let unresolvedLinks = 0;
  const nodes = data.nodes.map((node): KnowledgeNodeRecord => {
    if (!Number.isInteger(node.noteSchemaVersion) || node.noteSchemaVersion < 1) {
      inconsistent(`node ${node.id} has an invalid note schema version`);
    }
    if (node.noteSchemaVersion > NOTE_SCHEMA_VERSION) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'The archive contains notes from a newer version of mmap. Update mmap to import it.',
      );
    }
    const rewritten = rewriteNote(parseNoteDocument(node.note), {
      node: (archiveId) => {
        const mapped = nodeIdMap.get(archiveId);
        if (mapped !== undefined) return mapped;
        unresolvedLinks += 1;
        return newId();
      },
      // A skipped or unknown attachment gets an unused ID: the note shows it as missing.
      attachment: (archiveId) => attachmentIdMap.get(archiveId) ?? newId(),
    });
    return {
      id: nodeIdMap.get(node.id)!,
      workspaceId,
      title: normalizeNodeTitle(node.title),
      summary: normalizeNodeSummary(node.summary),
      noteJson: JSON.stringify(rewritten),
      noteSchemaVersion: NOTE_SCHEMA_VERSION,
      notePlainText: extractPlainText(rewritten),
      revision: 1,
      createdAt: timestamp(node.createdAt, 'node'),
      updatedAt: timestamp(node.updatedAt, 'node'),
    };
  });
  if (unresolvedLinks > 0) {
    warnings.push(
      `${plural(unresolvedLinks, 'note link points', 'note links point')} to nodes that are not ` +
        'in the archive. They are kept as unresolved links.',
    );
  }
  const nodeId = (archiveId: string, what: string): NodeId => {
    const mapped = nodeIdMap.get(archiveId);
    if (mapped === undefined) inconsistent(`${what} refers to a node that is not in the archive`);
    return mapped;
  };

  // --- Tags ------------------------------------------------------------------------------------
  const existingTagsByLabel = new Map(
    context.existingTags.map((tag) => [tag.normalizedLabel, tag]),
  );
  const tagIdMap = new Map<string, TagId>();
  const tags: TagRecord[] = [];
  const archiveTagLabels = new Set<string>();
  let reusedTags = 0;
  for (const tag of data.tags) {
    if (tagIdMap.has(tag.id)) inconsistent(`tag ${tag.id} repeats`);
    const displayLabel = toDisplayLabel(tag.label, 'Tag');
    const normalizedLabel = toNormalizedLabel(displayLabel);
    if (archiveTagLabels.has(normalizedLabel)) inconsistent('two tags have the same name');
    archiveTagLabels.add(normalizedLabel);
    const existing = existingTagsByLabel.get(normalizedLabel);
    if (existing !== undefined) {
      tagIdMap.set(tag.id, existing.id);
      reusedTags += 1;
      continue;
    }
    const id = newId() as TagId;
    tagIdMap.set(tag.id, id);
    tags.push({
      id,
      workspaceId,
      displayLabel,
      normalizedLabel,
      createdAt: timestamp(tag.createdAt, 'tag'),
      updatedAt: timestamp(tag.updatedAt, 'tag'),
    });
  }
  const assignedTags = new Set<string>();
  const nodeTags = data.nodeTags.map((assignment): NodeTagRecord => {
    const tagId = tagIdMap.get(assignment.tagId);
    if (tagId === undefined)
      inconsistent('a tag assignment refers to a tag that is not in the archive');
    const mappedNode = nodeId(assignment.nodeId, 'a tag assignment');
    const key = `${mappedNode}|${tagId}`;
    if (assignedTags.has(key)) inconsistent('a tag is assigned twice to the same node');
    assignedTags.add(key);
    return {
      nodeId: mappedNode,
      tagId,
      createdAt: timestamp(assignment.createdAt, 'tag assignment'),
    };
  });

  // --- Relationship types ----------------------------------------------------------------------
  const existingTypesByLabel = new Map(
    context.existingTypes.map((type) => [type.normalizedLabel, type]),
  );
  const takenLabels = new Set(context.existingTypes.map((type) => type.normalizedLabel));
  const typeMap = new Map<
    string,
    { id: RelationshipTypeId; directionality: RelationshipDirectionality }
  >();
  const relationshipTypes: RelationshipTypeRecord[] = [];
  const archiveTypeLabels = new Set<string>();
  let reusedTypes = 0;
  for (const type of data.relationshipTypes) {
    if (typeMap.has(type.id)) inconsistent(`relationship type ${type.id} repeats`);
    const label = toDisplayLabel(type.label, 'Relationship type');
    const normalizedLabel = toNormalizedLabel(label);
    if (archiveTypeLabels.has(normalizedLabel)) {
      inconsistent('two relationship types have the same name');
    }
    archiveTypeLabels.add(normalizedLabel);
    const existing = existingTypesByLabel.get(normalizedLabel);
    if (existing !== undefined && existing.directionality === type.directionality) {
      typeMap.set(type.id, { id: existing.id, directionality: existing.directionality });
      reusedTypes += 1;
      continue;
    }
    let finalLabel = label;
    if (existing !== undefined) {
      finalLabel = uniqueLabel(label, takenLabels);
      warnings.push(
        `The relationship type "${label}" already exists here with a different direction. ` +
          `The imported one is named "${finalLabel}".`,
      );
    }
    const finalNormalized = toNormalizedLabel(finalLabel);
    takenLabels.add(finalNormalized);
    const id = newId() as RelationshipTypeId;
    typeMap.set(type.id, { id, directionality: type.directionality });
    relationshipTypes.push({
      id,
      workspaceId,
      label: finalLabel,
      normalizedLabel: finalNormalized,
      directionality: type.directionality,
      isArchived: type.isArchived,
      // Built-in types are created by mmap itself; an imported type is always a user type.
      isBuiltin: false,
      createdAt: timestamp(type.createdAt, 'relationship type'),
      updatedAt: timestamp(type.updatedAt, 'relationship type'),
    });
  }

  // --- Relationships ---------------------------------------------------------------------------
  const relationshipMap = new Map<string, RelationshipRecord>();
  const relationshipKeys = new Set<string>();
  const relationships = data.relationships.map((relationship): RelationshipRecord => {
    if (relationshipMap.has(relationship.id)) {
      inconsistent(`relationship ${relationship.id} repeats`);
    }
    const type = typeMap.get(relationship.typeId);
    if (type === undefined) {
      inconsistent('a relationship refers to a type that is not in the archive');
    }
    const source = nodeId(relationship.sourceNodeId, 'a relationship');
    const target = nodeId(relationship.targetNodeId, 'a relationship');
    if (source === target) inconsistent('a relationship connects a node to itself');
    // Undirected endpoints are stored in ID order, and the new IDs order differently.
    const endpoints = toStoredEndpoints(
      { sourceNodeId: source, targetNodeId: target },
      type.directionality,
    );
    const key = `${endpoints.sourceNodeId}|${endpoints.targetNodeId}|${type.id}`;
    if (relationshipKeys.has(key)) inconsistent('a relationship appears twice');
    relationshipKeys.add(key);
    const record: RelationshipRecord = {
      id: newId() as RelationshipId,
      workspaceId,
      sourceNodeId: endpoints.sourceNodeId,
      targetNodeId: endpoints.targetNodeId,
      typeId: type.id,
      directionality: type.directionality,
      description: normalizeRelationshipDescription(relationship.description),
      createdAt: timestamp(relationship.createdAt, 'relationship'),
      updatedAt: timestamp(relationship.updatedAt, 'relationship'),
    };
    relationshipMap.set(relationship.id, record);
    return record;
  });

  // --- Maps, placements and connectors ---------------------------------------------------------
  const mapIdMap = mapIds<MapId>(data.maps, 'map', newId);
  const maps = data.maps.map((map): MindMapRecord => {
    if (!(map.viewport.zoom > 0)) inconsistent(`map ${map.id} has an invalid zoom`);
    return {
      id: mapIdMap.get(map.id)!,
      workspaceId,
      title: normalizeMapTitle(map.title),
      mode: map.mode,
      viewport: { x: map.viewport.x, y: map.viewport.y, zoom: map.viewport.zoom },
      revision: 1,
      createdAt: timestamp(map.createdAt, 'map'),
      updatedAt: timestamp(map.updatedAt, 'map'),
    };
  });
  const placementIdMap = mapIds<PlacementId>(data.placements, 'placement', newId);
  const placementMapIds = new Map(
    data.placements.map((placement) => [placement.id, placement.mapId]),
  );
  const placementNodes = new Map<string, NodeId>();
  const nodesPerMap = new Set<string>();
  const unorderedPlacements = data.placements.map((placement): PlacementRecord => {
    const mapId = mapIdMap.get(placement.mapId);
    if (mapId === undefined) inconsistent('a placement refers to a map that is not in the archive');
    const mappedNode = nodeId(placement.nodeId, 'a placement');
    const key = `${mapId}|${mappedNode}`;
    if (nodesPerMap.has(key)) inconsistent('a node is placed twice on the same map');
    nodesPerMap.add(key);
    placementNodes.set(placement.id, mappedNode);
    let parentPlacementId: PlacementId | null = null;
    if (placement.parentPlacementId !== null) {
      if (placementMapIds.get(placement.parentPlacementId) !== placement.mapId) {
        inconsistent('a placement has a parent on another map or outside the archive');
      }
      parentPlacementId = placementIdMap.get(placement.parentPlacementId)!;
    }
    return {
      id: placementIdMap.get(placement.id)!,
      workspaceId,
      mapId,
      nodeId: mappedNode,
      x: placement.x,
      y: placement.y,
      parentPlacementId,
      siblingOrder: placement.siblingOrder,
      isCollapsed: placement.isCollapsed,
      style: { color: toPlacementColor(placement.color) },
      createdAt: timestamp(placement.createdAt, 'placement'),
      updatedAt: timestamp(placement.updatedAt, 'placement'),
    };
  });
  const placements = parentsFirst(unorderedPlacements);

  const connectionIds = new Set<string>();
  const connections = data.connections.map((connection): MapConnectionRecord => {
    if (connectionIds.has(connection.id)) inconsistent(`connector ${connection.id} repeats`);
    connectionIds.add(connection.id);
    const mapId = mapIdMap.get(connection.mapId);
    if (mapId === undefined) inconsistent('a connector refers to a map that is not in the archive');
    for (const end of [connection.sourcePlacementId, connection.targetPlacementId]) {
      if (placementMapIds.get(end) !== connection.mapId) {
        inconsistent('a connector joins placements of another map or outside the archive');
      }
    }
    if (connection.sourcePlacementId === connection.targetPlacementId) {
      inconsistent('a connector joins a placement to itself');
    }
    let relationshipId: RelationshipId | null = null;
    if (connection.relationshipId !== null) {
      const relationship = relationshipMap.get(connection.relationshipId);
      if (relationship === undefined) {
        inconsistent('a connector refers to a relationship that is not in the archive');
      }
      const ends = new Set([
        placementNodes.get(connection.sourcePlacementId),
        placementNodes.get(connection.targetPlacementId),
      ]);
      if (!ends.has(relationship.sourceNodeId) || !ends.has(relationship.targetNodeId)) {
        inconsistent('a connector is linked to a relationship between other nodes');
      }
      relationshipId = relationship.id;
    }
    return {
      id: newId() as MapConnectionId,
      workspaceId,
      mapId,
      sourcePlacementId: placementIdMap.get(connection.sourcePlacementId)!,
      targetPlacementId: placementIdMap.get(connection.targetPlacementId)!,
      relationshipId,
      label: normalizeConnectorLabel(connection.label),
      createdAt: timestamp(connection.createdAt, 'connector'),
      updatedAt: timestamp(connection.updatedAt, 'connector'),
    };
  });

  // --- Timeline --------------------------------------------------------------------------------
  const eventIds = new Set<string>();
  const timelineEvents = data.timelineEvents.map((event): TimelineEventRecord => {
    if (eventIds.has(event.id)) inconsistent(`timeline event ${event.id} repeats`);
    eventIds.add(event.id);
    const occurredAt = timestamp(event.occurredAt, 'timeline event');
    const lastActivityAt = timestamp(event.lastActivityAt, 'timeline event');
    if (lastActivityAt < occurredAt) inconsistent('a timeline event ends before it starts');
    let title: string | null = null;
    if (event.eventType === 'milestone') {
      title = normalizeMilestoneTitle(event.title ?? '');
    } else if (event.title !== null) {
      inconsistent('only milestones can have a title');
    }
    return {
      id: newId() as TimelineEventId,
      workspaceId,
      nodeId: event.nodeId === null ? null : nodeId(event.nodeId, 'a timeline event'),
      nodeTitleSnapshot: event.nodeTitleSnapshot,
      eventType: event.eventType,
      occurredAt,
      lastActivityAt,
      learnedAt: event.learnedAt === null ? null : timestamp(event.learnedAt, 'timeline event'),
      title,
      reflection: normalizeReflection(event.reflection),
      isImported: true,
      importOrigin: context.importOrigin,
    };
  });

  // --- Attachments and graph positions ---------------------------------------------------------
  const attachments: PlannedAttachment[] = [];
  for (const attachment of data.attachments) {
    const owner = nodeId(attachment.nodeId, 'an attachment');
    const id = attachmentIdMap.get(attachment.id);
    if (id === undefined) continue;
    const approved = context.approvedAttachments.get(attachment.id)!;
    attachments.push({
      id,
      archiveAttachmentId: attachment.id,
      nodeId: owner,
      originalName: approved.displayName,
      mimeType: approved.mimeType,
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
      createdAt: timestamp(attachment.createdAt, 'attachment'),
      updatedAt: timestamp(attachment.updatedAt, 'attachment'),
    });
  }
  const positioned = new Set<string>();
  const graphPositions = data.graphPositions.map((position): GraphNodePosition => {
    if (positioned.has(position.nodeId)) inconsistent('a node has two graph positions');
    positioned.add(position.nodeId);
    return { nodeId: nodeId(position.nodeId, 'a graph position'), x: position.x, y: position.y };
  });

  return {
    nodes,
    tags,
    nodeTags,
    relationshipTypes,
    relationships,
    maps,
    placements,
    connections,
    timelineEvents,
    attachments,
    graphPositions,
    nodeIdMap,
    summary: {
      nodes: nodes.length,
      newTags: tags.length,
      reusedTags,
      newRelationshipTypes: relationshipTypes.length,
      reusedRelationshipTypes: reusedTypes,
      relationships: relationships.length,
      maps: maps.length,
      placements: placements.length,
      connections: connections.length,
      timelineEvents: timelineEvents.length,
      attachments: attachments.length,
    },
    warnings,
  };
}

function inconsistent(problem: string): never {
  throw new DomainError('VALIDATION_FAILED', `The archive is not consistent: ${problem}.`);
}

function timestamp(value: string, what: string): UtcTimestamp {
  if (!isUtcTimestamp(value)) inconsistent(`a ${what} has an invalid date`);
  return value;
}

/** New IDs for archive records, rejecting repeated archive IDs. */
function mapIds<Id extends string>(
  records: readonly { readonly id: string }[],
  what: string,
  newId: () => string,
): Map<string, Id> {
  const map = new Map<string, Id>();
  for (const record of records) {
    if (map.has(record.id)) inconsistent(`${what} ${record.id} repeats`);
    map.set(record.id, newId() as Id);
  }
  return map;
}

function toPlacementColor(color: string | null): PlacementColor | null {
  return (PLACEMENT_COLORS as readonly string[]).includes(color ?? '')
    ? (color as PlacementColor)
    : null;
}

/** "Label (imported)", "Label (imported 2)", … within the label length limit. */
function uniqueLabel(label: string, taken: ReadonlySet<string>): string {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? ' (imported)' : ` (imported ${attempt})`;
    const candidate = `${label.slice(0, MAX_LABEL_LENGTH - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(toNormalizedLabel(candidate))) return candidate;
  }
}

/**
 * Orders placements so every parent precedes its children (the database checks parents as rows
 * are inserted). A placement that never becomes ready is part of a cycle.
 */
function parentsFirst(placements: readonly PlacementRecord[]): PlacementRecord[] {
  const ordered: PlacementRecord[] = [];
  const placed = new Set<string>();
  let remaining = [...placements];
  while (remaining.length > 0) {
    const ready = remaining.filter(
      (placement) =>
        placement.parentPlacementId === null || placed.has(placement.parentPlacementId),
    );
    if (ready.length === 0) inconsistent('a map hierarchy contains a cycle');
    for (const placement of ready) {
      ordered.push(placement);
      placed.add(placement.id);
    }
    remaining = remaining.filter((placement) => !placed.has(placement.id));
  }
  return ordered;
}

/**
 * Copies a validated note, replacing the IDs in wikilinks and attachment blocks. The copy is
 * validated again, so a rewrite can never produce a note the editor would reject.
 */
function rewriteNote(
  document: NoteDocument,
  replace: { node: (archiveId: string) => string; attachment: (archiveId: string) => string },
): NoteDocument {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== 'object') return value;
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) copy[key] = visit(child);
    const attrs = copy.attrs as Record<string, unknown> | undefined;
    if (copy.type === 'wikilink' && typeof attrs?.targetNodeId === 'string') {
      copy.attrs = { ...attrs, targetNodeId: replace.node(attrs.targetNodeId) };
    } else if (copy.type === 'attachment' && typeof attrs?.attachmentId === 'string') {
      copy.attrs = { ...attrs, attachmentId: replace.attachment(attrs.attachmentId) };
    }
    return copy;
  };
  return parseNoteDocument(visit(document));
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}
