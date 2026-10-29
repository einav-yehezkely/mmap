/**
 * Turns a workspace snapshot into archive data (PRD §5.11). A plain field-by-field mapping, so
 * that the archive format stays independent of storage details: workspace IDs, row keys,
 * revisions, derived plain text and file storage paths are not written.
 */

import type { WorkspaceSnapshot } from '../ports/portability';
import type { ArchiveData } from './archive-format';

export function toArchiveData(snapshot: WorkspaceSnapshot): ArchiveData {
  return {
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      summary: node.summary,
      // Stored note JSON was validated on save; it is embedded as an object, not a string.
      note: JSON.parse(node.noteJson) as unknown,
      noteSchemaVersion: node.noteSchemaVersion,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    })),
    tags: snapshot.tags.map((tag) => ({
      id: tag.id,
      label: tag.displayLabel,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
    })),
    nodeTags: snapshot.nodeTags.map((assignment) => ({
      nodeId: assignment.nodeId,
      tagId: assignment.tagId,
      createdAt: assignment.createdAt,
    })),
    relationshipTypes: snapshot.relationshipTypes.map((type) => ({
      id: type.id,
      label: type.label,
      directionality: type.directionality,
      isArchived: type.isArchived,
      isBuiltin: type.isBuiltin,
      createdAt: type.createdAt,
      updatedAt: type.updatedAt,
    })),
    relationships: snapshot.relationships.map((relationship) => ({
      id: relationship.id,
      sourceNodeId: relationship.sourceNodeId,
      targetNodeId: relationship.targetNodeId,
      typeId: relationship.typeId,
      description: relationship.description,
      createdAt: relationship.createdAt,
      updatedAt: relationship.updatedAt,
    })),
    maps: snapshot.maps.map((map) => ({
      id: map.id,
      title: map.title,
      mode: map.mode,
      viewport: { x: map.viewport.x, y: map.viewport.y, zoom: map.viewport.zoom },
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
    })),
    placements: snapshot.placements.map((placement) => ({
      id: placement.id,
      mapId: placement.mapId,
      nodeId: placement.nodeId,
      x: placement.x,
      y: placement.y,
      parentPlacementId: placement.parentPlacementId,
      siblingOrder: placement.siblingOrder,
      isCollapsed: placement.isCollapsed,
      color: placement.style.color,
      createdAt: placement.createdAt,
      updatedAt: placement.updatedAt,
    })),
    connections: snapshot.connections.map((connection) => ({
      id: connection.id,
      mapId: connection.mapId,
      sourcePlacementId: connection.sourcePlacementId,
      targetPlacementId: connection.targetPlacementId,
      relationshipId: connection.relationshipId,
      label: connection.label,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    })),
    timelineEvents: snapshot.timelineEvents.map((event) => ({
      id: event.id,
      nodeId: event.nodeId,
      nodeTitleSnapshot: event.nodeTitleSnapshot,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      lastActivityAt: event.lastActivityAt,
      learnedAt: event.learnedAt,
      title: event.title,
      reflection: event.reflection,
      isImported: event.isImported,
      importOrigin: event.importOrigin,
    })),
    attachments: snapshot.attachments.map((attachment) => ({
      id: attachment.id,
      nodeId: attachment.nodeId,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
      createdAt: attachment.createdAt,
      updatedAt: attachment.updatedAt,
    })),
    regions: snapshot.regions.map((region) => ({
      id: region.id,
      mapId: region.mapId,
      title: region.title,
      color: region.color,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      createdAt: region.createdAt,
      updatedAt: region.updatedAt,
    })),
    graphPositions: snapshot.graphPositions.map((position) => ({
      nodeId: position.nodeId,
      x: position.x,
      y: position.y,
    })),
  };
}
