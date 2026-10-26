/**
 * Application shell: sidebar navigation, persistent search and "new node" entry points, and the
 * active view (PRD §6). Phase 0 renders empty states for views delivered in later phases.
 */

import { Plus, Search } from 'lucide-react';
import { useState } from 'react';

import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { cn } from './lib/utils';
import { NAVIGATION_ITEMS, type ViewId } from './navigation';
import { ComingSoonView } from './views/coming-soon-view';
import { SettingsView } from './views/settings-view';

export function App() {
  const [activeView, setActiveView] = useState<ViewId>('library');
  const activeItem = NAVIGATION_ITEMS.find((item) => item.id === activeView) ?? NAVIGATION_ITEMS[0];

  return (
    <div className="flex h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <nav aria-label="Main" className="flex w-56 shrink-0 flex-col gap-1 border-r p-3">
        <p className="px-2 pb-3 text-lg font-semibold tracking-tight">mmap</p>
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
              type="search"
              aria-label="Search knowledge"
              placeholder="Search (available in Phase 2)"
              className="pl-9"
              disabled
            />
          </div>
          {/* Node creation arrives with the node library in Phase 1. */}
          <Button disabled title="Available in Phase 1">
            <Plus aria-hidden="true" />
            New node
          </Button>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto p-6 focus:outline-none"
        >
          {activeItem?.id === 'settings' ? (
            <SettingsView />
          ) : (
            activeItem && <ComingSoonView item={activeItem} />
          )}
        </main>
      </div>
    </div>
  );
}
