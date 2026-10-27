/**
 * Adds a learning milestone to the timeline: a title, optional details, an optional related node
 * and when it happened (defaults to now). Milestones are the user's own entries: they can be
 * edited and deleted later.
 */

import { X } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '../components/ui/button';
import { FormDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { errorMessage, unwrap } from '../lib/ipc';
import { NodePicker, type PickedNode } from '../nodes/node-picker';
import { fromLocalInputValue, toLocalInputValue } from './timeline-model';

export interface MilestoneDialogProps {
  readonly timeZone: string;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}

export function MilestoneDialog({ timeZone, onClose, onAdded }: MilestoneDialogProps) {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [node, setNode] = useState<PickedNode | null>(null);
  // "Now" as shown when the dialog opened; left unchanged, the milestone has no separate
  // learning date (it is placed at the moment it is recorded).
  const [openedAt] = useState(() => toLocalInputValue(new Date().toISOString(), timeZone));
  const [when, setWhen] = useState(openedAt);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const detailsId = useId();
  const whenId = useId();

  const submit = async () => {
    setError(null);
    const learnedAt = when === openedAt ? null : fromLocalInputValue(when, timeZone);
    if (when !== openedAt && learnedAt === null) {
      setError('Enter a valid date and time.');
      return;
    }
    try {
      await unwrap(
        window.mmap.timeline.addMilestone({
          title,
          details: details.trim() === '' ? null : details,
          nodeId: node?.id ?? null,
          learnedAt,
        }),
      );
      onAdded();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add a learning milestone"
      description="Record something you learned or achieved, for example finishing a course or understanding a hard idea."
      submitLabel="Add milestone"
      submitDisabled={title.trim() === ''}
      onSubmit={() => void submit()}
    >
      <div className="space-y-1">
        <label htmlFor={titleId} className="text-sm">
          Title
        </label>
        <Input
          id={titleId}
          autoFocus
          dir="auto"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={whenId} className="text-sm">
          When did it happen?
        </label>
        <Input
          id={whenId}
          type="datetime-local"
          value={when}
          onChange={(event) => setWhen(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={detailsId} className="text-sm">
          Details (optional)
        </label>
        <textarea
          id={detailsId}
          dir="auto"
          rows={3}
          maxLength={2_000}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={details}
          onChange={(event) => setDetails(event.target.value)}
        />
      </div>
      {node === null ? (
        <NodePicker
          label="Related node (optional)"
          placeholder="Link the milestone to a node"
          onPick={setNode}
        />
      ) : (
        <p className="flex items-center gap-2 text-sm">
          Related node: <strong dir="auto">{node.title}</strong>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Remove the related node"
            onClick={() => setNode(null)}
          >
            <X aria-hidden="true" />
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </FormDialog>
  );
}
