/**
 * In-renderer notification that node data changed (created, saved, deleted), so lists can
 * refresh. The main process remains the source of truth; this only signals "re-query".
 */

import { useEffect } from 'react';

const target = new EventTarget();
const EVENT_NAME = 'nodes-changed';

export function notifyNodesChanged(): void {
  target.dispatchEvent(new Event(EVENT_NAME));
}

export function useNodesChanged(listener: () => void): void {
  useEffect(() => {
    target.addEventListener(EVENT_NAME, listener);
    return () => target.removeEventListener(EVENT_NAME, listener);
  }, [listener]);
}
