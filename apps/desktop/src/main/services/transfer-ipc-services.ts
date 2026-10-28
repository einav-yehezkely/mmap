/**
 * IPC-facing export and import (PRD §5.11).
 *
 * File locations are chosen in native dialogs opened here, never sent by the renderer (PRD §8).
 * A previewed import is held in the main process under a random token until it is applied or
 * discarded, together with the open archive, so what is applied is exactly what was previewed.
 * Only one import is pending at a time; a new preview, opening another workspace or ten minutes
 * of inactivity discards it.
 */

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { DomainError, type IdGenerator } from '@mmap/domain';

import type { IpcServices } from '../ipc/register-ipc-handlers';
import { exportWorkspaceMarkdown } from '../portability/export-markdown';
import { exportWorkspaceArchive } from '../portability/export-workspace';
import type { ImportRecordWriter } from '../portability/import-writer';
import { applyImport, prepareImport, type PreparedImport } from '../portability/import-workspace';
import { TransferError } from '../portability/transfer-errors';
import type { OpenWorkspace } from '../workspaces/open-workspace';
import { WorkspaceError } from '../workspaces/workspace-errors';

type TransferChannel = Extract<keyof IpcServices, `transfer:${string}`>;

/** How long a previewed import stays available. */
export const IMPORT_PREVIEW_LIFETIME_MS = 10 * 60 * 1_000;

export interface TransferNativeInteractions {
  /** Save dialog for an archive; resolves with the chosen path, or null when cancelled. */
  chooseExportDestination(suggestedName: string): Promise<string | null>;
  /** Open dialog for an archive; resolves with the chosen path, or null when cancelled. */
  chooseArchiveToImport(): Promise<string | null>;
}

export interface TransferIpcDependencies {
  readonly currentWorkspace: () => OpenWorkspace | null;
  readonly maxAttachmentBytes: () => Promise<number>;
  readonly native: TransferNativeInteractions;
  readonly appVersion: string;
  readonly ids: IdGenerator;
  readonly now?: () => Date;
  /** Writes the import's records; the app passes the worker-thread writer. */
  readonly importRecordWriter?: ImportRecordWriter;
}

interface PendingImport {
  readonly token: string;
  readonly prepared: PreparedImport;
  readonly expiresAt: number;
}

export function createTransferIpcServices(
  dependencies: TransferIpcDependencies,
): Pick<IpcServices, TransferChannel> {
  const now = dependencies.now ?? (() => new Date());
  let pending: PendingImport | null = null;

  const requireWorkspace = (): OpenWorkspace => {
    const workspace = dependencies.currentWorkspace();
    if (workspace === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return workspace;
  };

  const discardPending = () => {
    pending?.prepared.reader.close();
    pending = null;
  };

  /** The pending import for `token`, if it is still valid for the open workspace. */
  const takePending = (token: string, workspace: OpenWorkspace): PreparedImport => {
    const current = pending;
    if (
      current === null ||
      current.token !== token ||
      current.expiresAt < now().getTime() ||
      current.prepared.workspaceId !== workspace.id
    ) {
      discardPending();
      throw new TransferError(
        'IMPORT_EXPIRED',
        'This import is no longer available. Choose the archive again.',
      );
    }
    return current.prepared;
  };

  return {
    'transfer:export-zip': async () => {
      const workspace = requireWorkspace();
      const date = now().toISOString().slice(0, 10);
      const destination = await dependencies.native.chooseExportDestination(
        `${safeFileName(await workspaceName(workspace))} ${date}.mmap.zip`,
      );
      if (destination === null) return { status: 'cancelled' as const };
      const result = await exportWorkspaceArchive(workspace, destination, {
        appVersion: dependencies.appVersion,
        now,
      });
      return {
        status: 'exported' as const,
        fileName: basename(destination),
        counts: result.counts,
        warnings: result.warnings,
      };
    },

    'transfer:export-markdown': async () => {
      const workspace = requireWorkspace();
      const date = now().toISOString().slice(0, 10);
      const destination = await dependencies.native.chooseExportDestination(
        `${safeFileName(await workspaceName(workspace))} ${date} Markdown.zip`,
      );
      if (destination === null) return { status: 'cancelled' as const };
      const result = await exportWorkspaceMarkdown(workspace, destination, now);
      return { status: 'exported' as const, fileName: basename(destination), ...result };
    },

    'transfer:preview-import': async () => {
      const workspace = requireWorkspace();
      discardPending();
      const archivePath = await dependencies.native.chooseArchiveToImport();
      if (archivePath === null) return { status: 'cancelled' as const };
      const prepared = await prepareImport(workspace, archivePath, {
        ids: dependencies.ids,
        maxAttachmentBytes: await dependencies.maxAttachmentBytes(),
      });
      const token = randomUUID();
      pending = { token, prepared, expiresAt: now().getTime() + IMPORT_PREVIEW_LIFETIME_MS };
      return {
        status: 'ready' as const,
        importToken: token,
        fileName: basename(archivePath),
        source: {
          workspaceName: prepared.manifest.workspace.name,
          exportedAt: prepared.manifest.exportedAt,
          appVersion: prepared.manifest.appVersion,
        },
        summary: prepared.plan.summary,
        warnings: prepared.warnings,
        previousImports: prepared.earlierImports.map((record) => record.importedAt),
        sameWorkspace: prepared.manifest.workspace.id === workspace.id,
      };
    },

    'transfer:apply-import': async ({ importToken, acceptDuplicate }) => {
      const workspace = requireWorkspace();
      const prepared = takePending(importToken, workspace);
      if (prepared.earlierImports.length > 0 && !acceptDuplicate) {
        // The renderer must show the duplicate warning first; the import stays pending.
        throw new DomainError(
          'DUPLICATE',
          'This archive was imported before. Confirm that you want to import it again.',
        );
      }
      pending = null;
      await applyImport(workspace, prepared, dependencies.importRecordWriter);
      return { summary: prepared.plan.summary };
    },

    'transfer:discard-import': ({ importToken }) => {
      if (pending?.token === importToken) discardPending();
      return Promise.resolve({ discarded: true as const });
    },
  };
}

async function workspaceName(workspace: OpenWorkspace): Promise<string> {
  return (await workspace.services.workspace.get(workspace.id)).name;
}

/** A file name proposal from a workspace name: no path separators or reserved characters. */
function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- removing control characters is the purpose.
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '');
  return cleaned === '' ? 'workspace' : cleaned.slice(0, 80);
}
