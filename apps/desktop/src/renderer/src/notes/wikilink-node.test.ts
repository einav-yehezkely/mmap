// @vitest-environment jsdom
/**
 * Wikilink rendering: unresolved links (deleted targets) are marked in text and style, resolved
 * ones are not, and repairing a link points it at another node without changing its label.
 */

import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createNoteExtensions } from './editor-extensions';
import { collectWikilinkTargets, RESOLUTION_META } from './wikilink-node';

const ALIVE = '3f2c9a4e-1b7d-4c2e-9f00-00000000000a';
const DELETED = '3f2c9a4e-1b7d-4c2e-9f00-00000000000b';
const REPLACEMENT = '3f2c9a4e-1b7d-4c2e-9f00-00000000000c';

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function editorWithLinks(): Editor {
  const editor = new Editor({
    extensions: createNoteExtensions(),
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { targetNodeId: ALIVE, label: 'Entropy' } },
            { type: 'text', text: ' and ' },
            { type: 'wikilink', attrs: { targetNodeId: DELETED, label: 'Old idea' } },
          ],
        },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

function resolve(editor: Editor, titles: Record<string, string>): void {
  editor.storage.wikilink.resolvedTitles = new Map(Object.entries(titles));
  editor.view.dispatch(editor.state.tr.setMeta(RESOLUTION_META, true));
}

describe('wikilink rendering', () => {
  it('collects each target once', () => {
    expect(collectWikilinkTargets(editorWithLinks().state.doc).sort()).toEqual([ALIVE, DELETED]);
  });

  it('shows labels and does not mark anything before resolution arrives', () => {
    const editor = editorWithLinks();

    expect(editor.view.dom.textContent).toContain('Entropy');
    expect(editor.view.dom.querySelectorAll('.wikilink-unresolved')).toHaveLength(0);
  });

  it('marks only links whose target no longer exists, with an explanatory label', () => {
    const editor = editorWithLinks();

    resolve(editor, { [ALIVE]: 'Entropy (physics)' });

    const unresolved = editor.view.dom.querySelectorAll('.wikilink-unresolved');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.getAttribute('aria-label')).toBe('Unresolved link Old idea');
    expect(
      editor.view.dom.querySelector(`[data-wikilink-target="${ALIVE}"]`)?.getAttribute('title'),
    ).toBe('Opens “Entropy (physics)”');
  });

  it('repairs a link by pointing it at another node and keeps its label', () => {
    const editor = editorWithLinks();
    let position = -1;
    editor.state.doc.descendants((node, at) => {
      if (node.type.name === 'wikilink' && node.attrs.targetNodeId === DELETED) position = at;
    });

    editor.commands.retargetWikilink(position, REPLACEMENT);
    resolve(editor, { [ALIVE]: 'Entropy', [REPLACEMENT]: 'New idea' });

    expect(JSON.stringify(editor.getJSON())).toContain(`"targetNodeId":"${REPLACEMENT}"`);
    expect(JSON.stringify(editor.getJSON())).toContain('"label":"Old idea"');
    expect(editor.view.dom.querySelectorAll('.wikilink-unresolved')).toHaveLength(0);
  });
});
