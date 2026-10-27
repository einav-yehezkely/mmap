/**
 * Adds a node to a map (PRD §5.6): pick an existing node, or explicitly create a new one. Nodes
 * already on the map are not offered, because a node appears at most once per map.
 */

import { Dialog as DialogPrimitive } from 'radix-ui';

import { Button } from '../components/ui/button';
import { NodePicker } from '../nodes/node-picker';

export interface AddToMapDialogProps {
  /** Title of the item that receives the new child, when adding inside a hierarchy. */
  readonly parentTitle: string | null;
  readonly excludeNodeIds: readonly string[];
  readonly onAddExisting: (nodeId: string) => void;
  readonly onCreateNew: (title: string) => void;
  readonly onClose: () => void;
}

export function AddToMapDialog({
  parentTitle,
  excludeNodeIds,
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
              excludeNodeIds={excludeNodeIds}
              onPick={(node) => onAddExisting(node.id)}
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
