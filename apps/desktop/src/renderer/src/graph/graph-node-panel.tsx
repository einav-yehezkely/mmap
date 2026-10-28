/**
 * Side panel for the node selected in the knowledge graph: title, summary, tags, mind map
 * memberships (with "highlight on graph" and "open mind map"), relationships in words with
 * direction, and actions (open the full note, Focus mode, expand neighbors, add a relationship).
 *
 * "Add relationship" (PRD §5.5: "create relationships from a node detail panel or graph action")
 * opens the node panel's form here. While it is open, clicking another node on the graph chooses
 * it as the other end (`pickedOther`); the picker in the form does the same from the keyboard.
 *
 * Membership and relationships are listed separately: being on the same map is not a
 * relationship (PRD §4.4).
 */

import type { NodeView, RelationshipTypeViewDto, RelationshipViewDto } from '@mmap/contracts';
import { ExternalLink, Eye, Focus, Network, Plus, Workflow, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { errorMessage, unwrap } from '../lib/ipc';
import { notifyNodesChanged, useNodesChanged } from '../nodes/node-events';
import type { PickedNode } from '../nodes/node-picker';
import { AddRelationshipForm } from '../relationships/node-relationships';
import type { SliceMap } from './graph-model';

export interface GraphNodePanelProps {
  readonly nodeId: string;
  readonly maps: readonly SliceMap[];
  readonly memberships: readonly string[];
  readonly mapColors: ReadonlyMap<string, string>;
  readonly highlightedMapId: string | null;
  readonly isFocused: boolean;
  readonly onClose: () => void;
  readonly onOpenNote: () => void;
  readonly onFocus: () => void;
  readonly onExpand: () => void;
  readonly onHighlightMap: (mapId: string | null) => void;
  readonly onOpenMap: (mapId: string) => void;
  /** Called when the "Add relationship" form opens (true) or closes (false). */
  readonly onRelatingChange: (relating: boolean) => void;
  /** The node last clicked on the graph while the form is open. */
  readonly graphPick: PickedNode | null;
}

interface Details {
  readonly node: NodeView;
  readonly relationships: readonly RelationshipViewDto[];
}

export function GraphNodePanel({
  nodeId,
  maps,
  memberships,
  mapColors,
  highlightedMapId,
  isFocused,
  onClose,
  onOpenNote,
  onFocus,
  onExpand,
  onHighlightMap,
  onOpenMap,
  onRelatingChange,
  graphPick,
}: GraphNodePanelProps) {
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Relationship types offered by the form; loaded when it opens. */
  const [types, setTypes] = useState<readonly RelationshipTypeViewDto[] | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // A relationship added here, or anything changed elsewhere, shows up in the list.
  useNodesChanged(useCallback(() => setReloadToken((token) => token + 1), []));

  const relating = types !== null;
  const startRelating = () => {
    setError(null);
    unwrap(window.mmap.relationshipTypes.list()).then(
      (list) => {
        setTypes(list.items.filter((type) => !type.isArchived));
        onRelatingChange(true);
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  };
  const stopRelating = () => {
    setTypes(null);
    onRelatingChange(false);
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      unwrap(window.mmap.nodes.get({ nodeId })),
      unwrap(window.mmap.relationships.listForNode({ nodeId })),
    ]).then(
      ([node, relationships]) => {
        if (!cancelled) setDetails({ node, relationships: relationships.items });
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nodeId, reloadToken]);

  const nodeMaps = maps.filter((map) => memberships.includes(map.id));

  return (
    <aside
      aria-label="Selected node"
      className="flex w-80 shrink-0 flex-col gap-3 overflow-auto rounded-md border bg-background p-3 text-sm"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && relating) {
          event.stopPropagation();
          stopRelating();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 break-words text-base font-semibold" dir="auto">
          {details?.node.title ?? 'Loading…'}
        </h2>
        <Button size="icon" variant="ghost" aria-label="Close node details" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {details?.node.summary && (
        <p className="text-muted-foreground" dir="auto">
          {details.node.summary}
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={onOpenNote}>
          <ExternalLink aria-hidden="true" />
          Open note
        </Button>
        <Button size="sm" variant="outline" aria-pressed={isFocused} onClick={onFocus}>
          <Focus aria-hidden="true" />
          {isFocused ? 'Focused' : 'Focus'}
        </Button>
        <Button size="sm" variant="outline" onClick={onExpand}>
          <Network aria-hidden="true" />
          Expand neighbors
        </Button>
        {!relating && (
          <Button size="sm" variant="outline" onClick={startRelating}>
            <Plus aria-hidden="true" />
            Add relationship
          </Button>
        )}
      </div>

      {relating && (
        <section aria-label="Add a relationship">
          {types.length === 0 ? (
            <p className="text-muted-foreground">
              Every relationship type is archived. Restore or add one in a node's Relationships
              section (Types).
            </p>
          ) : (
            <AddRelationshipForm
              nodeId={nodeId}
              types={types}
              pickedOther={graphPick}
              pickerHint="Or click the other node on the graph."
              onCancel={stopRelating}
              onCreate={async (input) => {
                setError(null);
                try {
                  await unwrap(window.mmap.relationships.create(input));
                  stopRelating();
                  // The graph, this panel and every open view reload.
                  notifyNodesChanged();
                } catch (caught) {
                  setError(errorMessage(caught));
                }
              }}
            />
          )}
        </section>
      )}

      {details !== null && details.node.tags.length > 0 && (
        <section aria-label="Tags">
          <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Tags</h3>
          <ul className="flex flex-wrap gap-1">
            {details.node.tags.map((tag) => (
              <li key={tag.id} className="rounded-full border px-2 py-0.5 text-xs" dir="auto">
                {tag.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Mind maps">
        <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Mind maps</h3>
        {nodeMaps.length === 0 ? (
          <p className="text-muted-foreground">Not on any mind map.</p>
        ) : (
          <ul className="space-y-1">
            {nodeMaps.map((map) => (
              <li key={map.id} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: mapColors.get(map.id) }}
                />
                <span className="min-w-0 flex-1 truncate" dir="auto" title={map.title}>
                  {map.title}
                </span>
                <Button
                  size="icon"
                  variant={highlightedMapId === map.id ? 'outline' : 'ghost'}
                  aria-pressed={highlightedMapId === map.id}
                  aria-label={`Highlight ${map.title} on the graph`}
                  title="Highlight on the graph"
                  onClick={() => onHighlightMap(highlightedMapId === map.id ? null : map.id)}
                >
                  <Eye aria-hidden="true" />
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
          </ul>
        )}
      </section>

      <section aria-label="Relationships">
        <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Relationships</h3>
        {details === null ? null : details.relationships.length === 0 ? (
          <p className="text-muted-foreground">No relationships.</p>
        ) : (
          <ul className="space-y-1">
            {details.relationships.map((relationship) => {
              const outgoing = relationship.source.id === nodeId;
              const other = outgoing ? relationship.target : relationship.source;
              const text =
                relationship.directionality === 'undirected'
                  ? `${relationship.typeLabel} — ${other.title}`
                  : outgoing
                    ? `${relationship.typeLabel} → ${other.title}`
                    : `← ${relationship.typeLabel} ${other.title}`;
              return (
                <li key={relationship.id} dir="auto">
                  {text}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}
