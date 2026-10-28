/**
 * PRD §13 acceptance criterion 12, against the real main-process stack (workspace manager,
 * SQLite, attachment store, ZIP files): "A workspace exported and imported into a fresh local
 * workspace preserves every supported entity, stable internal mapping, direction, hierarchy, note
 * content, and attachment checksum."
 *
 * The source workspace is built through the ordinary services; the archive is imported into a
 * second app profile whose workspace already has a tag and a relationship type with the same
 * names, to exercise label merging.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UtcTimestamp, WorkspaceSnapshot } from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { operationCancelled, type Progress } from '../operations/operation-progress';
import { createAttachmentIpcServices } from '../services/attachment-ipc-services';
import { exportWorkspaceArchive } from './export-workspace';
import { applyImport, prepareImport } from './import-workspace';
import { writeImport, writeImportInProcess, type ImportRecordWriter } from './import-writer';
import { createTransferIpcServices } from '../services/transfer-ipc-services';
import { createFileSettingsStore } from '../workspaces/app-settings';
import type { OpenWorkspace } from '../workspaces/open-workspace';
import { WorkspaceManager } from '../workspaces/workspace-manager';

let sandbox: string;
const managers: WorkspaceManager[] = [];

function startApp(profile: string): WorkspaceManager {
  const userData = join(sandbox, profile);
  mkdirSync(userData, { recursive: true });
  const manager = new WorkspaceManager({
    settings: createFileSettingsStore(userData),
    defaultWorkspacesRoot: join(userData, 'workspaces'),
    appVersion: 'test',
    timezone: () => 'UTC',
    clock: { now: () => new Date().toISOString() as UtcTimestamp },
    ids: { newId: () => crypto.randomUUID() },
    lockEnvironment: {
      pid: process.pid,
      hostname: 'test',
      instanceId: crypto.randomUUID(),
      now: () => new Date(),
      isProcessAlive: () => true,
    },
    trashFolder: () => Promise.reject(new Error('Not used in this test.')),
  });
  managers.push(manager);
  return manager;
}

/**
 * The worker thread's path without the thread: the records are written through a separate
 * connection while the write queue is held, from a structured clone of the job, exactly as the
 * worker receives it. (Vitest cannot start the bundled worker; the packaged smoke test does.)
 */
const writeLikeTheWorker: ImportRecordWriter = (workspace, plan, exportId, storedFiles) =>
  workspace.connections.runExclusive(() =>
    writeImport(
      structuredClone({
        databasePath: workspace.paths.database,
        workspaceId: workspace.id,
        plan,
        exportId,
        storedFiles: [...storedFiles],
      }),
    ),
  );

/** Progress that cancels as soon as the phase `label` starts, as a user pressing Cancel would. */
function cancelAt(label: string): Progress & { readonly phases: string[] } {
  const controller = new AbortController();
  const phases: string[] = [];
  return {
    phases,
    phase: (phase) => {
      phases.push(phase);
      if (phase === label) controller.abort();
    },
    advance: () => undefined,
    checkCancelled: () => {
      if (controller.signal.aborted) throw operationCancelled();
    },
    signal: controller.signal,
  };
}

function transfer(
  manager: WorkspaceManager,
  archivePath: string,
  importRecordWriter: ImportRecordWriter = writeImportInProcess,
) {
  return createTransferIpcServices({
    currentWorkspace: () => manager.current,
    maxAttachmentBytes: () => Promise.resolve(20 * 1024 * 1024),
    native: {
      chooseExportDestination: () => Promise.resolve(archivePath),
      chooseArchiveToImport: () => Promise.resolve(archivePath),
    },
    appVersion: 'test',
    ids: { newId: () => crypto.randomUUID() },
    importRecordWriter,
  });
}

function current(manager: WorkspaceManager): OpenWorkspace {
  const workspace = manager.current;
  if (workspace === null) throw new Error('no workspace is open');
  return workspace;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-portability-'));
});

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  rmSync(sandbox, { recursive: true, force: true });
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a tiny picture of a heat engine'),
]);

