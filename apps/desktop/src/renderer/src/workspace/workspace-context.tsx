/**
 * Holds the current workspace state for the whole UI and exposes lifecycle actions.
 *
 * Every action returns the new state from the main process, which is the single source of truth;
 * the renderer never guesses the outcome of an operation.
 */

import type { WorkspaceState } from '@mmap/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { unwrap } from '../lib/ipc';

interface WorkspaceContextValue {
  /** `null` until the first state arrives from the main process. */
  readonly state: WorkspaceState | null;
  /** Replaces the state with one returned by a lifecycle action. */
  readonly applyState: (state: WorkspaceState) => void;
  readonly refresh: () => Promise<void>;
}

const UNREADABLE_STATE: WorkspaceState = {
  status: 'unavailable',
  reason: 'WORKSPACE_DAMAGED',
  message: 'Could not read the workspace state. Restart mmap.',
  lastWorkspace: null,
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState | null>(null);

  const refresh = useCallback(async () => {
    setState(await unwrap(window.mmap.workspace.getState()));
  }, []);

  // Another window may have switched, closed or restored the workspace: re-read the state when
  // this window is focused again.
  useEffect(() => {
    const onFocus = () => {
      unwrap(window.mmap.workspace.getState()).then(setState, () => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.workspace.getState()).then(
      (initial) => {
        if (!cancelled) setState(initial);
      },
      () => {
        if (!cancelled) setState(UNREADABLE_STATE);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ state, applyState: setState, refresh }), [state, refresh]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (value === null) {
    throw new Error('useWorkspace must be used inside <WorkspaceProvider>.');
  }
  return value;
}
