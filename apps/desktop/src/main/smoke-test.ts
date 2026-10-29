/**
 * Packaged-app smoke test (PRD §11: "desktop smoke tests"; Phase 0 exit: "packaged app launches
 * offline; migrations pass").
 *
 * Started with `--smoke-test --smoke-report=<file>`. Runs inside the real packaged runtime and
 * checks the things unit tests cannot: the bundled SQLite engine, migrations, the custom protocol,
 * CSP, the preload bridge, and renderer isolation. Writes a JSON report and exits with code 0 on
 * success or 1 on failure. The window is never shown.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifySchemaOnFreshDatabase } from '@mmap/storage-sqlite';
import type { BrowserWindow } from 'electron';

import { checkAttachmentPreview } from './smoke-attachments';
import {
  checkGraphMapGroups,
  checkGraphRelationship,
  checkGraphRendering,
  checkTimeline,
} from './smoke-graph-timeline';
import type { ImportRecordWriter } from './portability/import-writer';
import { checkExportImport } from './smoke-transfer';
import { checkBackupAndRestore } from './smoke-backups';
import { checkAccessibility } from './smoke-accessibility';
import type { BackupService } from './backups/backup-service';
import type { WorkspaceManager } from './workspaces/workspace-manager';

export interface SmokeTestCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface SmokeTestReport {
  readonly passed: boolean;
  readonly checks: readonly SmokeTestCheck[];
}

const SMOKE_TEST_FLAG = '--smoke-test';
const REPORT_FLAG_PREFIX = '--smoke-report=';
const RENDERER_LOAD_TIMEOUT_MS = 30_000;

export function isSmokeTestRun(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_TEST_FLAG);
}

/** Path of axe-core's script, passed by the smoke runner; the check is skipped without it. */
export function smokeAxePath(argv: readonly string[]): string | undefined {
  return argv.find((argument) => argument.startsWith('--smoke-axe='))?.slice('--smoke-axe='.length);
}

export function smokeReportPath(argv: readonly string[]): string | undefined {
  return argv
    .find((argument) => argument.startsWith(REPORT_FLAG_PREFIX))
    ?.slice(REPORT_FLAG_PREFIX.length);
}

