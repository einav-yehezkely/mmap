/**
 * A region on a freeform map: a named, optionally colored rectangle drawn behind the items that
 * groups them by subject. Items belong to it by position only (their center is inside), so moving
 * an item in or out is all it takes; the canvas moves the items inside along when the region is
 * dragged.
 *
 * While selected it shows resize handles and a remove button. Double-clicking the title renames
 * it: Enter or clicking elsewhere saves, Escape cancels. A new region starts with its title being
 * edited.
 */

import type { MapViewDto } from '@mmap/contracts';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

import { cn } from '../lib/utils';
import { regionColorClass } from './placement-colors';

export type MapRegionView = MapViewDto['regions'][number];

/** Smallest region the resize handles allow (the service accepts 40). */
export const MIN_REGION_WIDTH = 120;
export const MIN_REGION_HEIGHT = 80;
const MAX_REGION_TITLE_LENGTH = 100;

export interface RegionNodeData extends Record<string, unknown> {
  readonly region: MapRegionView;
  /** True for a region just added: its title opens for editing once. */
  readonly autoEdit: boolean;
  readonly onRename: (regionId: string, title: string) => void;
  readonly onResized: (
    regionId: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => void;
  readonly onRemove: (regionId: string) => void;
}

export type RegionFlowNode = Node<RegionNodeData, 'region'>;

export const REGION_NODE_PREFIX = 'region:';

export function regionNodeId(regionId: string): string {
  return `${REGION_NODE_PREFIX}${regionId}`;
}

export function isRegionNodeId(id: string): boolean {
  return id.startsWith(REGION_NODE_PREFIX);
}

export const RegionNode = memo(function RegionNode({ data, selected }: NodeProps<RegionFlowNode>) {
  const { region, autoEdit, onRename, onResized, onRemove } = data;
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(region.title);
  const [autoEdited, setAutoEdited] = useState(autoEdit);
  if (autoEdit && !autoEdited) {
    setAutoEdited(true);
    setEditing(true);
    setDraft(region.title);
  }
  // Selecting the whole title is what a rename usually wants.
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing && input !== null) {
      input.focus();
      input.select();
    }
  }, [editing, input]);

  const finish = (save: boolean) => {
    setEditing(false);
    const title = draft.trim();
    if (save && title !== '' && title !== region.title) onRename(region.id, title);
    else setDraft(region.title);
  };

  return (
    <div
      className={cn(
        'relative h-full w-full rounded-xl border-2 border-dashed',
        regionColorClass(region.color),
        selected && 'border-solid',
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_REGION_WIDTH}
        minHeight={MIN_REGION_HEIGHT}
        color="var(--primary)"
        onResizeEnd={(_event, params) =>
          onResized(region.id, {
            x: Math.round(params.x),
            y: Math.round(params.y),
            width: Math.round(params.width),
            height: Math.round(params.height),
          })
        }
      />
      <div className="absolute left-3 right-3 top-2 flex items-center gap-1">
        {editing ? (
          <input
            ref={setInput}
            aria-label="Region title"
            dir="auto"
            // `nodrag` keeps typing and selecting text from dragging the region.
            className="nodrag h-7 min-w-0 flex-1 rounded border bg-background px-2 text-sm font-semibold"
            value={draft}
            maxLength={MAX_REGION_TITLE_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') finish(true);
              if (event.key === 'Escape') finish(false);
            }}
            onBlur={() => finish(true)}
          />
        ) : (
          <span
            dir="auto"
            className="mmap-region-title min-w-0 truncate text-sm font-semibold text-foreground/80"
            title="Double-click to rename"
            onDoubleClick={(event) => {
              event.stopPropagation();
              setDraft(region.title);
              setEditing(true);
            }}
          >
            {region.title}
          </span>
        )}
        {selected && !editing && (
          <button
            type="button"
            className="nodrag ml-auto inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`Remove region ${region.title}`}
            title="Remove the region (its items stay)"
            onClick={() => onRemove(region.id)}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
});
