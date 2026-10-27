/**
 * Records that the user reviewed a node (PRD §5.9: "Users can mark a node as learned/reviewed and
 * add a short reflection"). The reflection is optional, and so is the learning date: when left
 * empty, the review is placed at the moment it is recorded. Reviews are edited later from the
 * timeline's event panel.
 */

import { useId, useState } from 'react';

import { FormDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { fromLocalInputValue } from './timeline-model';

const MAX_REFLECTION_LENGTH = 2_000;

export interface ReviewDialogProps {
  readonly nodeTitle: string;
  readonly timeZone: string;
  readonly error: string | null;
  /** The reflection (or null) and the learning date as a UTC instant (or null for "now"). */
  readonly onSubmit: (reflection: string | null, learnedAt: string | null) => void;
  readonly onClose: () => void;
}

export function ReviewDialog({ nodeTitle, timeZone, error, onSubmit, onClose }: ReviewDialogProps) {
  const [reflection, setReflection] = useState('');
  const [when, setWhen] = useState('');
  const [whenError, setWhenError] = useState<string | null>(null);
  const reflectionId = useId();
  const whenId = useId();

  const submit = () => {
    let learnedAt: string | null = null;
    if (when !== '') {
      learnedAt = fromLocalInputValue(when, timeZone);
      if (learnedAt === null) {
        setWhenError('Enter a valid date and time, or leave it empty.');
        return;
      }
    }
    setWhenError(null);
    onSubmit(reflection.trim() === '' ? null : reflection, learnedAt);
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Mark “${nodeTitle}” as reviewed`}
      description="The timeline records that you reviewed this node. Add a short reflection if you like: what became clear, what to revisit."
      submitLabel="Mark as reviewed"
      onSubmit={submit}
    >
      <div className="space-y-1">
        <label htmlFor={reflectionId} className="text-sm">
          Reflection (optional)
        </label>
        <textarea
          id={reflectionId}
          dir="auto"
          rows={5}
          maxLength={MAX_REFLECTION_LENGTH}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={reflection}
          onChange={(event) => setReflection(event.target.value)}
        />
        <p className="text-right text-xs text-muted-foreground">
          {reflection.length} / {MAX_REFLECTION_LENGTH}
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={whenId} className="text-sm">
          When did you learn this? (optional)
        </label>
        <Input
          id={whenId}
          type="datetime-local"
          value={when}
          onChange={(event) => setWhen(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Leave empty for now. The timeline shows the review at this date; the time it was recorded
          is kept as well.
        </p>
      </div>
      {(whenError ?? error) && (
        <p role="alert" className="text-sm text-destructive">
          {whenError ?? error}
        </p>
      )}
    </FormDialog>
  );
}
