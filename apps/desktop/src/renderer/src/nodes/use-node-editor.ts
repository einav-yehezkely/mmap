/**
 * React binding for editing one node: loads it, drives the autosave state machine, offers draft
 * recovery and conflict resolution (PRD §5.2, §6 "unsaved/conflicting edit recovery").
 */

import type { NodeView } from '@mmap/contracts';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { errorMessage, IpcFailure, unwrap } from '../lib/ipc';
import { readRecoveredDraft, writeRecoveredDraft, type RecoveredDraft } from './draft-recovery';
import {
  NodeDraftSaver,
  type DraftState,
  type NodeFields,
  SaveFailure,
  type SavedVersion,
} from './node-draft-saver';
import { notifyNodesChanged } from './node-events';

export type ConflictChoice = 'keep-mine' | 'use-theirs' | 'save-mine-as-copy';

export type NodeEditor =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly node: NodeView;
      readonly state: DraftState;
      readonly recovered: RecoveredDraft | null;
      /**
       * Increments whenever the draft is replaced from outside the editor (conflict resolution,
       * draft recovery). Use as a React key so the rich-text editor reloads its content.
       */
      readonly contentVersion: number;
      readonly edit: (changes: Partial<NodeFields>) => void;
      readonly retry: () => void;
      readonly flush: () => Promise<void>;
      readonly resolveConflict: (choice: ConflictChoice) => Promise<void>;
      readonly restoreRecovered: () => void;
      readonly discardRecovered: () => void;
    };

function toSavedVersion(node: NodeView): SavedVersion {
  return {
    fields: { title: node.title, summary: node.summary, note: node.note },
    revision: node.revision,
  };
}

/** Converts a failed IPC call into the categories the saver understands. */
function toSaveFailure(error: unknown): SaveFailure {
  if (error instanceof IpcFailure) {
    if (error.code === 'REVISION_CONFLICT') return new SaveFailure('conflict', error.message);
    if (error.code === 'VALIDATION_FAILED') return new SaveFailure('invalid', error.message);
  }
  return new SaveFailure('failed', `${errorMessage(error)} Your changes are kept.`);
}

export function useNodeEditor(workspaceId: string, nodeId: string): NodeEditor {
  const [loaded, setLoaded] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; node: NodeView; saver: NodeDraftSaver; recovered: RecoveredDraft | null }
  >({ phase: 'loading' });
  const saverRef = useRef<NodeDraftSaver | null>(null);
  const [contentVersion, setContentVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.nodes.get({ nodeId })).then(
      (node) => {
        if (cancelled) return;
        const saver = new NodeDraftSaver({
          initial: toSavedVersion(node),
          save: async (changes, expectedRevision) => {
            try {
              const stored = await unwrap(
                window.mmap.nodes.update({ nodeId, expectedRevision, changes }),
              );
              notifyNodesChanged();
              return toSavedVersion(stored);
            } catch (error) {
              throw toSaveFailure(error);
            }
          },
          persistRecovery: (draft) => writeRecoveredDraft(workspaceId, nodeId, draft),
        });
        saverRef.current = saver;
        const recovered = readRecoveredDraft(workspaceId, nodeId);
        const differs =
          recovered !== null &&
          JSON.stringify(recovered.fields) !== JSON.stringify(toSavedVersion(node).fields);
        setLoaded({ phase: 'ready', node, saver, recovered: differs ? recovered : null });
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ phase: 'error', message: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
      // Save anything pending when the editor closes or switches to another node.
      const saver = saverRef.current;
      saverRef.current = null;
      if (saver) {
        void saver.flush().finally(() => saver.dispose());
      }
    };
  }, [workspaceId, nodeId]);

  const saver = loaded.phase === 'ready' ? loaded.saver : null;
  const subscribe = useCallback(
    (onChange: () => void) => saver?.subscribe(onChange) ?? (() => undefined),
    [saver],
  );
  const state = useSyncExternalStore(subscribe, () => saver?.getState() ?? null);

  const resolveConflict = useCallback(
    async (choice: ConflictChoice) => {
      if (saver === null) return;
      const latest = toSavedVersion(await unwrap(window.mmap.nodes.get({ nodeId })));
      if (choice === 'save-mine-as-copy') {
        const mine = saver.getState().draft;
        const copy = await unwrap(
          window.mmap.nodes.create({ title: `${mine.title} (my version)`, summary: mine.summary }),
        );
        await unwrap(
          window.mmap.nodes.update({
            nodeId: copy.id,
            expectedRevision: copy.revision,
            changes: { note: mine.note },
          }),
        );
        await saver.resolveConflict(latest, 'use-theirs');
      } else {
        await saver.resolveConflict(latest, choice);
      }
      if (choice !== 'keep-mine') {
        setContentVersion((version) => version + 1);
      }
      notifyNodesChanged();
    },
    [saver, nodeId],
  );

  return useMemo((): NodeEditor => {
    if (loaded.phase !== 'ready' || state === null) {
      return loaded.phase === 'error' ? loaded : { phase: 'loading' };
    }
    const { saver: activeSaver, node, recovered } = loaded;
    return {
      phase: 'ready',
      node,
      state,
      recovered,
      contentVersion,
      edit: (changes) => activeSaver.edit(changes),
      retry: () => void activeSaver.retry(),
      flush: () => activeSaver.flush(),
      resolveConflict,
      restoreRecovered: () => {
        if (recovered === null) return;
        activeSaver.edit(recovered.fields);
        setLoaded({ ...loaded, recovered: null });
        setContentVersion((version) => version + 1);
      },
      discardRecovered: () => {
        writeRecoveredDraft(workspaceId, node.id, null);
        setLoaded({ ...loaded, recovered: null });
      },
    };
  }, [loaded, state, resolveConflict, workspaceId, contentVersion]);
}
