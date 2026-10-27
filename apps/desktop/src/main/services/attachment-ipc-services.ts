/**
 * IPC-facing attachment operations (PRD §5.10).
 *
 * Adding a file, per selected file:
 * 1. Check it is a regular file and read its size and first bytes.
 * 2. Classify it with the domain policy (`classifyAttachment`): executables (by extension or
 *    by content), oversized and badly named files are rejected with a reason the user can read.
 * 3. Copy it into the workspace store, verifying size and checksum (`FileAttachmentStore`).
 * 4. Record the metadata in the database. If that fails, the stored copy is removed again.
 * Failures of one file never prevent the others from being added.
 *
 * Opening re-classifies the stored copy before asking the OS to open it, so a file planted in
 * the attachments folder or a tampered database row cannot make mmap launch an executable.
 */

import { basename, extname } from 'node:path';

import {
  classifyAttachment,
  isDomainError,
  SNIFF_BYTES,
  type AttachmentId,
  type AttachmentRejectionReason,
  type NodeId,
} from '@mmap/domain';

import {
  AttachmentStoreError,
  type FileAttachmentStore,
} from '../attachments/file-attachment-store';
import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { OpenWorkspace } from '../workspaces/open-workspace';
import { WorkspaceError } from '../workspaces/workspace-errors';

type AttachmentChannel = Extract<keyof IpcServices, `attachments:${string}`>;

export interface AttachmentNativeInteractions {
  /** Shows a multi-select file picker. Resolves with absolute paths, or null when cancelled. */
  chooseFiles(): Promise<readonly string[] | null>;
  /** Opens a file with its default application. Resolves false when the OS reports a failure. */
  openFile(absolutePath: string): Promise<boolean>;
}

export interface AttachmentIpcDependencies {
  readonly currentWorkspace: () => OpenWorkspace | null;
  readonly maxAttachmentBytes: () => Promise<number>;
  readonly native: AttachmentNativeInteractions;
  readonly logFailure: (operation: string, error: unknown) => void;
}

export function createAttachmentIpcServices(
  dependencies: AttachmentIpcDependencies,
): Pick<IpcServices, AttachmentChannel> {
  const requireWorkspace = (): OpenWorkspace => {
    const workspace = dependencies.currentWorkspace();
    if (workspace === null) {
      throw new WorkspaceError('WORKSPACE_MISSING', 'No workspace is open.');
    }
    return workspace;
  };

  return {
    'attachments:add': async ({ nodeId }) => {
      const workspace = requireWorkspace();
      // Fail before showing a dialog if the node is gone.
      await workspace.services.nodes.get(nodeId as NodeId);

      const sources = await dependencies.native.chooseFiles();
      if (sources === null || sources.length === 0) {
        return { cancelled: true, added: [], rejected: [] };
      }

      const maxBytes = await dependencies.maxAttachmentBytes();
      const added = [];
      const rejected: { fileName: string; reason: string }[] = [];
      for (const sourcePath of sources) {
        const fileName = basename(sourcePath);
        try {
          added.push(await addOneFile(workspace, nodeId as NodeId, sourcePath, fileName, maxBytes));
        } catch (error) {
          if (error instanceof AttachmentStoreError || error instanceof RejectedFileError) {
            rejected.push({ fileName, reason: error.message });
          } else if (isDomainError(error) && error.code === 'NOT_FOUND') {
            throw error;
          } else {
            dependencies.logFailure('attachments:add', error);
            rejected.push({ fileName, reason: 'The file could not be added.' });
          }
        }
      }
      return { cancelled: false, added, rejected };
    },

    'attachments:list': async ({ nodeId }) => {
      const workspace = requireWorkspace();
      const views = await workspace.services.attachments.listForNode(nodeId as NodeId);
      return {
        items: await Promise.all(
          views.map(async (view) => ({
            ...view,
            fileAvailable: await isFileAvailable(workspace, view.id),
          })),
        ),
      };
    },

    'attachments:open': async ({ attachmentId }) => {
      const workspace = requireWorkspace();
      const record = await workspace.services.attachments.getStoredFile(
        attachmentId as AttachmentId,
      );
      const absolutePath = await workspace.attachmentStore.resolveExisting(record.relativePath);
      if (absolutePath === null) {
        return { opened: false };
      }
      // Re-check the stored bytes and name: never open something that would execute.
      const { byteSize } = await workspace.attachmentStore.statSource(absolutePath);
      const classification = classifyAttachment(
        {
          originalName: record.originalName,
          byteSize,
          leadingBytes: await workspace.attachmentStore.readLeadingBytes(absolutePath, SNIFF_BYTES),
        },
        Number.MAX_SAFE_INTEGER,
      );
      if (
        !classification.accepted ||
        extensionOf(absolutePath) !== extensionOf(record.originalName)
      ) {
        return { opened: false };
      }
      return { opened: await dependencies.native.openFile(absolutePath) };
    },

    'attachments:remove': async ({ attachmentId }) => {
      const workspace = requireWorkspace();
      const { relativePath } = await workspace.services.attachments.remove(
        attachmentId as AttachmentId,
      );
      // The metadata is gone; deleting the file is best effort. A failure here leaves an orphan
      // that startup reconciliation removes later (PRD §5.10: "Retry orphan cleanup").
      await workspace.attachmentStore.remove(relativePath).catch((error: unknown) => {
        dependencies.logFailure('attachments:remove file', error);
      });
      return { removed: true as const };
    },
  };
}

