/**
 * Main navigation areas (PRD §6). Kept as data so the sidebar, keyboard handling and future
 * routing share one definition.
 */

import { Clock3, Library, Network, Settings, Workflow, type LucideIcon } from 'lucide-react';

export type ViewId = 'library' | 'maps' | 'graph' | 'timeline' | 'settings';

export interface NavigationItem {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Phase in which the view becomes functional; shown in the empty state until then. */
  readonly availableInPhase: number;
  readonly description: string;
}

export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  {
    id: 'library',
    label: 'Library',
    icon: Library,
    availableInPhase: 1,
    description: 'Browse, sort and open every knowledge node in this workspace.',
  },
  {
    id: 'maps',
    label: 'Mind Maps',
    icon: Workflow,
    availableInPhase: 3,
    description: 'Arrange existing nodes in freeform or hierarchical maps.',
  },
  {
    id: 'graph',
    label: 'Knowledge Graph',
    icon: Network,
    availableInPhase: 4,
    description: 'Explore typed relationships across the whole workspace.',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    icon: Clock3,
    availableInPhase: 4,
    description: 'Revisit what you created, updated and reviewed over time.',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    availableInPhase: 0,
    description: 'Workspace location, backups and application information.',
  },
];