/** Builds a workspace with every kind of entity, and returns the IDs needed for checks. */
async function buildSourceWorkspace(manager: WorkspaceManager) {
  const workspace = current(manager);
  const { nodes, tags, relationships, maps, timeline, graph } = workspace.services;
  await workspace.services.workspace.rename(workspace.id, 'Physics');

  const entropy = await nodes.create({ title: 'Entropy', summary: 'Disorder, counted.' });
  const heat = await nodes.create({ title: 'Heat' });
  const temperature = await nodes.create({ title: 'Temperature' });
  const lonely = await nodes.create({ title: 'Lonely idea' });

  const imagePath = join(sandbox, 'engine.png');
  writeFileSync(imagePath, PNG);
  const attachments = createAttachmentIpcServices({
    currentWorkspace: () => manager.current,
    maxAttachmentBytes: () => Promise.resolve(20 * 1024 * 1024),
    native: {
      chooseFiles: () => Promise.resolve([imagePath]),
      openFile: () => Promise.resolve(true),
    },
    logFailure: () => undefined,
  });
  const [attachment] = (await attachments['attachments:add']({ nodeId: entropy.id })).added;
  if (attachment === undefined) throw new Error('attachment was not added');

  await nodes.update(entropy.id, entropy.revision, {
    note: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Entropy grows as ' },
            { type: 'wikilink', attrs: { targetNodeId: heat.id, label: 'heat' } },
            { type: 'text', text: ' flows; ', marks: [{ type: 'bold' }] },
            { type: 'inlineMath', attrs: { latex: 'dS = \\delta Q / T' } },
            { type: 'text', text: ' and see ' },
            {
              type: 'wikilink',
              attrs: { targetNodeId: '0f0f0f0f-0000-4000-8000-000000000000', label: 'gone' },
            },
          ],
        },
        { type: 'blockMath', attrs: { latex: 'S = k_B \\ln W' } },
        {
          type: 'attachment',
          attrs: { attachmentId: attachment.id, displayName: 'engine.png', kind: 'image' },
        },
      ],
    },
  });

  await tags.assignToNode(entropy.id, 'thermo');
  await tags.assignToNode(heat.id, 'thermo');
  await tags.assignToNode(temperature.id, 'basics');

  const explains = await relationships.createType('explains', 'directed');
  const relatedTo = (await relationships.listTypes()).find((type) => type.label === 'related to');
  if (relatedTo === undefined) throw new Error('built-in type missing');
  const explainsHeat = await relationships.create({
    sourceNodeId: entropy.id,
    targetNodeId: heat.id,
    typeId: explains.id,
    description: 'Clausius',
  });
  await relationships.create({
    sourceNodeId: temperature.id,
    targetNodeId: heat.id,
    typeId: relatedTo.id,
  });

  let map = await maps.createMap('Thermo map', 'hierarchical');
  map = await maps.addPlacement(map.map.id, map.map.revision, { nodeId: entropy.id, x: 0, y: 0 });
  const root = map.placements[0]!.id;
  map = await maps.addPlacement(map.map.id, map.map.revision, {
    nodeId: heat.id,
    x: 100,
    y: 50,
    parentPlacementId: root,
  });
  map = await maps.addPlacement(map.map.id, map.map.revision, {
    nodeId: temperature.id,
    x: 100,
    y: 120,
    parentPlacementId: root,
  });
  const heatPlacement = map.placements.find((item) => item.nodeId === heat.id)!.id;
  map = await maps.setPlacementStyle(map.map.id, map.map.revision, heatPlacement, {
    color: 'amber',
  });
  map = await maps.addConnection(map.map.id, map.map.revision, {
    sourcePlacementId: root,
    targetPlacementId: heatPlacement,
    label: 'drives',
    relationshipId: explainsHeat.id,
  });
  map = await maps.setCollapsed(map.map.id, map.map.revision, root, true);
  await maps.setViewport(map.map.id, { x: 12, y: -8, zoom: 1.5 });
  const freeform = await maps.createMap('Scratch');
  await maps.addPlacement(freeform.map.id, freeform.map.revision, {
    nodeId: lonely.id,
    x: 10,
    y: 20,
  });

  await timeline.markReviewed(heat.id, 'Finally clear.', '2026-10-01T08:00:00.000Z');
  await timeline.addMilestone({
    title: 'Finished thermodynamics',
    details: 'All four laws.',
    nodeId: entropy.id,
    learnedAt: '2026-09-20T10:00:00.000Z',
  });
  await graph.savePositions([{ nodeId: entropy.id, x: 33, y: -44 }]);

  return { entropy, heat, attachment, root };
}

