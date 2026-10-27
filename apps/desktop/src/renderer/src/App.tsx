/**
 * Application shell (PRD §6): workspace gate, sidebar navigation, persistent search and
 * "new node" entry points, the active view, and the node detail panel shared by all views.
 */

import type { WorkspaceSummary } from '@mmap/contracts';
import { Plus, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import logoUrl from './assets/mmap-logo.png';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { GraphView } from './graph/graph-view';
import { HomeView } from './home/home-view';
import { cn } from './lib/utils';
import { MapsView } from './maps/maps-view';
import { NAVIGATION_ITEMS, type ViewId } from './navigation';
import { LibraryView } from './nodes/library-view';
import { NewNodeDialog } from './nodes/new-node-dialog';
import { NodeDetailPanel } from './nodes/node-detail-panel';
import { NodePreview } from './nodes/node-preview';
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

/** Views that open nodes in the full-width editor. */
type PageView = 'home' | 'library';

function Workbench({ workspace }: { workspace: WorkspaceSummary }) {
  // The app opens on Home (a summary and quick actions), not inside one of the work views.
  const [activeView, setActiveView] = useState<ViewId>('home');
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  /** Node shown read-only beside the view (Mind Maps); the node editor panel takes precedence. */
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  /** A mind map to open from another view (e.g. the graph); the counter remounts the maps view. */
  const [mapRequest, setMapRequest] = useState<{ mapId: string; request: number } | null>(null);
  /** The map being edited in the Mind Maps view, preselected when creating a node there. */
  const [editedMapId, setEditedMapId] = useState<string | null>(null);
  /** A node opened from Home or the Library, shown full-width in place of that view. */
  const [pageNode, setPageNode] = useState<{ view: PageView; nodeId: string } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  /** Scroll position of the view a full-width node replaced, restored when going back. */
  const pageReturnScroll = useRef(0);
  const restoreScroll = useRef<number | null>(null);
  /** Open "New node" dialog, with the map to preselect. */
  const [newNode, setNewNode] = useState<{ preselectedMapId: string | null } | null>(null);
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

  /** Switches the main view; a node open full-width over Home is closed (its edits are saved). */
  const navigate = (view: ViewId) => {
    setPageNode(null);
    setPreviewNodeId(null);
    setActiveView(view);
  };

  /** Mind map items open read-only first; the preview's pencil switches to the editor. */
  const previewNode = (nodeId: string) => {
    setOpenNodeId(null);
    setPreviewNodeId(nodeId);
  };
  const editNode = (nodeId: string) => {
    setPreviewNodeId(null);
    setOpenNodeId(nodeId);
  };

  /** Opens a mind map in the Mind Maps view (from Home, the graph or the node panel). */
  const openMap = (mapId: string) => {
    setMapRequest((current) => ({ mapId, request: (current?.request ?? 0) + 1 }));
    navigate('maps');
  };

  /**
   * Home and the Library open nodes in a full-width editor instead of squeezing the view beside a
   * panel. The view stays mounted (hidden), so going back shows it exactly as it was, at the same
   * scroll position. Links followed inside the editor open in the same place.
   */
  const openFullPage = (view: PageView, nodeId: string) => {
    if (pageNode === null) pageReturnScroll.current = mainRef.current?.scrollTop ?? 0;
    setOpenNodeId(null);
    setPageNode({ view, nodeId });
  };
  const closeFullPage = () => {
    restoreScroll.current = pageReturnScroll.current;
    setPageNode(null);
  };
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    if (pageNode !== null) {
      main.scrollTop = 0;
    } else if (restoreScroll.current !== null) {
      main.scrollTop = restoreScroll.current;
      restoreScroll.current = null;
    }
  }, [pageNode]);

  /** The full-width editor, for the view it replaces. */
  const fullPageEditor = (view: PageView, backLabel: string) =>
    pageNode?.view === view ? (
      <NodeDetailPanel
        key={pageNode.nodeId}
        layout="page"
        backLabel={backLabel}
        workspaceId={workspace.id}
        timeZone={workspace.timezone}
        nodeId={pageNode.nodeId}
        onClose={closeFullPage}
        onOpenNode={(nodeId) => setPageNode({ view, nodeId })}
        onOpenMap={openMap}
      />
    ) : null;

  /**
   * Creating a node is always an explicit action (PRD §5.6): the dialog asks for a title and,
   * optionally, mind maps to add it to (the map being edited is preselected). The new node opens
   * straight away.
   */
  const createNode = () =>
    setNewNode({ preselectedMapId: activeView === 'maps' ? editedMapId : null });

  return (
    <div className="flex h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <nav aria-label="Main" className="flex w-56 shrink-0 flex-col gap-1 border-r p-3">
        <div className="flex items-center gap-2.5 px-2 pb-3">
          <img src={logoUrl} alt="" className="size-8 shrink-0" />
          <div className="min-w-0">
            <p className="text-lg font-semibold leading-tight tracking-tight">mmap</p>
            <p className="truncate text-xs text-muted-foreground" title={workspace.name}>
              {workspace.name}
            </p>
          </div>
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
              onClick={() => navigate(item.id)}
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
                if (event.target.value.trim() !== '') navigate('search');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setSearchQuery(searchText);
                  navigate('search');
                }
              }}
            />
          </div>
          <Button onClick={createNode}>
            <Plus aria-hidden="true" />
            New node
          </Button>
        </header>
        {newNode !== null && (
          <NewNodeDialog
            preselectedMapId={newNode.preselectedMapId}
            onClose={() => setNewNode(null)}
            onCreated={(nodeId) => {
              setNewNode(null);
              if (activeView === 'home' || activeView === 'library') {
                openFullPage(activeView, nodeId);
              } else {
                setOpenNodeId(nodeId);
              }
            }}
          />
        )}
        {workspace.cloudSyncProvider && (
          <div className="border-b px-6 py-2">
            <CloudSyncWarning provider={workspace.cloudSyncProvider} />
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <main
            ref={mainRef}
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 overflow-auto p-6 focus:outline-none"
          >
            {activeItem?.id === 'home' && (
              <>
                <div hidden={pageNode !== null}>
                  <HomeView
                    workspaceName={workspace.name}
                    timeZone={workspace.timezone}
                    onOpenNode={(nodeId) => openFullPage('home', nodeId)}
                    onOpenMap={openMap}
                    onNavigate={navigate}
                    onCreateNode={createNode}
                    onFocusSearch={() => searchInput.current?.focus()}
                  />
                </div>
                {fullPageEditor('home', 'Back to Home')}
              </>
            )}
            {activeItem?.id === 'settings' && <SettingsView workspace={workspace} />}
            {activeItem?.id === 'library' && (
              <>
                <div hidden={pageNode !== null}>
                  <LibraryView
                    timeZone={workspace.timezone}
                    selectedNodeId={pageNode?.nodeId ?? null}
                    onOpenNode={(nodeId) => openFullPage('library', nodeId)}
                    onCreateNode={createNode}
                  />
                </div>
                {fullPageEditor('library', 'Back to Library')}
              </>
            )}
            {activeItem?.id === 'maps' && (
              <MapsView
                key={mapRequest?.request ?? 0}
                initialMapId={mapRequest?.mapId ?? null}
                timeZone={workspace.timezone}
                onOpenNode={previewNode}
                onOpenMapChange={setEditedMapId}
              />
            )}
            {activeView === 'search' && (
              <SearchView query={searchQuery} onOpenNode={setOpenNodeId} />
            )}
            {activeItem?.id === 'graph' && (
              <GraphView onOpenNode={setOpenNodeId} onOpenMap={openMap} />
            )}
            {activeItem?.id === 'timeline' && (
              <TimelineView timeZone={workspace.timezone} onOpenNode={setOpenNodeId} />
            )}
          </main>

          {openNodeId === null && previewNodeId !== null && (
            <NodePreview
              key={previewNodeId}
              nodeId={previewNodeId}
              onClose={() => setPreviewNodeId(null)}
              onEdit={editNode}
              onOpenNode={previewNode}
            />
          )}
          {openNodeId !== null && (
            <NodeDetailPanel
              key={openNodeId}
              workspaceId={workspace.id}
              timeZone={workspace.timezone}
              nodeId={openNodeId}
              onClose={() => setOpenNodeId(null)}
              onOpenNode={setOpenNodeId}
              onOpenMap={openMap}
            />
          )}
        </div>
      </div>
    </div>
  );
}
