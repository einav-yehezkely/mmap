/**
 * Searchable multi-select of mind maps for the knowledge graph. Checking maps filters the graph
 * to the union of their nodes; the eye button highlights one map's members without filtering;
 * the collapse button folds a map into one summary node; the map button opens the mind map with
 * its own layout.
 */

import { ChevronsDownUp, ChevronsUpDown, Eye, Workflow } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import type { SliceMap } from './graph-model';

export interface GraphMapFilterProps {
  readonly maps: readonly SliceMap[];
  readonly selected: readonly string[];
  readonly colors: ReadonlyMap<string, string>;
  readonly highlightedMapId: string | null;
  readonly onChange: (mapIds: readonly string[]) => void;
  readonly onHighlight: (mapId: string | null) => void;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggleCollapsed: (mapId: string) => void;
  readonly onOpenMap: (mapId: string) => void;
}

export function GraphMapFilter({
  maps,
  selected,
  colors,
  highlightedMapId,
  onChange,
  onHighlight,
  collapsed,
  onToggleCollapsed,
  onOpenMap,
}: GraphMapFilterProps) {
  const [search, setSearch] = useState('');
  const searchId = useId();
  if (maps.length === 0) {
    return <p className="text-sm text-muted-foreground">No mind maps yet.</p>;
  }
  const needle = search.trim().toLocaleLowerCase();
  const shown = maps.filter((map) => map.title.toLocaleLowerCase().includes(needle));
  const toggle = (mapId: string) =>
    onChange(
      selected.includes(mapId) ? selected.filter((id) => id !== mapId) : [...selected, mapId],
    );

  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">Mind maps</legend>
      <div className="flex items-center gap-2">
        <label htmlFor={searchId} className="sr-only">
          Search mind maps
        </label>
        <Input
          id={searchId}
          type="search"
          dir="auto"
          className="h-8"
          placeholder="Search maps"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {selected.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => onChange([])}>
            Clear
          </Button>
        )}
      </div>
      <ul className="max-h-48 space-y-0.5 overflow-auto">
        {shown.map((map) => (
          <li key={map.id} className="flex items-center gap-1.5 text-sm">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 hover:bg-accent">
              <input
                type="checkbox"
                checked={selected.includes(map.id)}
                onChange={() => toggle(map.id)}
              />
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: colors.get(map.id) }}
              />
              <span className="min-w-0 flex-1 truncate" dir="auto" title={map.title}>
                {map.title}
              </span>
              <span className="text-xs text-muted-foreground">{map.nodeCount}</span>
            </label>
            <Button
              size="icon"
              variant={highlightedMapId === map.id ? 'outline' : 'ghost'}
              aria-pressed={highlightedMapId === map.id}
              aria-label={`Highlight ${map.title} on the graph`}
              title="Highlight on the graph"
              onClick={() => onHighlight(highlightedMapId === map.id ? null : map.id)}
            >
              <Eye aria-hidden="true" />
            </Button>
            <Button
              size="icon"
              variant={collapsed.has(map.id) ? 'outline' : 'ghost'}
              aria-pressed={collapsed.has(map.id)}
              aria-label={
                collapsed.has(map.id)
                  ? `Expand ${map.title} on the graph`
                  : `Collapse ${map.title} into one summary node`
              }
              title={collapsed.has(map.id) ? 'Expand map' : 'Collapse map'}
              onClick={() => onToggleCollapsed(map.id)}
            >
              {collapsed.has(map.id) ? (
                <ChevronsUpDown aria-hidden="true" />
              ) : (
                <ChevronsDownUp aria-hidden="true" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Open mind map ${map.title}`}
              title="Open mind map"
              onClick={() => onOpenMap(map.id)}
            >
              <Workflow aria-hidden="true" />
            </Button>
          </li>
        ))}
        {shown.length === 0 && <li className="text-sm text-muted-foreground">No map matches.</li>}
      </ul>
      {selected.length > 1 && (
        <p className="text-xs text-muted-foreground">
          Showing nodes on any of the {selected.length} selected maps.
        </p>
      )}
    </fieldset>
  );
}
