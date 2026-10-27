/**
 * Placement colors (map styling, PRD §4.4). Colors are decoration chosen by the user and never
 * the only way information is shown; every color also has a text name in the color picker.
 */

import type { PlacementViewDto } from '@mmap/contracts';

export type PlacementColor = NonNullable<PlacementViewDto['color']>;

export const PLACEMENT_COLOR_OPTIONS: readonly { value: PlacementColor; label: string }[] = [
  { value: 'gray', label: 'Gray' },
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'amber', label: 'Amber' },
  { value: 'red', label: 'Red' },
  { value: 'violet', label: 'Violet' },
];

const COLOR_CLASSES: Record<PlacementColor, string> = {
  gray: 'border-zinc-400 bg-zinc-50 dark:bg-zinc-900',
  blue: 'border-blue-500 bg-blue-50 dark:bg-blue-950',
  green: 'border-green-600 bg-green-50 dark:bg-green-950',
  amber: 'border-amber-500 bg-amber-50 dark:bg-amber-950',
  red: 'border-red-500 bg-red-50 dark:bg-red-950',
  violet: 'border-violet-500 bg-violet-50 dark:bg-violet-950',
};

export function placementColorClass(color: PlacementViewDto['color']): string {
  return color === null ? 'border-border' : COLOR_CLASSES[color];
}
