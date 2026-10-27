/**
 * Outline of the map: a keyboard-accessible list next to the canvas (PRD §5.6 "keyboard
 * alternatives for adding, opening, and moving items within a hierarchy"; PRD §6 WCAG 2.2 AA).
 *
 * Follows the WAI-ARIA tree pattern with one focusable row at a time (roving tabindex):
 * - Up/Down, Home/End: move focus; Right/Left: expand/collapse or go to child/parent;
 * - Enter: open the node; Insert: add an item (as a child in hierarchical mode); Delete: remove
 *   the item from this map (the node stays in the library);
 * - Alt+Up/Down: move among siblings; Alt+Right: indent under the previous sibling;
 *   Alt+Left: outdent to after the parent (hierarchical mode).
 * The same actions are available as buttons for pointer users.
 */

import type { MapViewDto } from '@mmap/contracts';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plus,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { buildOutlineRows, planKeyboardMove, type HierarchyMove } from './map-model';

export interface MapOutlineProps {
  readonly view: MapViewDto;
  readonly selectedPlacementId: string | null;
  readonly onSelect: (placementId: string | null) => void;
  readonly onOpenNode: (nodeId: string) => void;
  /** Moves an item within the hierarchy; the target is computed when the move runs. */
  readonly onMove: (placementId: string, move: HierarchyMove) => void;
  readonly onToggleCollapse: (placementId: string, collapsed: boolean) => void;
  /** Add an item; in hierarchical mode as a child of `parentPlacementId` (null = top level). */
  readonly onAdd: (parentPlacementId: string | null) => void;
  readonly onRemove: (placementId: string) => void;
}

const MOVE_KEYS: Record<string, HierarchyMove> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'indent',
  ArrowLeft: 'outdent',
};

