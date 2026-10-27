/**
 * The portable workspace archive (PRD §5.11): a ZIP file holding a versioned manifest, one JSON
 * document with every workspace entity, and the attachment files.
 *
 *   manifest.json            format, version, export ID, workspace, counts, file checksums
 *   data/workspace.json      all entities (`ArchiveData`)
 *   attachments/<id>         the bytes of each attachment, named by its attachment ID
 *
 * The archive is the lossless restore format. It holds workspace data only: no locks, temporary
 * files, logs, machine-specific settings, search index rows or derived note references (those
 * are rebuilt from the notes on import).
 *
 * The types here describe the archive as plain JSON. Timestamps are UTC ISO strings and IDs are
 * the source workspace's IDs; import never reuses them (see `import-plan.ts`). Everything read
 * from an archive is untrusted until the desktop schema check and `planImport` have validated it.
 */

export const ARCHIVE_FORMAT = 'mmap-workspace-export';
/** Bump when the archive layout or data shape changes; older readers reject newer versions. */
export const ARCHIVE_FORMAT_VERSION = 1;

export const ARCHIVE_MANIFEST_PATH = 'manifest.json';
export const ARCHIVE_DATA_PATH = 'data/workspace.json';
export const ARCHIVE_ATTACHMENTS_DIRECTORY = 'attachments';

/** Archive path of an attachment's bytes. Named by ID only: never by the user's file name. */
export function archiveAttachmentPath(attachmentId: string): string {
  return `${ARCHIVE_ATTACHMENTS_DIRECTORY}/${attachmentId}`;
}

export interface ArchiveFileEntry {
  /** Path inside the ZIP, always one of the layout paths above. */
  readonly path: string;
  readonly byteSize: number;
  /** Lowercase hex SHA-256 of the file's bytes. */
  readonly sha256: string;
}

export interface ArchiveCounts {
  readonly nodes: number;
  readonly tags: number;
  readonly relationshipTypes: number;
  readonly relationships: number;
  readonly maps: number;
  readonly placements: number;
  readonly connections: number;
  readonly timelineEvents: number;
  readonly attachments: number;
}

export interface ArchiveManifest {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly formatVersion: number;
  /** Random ID of this export. Importing the same archive twice is detected by it. */
  readonly exportId: string;
  readonly exportedAt: string;
  readonly appVersion: string;
  /** Database schema version of the exporting app (informational). */
  readonly schemaVersion: number;
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly timezone: string;
  };
  readonly counts: ArchiveCounts;
  /** The data file and every attachment file, with sizes and checksums. */
  readonly files: readonly ArchiveFileEntry[];
}

export interface ArchiveNode {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  /** The note as a parsed JSON document (not a string), so the archive stays readable. */
  readonly note: unknown;
  readonly noteSchemaVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArchiveTag {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArchiveNodeTag {
  readonly nodeId: string;
  readonly tagId: string;
  readonly createdAt: string;
}

export interface ArchiveRelationshipType {
  readonly id: string;
  readonly label: string;
  readonly directionality: 'directed' | 'undirected';
  readonly isArchived: boolean;
  readonly isBuiltin: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArchiveRelationship {
  readonly id: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly typeId: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArchiveMap {
  readonly id: string;
  readonly title: string;
  readonly mode: 'freeform' | 'hierarchical';
  readonly viewport: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArchivePlacement {
  readonly id: string;
  readonly mapId: string;
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly parentPlacementId: string | null;
  readonly siblingOrder: number;
  readonly isCollapsed: boolean;
  readonly color: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArchiveConnection {
  readonly id: string;
  readonly mapId: string;
  readonly sourcePlacementId: string;
  readonly targetPlacementId: string;
  readonly relationshipId: string | null;
  readonly label: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArchiveTimelineEvent {
  readonly id: string;
  /** Null when the node was deleted before the export; the title snapshot keeps it readable. */
  readonly nodeId: string | null;
  readonly nodeTitleSnapshot: string | null;
  readonly eventType:
    'node_created' | 'note_updated' | 'relationship_created' | 'reviewed' | 'milestone';
  readonly occurredAt: string;
  readonly lastActivityAt: string;
  readonly learnedAt: string | null;
  readonly title: string | null;
  readonly reflection: string | null;
  readonly isImported: boolean;
  readonly importOrigin: string | null;
}

export interface ArchiveAttachment {
  readonly id: string;
  readonly nodeId: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArchiveGraphPosition {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
}

export interface ArchiveData {
  readonly nodes: readonly ArchiveNode[];
  readonly tags: readonly ArchiveTag[];
  readonly nodeTags: readonly ArchiveNodeTag[];
  readonly relationshipTypes: readonly ArchiveRelationshipType[];
  readonly relationships: readonly ArchiveRelationship[];
  readonly maps: readonly ArchiveMap[];
  readonly placements: readonly ArchivePlacement[];
  readonly connections: readonly ArchiveConnection[];
  readonly timelineEvents: readonly ArchiveTimelineEvent[];
  readonly attachments: readonly ArchiveAttachment[];
  /** Where nodes were left in the global graph (visual state). */
  readonly graphPositions: readonly ArchiveGraphPosition[];
}

export function archiveCounts(data: ArchiveData): ArchiveCounts {
  return {
    nodes: data.nodes.length,
    tags: data.tags.length,
    relationshipTypes: data.relationshipTypes.length,
    relationships: data.relationships.length,
    maps: data.maps.length,
    placements: data.placements.length,
    connections: data.connections.length,
    timelineEvents: data.timelineEvents.length,
    attachments: data.attachments.length,
  };
}
