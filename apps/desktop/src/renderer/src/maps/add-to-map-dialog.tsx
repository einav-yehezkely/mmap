/**
 * Adds a node to a map (PRD §5.6): pick an existing node, or explicitly create a new one.
 *
 * A node appears at most once per map. At the top level, nodes already on the map are not offered.
 * When adding under an item of a hierarchy, they are offered too, marked "already on this map":
 * choosing one moves that item under the parent instead (what the user means when they pick it).
 */

import { Dialog as DialogPrimitive } from 'radix-ui';

import { Button } from '../components/ui/button';
import { NodePicker } from '../nodes/node-picker';

export interface AddToMapDialogProps {
  /** Title of the item that receives the new child, when adding inside a hierarchy. */
  readonly parentTitle: string | null;
  /** The map items are added to. */
  readonly mapId: string;
  /**
   * Adding under an item of a hierarchy: node ID → placement ID of every item already on the map
   * (offered, and moved under the parent when chosen), and the parent's node, which is never
   * offered. Null at the top level, where items on the map are not offered.
   */
  readonly moveTargets: {
    readonly placementOfNode: ReadonlyMap<string, string>;
    readonly parentNodeId: string;
  } | null;
  readonly onMoveExisting: (placementId: string) => void;
  readonly onAddExisting: (nodeId: string) => void;
  readonly onCreateNew: (title: string) => void;
  readonly onClose: () => void;
}

export function AddToMapDialog({
  parentTitle,
  mapId,
  moveTargets,
  onMoveExisting,
  onAddExisting,
  onCreateNew,
  onClose,
}: AddToMapDialogProps) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-black/50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/4 w-full max-w-lg -translate-x-1/2 rounded-md border bg-background p-6 shadow-lg focus:outline-none">
          <DialogPrimitive.Title className="text-lg font-semibold">
            {parentTitle === null ? 'Add to map' : `Add under “${parentTitle}”`}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
            Choose an existing node or create a new one. The map shows the node itself, so edits to
            it appear on every map.
          </DialogPrimitive.Description>
          <div className="mt-4">
            <NodePicker
              label="Node to add"
              autoFocus
              {...(moveTargets === null
                ? {
                    // Filtered in the main process, so a map of any size works (a list of IDs
                    // was capped at 50, and larger maps found nothing at all).
                    excludeOnMapId: mapId,
                  }
                : {
                    excludeNodeIds: [moveTargets.parentNodeId],
                    describe: (node) =>
                      moveTargets.placementOfNode.has(node.id)
                        ? 'already on this map; moves here'
                        : null,
                  })}
              onPick={(node) => {
                const placementId = moveTargets?.placementOfNode.get(node.id);
                if (placementId === undefined) onAddExisting(node.id);
                else onMoveExisting(placementId);
              }}
              onCreateNew={onCreateNew}
            />
          </div>
          <div className="mt-4 flex justify-end">
            <DialogPrimitive.Close asChild>
              <Button variant="outline">Cancel</Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