export function MapOutline({
  view,
  selectedPlacementId,
  onSelect,
  onOpenNode,
  onMove,
  onToggleCollapse,
  onAdd,
  onRemove,
}: MapOutlineProps) {
  const rows = useMemo(() => buildOutlineRows(view), [view]);
  const isHierarchy = view.map.mode === 'hierarchical';
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const [shouldFocus, setShouldFocus] = useState(false);

  // The selected row when it is visible in the outline. Every action works on this row only; when
  // nothing visible is selected, the actions are unavailable rather than falling back to another
  // item the user did not choose.
  const active = rows.find((row) => row.placement.id === selectedPlacementId) ?? null;
  // The row reachable with Tab (roving tabindex): the selection, otherwise the first row.
  // Focusing a row selects it, so keyboard actions always act on the visibly selected row.
  const activeId = active?.placement.id ?? rows[0]?.placement.id ?? null;

  // Moves keyboard focus after the selection changed by keyboard (also after a move, when the
  // rows were rebuilt from the main process's answer).
  useEffect(() => {
    if (!shouldFocus || activeId === null) return;
    rowElements.current.get(activeId)?.focus();
  }, [shouldFocus, activeId, rows]);

  const focusRow = (placementId: string | undefined) => {
    if (placementId === undefined) return;
    setShouldFocus(true);
    onSelect(placementId);
  };

  const move = (placementId: string, direction: HierarchyMove) => {
    setShouldFocus(true);
    onMove(placementId, direction);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (active === null) return;
    const index = rows.indexOf(active);
    const { placement } = active;
    const moveDirection = MOVE_KEYS[event.key];
    if (event.altKey && moveDirection !== undefined) {
      event.preventDefault();
      if (isHierarchy) move(placement.id, moveDirection);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(rows[index + 1]?.placement.id);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(rows[index - 1]?.placement.id);
        return;
      case 'Home':
        event.preventDefault();
        focusRow(rows[0]?.placement.id);
        return;
      case 'End':
        event.preventDefault();
        focusRow(rows.at(-1)?.placement.id);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (!active.hasChildren) return;
        if (placement.isCollapsed) onToggleCollapse(placement.id, false);
        else focusRow(rows[index + 1]?.placement.id);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (active.hasChildren && !placement.isCollapsed) {
          onToggleCollapse(placement.id, true);
        } else {
          focusRow(placement.parentPlacementId ?? undefined);
        }
        return;
      case 'Enter':
        event.preventDefault();
        onOpenNode(placement.nodeId);
        return;
      case 'Insert':
        event.preventDefault();
        onAdd(isHierarchy ? placement.id : null);
        return;
      case 'Delete':
        event.preventDefault();
        onRemove(placement.id);
        return;
    }
  };

  const can = (direction: HierarchyMove) =>
    active !== null &&
    isHierarchy &&
    planKeyboardMove(view, active.placement.id, direction) !== null;

  return (
    <section aria-label="Map outline" className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Outline actions">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onAdd(isHierarchy && active !== null ? active.placement.id : null)}
          title={isHierarchy ? 'Add a child of the selected item (Insert)' : 'Add an item (Insert)'}
        >
          <Plus aria-hidden="true" />
          {isHierarchy && active !== null ? 'Add child' : 'Add'}
        </Button>
        {isHierarchy && (
          <Button size="sm" variant="outline" onClick={() => onAdd(null)}>
            <Plus aria-hidden="true" />
            Add top-level
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={active === null}
          onClick={() => active && onOpenNode(active.placement.nodeId)}
          title="Open the node (Enter)"
        >
          <ExternalLink aria-hidden="true" />
          Open
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={active === null}
          onClick={() => active && onRemove(active.placement.id)}
          title="Remove from this map; the node stays in the library (Delete)"
        >
          <Trash2 aria-hidden="true" />
          Remove
        </Button>
      </div>
      {isHierarchy && (
        <div className="flex gap-1" role="toolbar" aria-label="Move the selected item">
          {(
            [
              ['up', ArrowUp, 'Move up (Alt+Up)'],
              ['down', ArrowDown, 'Move down (Alt+Down)'],
              ['outdent', ArrowLeft, 'Outdent (Alt+Left)'],
              ['indent', ArrowRight, 'Indent under the previous item (Alt+Right)'],
            ] as const
          ).map(([direction, Icon, label]) => (
            <Button
              key={direction}
              size="icon"
              variant="outline"
              aria-label={label}
              title={label}
              disabled={!can(direction)}
              onClick={() => active && move(active.placement.id, direction)}
            >
              <Icon aria-hidden="true" />
            </Button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">This map is empty. Add a node to start.</p>
      ) : (
        <ul
          role="tree"
          aria-label={`Items of ${view.map.title}`}
          className="min-h-0 flex-1 overflow-auto rounded-md border p-1"
          onKeyDown={onKeyDown}
          onBlur={() => setShouldFocus(false)}
        >
          {rows.map((row) => {
            const { placement } = row;
            const isActive = placement.id === activeId;
            return (
              <li
                key={placement.id}
                ref={(element) => {
                  if (element) rowElements.current.set(placement.id, element);
                  else rowElements.current.delete(placement.id);
                }}
                role="treeitem"
                aria-level={row.level}
                aria-posinset={row.position}
                aria-setsize={row.setSize}
                aria-expanded={row.hasChildren ? !placement.isCollapsed : undefined}
                aria-selected={placement.id === selectedPlacementId}
                tabIndex={isActive ? 0 : -1}
                onFocus={() => {
                  if (placement.id !== selectedPlacementId) onSelect(placement.id);
                }}
                onClick={() => onSelect(placement.id)}
                onDoubleClick={() => onOpenNode(placement.nodeId)}
                className={cn(
                  'flex cursor-default items-center gap-1 rounded px-1 py-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  placement.id === selectedPlacementId && 'bg-accent text-accent-foreground',
                )}
                style={{ paddingInlineStart: `${(row.level - 1) * 16 + 4}px` }}
              >
                {row.hasChildren ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="text-muted-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleCollapse(placement.id, !placement.isCollapsed);
                    }}
                  >
                    {placement.isCollapsed ? (
                      <ChevronRight className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                  </button>
                ) : (
                  <span className="inline-block w-3" aria-hidden="true" />
                )}
                <span dir="auto" className="truncate">
                  {placement.nodeTitle}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Keyboard shortcuts</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>Up/Down: previous/next item; Left/Right: collapse/expand</li>
          <li>Enter: open the node; Insert: add; Delete: remove from this map</li>
          {isHierarchy && <li>Alt+Up/Down: reorder; Alt+Right: indent; Alt+Left: outdent</li>}
          {!isHierarchy && <li>On the canvas, arrow keys move the selected item</li>}
        </ul>
      </details>
    </section>
  );
}