async function addOneFile(
  workspace: OpenWorkspace,
  nodeId: NodeId,
  sourcePath: string,
  fileName: string,
  maxBytes: number,
) {
  const store: FileAttachmentStore = workspace.attachmentStore;
  const { byteSize } = await store.statSource(sourcePath);
  const leadingBytes = await store.readLeadingBytes(sourcePath, SNIFF_BYTES);
  const classification = classifyAttachment(
    { originalName: fileName, byteSize, leadingBytes },
    maxBytes,
  );
  if (!classification.accepted) {
    throw new RejectedFileError(describeRejection(classification.reason, maxBytes));
  }

  const stored = await store.importFile(
    sourcePath,
    extensionOf(classification.displayName),
    maxBytes,
  );
  try {
    const view = await workspace.services.attachments.register(nodeId, {
      relativePath: stored.relativePath,
      displayName: classification.displayName,
      mimeType: classification.mimeType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
    });
    return { ...view, fileAvailable: true };
  } catch (error) {
    await store.remove(stored.relativePath);
    throw error;
  }
}

/**
 * Whether the managed copy exists. Files can go missing if someone edits the workspace folder by
 * hand or restores an incomplete copy; the UI then says so instead of failing silently.
 */
async function isFileAvailable(
  workspace: OpenWorkspace,
  attachmentId: AttachmentId,
): Promise<boolean> {
  const record = await workspace.services.attachments.getStoredFile(attachmentId);
  return (await workspace.attachmentStore.resolveExisting(record.relativePath)) !== null;
}

/** A file refused by the attachment policy; its message is shown to the user. */
class RejectedFileError extends Error {}

function describeRejection(reason: AttachmentRejectionReason, maxBytes: number): string {
  switch (reason) {
    case 'EXECUTABLE':
      return 'Programs and scripts cannot be attached, for your safety.';
    case 'TOO_LARGE':
      return `The file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit (change it in Settings).`;
    case 'EMPTY_FILE':
      return 'The file is empty.';
    case 'INVALID_NAME':
      return 'The file name cannot be used.';
  }
}

/** Lowercase extension without the dot, or null. */
function extensionOf(fileName: string): string | null {
  const extension = extname(fileName).slice(1).toLowerCase();
  return extension === '' ? null : extension;
}
