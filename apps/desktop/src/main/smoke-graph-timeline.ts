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

/**
 * Marks a node as reviewed and adds a milestone through the bridge, checks the window query, and
 * finds both markers on the visual timeline.
 */
/**
 * PRD §5.5 "graph action": in the Knowledge Graph, select a node, open "Add relationship", choose
 * the other node with Find, clear it, choose it again by clicking it on the canvas (real mouse
 * input at the position Cytoscape reports for it), and save. The relationship must exist
 * afterwards, and the selection must not have moved to the other node.
 */
export async function checkGraphRelationship(window: BrowserWindow): Promise<void> {
  const run = (code: string) => window.webContents.executeJavaScript(code) as Promise<string>;
  const helpers = `
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (predicate, timeoutMs) => {
      const start = performance.now();
      while (performance.now() - start < timeoutMs) {
        if (predicate()) return true;
        await wait(20);
      }
      return false;
    };
    const buttonWithText = (text) =>
      [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text);
    const press = (element, what) => {
      if (!element) throw new Error(what + ' not found');
      element.click();
    };
    const find = async (title) => {
      const box = document.querySelector('input[placeholder="Find in graph"]');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setValue.call(box, title);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      if (!(await until(() => buttonWithText(title), 3000))) throw new Error('Find did not list ' + title);
      press(buttonWithText(title), 'Find result ' + title);
    };`;
  const prepared = await run(`(async () => {
    ${helpers}
    const { nodes } = window.mmap;
    const source = (await nodes.create({ title: 'Smoke graph source' })).data;
    const target = (await nodes.create({ title: 'Smoke graph target' })).data;
    window.__smokeRelation = { source: source.id, target: target.id };
    press(buttonWithText('Home'), 'Home');
    await wait(300);
    press(buttonWithText('Knowledge Graph'), 'Knowledge Graph');
    if (!(await until(() => document.querySelector('input[placeholder="Find in graph"]'), 5000))) return 'graph view not shown';
    await wait(1000);
    await find('Smoke graph source');
    if (!(await until(() => document.querySelector('aside[aria-label="Selected node"]')?.textContent.includes('Smoke graph source'), 3000))) return 'source not selected';
    press(buttonWithText('Add relationship'), 'Add relationship');
    if (!(await until(() => document.querySelector('section[aria-label="Add a relationship"] form'), 3000))) return 'form not shown';
    await find('Smoke graph target');
    const chip = () => document.querySelector('button[aria-label="Choose a different node instead of Smoke graph target"]');
    if (!(await until(chip, 3000))) return 'Find did not choose the other node';
    if (!document.querySelector('aside[aria-label="Selected node"]')?.textContent.includes('Smoke graph source')) return 'Find changed the selection while relating';
    press(chip(), 'clear chosen node');
    if (!(await until(() => !chip(), 3000))) return 'chosen node not cleared';
    await wait(800);
    // Cytoscape draws on a canvas; it registers itself on its container (\`_cyreg\`), which gives
    // the target's position on screen.
    const container = document.querySelector('div[role="img"][aria-label^="Knowledge graph."]');
    const cy = container?._cyreg?.cy;
    if (!cy) return 'canvas not found';
    const position = cy.getElementById(window.__smokeRelation.target).renderedPosition();
    const box = container.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(box.x + position.x), y: Math.round(box.y + position.y) });
  })()`);
  if (!prepared.startsWith('{')) throw new Error(prepared);
  const target = JSON.parse(prepared) as { x: number; y: number };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...target });
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    ...target,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 });
  const outcome = await run(`(async () => {
    ${helpers}
    const chip = () => document.querySelector('button[aria-label="Choose a different node instead of Smoke graph target"]');
    if (!(await until(chip, 3000))) return 'clicking the node on the graph did not choose it';
    if (!document.querySelector('aside[aria-label="Selected node"] h2')?.textContent.includes('Smoke graph source')) return 'the click changed the selection while relating';
    const form = document.querySelector('section[aria-label="Add a relationship"] form');
    press([...form.querySelectorAll('button[type="submit"]')][0], 'save');
    if (!(await until(() => !document.querySelector('section[aria-label="Add a relationship"]'), 3000))) return 'form did not close after saving';
    const { source, target } = window.__smokeRelation;
    const related = (await window.mmap.relationships.listForNode({ nodeId: source })).data.items;
    if (!related.some((item) => new Set([item.source.id, item.target.id]).has(target))) return 'relationship not saved';
    for (const nodeId of [source, target]) {
      const node = (await window.mmap.nodes.get({ nodeId })).data;
      await window.mmap.nodes.delete({ nodeId, expectedRevision: node.revision });
    }
    press(buttonWithText('Home'), 'Home');
    return 'ok';
  })()`);
  if (outcome !== 'ok') throw new Error(outcome);
}

export async function checkTimeline(window: BrowserWindow): Promise<void> {
  const outcome = (await window.webContents.executeJavaScript(`
    (async () => {
      const { nodes, timeline } = window.mmap;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const button = (text) =>
        [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
      const marker = (text) =>
        [...document.querySelectorAll('svg [role="button"]')].find((item) =>
          (item.getAttribute('aria-label') ?? '').includes(text),
        );
      const node = (await nodes.create({ title: 'Timeline smoke node' })).data;
      const review = await timeline.markReviewed({ nodeId: node.id, reflection: 'Smoke reflection' });
      if (!review.ok) return 'mark reviewed failed: ' + review.error.code;
      const recorded = await timeline.list({ limit: 5, eventTypes: ['reviewed'] });
      if (!recorded.ok || recorded.data.items[0]?.id !== review.data.id) return 'review not listed';
      const learnedAt = new Date(Date.now() - 3 * 3600000).toISOString();
      const milestone = await timeline.addMilestone({
        title: 'Smoke milestone',
        details: null,
        nodeId: node.id,
        learnedAt,
      });
      if (!milestone.ok || milestone.data.learnedAt !== learnedAt) return 'add milestone failed';
      const range = await timeline.window({
        fromUtc: new Date(Date.now() - 7 * 86400000).toISOString(),
        toUtcExclusive: new Date(Date.now() + 86400000).toISOString(),
        eventTypes: ['milestone'],
      });
      if (!range.ok || !range.data.items.some((item) => item.id === milestone.data.id)) {
        return 'window query missed the milestone';
      }
      // Only reviews and milestones, at day zoom, so other activity never clusters with them.
      button('Timeline').click();
      await wait(100);
      button('Filters').click();
      await wait(50);
      button('Reviews').click();
      button('Milestones').click();
      button('Day').click();
      const start = performance.now();
      while (performance.now() - start < 5000) {
        if (marker('Smoke milestone') && marker('Reviewed Timeline smoke node')) break;
        await wait(20);
      }
      if (!marker('Smoke milestone')) return 'timeline did not show the milestone marker';
      if (!marker('Reviewed Timeline smoke node')) return 'timeline did not show the review marker';
      marker('Reviewed Timeline smoke node').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      while (performance.now() - start < 5000) {
        if (document.querySelector('aside[aria-label="Timeline event"]')) break;
        await wait(20);
      }
      const panel = document.querySelector('aside[aria-label="Timeline event"]');
      if (!panel || !panel.textContent.includes('Open Timeline smoke node')) {
        return 'event panel did not open';
      }
      await timeline.deleteEntry({ eventId: milestone.data.id });
      await timeline.deleteEntry({ eventId: review.data.id });
      await nodes.delete({ nodeId: node.id, expectedRevision: node.revision });
      button('Library').click();
      return 'ok';
    })()`)) as string;
  if (outcome !== 'ok') throw new Error(outcome);
}
