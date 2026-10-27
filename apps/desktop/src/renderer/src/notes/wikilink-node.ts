/**
 * Tiptap node for wikilinks (PRD §4.3, §5.4).
 *
 * A wikilink stores only the target node ID and the label the author chose. It never stores a
 * title for identity, so renaming the target keeps the link working, and it never creates a
 * semantic relationship.
 *
 * Typing `[[` removes the brackets and asks the host to show a node picker (`onRequestLink`);
 * the host then inserts the chosen link. Whether each target still exists is supplied by the host
 * through `setResolvedTargets` (from the main process); unresolved links get a distinct style and
 * text so the state is never conveyed by color alone.
 */

import { InputRule, mergeAttributes, Node } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface WikilinkAttributes {
  readonly targetNodeId: string;
  readonly label: string;
}

export interface WikilinkOptions {
  /** Called when the user typed `[[`; the host shows a picker and inserts the link. */
  readonly onRequestLink: (() => void) | undefined;
}

interface WikilinkStorage {
  /** Titles of targets known to exist; `null` until the first resolution arrived. */
  resolvedTitles: ReadonlyMap<string, string> | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikilink: {
      insertWikilink: (attributes: WikilinkAttributes) => ReturnType;
      /** Points the wikilink at `position` to another node (repairing an unresolved link). */
      retargetWikilink: (position: number, targetNodeId: string) => ReturnType;
    };
  }
  interface Storage {
    wikilink: WikilinkStorage;
  }
}

export const RESOLUTION_META = 'wikilinkResolutionChanged';
const decorationKey = new PluginKey('wikilinkResolution');

export const WikilinkNode = Node.create<WikilinkOptions, WikilinkStorage>({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { onRequestLink: undefined };
  },

  addStorage() {
    return { resolvedTitles: null };
  },

  addAttributes() {
    return {
      targetNodeId: { default: null },
      label: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wikilink-target]',
        getAttrs: (element) => ({
          targetNodeId: element.getAttribute('data-wikilink-target'),
          label: element.textContent ?? '',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-wikilink-target': String(node.attrs.targetNodeId),
        class: 'wikilink',
      }),
      String(node.attrs.label),
    ];
  },

  renderText({ node }) {
    return `[[${String(node.attrs.label)}]]`;
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\[\[$/,
        handler: ({ state, range }) => {
          state.tr.delete(range.from, range.to);
          this.options.onRequestLink?.();
        },
      }),
    ];
  },

  addCommands() {
    return {
      insertWikilink:
        (attributes) =>
        ({ commands }) =>
          commands.insertContent([
            { type: this.name, attrs: { ...attributes } },
            { type: 'text', text: ' ' },
          ]),
      retargetWikilink:
        (position, targetNodeId) =>
        ({ tr, state, dispatch }) => {
          const node = state.doc.nodeAt(position);
          if (node?.type.name !== this.name) return false;
          dispatch?.(tr.setNodeMarkup(position, undefined, { ...node.attrs, targetNodeId }));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: decorationKey,
        props: {
          decorations(state) {
            const titles = storage.resolvedTitles;
            if (titles === null) return DecorationSet.empty;
            const decorations: Decoration[] = [];
            state.doc.descendants((node, position) => {
              if (node.type.name !== 'wikilink') return;
              const title = titles.get(String(node.attrs.targetNodeId));
              decorations.push(
                Decoration.node(position, position + node.nodeSize, {
                  class: title === undefined ? 'wikilink wikilink-unresolved' : 'wikilink',
                  title:
                    title === undefined
                      ? 'Unresolved link: the linked node no longer exists. Click to choose another node.'
                      : `Opens “${title}”`,
                  'aria-label':
                    title === undefined
                      ? `Unresolved link ${String(node.attrs.label)}`
                      : `Link to ${title}`,
                }),
              );
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

/** IDs of all wikilink targets in a document, without duplicates. */
export function collectWikilinkTargets(document: {
  descendants: (
    visit: (node: { type: { name: string }; attrs: Record<string, unknown> }) => void,
  ) => void;
}): string[] {
  const targets = new Set<string>();
  document.descendants((node) => {
    if (node.type.name === 'wikilink') targets.add(String(node.attrs.targetNodeId));
  });
  return [...targets];
}