export async function runSmokeTest(
  window: BrowserWindow,
  workspaces: WorkspaceManager,
  backups: BackupService,
  importRecordWriter: ImportRecordWriter,
  axePath?: string,
): Promise<SmokeTestReport> {
  const checks: SmokeTestCheck[] = [];

  checks.push(await check('sqlite migrations, FTS5 and integrity on a fresh file', verifyStorage));
  checks.push(await check('renderer loads from app protocol', () => waitForRendererLoad(window)));
  checks.push(
    await check('React shell renders main navigation', async () => {
      // Proves bundled scripts and styles were allowed by the CSP and React mounted.
      const rendered = (await window.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            if (document.querySelector('nav[aria-label="Main"]')) return resolve(true);
            if (Date.now() > deadline) return resolve(false);
            setTimeout(poll, 50);
          };
          poll();
        })`)) as boolean;
      if (!rendered) {
        throw new Error('Main navigation did not render.');
      }
    }),
  );
  checks.push(
    await check('preload bridge returns app info over IPC', async () => {
      const result = (await window.webContents.executeJavaScript('window.mmap.app.getInfo()')) as {
        ok: boolean;
        data?: { storage?: { fts5Available?: boolean } };
      };
      if (!result.ok || result.data?.storage?.fts5Available !== true) {
        throw new Error(`Unexpected response: ${JSON.stringify(result)}`);
      }
    }),
  );
  checks.push(
    await check('first-run workspace is created and open', async () => {
      const result = (await window.webContents.executeJavaScript(
        'window.mmap.workspace.getState()',
      )) as { ok: boolean; data?: { status?: string } };
      if (!result.ok || result.data?.status !== 'open') {
        throw new Error(`Unexpected workspace state: ${JSON.stringify(result)}`);
      }
    }),
  );
  checks.push(
    await check('node create, save, conflict and delete through the bridge', async () => {
      // Runs in the renderer, exactly like the UI does, so request and response contracts are
      // validated by the real IPC layer.
      const outcome = (await window.webContents.executeJavaScript(`
        (async () => {
          const api = window.mmap.nodes;
          const created = await api.create({ title: 'Smoke test node' });
          if (!created.ok) return 'create failed: ' + created.error.code;
          const note = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved text' }] }] };
          const saved = await api.update({ nodeId: created.data.id, expectedRevision: 1, changes: { note } });
          if (!saved.ok || saved.data.revision !== 2) return 'save failed';
          const stale = await api.update({ nodeId: created.data.id, expectedRevision: 1, changes: { title: 'stale' } });
          if (stale.ok || stale.error.code !== 'REVISION_CONFLICT') return 'stale save was not rejected';
          const reloaded = await api.get({ nodeId: created.data.id });
          if (!reloaded.ok || reloaded.data.note.content[0].content[0].text !== 'Saved text') return 'note did not round-trip';
          const tagged = await api.addTag({ nodeId: created.data.id, label: 'Smoke Tag' });
          if (!tagged.ok || tagged.data.tags[0].label !== 'Smoke Tag') return 'tagging failed';
          const filtered = await api.list({ sort: 'title-asc', limit: 10, tagIds: [tagged.data.tags[0].id] });
          if (!filtered.ok || filtered.data.totalCount !== 1) return 'tag filter failed';
          const deleted = await api.delete({ nodeId: created.data.id, expectedRevision: 2 });
          return deleted.ok ? 'ok' : 'delete failed';
        })()`)) as string;
      if (outcome !== 'ok') {
        throw new Error(outcome);
      }
    }),
  );
  checks.push(
    await check('relationships, wikilinks, backlinks and search through the bridge', async () => {
      const outcome = (await window.webContents.executeJavaScript(`
        (async () => {
          const { nodes, relationships, relationshipTypes, search } = window.mmap;
          const a = (await nodes.create({ title: 'Smoke source' })).data;
          const b = (await nodes.create({ title: 'Smoke target zebra' })).data;
          const types = (await relationshipTypes.list()).data.items;
          const dependsOn = types.find((t) => t.label === 'depends on');
          const relatedTo = types.find((t) => t.label === 'related to');
          const directed = await relationships.create({ sourceNodeId: a.id, targetNodeId: b.id, typeId: dependsOn.id });
          if (!directed.ok || directed.data.source.id !== a.id) return 'directed relationship failed';
          await relationships.create({ sourceNodeId: a.id, targetNodeId: b.id, typeId: relatedTo.id });
          const reversed = await relationships.create({ sourceNodeId: b.id, targetNodeId: a.id, typeId: relatedTo.id });
          if (reversed.ok || reversed.error.code !== 'DUPLICATE') return 'reversed undirected duplicate was not rejected';
          const note = { type: 'doc', content: [{ type: 'paragraph', content: [
            { type: 'text', text: 'Unicorn notes about ' },
            { type: 'wikilink', attrs: { targetNodeId: b.id, label: 'the target' } } ] }] };
          const saved = await nodes.update({ nodeId: a.id, expectedRevision: a.revision, changes: { note } });
          if (!saved.ok) return 'saving a note with a wikilink failed: ' + saved.error.code;
          const backlinks = await nodes.backlinks({ nodeId: b.id });
          if (!backlinks.ok || backlinks.data.items[0]?.sourceNodeId !== a.id) return 'backlink missing';
          const found = await search.query({ text: 'unicorn', limit: 10 });
          if (!found.ok || found.data.items[0]?.nodeId !== a.id) return 'search did not find the note';
          const contradicts = types.find((t) => t.label === 'contradicts');
          const byType = await search.query({ text: 'unicorn', relationshipTypeIds: [dependsOn.id], limit: 10 });
          if (!byType.ok || byType.data.items[0]?.nodeId !== a.id) return 'relationship-type filter dropped the note';
          const byOtherType = await search.query({ text: 'unicorn', relationshipTypeIds: [contradicts.id], limit: 10 });
          if (!byOtherType.ok || byOtherType.data.totalCount !== 0) return 'relationship-type filter let an unrelated note through';
          const lookup = await nodes.lookup({ text: 'smoke target' });
          if (!lookup.ok || lookup.data.items[0]?.id !== b.id) return 'title lookup failed';
          await nodes.delete({ nodeId: a.id, expectedRevision: saved.data.revision });
          await nodes.delete({ nodeId: b.id, expectedRevision: b.revision });
          return 'ok';
        })()`)) as string;
      if (outcome !== 'ok') {
        throw new Error(outcome);
      }
    }),
  );
  checks.push(
    // PRD §13 acceptance criteria 6 and 8 through the real bridge: one node on two maps shows
    // the same title, moving it on one map leaves the other, and deleting a map keeps the node.
    await check('mind maps reuse nodes, persist layout and keep nodes on delete', async () => {
      const outcome = (await window.webContents.executeJavaScript(`
        (async () => {
          const { nodes, maps } = window.mmap;
          const node = (await nodes.create({ title: 'Smoke map node' })).data;
          let first = (await maps.create({ title: 'Smoke map one' })).data;
          let second = (await maps.create({ title: 'Smoke map two', mode: 'hierarchical' })).data;
          first = (await maps.addPlacement({ mapId: first.map.id, expectedRevision: first.map.revision, nodeId: node.id, x: 0, y: 0 })).data;
          second = (await maps.addPlacement({ mapId: second.map.id, expectedRevision: second.map.revision, nodeId: node.id, x: 0, y: 0 })).data;
          const placement = first.placements[0];
          const moved = await maps.movePlacements({ mapId: first.map.id, expectedRevision: first.map.revision, changes: [{ placementId: placement.id, x: 400, y: 300 }] });
          if (!moved.ok) return 'moving a placement failed: ' + moved.error.code;
          await nodes.update({ nodeId: node.id, expectedRevision: node.revision, changes: { title: 'Smoke map node renamed' } });
          const reloaded = (await maps.get({ mapId: second.map.id })).data;
          if (reloaded.placements[0]?.nodeTitle !== 'Smoke map node renamed') return 'title not shared between maps';
          if (reloaded.placements[0]?.x !== 0) return 'moving on one map changed the other';
          const stale = await maps.rename({ mapId: first.map.id, expectedRevision: first.map.revision, title: 'Stale' });
          if (stale.ok || stale.error.code !== 'REVISION_CONFLICT') return 'stale map revision was accepted';
          await maps.delete({ mapId: first.map.id });
          await maps.delete({ mapId: second.map.id });
          const stillThere = await nodes.get({ nodeId: node.id });
          if (!stillThere.ok) return 'deleting maps deleted the node';
          await nodes.delete({ nodeId: node.id, expectedRevision: stillThere.data.revision });
          return 'ok';
        })()`)) as string;
      if (outcome !== 'ok') {
        throw new Error(outcome);
      }
    }),
  );
  checks.push(
    // Renders the real map editor (React Flow under the production CSP) and measures PRD §9
    // "open a 200-placement map within 2 seconds of data availability".
    await check('200-placement map opens in the editor within 2 seconds', async () => {
      const outcome = (await window.webContents.executeJavaScript(`
        (async () => {
          const { nodes, maps } = window.mmap;
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
            [...document.querySelectorAll('button')].find((button) => button.textContent.includes(text));
          let view = (await maps.create({ title: 'Smoke large map' })).data;
          for (let index = 0; index < 200; index += 1) {
            view = (await maps.addPlacement({ mapId: view.map.id, expectedRevision: view.map.revision,
              newNodeTitle: 'Smoke item ' + index, x: (index % 20) * 220, y: Math.floor(index / 20) * 80 })).data;
          }
          buttonWithText('Mind Maps').click();
          if (!(await until(() => buttonWithText('Smoke large map'), 3000))) return 'map list did not show the map';
          const start = performance.now();
          buttonWithText('Smoke large map').click();
          const rendered = await until(() => document.querySelectorAll('.react-flow__node').length === 200, 5000);
          const elapsed = Math.round(performance.now() - start);
          if (!rendered) return 'map editor did not render 200 items (' + document.querySelectorAll('.react-flow__node').length + ')';
          if (elapsed > 2000) return 'opening took ' + elapsed + ' ms';
          if (!document.querySelector('[role="tree"]')) return 'outline missing';
          buttonWithText('All maps').click();
          await maps.delete({ mapId: view.map.id });
          return 'ok:' + elapsed;
        })()`)) as string;
      if (!outcome.startsWith('ok')) {
        throw new Error(outcome);
      }
      console.log(`      map open time: ${outcome.slice(3)} ms`);
    }),
  );
  checks.push(
    await check(
      'double-clicking a map item previews its note (freeform and hierarchy); the pencil opens the editor',
      async () => {
        for (const mode of ['freeform', 'hierarchical'] as const) {
          await previewByDoubleClick(window, mode);
        }
      },
    ),
  );
  checks.push(
    await check(
      'a connector note, a linked and a newly created relationship are saved and shown',
      async () => {
        const outcome = (await window.webContents.executeJavaScript(`
        (async () => {
          const { nodes, maps } = window.mmap;
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
            [...document.querySelectorAll('button')].find((button) => button.textContent.includes(text));
          const press = (element, what) => {
            if (!element) throw new Error(what + ' not found');
            element.click();
          };
          const a = (await nodes.create({ title: 'Smoke note source' })).data;
          const b = (await nodes.create({ title: 'Smoke note target' })).data;
          let view = (await maps.create({ title: 'Smoke connector note' })).data;
          view = (await maps.addPlacement({ mapId: view.map.id, expectedRevision: view.map.revision, nodeId: a.id, x: 0, y: 0 })).data;
          view = (await maps.addPlacement({ mapId: view.map.id, expectedRevision: view.map.revision, nodeId: b.id, x: 400, y: 0 })).data;
          view = (await maps.addConnection({ mapId: view.map.id, expectedRevision: view.map.revision,
            sourcePlacementId: view.placements[0].id, targetPlacementId: view.placements[1].id })).data;
          const mapId = view.map.id;
          // Leave Mind Maps first, so its list loads again with the new map.
          press(buttonWithText('Home'), 'Home');
          await wait(300);
          press(buttonWithText('Mind Maps'), 'Mind Maps');
          const shown = await until(() => {
            const button = document.querySelector('main')?.textContent.includes('New map') ? buttonWithText('Smoke connector note') : undefined;
            button?.click();
            return Boolean(button);
          }, 3000);
          if (!shown) return 'map list did not show the map';
          const edge = () => document.querySelector('.react-flow__edge.mmap-connector-line');
          if (!(await until(edge, 3000))) return 'connector not shown';
          edge().dispatchEvent(new MouseEvent('click', { bubbles: true }));
          const noteButton = () => document.querySelector('button[aria-label="Add a note to this connector"]');
          if (!(await until(noteButton, 3000))) return 'note button not shown on the selected connector';
          press(noteButton(), 'note button');
          const input = () => document.querySelector('input[aria-label="Note on this connector"]');
          if (!(await until(() => input() && document.activeElement === input(), 3000))) return 'note box did not open focused';
          input().value = 'heats up';
          input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const saved = async (label) => (await maps.get({ mapId })).data.connections[0].label === label;
          if (!(await until(() => [...document.querySelectorAll('.react-flow__edgelabel-renderer span')].some((span) => span.textContent === 'heats up'), 3000))) return 'note not shown on the line';
          if (!(await saved('heats up'))) return 'note not saved';
          press(buttonWithText('Undo'), 'Undo');
          await wait(800);
          if (!(await saved(null))) return 'undo did not remove the note';

          // Linking the connector to a relationship between the same two notes (PRD §4.4).
          const dependsOn = (await window.mmap.relationshipTypes.list()).data.items.find((t) => t.label === 'depends on');
          const relationship = (await window.mmap.relationships.create({ sourceNodeId: a.id, targetNodeId: b.id, typeId: dependsOn.id })).data;
          edge().dispatchEvent(new MouseEvent('click', { bubbles: true }));
          const linkButton = () => document.querySelector('button[aria-label="Link this connector to a relationship"]');
          if (!(await until(linkButton, 3000))) return 'link button not shown on the selected connector';
          press(linkButton(), 'link button');
          const option = () => [...document.querySelectorAll('[role="dialog"][aria-label="Show a relationship on this connector"] button')].find((button) => button.textContent.includes('depends on'));
          if (!(await until(option, 3000))) return 'the relationship between the two notes was not offered';
          press(option(), 'relationship option');
          const linked = async (id) => (await maps.get({ mapId })).data.connections[0].relationshipId === id;
          if (!(await until(() => [...document.querySelectorAll('.react-flow__edgelabel-renderer span')].some((span) => span.textContent === 'depends on'), 3000))) return 'linked type not shown on the line';
          if (!(await linked(relationship.id))) return 'link not saved';
          // The note box edits the note alone, never the linked type shown next to it.
          edge().dispatchEvent(new MouseEvent('click', { bubbles: true }));
          if (!(await until(noteButton, 3000))) return 'note button missing after linking';
          press(noteButton(), 'note button');
          if (!(await until(input, 3000))) return 'note box did not open after linking';
          if (input().value !== '') return 'note box started with the linked type: ' + input().value;
          input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          press(buttonWithText('Undo'), 'Undo');
          await wait(800);
          if (!(await linked(null))) return 'undo did not remove the link';
          await window.mmap.relationships.delete({ relationshipId: relationship.id });

          // Creating a relationship from inside the map: the link panel's "Create a relationship".
          edge().dispatchEvent(new MouseEvent('click', { bubbles: true }));
          if (!(await until(linkButton, 3000))) return 'link button missing before creating';
          press(linkButton(), 'link button');
          const createForm = () => [...document.querySelectorAll('[role="dialog"][aria-label="Show a relationship on this connector"] form')][0];
          if (!(await until(() => createForm()?.querySelector('select option'), 3000))) return 'create form not offered';
          const select = createForm().querySelector('select');
          const optionFor = [...select.options].find((o) => o.textContent.includes('depends on'));
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, optionFor.value);
          select.dispatchEvent(new Event('change', { bubbles: true }));
          press([...createForm().querySelectorAll('button')].find((button) => button.textContent.trim() === 'Create'), 'Create');
          const created = async () => (await window.mmap.relationships.listForNode({ nodeId: a.id })).data.items.find((item) => item.source.id === a.id && item.target.id === b.id && item.typeLabel === 'depends on');
          let made = null;
          for (let attempt = 0; attempt < 30 && !made; attempt += 1) { made = await created(); if (!made) await wait(100); }
          if (!made) return 'the relationship was not created from the map';
          if (!(await until(() => [...document.querySelectorAll('.react-flow__edgelabel-renderer span')].some((span) => span.textContent === 'depends on'), 3000))) return 'the created relationship is not shown on the connector';
          if (!(await linked(made.id))) return 'the created relationship was not linked';
          await window.mmap.relationships.delete({ relationshipId: made.id });
          press(buttonWithText('All maps'), 'All maps');
          await maps.delete({ mapId });
          return 'ok';
        })()`)) as string;
        if (outcome !== 'ok') {
          throw new Error(outcome);
        }
      },
    ),
  );
  checks.push(
    await check(
      'adding to a large hierarchy map finds other nodes and moves an item under a parent',
      async () => {
        const outcome = (await window.webContents.executeJavaScript(`
        (async () => {
          const { nodes, maps } = window.mmap;
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
          const type = (input, text) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const option = (text) =>
            [...document.querySelectorAll('[role="dialog"] [role="option"]')].find((item) => item.textContent.includes(text));
          // More than 50 items: the old picker sent their IDs and was refused, so it found nothing.
          let view = (await maps.create({ title: 'Smoke large hierarchy', mode: 'hierarchical' })).data;
          for (let index = 0; index < 54; index += 1) {
            view = (await maps.addPlacement({ mapId: view.map.id, expectedRevision: view.map.revision,
              newNodeTitle: 'Smoke filler ' + index, x: 0, y: 0, parentPlacementId: null })).data;
          }
          view = (await maps.addPlacement({ mapId: view.map.id, expectedRevision: view.map.revision,
            newNodeTitle: 'Smoke parent item', x: 0, y: 0, parentPlacementId: null })).data;
          view = (await maps.addPlacement({ mapId: view.map.id, expectedRevision: view.map.revision,
            newNodeTitle: 'Smoke mover item', x: 0, y: 0, parentPlacementId: null })).data;
          const unplaced = (await nodes.create({ title: 'Smoke unplaced zebra' })).data;
          const mapId = view.map.id;
          press(buttonWithText('Home'), 'Home');
          await wait(300);
          press(buttonWithText('Mind Maps'), 'Mind Maps');
          const opened = await until(() => {
            const button = document.querySelector('main')?.textContent.includes('New map')
              ? [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Smoke large hierarchy'))
              : undefined;
            button?.click();
            return Boolean(button);
          }, 3000);
          if (!opened) return 'map list did not show the map';
          const row = (text) => [...document.querySelectorAll('[role="treeitem"]')].find((item) => item.textContent.includes(text));
          if (!(await until(() => row('Smoke parent item'), 5000))) return 'outline not shown';

          press(buttonWithText('Add top-level'), 'Add top-level');
          const input = () => document.querySelector('[role="dialog"] input');
          if (!(await until(input, 3000))) return 'add dialog did not open';
          type(input(), 'Smoke unplaced');
          if (!(await until(() => option('Smoke unplaced zebra'), 3000))) return 'the add dialog did not find a node that is not on the map';
          if (document.querySelector('[role="dialog"] [role="alert"]')) return 'the lookup failed';
          press(buttonWithText('Cancel'), 'Cancel');
          await until(() => !input(), 3000);

          press(row('Smoke parent item'), 'parent row');
          if (!(await until(() => buttonWithText('Add child'), 3000))) return 'Add child not offered';
          press(buttonWithText('Add child'), 'Add child');
          if (!(await until(input, 3000))) return 'add-child dialog did not open';
          type(input(), 'Smoke mover');
          if (!(await until(() => option('already on this map'), 3000))) return 'an item already on the map was not offered to move';
          option('Smoke mover item').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          const moved = async () => {
            const current = (await maps.get({ mapId })).data;
            const parent = current.placements.find((p) => p.nodeTitle === 'Smoke parent item');
            const mover = current.placements.find((p) => p.nodeTitle === 'Smoke mover item');
            return mover.parentPlacementId === parent.id && current.placements.length === 56;
          };
          let ok = false;
          for (let attempt = 0; attempt < 50 && !ok; attempt += 1) { ok = await moved(); if (!ok) await wait(100); }
          if (!ok) return 'the item was not moved under the parent';
          if (input()) return 'the dialog stayed open after the move';
          press(buttonWithText('All maps'), 'All maps');
          await maps.delete({ mapId });
          await nodes.delete({ nodeId: unplaced.id, expectedRevision: unplaced.revision });
          return 'ok';
        })()`)) as string;
        if (outcome !== 'ok') throw new Error(outcome);
      },
    ),
  );
  checks.push(
    await check('a second window opens a note, and the first shows its changes when focused', () =>
      checkSecondWindow(window),
    ),
  );
  checks.push(
    await check(
      'auto layout arranges a messy map, keeps locked items, Undo restores it, and its routes are kept',
      async () => {
        const outcome = (await window.webContents.executeJavaScript(`
        (async () => {
          const { maps } = window.mmap;
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const until = async (predicate, timeoutMs) => {
            const start = performance.now();
            while (performance.now() - start < timeoutMs) {
              if (await predicate()) return true;
              await wait(50);
            }
            return false;
          };
          const buttonWithText = (text) =>
            [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text);
          const press = (element, what) => {
            if (!element) throw new Error(what + ' not found');
            element.click();
          };
          // A messy map: five items piled up, connected in a chain, plus one locked item.
          let view = (await maps.create({ title: 'Smoke auto layout' })).data;
          for (const [index, title] of ['One', 'Two', 'Three', 'Four', 'Five', 'Locked'].entries()) {
            view = (await maps.addPlacement({ mapId: view.map.id, expectedRevision: view.map.revision,
              newNodeTitle: 'Smoke layout ' + title, x: 40 + (index % 2) * 15, y: 30 + index * 6 })).data;
          }
          const id = (title) => view.placements.find((p) => p.nodeTitle === 'Smoke layout ' + title).id;
          for (const [from, to] of [['One', 'Two'], ['Two', 'Three'], ['Three', 'Four'], ['Four', 'Five'], ['Five', 'Two']]) {
            view = (await maps.addConnection({ mapId: view.map.id, expectedRevision: view.map.revision,
              sourcePlacementId: id(from), targetPlacementId: id(to) })).data;
          }
          view = (await maps.setPlacementPinned({ mapId: view.map.id, expectedRevision: view.map.revision,
            placementId: id('Locked'), pinned: true })).data;
          const before = new Map(view.placements.map((p) => [p.id, { x: p.x, y: p.y }]));
          const mapId = view.map.id;
          press(buttonWithText('Home'), 'Home');
          await wait(300);
          press(buttonWithText('Mind Maps'), 'Mind Maps');
          const opened = await until(() => {
            const button = document.querySelector('main')?.textContent.includes('New map')
              ? [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Smoke auto layout'))
              : undefined;
            button?.click();
            return Boolean(button);
          }, 3000);
          if (!opened) return 'map list did not show the map';
          if (!(await until(() => document.querySelectorAll('.react-flow__node').length === 6, 5000))) return 'map not shown';
          await wait(500);
          press(buttonWithText('Auto layout'), 'Auto layout');
          const arranged = async () => {
            const current = (await maps.get({ mapId })).data;
            const at = (title) => current.placements.find((p) => p.nodeTitle === 'Smoke layout ' + title);
            // The chain One → Two → Three runs left to right; the cycle Two → … → Five → Two is broken
            // where ELK chooses, so only the part outside it is checked.
            return at('One').x < at('Two').x && at('Two').x < at('Three').x ? current : null;
          };
          let after = null;
          for (let attempt = 0; attempt < 60 && !after; attempt += 1) { after = await arranged(); if (!after) await wait(100); }
          if (!after) return 'the map was not arranged left to right';
          const locked = after.placements.find((p) => p.id === id('Locked'));
          if (locked.x !== before.get(locked.id).x || locked.y !== before.get(locked.id).y) return 'the locked item moved';
          if (document.body.textContent.includes('could not be arranged')) return 'layout reported a failure';
          press(buttonWithText('Undo'), 'Undo');
          const restored = await until(async () => {
            const current = (await maps.get({ mapId })).data;
            return current.placements.every((p) => p.x === before.get(p.id).x && p.y === before.get(p.id).y);
          }, 5000);
          if (!restored) return 'Undo did not put the items back';

          // Arranged again, the clean routes are kept with the map: they come back after leaving.
          const routed = () =>
            [...document.querySelectorAll('.react-flow__edge.mmap-connector-line path.react-flow__edge-path')].some(
              (path) => (path.getAttribute('d') ?? '').includes(' L '),
            );
          press(buttonWithText('Auto layout'), 'Auto layout');
          if (!(await until(async () => Boolean(await arranged()) && routed(), 5000))) return 'second layout not drawn with routes';
          await wait(500);
          press(buttonWithText('All maps'), 'All maps');
          const reopened = await until(() => {
            const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Smoke auto layout'));
            button?.click();
            return Boolean(button);
          }, 3000);
          if (!reopened) return 'could not reopen the map';
          if (!(await until(() => document.querySelectorAll('.react-flow__node').length === 6 && routed(), 5000))) return 'the routes were not kept after leaving the map';
          press(buttonWithText('All maps'), 'All maps');
          await maps.delete({ mapId });
          return 'ok';
        })()`)) as string;
        if (outcome !== 'ok') throw new Error(outcome);
      },
    ),
  );
  checks.push(
    await check('renderer has no Node.js access', async () => {
      const exposed = (await window.webContents.executeJavaScript(
        "[typeof require, typeof process, typeof module].join(',')",
      )) as string;
      if (exposed !== 'undefined,undefined,undefined') {
        throw new Error(`Node globals visible in renderer: ${exposed}`);
      }
    }),
  );
  checks.push(
    await check('content security policy blocks inline scripts', async () => {
      const executed = (await window.webContents.executeJavaScript(`
        new Promise((resolve) => {
          window.__inlineRan = false;
          const script = document.createElement('script');
          script.textContent = 'window.__inlineRan = true';
          document.head.appendChild(script);
          setTimeout(() => resolve(window.__inlineRan), 50);
        })`)) as boolean;
      if (executed) {
        throw new Error('An injected inline script executed.');
      }
    }),
  );

  checks.push(
    await check('attachment stored and previewed through mmap-attachment', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mmap-smoke-attachment-'));
      try {
        await checkAttachmentPreview(window, workspaces, directory);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  checks.push(
    await check(
      'a relationship is added from the knowledge graph (Find and a click on the node)',
      () => checkGraphRelationship(window),
    ),
  );
  checks.push(
    await check(
      'the knowledge graph shows each mind map as drawn, with copies of shared notes',
      () => checkGraphMapGroups(window),
    ),
  );
  checks.push(
    await check('1,000-node graph renders within 3 seconds', async () => {
      const elapsed = await checkGraphRendering(window, workspaces);
      console.log(`      graph render time: ${elapsed} ms`);
    }),
  );
  checks.push(
    await check('review recorded and shown in the timeline', () => checkTimeline(window)),
  );
  checks.push(
    await check('workspace exported to ZIP and imported back', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mmap-smoke-transfer-'));
      try {
        await checkExportImport(workspaces, directory, importRecordWriter);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  checks.push(
    await check('backup taken and restorable', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'mmap-smoke-backup-'));
      try {
        await checkBackupAndRestore(workspaces, backups, directory);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  if (axePath !== undefined) {
    checks.push(
      await check('primary views pass automated WCAG 2.2 AA checks', () =>
        checkAccessibility(window, axePath),
      ),
    );
  }

  return { passed: checks.every((item) => item.passed), checks };
}

/**
 * Opens a map in the given mode, double-clicks an item with real mouse input (synthetic events
 * would skip React Flow's own double-click zoom, which is what hid the event in hierarchy maps),
 * and checks the read-only preview and the pencil's switch to the editor.
 */
async function previewByDoubleClick(
  window: BrowserWindow,
  mode: 'freeform' | 'hierarchical',
): Promise<void> {
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
      [...document.querySelectorAll('button')].find((button) => button.textContent.includes(text));
    const press = (element, what) => {
      if (!element) throw new Error(what + ' not found');
      element.click();
    };`;
  const title = 'Smoke preview ' + mode;
  const opened = await run(`(async () => {
    ${helpers}
    const { nodes, maps } = window.mmap;
    const node = (await nodes.create({ title: ${JSON.stringify(title)}, summary: 'Preview summary line' })).data;
    await nodes.update({ nodeId: node.id, expectedRevision: node.revision, changes: { note: { type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Preview body text' }] }] } } });
    const view = (await maps.create({ title: ${JSON.stringify(title)}, mode: ${JSON.stringify(mode)} })).data;
    await maps.addPlacement({ mapId: view.map.id, expectedRevision: view.map.revision, nodeId: node.id, x: 0, y: 0 });
    window.__smokePreviewMap = view.map.id;
    // Leave Mind Maps first, so its list loads again with the new map.
    press(buttonWithText('Home'), 'Home');
    await wait(300);
    press(buttonWithText('Mind Maps'), 'Mind Maps');
    // Clicked from inside the wait: Home also lists recent maps, and the list re-renders as it loads.
    const shown = await until(() => {
      const button = document.querySelector('main')?.textContent.includes('New map') ? buttonWithText(${JSON.stringify(title)}) : undefined;
      button?.click();
      return Boolean(button);
    }, 3000);
    if (!shown) return 'map list did not show the map';
    if (!(await until(() => document.querySelector('.react-flow__node'), 3000))) return 'map item not shown';
    // The map fits itself into view after opening; click only once the item has stopped moving.
    let point = null;
    let stillFor = 0;
    const settled = await until(() => {
      const box = document.querySelector('.react-flow__node').getBoundingClientRect();
      const next = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      stillFor = point !== null && point.x === next.x && point.y === next.y ? stillFor + 1 : 0;
      point = next;
      return stillFor >= 15 && document.elementFromPoint(next.x, next.y)?.closest('.react-flow__node') !== null;
    }, 5000);
    if (!settled) return 'map item did not settle under the pointer';
    return JSON.stringify(point);
  })()`);
  if (!opened.startsWith('{')) throw new Error(`${mode}: ${opened}`);
  const { x, y } = JSON.parse(opened) as { x: number; y: number };
  const mouse = (type: 'mouseDown' | 'mouseUp' | 'mouseMove', clickCount: number) =>
    window.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount });
  mouse('mouseMove', 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  mouse('mouseDown', 1);
  mouse('mouseUp', 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  mouse('mouseDown', 2);
  mouse('mouseUp', 2);
  const outcome = await run(`(async () => {
    ${helpers}
    const previewNote = () => document.querySelector('aside .note-content');
    if (!(await until(() => previewNote()?.textContent.includes('Preview body text'), 3000))) return 'double-click did not open the preview';
    if (previewNote().getAttribute('contenteditable') !== 'false') return 'preview note is editable';
    if (document.querySelector('[aria-label="Formatting"]')) return 'preview shows the editing toolbar';
    if (!previewNote().closest('aside').textContent.includes('Preview summary line')) return 'preview does not show the summary';
    press(document.querySelector('button[aria-label="Edit note"]'), 'pencil');
    if (!(await until(() => document.querySelector('aside [aria-label="Formatting"]'), 3000))) return 'pencil did not open the editor';
    const editable = () => document.querySelector('aside .note-content')?.getAttribute('contenteditable') === 'true';
    if (!(await until(editable, 3000))) return 'editor note is not editable';
    press(document.querySelector('button[aria-label="Close node"]'), 'Close node');
    press(buttonWithText('All maps'), 'All maps');
    await window.mmap.maps.delete({ mapId: window.__smokePreviewMap });
    return 'ok';
  })()`);
  if (outcome !== 'ok') throw new Error(`${mode}: ${outcome}`);
}

export function writeSmokeReport(report: SmokeTestReport, reportPath: string | undefined): void {
  const serialized = JSON.stringify(report, null, 2);
  if (reportPath) {
    writeFileSync(reportPath, serialized, 'utf8');
  }
  console.log(serialized);
}

async function check(name: string, run: () => Promise<void>): Promise<SmokeTestCheck> {
  try {
    await run();
    return { name, passed: true };
  } catch (error) {
    return { name, passed: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyStorage(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'mmap-smoke-'));
  try {
    await verifySchemaOnFreshDatabase(join(directory, 'smoke.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function waitForRendererLoad(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoading()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Renderer did not load in time.')),
      RENDERER_LOAD_TIMEOUT_MS,
    );
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
    window.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer);
      reject(new Error(`Renderer failed to load (${code}: ${description}).`));
    });
  });
}

