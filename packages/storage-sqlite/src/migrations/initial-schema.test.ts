/**
 * Constraint tests for the initial schema. These verify the database-level second line of
 * defense for PRD invariants; services enforce the same rules first.
 */

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countRows,
  FIXED_TIME,
  insert,
  insertOrderedNodePair,
  nextTestId,
  openMigratedTemporaryDatabase,
  type TemporaryDatabase,
} from '../test-support/temporary-database';

let temporary: TemporaryDatabase;
let database: DatabaseSync;
let workspaceId: string;

beforeEach(async () => {
  temporary = await openMigratedTemporaryDatabase();
  database = temporary.database;
  workspaceId = insert.workspace(database);
});

afterEach(() => {
  temporary.dispose();
});

describe('relationships (PRD §4.2)', () => {
  it('rejects self-links', () => {
    const node = insert.node(database, workspaceId);
    const typeId = insert.relationshipType(database, workspaceId, 'depends on', 'directed');

    expect(() =>
      insert.relationship(database, {
        workspaceId,
        sourceNodeId: node,
        targetNodeId: node,
        typeId,
        directionality: 'directed',
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects undirected relationships stored in non-canonical order', () => {
    const { low, high } = insertOrderedNodePair(database, workspaceId);
    const typeId = insert.relationshipType(database, workspaceId, 'related to', 'undirected');

    expect(() =>
      insert.relationship(database, {
        workspaceId,
        sourceNodeId: high,
        targetNodeId: low,
        typeId,
        directionality: 'undirected',
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects exact duplicates but allows the reverse direction and other types', () => {
    const { low, high } = insertOrderedNodePair(database, workspaceId);
    const dependsOn = insert.relationshipType(database, workspaceId, 'depends on', 'directed');
    const partOf = insert.relationshipType(database, workspaceId, 'part of', 'directed');
    const base = { workspaceId, typeId: dependsOn, directionality: 'directed' as const };

    insert.relationship(database, { ...base, sourceNodeId: low, targetNodeId: high });

    expect(() =>
      insert.relationship(database, { ...base, sourceNodeId: low, targetNodeId: high }),
    ).toThrow(/UNIQUE constraint failed/);
    // Reverse direction is a different directed relationship.
    insert.relationship(database, { ...base, sourceNodeId: high, targetNodeId: low });
    // A different type between the same endpoints is allowed.
    insert.relationship(database, {
      ...base,
      typeId: partOf,
      sourceNodeId: low,
      targetNodeId: high,
    });

    expect(countRows(database, 'relationships')).toBe(3);
  });

  it('rejects a relationship whose stored directionality differs from its type', () => {
    const { low, high } = insertOrderedNodePair(database, workspaceId);
    const relatedTo = insert.relationshipType(database, workspaceId, 'related to', 'undirected');

    expect(() =>
      insert.relationship(database, {
        workspaceId,
        sourceNodeId: high,
        targetNodeId: low,
        typeId: relatedTo,
        directionality: 'directed',
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('prevents changing a type directionality while the type is used', () => {
    const { low, high } = insertOrderedNodePair(database, workspaceId);
    const typeId = insert.relationshipType(database, workspaceId, 'depends on', 'directed');
    const unusedTypeId = insert.relationshipType(database, workspaceId, 'unused', 'directed');
    insert.relationship(database, {
      workspaceId,
      sourceNodeId: low,
      targetNodeId: high,
      typeId,
      directionality: 'directed',
    });
    const changeDirectionality = database.prepare(
      "UPDATE relationship_types SET directionality = 'undirected' WHERE id = ?",
    );

    expect(() => changeDirectionality.run(typeId)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => changeDirectionality.run(unusedTypeId)).not.toThrow();
  });

  it('prevents deleting a type that is in use', () => {
    const { low, high } = insertOrderedNodePair(database, workspaceId);
    const typeId = insert.relationshipType(database, workspaceId, 'depends on', 'directed');
    insert.relationship(database, {
      workspaceId,
      sourceNodeId: low,
      targetNodeId: high,
      typeId,
      directionality: 'directed',
    });

    expect(() =>
      database.prepare('DELETE FROM relationship_types WHERE id = ?').run(typeId),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('removes relationships when an endpoint node is deleted', () => {
    const { low, high } = insertOrderedNodePair(database, workspaceId);
    const typeId = insert.relationshipType(database, workspaceId, 'depends on', 'directed');
    insert.relationship(database, {
      workspaceId,
      sourceNodeId: low,
      targetNodeId: high,
      typeId,
      directionality: 'directed',
    });

    database.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(high);

    expect(countRows(database, 'relationships')).toBe(0);
    expect(countRows(database, 'knowledge_nodes')).toBe(1);
  });
});

describe('workspace isolation (PRD §7.3, acceptance criterion 2)', () => {
  it('rejects relationships that cross workspaces', () => {
    const otherWorkspaceId = insert.workspace(database, 'Other');
    const localNode = insert.node(database, workspaceId);
    const foreignNode = insert.node(database, otherWorkspaceId);
    const typeId = insert.relationshipType(database, workspaceId, 'depends on', 'directed');

    expect(() =>
      insert.relationship(database, {
        workspaceId,
        sourceNodeId: localNode,
        targetNodeId: foreignNode,
        typeId,
        directionality: 'directed',
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('rejects placing a node from another workspace on a map', () => {
    const otherWorkspaceId = insert.workspace(database, 'Other');
    const foreignNode = insert.node(database, otherWorkspaceId);
    const mapId = insert.map(database, workspaceId);

    expect(() => insert.placement(database, { workspaceId, mapId, nodeId: foreignNode })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('rejects tagging a node with a tag from another workspace', () => {
    const otherWorkspaceId = insert.workspace(database, 'Other');
    const node = insert.node(database, workspaceId);
    const foreignTag = nextTestId();
    database
      .prepare(
        `INSERT INTO tags (id, workspace_id, display_label, normalized_label, created_at, updated_at)
         VALUES (?, ?, 'Physics', 'physics', ?, ?)`,
      )
      .run(foreignTag, otherWorkspaceId, FIXED_TIME, FIXED_TIME);

    expect(() =>
      database
        .prepare(
          'INSERT INTO node_tags (workspace_id, node_id, tag_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(workspaceId, node, foreignTag, FIXED_TIME),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('rejects timeline events that point at another workspace node', () => {
    const otherWorkspaceId = insert.workspace(database, 'Other');
    const foreignNode = insert.node(database, otherWorkspaceId);

    expect(() =>
      database
        .prepare(
          `INSERT INTO timeline_events (id, workspace_id, node_id, event_type, occurred_at, last_activity_at)
           VALUES (?, ?, ?, 'reviewed', ?, ?)`,
        )
        .run(nextTestId(), workspaceId, foreignNode, FIXED_TIME, FIXED_TIME),
    ).toThrow(/workspace mismatch/);
  });
});

describe('mind map placements (PRD §4.4, §5.6)', () => {
  it('allows a node at most once per map but in many maps', () => {
    const nodeId = insert.node(database, workspaceId);
    const firstMap = insert.map(database, workspaceId, 'First');
    const secondMap = insert.map(database, workspaceId, 'Second');

    insert.placement(database, { workspaceId, mapId: firstMap, nodeId });
    insert.placement(database, { workspaceId, mapId: secondMap, nodeId });

    expect(() => insert.placement(database, { workspaceId, mapId: firstMap, nodeId })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('rejects a parent from a different map', () => {
    const firstMap = insert.map(database, workspaceId, 'First');
    const secondMap = insert.map(database, workspaceId, 'Second');
    const parent = insert.placement(database, {
      workspaceId,
      mapId: firstMap,
      nodeId: insert.node(database, workspaceId),
    });

    expect(() =>
      insert.placement(database, {
        workspaceId,
        mapId: secondMap,
        nodeId: insert.node(database, workspaceId),
        parentPlacementId: parent,
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('rejects hierarchy cycles on reparenting', () => {
    const mapId = insert.map(database, workspaceId);
    const root = insert.placement(database, {
      workspaceId,
      mapId,
      nodeId: insert.node(database, workspaceId),
    });
    const child = insert.placement(database, {
      workspaceId,
      mapId,
      nodeId: insert.node(database, workspaceId),
      parentPlacementId: root,
    });
    const grandchild = insert.placement(database, {
      workspaceId,
      mapId,
      nodeId: insert.node(database, workspaceId),
      parentPlacementId: child,
    });
    const reparent = database.prepare(
      'UPDATE map_placements SET parent_placement_id = ? WHERE id = ?',
    );

    expect(() => reparent.run(grandchild, root)).toThrow(/hierarchy cycle/);
    expect(() => reparent.run(root, root)).toThrow(/hierarchy cycle|CHECK constraint failed/);
    // A legal move: grandchild becomes a direct child of root.
    expect(() => reparent.run(root, grandchild)).not.toThrow();
  });

  it('deleting a map keeps its canonical nodes (acceptance criterion 8)', () => {
    const mapId = insert.map(database, workspaceId);
    const parentNode = insert.node(database, workspaceId);
    const childNode = insert.node(database, workspaceId);
    const parent = insert.placement(database, { workspaceId, mapId, nodeId: parentNode });
    insert.placement(database, {
      workspaceId,
      mapId,
      nodeId: childNode,
      parentPlacementId: parent,
    });

    database.prepare('DELETE FROM mind_maps WHERE id = ?').run(mapId);

    expect(countRows(database, 'map_placements')).toBe(0);
    expect(countRows(database, 'knowledge_nodes')).toBe(2);
  });

  it('refuses to silently delete a subtree when a parent placement is removed', () => {
    const mapId = insert.map(database, workspaceId);
    const parent = insert.placement(database, {
      workspaceId,
      mapId,
      nodeId: insert.node(database, workspaceId),
    });
    insert.placement(database, {
      workspaceId,
      mapId,
      nodeId: insert.node(database, workspaceId),
      parentPlacementId: parent,
    });

    expect(() => database.prepare('DELETE FROM map_placements WHERE id = ?').run(parent)).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });
});

describe('full-text search index (PRD §5.8)', () => {
  function searchTitles(query: string): string[] {
    return database
      .prepare(
        `SELECT n.title FROM knowledge_nodes_fts
         JOIN knowledge_nodes AS n ON n.row_key = knowledge_nodes_fts.rowid
         WHERE knowledge_nodes_fts MATCH ? AND n.workspace_id = ?
         ORDER BY n.title`,
      )
      .all(query, workspaceId)
      .map((row) => String(row.title));
  }

  it('stays in sync with inserts, updates and deletes', () => {
    const nodeId = insert.node(database, workspaceId, {
      title: 'Entropy',
      plainText: 'Disorder in thermodynamic systems',
    });
    expect(searchTitles('thermodynamic')).toEqual(['Entropy']);

    database
      .prepare("UPDATE knowledge_nodes SET note_plain_text = 'Information theory' WHERE id = ?")
      .run(nodeId);
    expect(searchTitles('thermodynamic')).toEqual([]);
    expect(searchTitles('information')).toEqual(['Entropy']);

    database.prepare('DELETE FROM knowledge_nodes WHERE id = ?').run(nodeId);
    expect(searchTitles('information')).toEqual([]);
    expect(() =>
      database.exec(
        "INSERT INTO knowledge_nodes_fts (knowledge_nodes_fts) VALUES ('integrity-check')",
      ),
    ).not.toThrow();
  });

  it('matches Unicode text with diacritics removed', () => {
    insert.node(database, workspaceId, { title: 'Café', plainText: 'שלום עולם' });

    expect(searchTitles('cafe')).toEqual(['Café']);
    expect(searchTitles('שלום')).toEqual(['Café']);
  });

  it('never returns matches from another workspace', () => {
    const otherWorkspaceId = insert.workspace(database, 'Other');
    insert.node(database, otherWorkspaceId, { title: 'Secret', plainText: 'quantum' });
    insert.node(database, workspaceId, { title: 'Mine', plainText: 'quantum' });

    expect(searchTitles('quantum')).toEqual(['Mine']);
  });
});

describe('attachments (PRD §5.10)', () => {
  it.each([
    '../outside.bin',
    'a/../../outside.bin',
    '/absolute.bin',
    'C:/Windows/system32.dll',
    'ab\\cd.bin',
    'a/..',
    '',
  ])('rejects unsafe relative path %j', (relativePath) => {
    const nodeId = insert.node(database, workspaceId);

    expect(() =>
      database
        .prepare(
          `INSERT INTO attachments
             (id, workspace_id, node_id, relative_path, original_name, mime_type, byte_size, sha256, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'file.pdf', 'application/pdf', 1, ?, 'staged', ?, ?)`,
        )
        .run(
          nextTestId(),
          workspaceId,
          nodeId,
          relativePath,
          'a'.repeat(64),
          FIXED_TIME,
          FIXED_TIME,
        ),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('column validation', () => {
  it('rejects non-UTC timestamps and non-canonical IDs', () => {
    const insertWorkspace = database.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );

    expect(() => insertWorkspace.run(nextTestId(), 'W', '2026-10-26 12:00:00', FIXED_TIME)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      insertWorkspace.run('NOT-A-UUID-00000000000000000000000000', 'W', FIXED_TIME, FIXED_TIME),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects invalid note JSON', () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO knowledge_nodes (id, workspace_id, title, note_json, note_schema_version, created_at, updated_at)
           VALUES (?, ?, 'T', '{not json', 1, ?, ?)`,
        )
        .run(nextTestId(), workspaceId, FIXED_TIME, FIXED_TIME),
    ).toThrow(/CHECK constraint failed/);
  });
});
