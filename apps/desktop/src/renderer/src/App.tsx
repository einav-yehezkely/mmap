/**
 * Application shell (PRD §6): workspace gate, sidebar navigation, persistent search and
 * "new node" entry points, the active view, and the node detail panel shared by all views.
 */

import type { WorkspaceSummary } from '@mmap/contracts';
import { Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { errorMessage, unwrap } from './lib/ipc';
import { GraphView } from './graph/graph-view';
import { cn } from './lib/utils';
import { MapsView } from './maps/maps-view';
import { NAVIGATION_ITEMS, type ViewId } from './navigation';
import { LibraryView } from './nodes/library-view';
import { NodeDetailPanel } from './nodes/node-detail-panel';
import { notifyNodesChanged } from './nodes/node-events';
import { SearchView } from './nodes/search-view';
import { TimelineView } from './timeline/timeline-view';
import { SettingsView } from './views/settings-view';
import { CloudSyncWarning } from './workspace/cloud-sync-warning';
import { useWorkspace } from './workspace/workspace-context';
import { WorkspaceSetupView } from './workspace/workspace-setup-view';

export function App() {
  const { state } = useWorkspace();

  if (state === null) {
    return (
      <p role="status" className="p-6 text-muted-foreground">
        Opening workspace…
      </p>
    );
  }
  if (state.status !== 'open') {
    return <WorkspaceSetupView state={state} />;
  }
  // Keyed by workspace: switching workspaces discards all view state of the previous one, so
  // nothing from workspace A can be shown or saved while workspace B is open.
  return <Workbench key={state.workspace.id} workspace={state.workspace} />;
}

function Workbench({ workspace }: { workspace: WorkspaceSummary }) {
  const [activeView, setActiveView] = useState<ViewId>('library');
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  /** A mind map to open from another view (e.g. the graph); the counter remounts the maps view. */
  const [mapRequest, setMapRequest] = useState<{ mapId: string; request: number } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);

  const activeItem =
    activeView === 'search'
      ? undefined
      : (NAVIGATION_ITEMS.find((item) => item.id === activeView) ?? NAVIGATION_ITEMS[0]);

  // Search while typing, but only after a short pause, so each keystroke does not run a query.
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchText), 250);
    return () => clearTimeout(timer);
  }, [searchText]);

  // Ctrl+K (Cmd+K) focuses the search box from anywhere (PRD §6: search is easy to reach).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Creating a node is always an explicit action (PRD §5.6); it opens straight away. */
  const createNode = async () => {
    setCreateError(null);
    try {
      const node = await unwrap(window.mmap.nodes.create({ title: 'Untitled node' }));
      notifyNodesChanged();
      setOpenNodeId(node.id);
    } catch (error) {
      setCreateError(errorMessage(error));
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <nav aria-label="Main" className="flex w-56 shrink-0 flex-col gap-1 border-r p-3">
        <div className="px-2 pb-3">
          <p className="text-lg font-semibold tracking-tight">mmap</p>
          <p className="truncate text-xs text-muted-foreground" title={workspace.name}>
            {workspace.name}
          </p>
        </div>
        {NAVIGATION_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = item.id === activeView;
          return (
            <Button
              key={item.id}
              variant="ghost"
              aria-current={isActive ? 'page' : undefined}
              className={cn('justify-start', isActive && 'bg-accent text-accent-foreground')}
              onClick={() => setActiveView(item.id)}
            >
              <Icon aria-hidden="true" />
              {item.label}
            </Button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-6 py-3">
          <div className="relative max-w-md flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchInput}
              type="search"
              aria-label="Search knowledge"
              placeholder="Search (Ctrl+K)"
              className="pl-9"
              dir="auto"
              value={searchText}
              onChange={(event) => {
                setSearchText(event.target.value);
                if (event.target.value.trim() !== '') setActiveView('search');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setSearchQuery(searchText);
                  setActiveView('search');
                }
              }}
            />
          </div>
          <Button onClick={() => void createNode()}>
            <Plus aria-hidden="true" />
            New node
          </Button>
        </header>
        {createError && (
          <p role="alert" className="border-b px-6 py-2 text-sm text-destructive">
            {createError}
          </p>
        )}
        {workspace.cloudSyncProvider && (
          <div className="border-b px-6 py-2">
            <CloudSyncWarning provider={workspace.cloudSyncProvider} />
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 overflow-auto p-6 focus:outline-none"
          >
            {activeItem?.id === 'settings' && <SettingsView workspace={workspace} />}
            {activeItem?.id === 'library' && (
              <LibraryView
                timeZone={workspace.timezone}
                selectedNodeId={openNodeId}
                onOpenNode={setOpenNodeId}
                onCreateNode={() => void createNode()}
              />
            )}
            {activeItem?.id === 'maps' && (
              <MapsView
                key={mapRequest?.request ?? 0}
                initialMapId={mapRequest?.mapId ?? null}
                timeZone={workspace.timezone}
                onOpenNode={setOpenNodeId}
              />
            )}
            {activeView === 'search' && (
              <SearchView query={searchQuery} onOpenNode={setOpenNodeId} />
            )}
            {activeItem?.id === 'graph' && (
              <GraphView
                onOpenNode={setOpenNodeId}
                onOpenMap={(mapId) => {
                  setMapRequest((current) => ({ mapId, request: (current?.request ?? 0) + 1 }));
                  setActiveView('maps');
                }}
              />
            )}
            {activeItem?.id === 'timeline' && (
              <TimelineView timeZone={workspace.timezone} onOpenNode={setOpenNodeId} />
            )}
          </main>

          {openNodeId !== null && (
            <NodeDetailPanel
              key={openNodeId}
              workspaceId={workspace.id}
              timeZone={workspace.timezone}
              nodeId={openNodeId}
              onClose={() => setOpenNodeId(null)}
              onOpenNode={setOpenNodeId}
            />
          )}
        </div>
      </div>
    </div>
  );
}
