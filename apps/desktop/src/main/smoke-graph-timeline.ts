/**
 * Smoke checks for the knowledge graph and the timeline inside the packaged app (PRD §11:
 * installed-app end-to-end; PRD §9 graph rendering budget).
 *
 * The large graph is seeded through the workspace services in the main process, because creating
 * 1,000 nodes and 3,000 relationships one bridge call at a time would measure the bridge, not the
 * graph. The measured part goes through the real renderer: from opening the Knowledge Graph view
 * until all 1,000 nodes are drawn and fitted to the view. (A graph this large is not laid out
 * automatically on opening; new nodes get stable placements, and Rearrange is a user action.)
 */

import type { NodeId, RelationshipTypeId } from '@mmap/domain';
import type { BrowserWindow } from 'electron';

import type { WorkspaceManager } from './workspaces/workspace-manager';

/** PRD §9: "Render an initial graph capped at 1,000 nodes/3,000 edges within 3 seconds". */
const GRAPH_NODES = 1_000;
const GRAPH_EDGES = 3_000;
const GRAPH_BUDGET_MS = 3_000;

/** Seeds a graph of exactly 1,000 nodes and 3,000 relationships; returns the node IDs. */
async function seedGraph(workspaces: WorkspaceManager): Promise<NodeId[]> {
  const workspace = workspaces.current;
  if (workspace === null) throw new Error('No workspace is open.');
  const { nodes, relationships } = workspace.services;
  const types = await relationships.listTypes();
  const typeIds = types.filter((type) => !type.isArchived).map((type) => type.id);
  const ids: NodeId[] = [];
  await workspace.connections.runInTransaction(async () => {
    for (let index = 0; index < GRAPH_NODES; index += 1) {
      ids.push((await nodes.create({ title: `Graph smoke ${index}` })).id);
    }
    // Deterministic, distinct pairs: each node links to three others at fixed offsets.
    const offsets = [1, 7, 31];
    for (let index = 0; index < GRAPH_NODES; index += 1) {
      for (const [position, offset] of offsets.entries()) {
        const typeId = typeIds[(index + position) % typeIds.length] as RelationshipTypeId;
        await relationships.create({
          sourceNodeId: ids[index] as NodeId,
          targetNodeId: ids[(index + offset) % GRAPH_NODES] as NodeId,
          typeId,
        });
      }
    }
  });
  return ids;
}

async function removeNodes(workspaces: WorkspaceManager, ids: readonly NodeId[]): Promise<void> {
  const workspace = workspaces.current;
  if (workspace === null) return;
  await workspace.connections.runInTransaction(async () => {
    for (const id of ids) {
      const node = await workspace.services.nodes.get(id);
      await workspace.services.nodes.delete(id, node.revision);
    }
  });
}

/** Opens the graph view and returns the time until 1,000 laid-out nodes are on the canvas. */
export async function checkGraphRendering(
  window: BrowserWindow,
  workspaces: WorkspaceManager,
): Promise<number> {
  const ids = await seedGraph(workspaces);
  try {
    const outcome = (await window.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const button = (text) =>
          [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
        button('Library').click();
        await wait(200);
        const start = performance.now();
        button('Knowledge Graph').click();
        while (performance.now() - start < 15000) {
          const canvas = document.querySelector('[data-rendered-nodes]');
          if (canvas && canvas.dataset.renderedNodes === '${GRAPH_NODES}') {
            const elapsed = Math.round(performance.now() - start);
            // The statement must match the real total: complete only when nothing is left out
            // (earlier checks may have left other nodes in this workspace).
            const total = (await window.mmap.graph.overview({})).data.totalNodes;
            const status = document.querySelector('[role="status"]')?.textContent ?? '';
            const expected = total > ${GRAPH_NODES}
              ? 'Partial view: showing ' + (${GRAPH_NODES}).toLocaleString() + ' of ' + total.toLocaleString()
              : 'Showing all ' + total.toLocaleString();
            if (!status.includes(expected)) return 'status "' + status + '" does not say "' + expected + '"';
            return 'ok:' + elapsed;
          }
          await wait(20);
        }
        return 'graph did not render ${GRAPH_NODES} nodes (' +
          (document.querySelector('[data-rendered-nodes]')?.dataset.renderedNodes ?? 'none') + ')';
      })()`)) as string;
    if (!outcome.startsWith('ok:')) throw new Error(outcome);
    const elapsed = Number(outcome.slice(3));
    if (elapsed > GRAPH_BUDGET_MS) {
      throw new Error(`Rendering ${GRAPH_NODES} nodes / ${GRAPH_EDGES} edges took ${elapsed} ms`);
    }
    return elapsed;
  } finally {
    await removeNodes(workspaces, ids);
  }
}

/** Marks a node as reviewed through the bridge and finds the entry in the Timeline view. */
export async function checkTimeline(window: BrowserWindow): Promise<void> {
  const outcome = (await window.webContents.executeJavaScript(`
    (async () => {
      const { nodes, timeline } = window.mmap;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const button = (text) =>
        [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
      const node = (await nodes.create({ title: 'Timeline smoke node' })).data;
      const review = await timeline.markReviewed({ nodeId: node.id, reflection: 'Smoke reflection' });
      if (!review.ok) return 'mark reviewed failed: ' + review.error.code;
      const recorded = await timeline.list({ limit: 5, eventTypes: ['reviewed'] });
      if (!recorded.ok || recorded.data.items[0]?.id !== review.data.id) return 'review not listed';
      button('Timeline').click();
      const start = performance.now();
      while (performance.now() - start < 5000) {
        if (document.body.textContent.includes('Smoke reflection')) break;
        await wait(20);
      }
      if (!document.body.textContent.includes('Smoke reflection')) return 'timeline view did not show the review';
      await timeline.deleteReviewed({ eventId: review.data.id });
      await nodes.delete({ nodeId: node.id, expectedRevision: node.revision });
      button('Library').click();
      return 'ok';
    })()`)) as string;
  if (outcome !== 'ok') throw new Error(outcome);
}
