/**
 * Main navigation areas (PRD §6). Kept as data so the sidebar, keyboard handling and future
 * routing share one definition.
 */

import { Clock3, House, Library, Network, Settings, Workflow, type LucideIcon } from 'lucide-react';

/** `search` is reached from the search box, not from the sidebar. */
export type ViewId = 'home' | 'library' | 'maps' | 'graph' | 'timeline' | 'settings' | 'search';

export interface NavigationItem {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly description: string;
}

export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  {
    id: 'home',
    label: 'Home',
    icon: House,
    description: 'Pick up where you left off: recent notes, maps and activity.',
  },
  {
    id: 'library',
    label: 'Library',
    icon: Library,
    description: 'Browse, sort and open every knowledge node in this workspace.',
  },
  {
    id: 'maps',
    label: 'Mind Maps',
    icon: Workflow,
    description: 'Arrange existing nodes in freeform or hierarchical maps.',
  },
  {
    id: 'graph',
    label: 'Knowledge Graph',
    icon: Network,
    description: 'Explore typed relationships across the whole workspace.',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: Clock3,
    description: 'Revisit what you created, updated and reviewed over time.',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    description: 'Workspace location, backups and application information.',
  },
];
