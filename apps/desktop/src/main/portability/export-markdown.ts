/**
 * Writes the readable Markdown export (PRD §5.11) as one ZIP file:
 *
 *   README.md                    what the export contains and how to restore instead
 *   nodes/<Title> (<id>).md      one file per node (see `markdown-export.ts` in the domain)
 *   attachments/<id> <name>      attached files, under their original (sanitized) names
 *
 * Attachments are included when their managed file exists; a missing file is reported, and the
 * note says "Missing attachment". Like the ZIP export, it reads one consistent snapshot.
 */

import { extname } from 'node:path';

import {
  MARKDOWN_README,
  markdownFileName,
  nodeToMarkdown,
  parseNoteDocument,
  safeFileStem,
  type MarkdownRelationship,
} from '@mmap/domain';

import type { OpenWorkspace } from '../workspaces/open-workspace';
import { ZipWriter } from './zip-writer';

export interface MarkdownExportResult {
  readonly nodes: number;
  readonly attachments: number;
  readonly warnings: readonly string[];
}

export async function exportWorkspaceMarkdown(
  workspace: OpenWorkspace,
  destinationPath: string,
  now: () => Date,
): Promise<MarkdownExportResult> {
  const snapshot = await workspace.services.snapshots.read(workspace.id);

  const fileNames = new Map(
    snapshot.nodes.map((node) => [node.id as string, markdownFileName(node.title, node.id)]),
  );
  const titles = new Map(snapshot.nodes.map((node) => [node.id as string, node.title]));
  const tagLabels = new Map(snapshot.tags.map((tag) => [tag.id as string, tag.displayLabel]));
  const tagsByNode = new Map<string, string[]>();
  for (const assignment of snapshot.nodeTags) {
    const label = tagLabels.get(assignment.tagId);
    if (label === undefined) continue;
    tagsByNode.set(assignment.nodeId, [...(tagsByNode.get(assignment.nodeId) ?? []), label]);
  }
  const typeLabels = new Map(
    snapshot.relationshipTypes.map((type) => [type.id as string, type.label]),
  );
  const relationshipsByNode = new Map<string, MarkdownRelationship[]>();
  const addRelationship = (nodeId: string, relationship: MarkdownRelationship) =>
    relationshipsByNode.set(nodeId, [...(relationshipsByNode.get(nodeId) ?? []), relationship]);
  for (const relationship of snapshot.relationships) {
    const typeLabel = typeLabels.get(relationship.typeId) ?? 'related';
    const undirected = relationship.directionality === 'undirected';
    addRelationship(relationship.sourceNodeId, {
      typeLabel,
      direction: undirected ? 'undirected' : 'outgoing',
      otherNodeId: relationship.targetNodeId,
      otherTitle: titles.get(relationship.targetNodeId) ?? '',
    });
    addRelationship(relationship.targetNodeId, {
      typeLabel,
      direction: undirected ? 'undirected' : 'incoming',
      otherNodeId: relationship.sourceNodeId,
      otherTitle: titles.get(relationship.sourceNodeId) ?? '',
    });
  }

  // Attachment files that exist, under "<first 8 ID characters> <name>" so names stay unique.
  const zip = new ZipWriter(now());
  const attachmentPaths = new Map<string, string>();
  let missing = 0;
  for (const attachment of snapshot.attachments) {
    const source = await workspace.attachmentStore.resolveExisting(attachment.relativePath);
    if (source === null) {
      missing += 1;
      continue;
    }
    const extension = extname(attachment.originalName);
    const stem = safeFileStem(
      attachment.originalName.slice(0, attachment.originalName.length - extension.length),
      80,
    );
    const name = `${attachment.id.slice(0, 8)} ${stem}${safeExtension(extension)}`;
    zip.addFile(`attachments/${name}`, source);
    attachmentPaths.set(attachment.id, `../attachments/${name}`);
  }

  const links = {
    nodeFile: (nodeId: string) => fileNames.get(nodeId) ?? null,
    attachmentPath: (attachmentId: string) => attachmentPaths.get(attachmentId) ?? null,
  };
  zip.addBuffer('README.md', Buffer.from(MARKDOWN_README, 'utf8'));
  for (const node of snapshot.nodes) {
    const markdown = nodeToMarkdown(
      {
        id: node.id,
        title: node.title,
        summary: node.summary,
        tags: tagsByNode.get(node.id) ?? [],
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        note: parseNoteDocument(JSON.parse(node.noteJson)),
        relationships: relationshipsByNode.get(node.id) ?? [],
      },
      links,
    );
    zip.addBuffer(`nodes/${fileNames.get(node.id)!}`, Buffer.from(markdown, 'utf8'));
  }
  await zip.writeTo(destinationPath, 'The Markdown export');

  return {
    nodes: snapshot.nodes.length,
    attachments: attachmentPaths.size,
    warnings:
      missing === 0
        ? []
        : [
            `${missing === 1 ? '1 attachment was' : `${missing} attachments were`} not exported ` +
              'because the file is missing from the workspace folder.',
          ],
  };
}

/** A short alphanumeric extension, or none. */
function safeExtension(extension: string): string {
  return /^\.[a-z0-9]{1,16}$/iu.test(extension) ? extension.toLowerCase() : '';
}