/**
 * PRD §5.1: multiple windows share the services and revision checks. Opens a note in a second
 * window through `app:open-window`, renames it there, and checks that the first window's Library
 * shows the new title when that window is focused again; then closes the second window.
 */
async function checkSecondWindow(first: BrowserWindow): Promise<void> {
  const { BrowserWindow: Windows } = await import('electron');
  const run = (target: BrowserWindow, code: string) =>
    target.webContents.executeJavaScript(code) as Promise<string>;
  const nodeId = await run(
    first,
    `(async () => {
      const node = (await window.mmap.nodes.create({ title: 'Smoke window note' })).data;
      [...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === 'Library').click();
      await window.mmap.app.openWindow({ nodeId: node.id });
      return node.id;
    })()`,
  );
  let second: BrowserWindow | undefined;
  for (let attempt = 0; attempt < 100 && second === undefined; attempt += 1) {
    second = Windows.getAllWindows().find((candidate) => candidate !== first);
    if (second === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (second === undefined) throw new Error('no second window opened');
  const waitFor = async (target: BrowserWindow, condition: string, what: string) => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const met = await run(target, `String(Boolean(${condition}))`).catch(() => 'false');
      if (met === 'true') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(what);
  };
  await waitFor(
    second,
    "document.querySelector('article[aria-label=\"Node editor\"]') && [...document.querySelectorAll('input')].some((input) => input.value === 'Smoke window note')",
    'the second window did not open the note',
  );
  // The rename happens in the second window; the first finds out when it is focused.
  await run(
    second,
    `(async () => {
      const node = (await window.mmap.nodes.get({ nodeId: ${JSON.stringify(nodeId)} })).data;
      await window.mmap.nodes.update({ nodeId: node.id, expectedRevision: node.revision, changes: { title: 'Smoke window renamed' } });
      return 'ok';
    })()`,
  );
  await run(first, "window.dispatchEvent(new Event('focus')); 'ok'");
  await waitFor(
    first,
    "document.querySelector('main')?.textContent.includes('Smoke window renamed')",
    'the first window did not show the change made in the second one',
  );
  second.close();
  for (let attempt = 0; attempt < 50 && !second.isDestroyed(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stillWorks = await run(
    first,
    `(async () => {
      const node = (await window.mmap.nodes.get({ nodeId: ${JSON.stringify(nodeId)} })).data;
      await window.mmap.nodes.delete({ nodeId: node.id, expectedRevision: node.revision });
      return 'ok';
    })()`,
  );
  if (stillWorks !== 'ok') throw new Error('the first window stopped working');
  // Input focus goes back to the first window, as when a user clicks it; later checks send it
  // mouse input.
  first.webContents.focus();
}
