/**
 * Tiptap node for managed attachments inside notes (PRD §5.3, §5.10).
 *
 * The node stores only the attachment ID, a display name and whether it is shown as an image.
 * Bytes stay in the workspace's managed attachments folder:
 * - images render through `mmap-attachment://current/<id>`, which the main process serves only for
 *   previewable raster images of the open workspace;
 * - other files render as a labelled chip; double-clicking asks the main process to open the
 *   file with its default application, after re-checking it.
 *
 * Attribute values are written with DOM APIs by ProseMirror (never as HTML strings), and the note
 * schema in the domain validates them on save (canonical UUID, bounded display name).
 */

import { attachmentPreviewUrl } from '@mmap/contracts';
import { mergeAttributes, Node } from '@tiptap/core';

export interface AttachmentNodeAttributes {
  readonly attachmentId: string;
  readonly displayName: string;
  readonly kind: 'image' | 'file';
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    attachment: {
      insertAttachments: (attachments: readonly AttachmentNodeAttributes[]) => ReturnType;
    };
  }
}

export const AttachmentNode = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      attachmentId: { default: null },
      displayName: { default: '' },
      kind: { default: 'file' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-attachment-id]',
        getAttrs: (element) => ({
          attachmentId: element.getAttribute('data-attachment-id'),
          displayName: element.getAttribute('data-attachment-name') ?? '',
          kind: element.getAttribute('data-attachment-kind') === 'image' ? 'image' : 'file',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attachmentId = String(node.attrs.attachmentId);
    const displayName = String(node.attrs.displayName);
    const kind = node.attrs.kind === 'image' ? 'image' : 'file';
    const wrapper = mergeAttributes(HTMLAttributes, {
      'data-attachment-id': attachmentId,
      'data-attachment-name': displayName,
      'data-attachment-kind': kind,
      class: `note-attachment note-attachment-${kind}`,
      title: kind === 'image' ? displayName : `${displayName} — double-click to open`,
    });
    if (kind === 'image') {
      return [
        'div',
        wrapper,
        ['img', { src: attachmentPreviewUrl(attachmentId), alt: displayName, loading: 'lazy' }],
        ['span', { class: 'note-attachment-caption' }, displayName],
      ];
    }
    return ['div', wrapper, ['span', { class: 'note-attachment-label' }, displayName]];
  },

  addCommands() {
    return {
      insertAttachments:
        (attachments) =>
        ({ commands }) =>
          commands.insertContent(
            attachments.map((attachment) => ({ type: this.name, attrs: { ...attachment } })),
          ),
    };
  },
});
