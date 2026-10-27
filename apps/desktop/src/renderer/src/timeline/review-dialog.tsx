/**
 * Records that the user reviewed a node, or edits the reflection of an earlier review
 * (PRD §5.9: "Users can mark a node as learned/reviewed and add a short reflection"). The
 * reflection is optional; the timeline records the review either way.
 */

import { useId, useState } from 'react';

import { FormDialog } from '../components/ui/dialog';

const MAX_REFLECTION_LENGTH = 2_000;

export interface ReviewDialogProps {
  readonly mode: 'create' | 'edit';
  readonly nodeTitle: string;
  readonly initialReflection: string | null;
  readonly error: string | null;
  readonly onSubmit: (reflection: string | null) => void;
  readonly onClose: () => void;
}

export function ReviewDialog({
  mode,
  nodeTitle,
  initialReflection,
  error,
  onSubmit,
  onClose,
}: ReviewDialogProps) {
  const [reflection, setReflection] = useState(initialReflection ?? '');
  const reflectionId = useId();
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={mode === 'create' ? `Mark “${nodeTitle}” as reviewed` : 'Edit reflection'}
      description="The timeline records that you reviewed this node. Add a short reflection if you like: what became clear, what to revisit."
      submitLabel={mode === 'create' ? 'Mark as reviewed' : 'Save reflection'}
      onSubmit={() => onSubmit(reflection.trim() === '' ? null : reflection)}
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
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </FormDialog>
  );
}
