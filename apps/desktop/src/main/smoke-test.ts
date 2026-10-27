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

export function smokeReportPath(argv: readonly string[]): string | undefined {
  return argv
    .find((argument) => argument.startsWith(REPORT_FLAG_PREFIX))
    ?.slice(REPORT_FLAG_PREFIX.length);
}

export async function runSmokeTest(
  window: BrowserWindow,
  workspaces: WorkspaceManager,
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

  return { passed: checks.every((item) => item.passed), checks };
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