/** Compares imported data with the source through titles, since every ID is new. */
function byTitle(snapshot: WorkspaceSnapshot) {
  const titles = new Map(snapshot.nodes.map((node) => [node.id as string, node.title]));
  return { titles, title: (id: string | null) => (id === null ? null : (titles.get(id) ?? null)) };
}

describe('cancelling exports and imports', () => {
  it('a cancelled export leaves no archive and no partial file', async () => {
    const source = startApp('source');
    await source.startup();
    await buildSourceWorkspace(source);
    const folder = join(sandbox, 'exports');
    mkdirSync(folder);
    const archivePath = join(folder, 'physics.mmap.zip');

    const progress = cancelAt('Writing the archive');
    await expect(
      exportWorkspaceArchive(
        current(source),
        archivePath,
        { appVersion: 'test', now: () => new Date() },
        progress,
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

    expect(progress.phases).toEqual([
      'Reading the workspace',
      'Checking attached files',
      'Writing the archive',
    ]);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('a cancelled import adds nothing, keeps no copied files, and the import can run again', async () => {
    const source = startApp('source');
    await source.startup();
    await buildSourceWorkspace(source);
    const archivePath = join(sandbox, 'physics.mmap.zip');
    await transfer(source, archivePath)['transfer:export-zip']({});

    const destination = startApp('destination');
    await destination.startup();
    const target = current(destination);
    const attachmentsFolder = join(target.paths.folder, 'attachments');
    const filesBefore = readdirSync(attachmentsFolder, { recursive: true });
    const options = {
      ids: { newId: () => crypto.randomUUID() },
      maxAttachmentBytes: 20 * 1024 * 1024,
    };

    // Cancelled after the attached files were copied, just before the records are written.
    const prepared = await prepareImport(target, archivePath, options);
    const late = cancelAt('Copying attached files');
    await expect(applyImport(target, prepared, undefined, late)).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
    });
    expect(late.phases).not.toContain('Saving to the workspace');
    expect((await target.services.snapshots.read(target.id)).nodes).toEqual([]);
    expect(readdirSync(attachmentsFolder, { recursive: true })).toEqual(filesBefore);

    // Cancelling the preview stops it as well.
    await expect(
      prepareImport(target, archivePath, {
        ...options,
        progress: cancelAt('Checking attached files'),
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

    // Nothing was recorded as imported: a new import of the same archive is not a duplicate.
    const again = await prepareImport(target, archivePath, options);
    expect(again.earlierImports).toEqual([]);
    await applyImport(target, again);
    expect((await target.services.snapshots.read(target.id)).nodes.length).toBeGreaterThan(0);
  });
});

describe('workspace export and import (criterion 12)', () => {
  it.each([
    ['in the main process', writeImportInProcess],
    ['through a separate connection, as in the worker thread', writeLikeTheWorker],
  ])('round-trips every entity into a fresh workspace with new IDs (%s)', async (_, writer) => {
    const source = startApp('source');
    await source.startup();
    await buildSourceWorkspace(source);
    const archivePath = join(sandbox, 'physics.mmap.zip');
    const exported = await transfer(source, archivePath)['transfer:export-zip']({});
    expect(exported).toMatchObject({
      status: 'exported',
      fileName: 'physics.mmap.zip',
      warnings: [],
      counts: {
        nodes: 4,
        relationships: 2,
        maps: 2,
        placements: 4,
        connections: 1,
        attachments: 1,
      },
    });
    const sourceSnapshot = await current(source).services.snapshots.read(current(source).id);

    const destination = startApp('destination');
    await destination.startup();
    const target = current(destination);
    // Same tag in other letter case (merged), same type name with the other direction (renamed).
    const existing = await target.services.nodes.create({ title: 'Already here' });
    await target.services.tags.assignToNode(existing.id, 'Thermo');
    await target.services.relationships.createType('explains', 'undirected');

    const services = transfer(destination, archivePath, writer);
    const preview = await services['transfer:preview-import']({});
    if (preview.status !== 'ready') throw new Error('preview was cancelled');
    expect(preview).toMatchObject({
      source: { workspaceName: 'Physics', appVersion: 'test' },
      summary: {
        nodes: 4,
        newTags: 1,
        reusedTags: 1,
        newRelationshipTypes: 1,
        relationships: 2,
        maps: 2,
        placements: 4,
        connections: 1,
        attachments: 1,
      },
      previousImports: [],
      sameWorkspace: false,
    });
    expect(preview.warnings).toEqual([
      '1 note link points to nodes that are not in the archive. They are kept as unresolved links.',
      'The relationship type "explains" already exists here with a different direction. The ' +
        'imported one is named "explains (imported)".',
    ]);
    // Nothing is written by the preview.
    expect(
      (await target.services.nodes.list({ sort: 'title-asc', page: { limit: 50 } })).items,
    ).toHaveLength(1);

    await services['transfer:apply-import']({
      importToken: preview.importToken,
      acceptDuplicate: false,
    });

    const imported = await target.services.snapshots.read(target.id);
    const { titles, title } = byTitle(imported);
    const idOf = (name: string) => imported.nodes.find((node) => node.title === name)!.id;
    const sourceIds = new Set(sourceSnapshot.nodes.map((node) => node.id as string));
    expect([...titles.keys()].some((id) => sourceIds.has(id))).toBe(false);
    expect([...titles.values()].sort()).toEqual([
      'Already here',
      'Entropy',
      'Heat',
      'Lonely idea',
      'Temperature',
    ]);

    // Notes: content kept, wikilinks and attachment blocks rewritten to the new IDs.
    const entropy = imported.nodes.find((node) => node.title === 'Entropy')!;
    expect(entropy.summary).toBe('Disorder, counted.');
    const note = JSON.parse(entropy.noteJson) as {
      content: [
        { content: { attrs?: { targetNodeId?: string } }[] },
        unknown,
        { attrs: { attachmentId: string } },
      ];
    };
    expect(note.content[0].content[1]!.attrs!.targetNodeId).toBe(idOf('Heat'));
    expect(note.content[0].content[5]!.attrs!.targetNodeId).not.toBe(
      '0f0f0f0f-0000-4000-8000-000000000000',
    );
    expect(entropy.notePlainText).toContain('S = k_B \\ln W');
    const backlinks = await target.services.nodes.backlinks(idOf('Heat'));
    expect(backlinks.map((link) => link.sourceTitle)).toEqual(['Entropy']);

    // Attachment: new ID referenced by the note, same bytes and checksum.
    const [attachment] = imported.attachments;
    expect(note.content[2].attrs.attachmentId).toBe(attachment!.id);
    expect(attachment).toMatchObject({
      nodeId: idOf('Entropy'),
      originalName: 'engine.png',
      mimeType: 'image/png',
    });
    const storedPath = await target.attachmentStore.resolveExisting(attachment!.relativePath);
    expect(createHash('sha256').update(readFileSync(storedPath!)).digest('hex')).toBe(
      createHash('sha256').update(PNG).digest('hex'),
    );

    // Tags merged by label.
    const tagsByLabel = new Map(imported.tags.map((tag) => [tag.normalizedLabel, tag]));
    expect(imported.tags.map((tag) => tag.displayLabel).sort()).toEqual(['Thermo', 'basics']);
    const thermoHolders = imported.nodeTags
      .filter((assignment) => assignment.tagId === tagsByLabel.get('thermo')!.id)
      .map((assignment) => title(assignment.nodeId))
      .sort();
    expect(thermoHolders).toEqual(['Already here', 'Entropy', 'Heat']);

    // Relationships keep direction; undirected endpoints are in canonical order for the new IDs.
    const types = new Map(imported.relationshipTypes.map((type) => [type.id as string, type]));
    const described = imported.relationships.map((relationship) => ({
      source: title(relationship.sourceNodeId),
      target: title(relationship.targetNodeId),
      type: types.get(relationship.typeId)!.label,
      directionality: relationship.directionality,
      description: relationship.description,
      canonical:
        relationship.directionality === 'directed' ||
        relationship.sourceNodeId < relationship.targetNodeId,
    }));
    expect(described).toContainEqual({
      source: 'Entropy',
      target: 'Heat',
      type: 'explains (imported)',
      directionality: 'directed',
      description: 'Clausius',
      canonical: true,
    });
    expect(described.find((item) => item.type === 'related to')).toMatchObject({
      directionality: 'undirected',
      canonical: true,
    });
    const relatedTo = imported.relationshipTypes.filter((type) => type.label === 'related to');
    expect(relatedTo).toHaveLength(1);

    // Maps: mode, viewport, hierarchy, order, collapse, color, connector and its relationship.
    const thermoMap = imported.maps.find((map) => map.title === 'Thermo map')!;
    expect(thermoMap).toMatchObject({
      mode: 'hierarchical',
      viewport: { x: 12, y: -8, zoom: 1.5 },
    });
    const placements = imported.placements.filter((placement) => placement.mapId === thermoMap.id);
    const placementOf = (name: string) => placements.find((item) => title(item.nodeId) === name)!;
    expect(placementOf('Entropy')).toMatchObject({ parentPlacementId: null, isCollapsed: true });
    expect(placementOf('Heat')).toMatchObject({
      parentPlacementId: placementOf('Entropy').id,
      style: { color: 'amber' },
    });
    expect(placementOf('Temperature').parentPlacementId).toBe(placementOf('Entropy').id);
    const sourcePlacements = sourceSnapshot.placements;
    const sourceTitles = byTitle(sourceSnapshot);
    for (const name of ['Heat', 'Temperature']) {
      const original = sourcePlacements.find((item) => sourceTitles.title(item.nodeId) === name)!;
      expect(placementOf(name).siblingOrder).toBe(original.siblingOrder);
    }
    const [connector] = imported.connections;
    expect(connector).toMatchObject({
      mapId: thermoMap.id,
      sourcePlacementId: placementOf('Entropy').id,
      targetPlacementId: placementOf('Heat').id,
      label: 'drives',
    });
    expect(
      imported.relationships.find((item) => item.id === connector!.relationshipId),
    ).toBeDefined();
    const scratch = imported.maps.find((map) => map.title === 'Scratch')!;
    expect(imported.placements.find((item) => item.mapId === scratch.id)).toMatchObject({
      x: 10,
      y: 20,
    });

    // Timeline: history kept and marked as imported.
    const events = imported.timelineEvents.filter((event) => event.isImported);
    expect(events.length).toBe(sourceSnapshot.timelineEvents.length);
    // The only event not imported is the destination's own node creation.
    expect(
      imported.timelineEvents
        .filter((event) => !event.isImported)
        .map((event) => event.nodeTitleSnapshot),
    ).toEqual(['Already here']);
    expect(events[0]!.importOrigin).toMatch(/^Physics \(exported \d{4}-\d{2}-\d{2}\)$/u);
    expect(events.find((event) => event.eventType === 'milestone')).toMatchObject({
      title: 'Finished thermodynamics',
      reflection: 'All four laws.',
      learnedAt: '2026-09-20T10:00:00.000Z',
      nodeId: idOf('Entropy'),
    });
    expect(events.find((event) => event.eventType === 'reviewed')).toMatchObject({
      reflection: 'Finally clear.',
      learnedAt: '2026-10-01T08:00:00.000Z',
      nodeId: idOf('Heat'),
    });

    // Graph positions follow their nodes.
    expect(imported.graphPositions).toEqual([{ nodeId: idOf('Entropy'), x: 33, y: -44 }]);

    // Search finds imported notes.
    const hits = await target.services.search.search({
      workspaceId: target.id,
      text: 'disorder',
      tagIds: [],
      page: { limit: 10 },
    });
    expect(hits.items.map((hit) => hit.title)).toEqual(['Entropy']);
  });

  it('leaves nothing behind when the worker path fails part-way, and stays usable', async () => {
    const source = startApp('source');
    await source.startup();
    await current(source).services.nodes.create({ title: 'First' });
    await current(source).services.nodes.create({ title: 'Second' });
    const archivePath = join(sandbox, 'two.mmap.zip');
    await transfer(source, archivePath)['transfer:export-zip']({});

    const destination = startApp('destination');
    await destination.startup();
    const target = current(destination);
    await target.services.nodes.create({ title: 'Already here' });
    // The second insert of the same node fails inside the worker's transaction.
    const failing: ImportRecordWriter = (workspace, plan, exportId, storedFiles) =>
      writeLikeTheWorker(
        workspace,
        { ...plan, nodes: [...plan.nodes, plan.nodes[0]!] },
        exportId,
        storedFiles,
      );
    const services = transfer(destination, archivePath, failing);
    const preview = await services['transfer:preview-import']({});
    if (preview.status !== 'ready') throw new Error('cancelled');
    await expect(
      services['transfer:apply-import']({
        importToken: preview.importToken,
        acceptDuplicate: false,
      }),
    ).rejects.toThrow();

    const titles = (await target.services.snapshots.read(target.id)).nodes.map(
      (node) => node.title,
    );
    expect(titles).toEqual(['Already here']);
    // The write queue was released: ordinary saves work again.
    await target.services.nodes.create({ title: 'After the failure' });
    expect((await target.services.snapshots.read(target.id)).nodes).toHaveLength(2);
  });

  it('warns before importing the same archive again', async () => {
    const source = startApp('source');
    await source.startup();
    await current(source).services.nodes.create({ title: 'Only node' });
    const archivePath = join(sandbox, 'one.mmap.zip');
    await transfer(source, archivePath)['transfer:export-zip']({});

    const destination = startApp('destination');
    await destination.startup();
    const services = transfer(destination, archivePath);
    const first = await services['transfer:preview-import']({});
    if (first.status !== 'ready') throw new Error('cancelled');
    await services['transfer:apply-import']({
      importToken: first.importToken,
      acceptDuplicate: false,
    });

    const second = await services['transfer:preview-import']({});
    if (second.status !== 'ready') throw new Error('cancelled');
    expect(second.previousImports).toHaveLength(1);
    await expect(
      services['transfer:apply-import']({
        importToken: second.importToken,
        acceptDuplicate: false,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
    await services['transfer:apply-import']({
      importToken: second.importToken,
      acceptDuplicate: true,
    });

    const target = current(destination);
    const titles = (await target.services.snapshots.read(target.id)).nodes.map(
      (node) => node.title,
    );
    expect(titles).toEqual(['Only node', 'Only node']);
  });

  it('refuses a token from an earlier preview', async () => {
    const source = startApp('source');
    await source.startup();
    const archivePath = join(sandbox, 'empty.mmap.zip');
    const services = transfer(source, archivePath);
    await services['transfer:export-zip']({});
    const first = await services['transfer:preview-import']({});
    if (first.status !== 'ready') throw new Error('cancelled');
    expect(first.sameWorkspace).toBe(true);
    await services['transfer:preview-import']({});
    await expect(
      services['transfer:apply-import']({ importToken: first.importToken, acceptDuplicate: true }),
    ).rejects.toMatchObject({ code: 'IMPORT_EXPIRED' });
  });
});
