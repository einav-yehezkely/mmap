/**
 * Side panel for the timeline event the user selected: what happened, when (the learning date and
 * the recorded time are shown separately), the related node, and the reflection or details.
 *
 * The learning date can be set or cleared on any event: it annotates when the learning happened
 * and never changes the recorded time. Title and reflection can be edited, and the entry deleted,
 * only for the user's own reviews and milestones; recorded activity stays as it happened.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import { ExternalLink, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';

import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { formatDateTime, formatTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';
import {
  describeEntry,
  effectiveTime,
  entrySubject,
  EVENT_STYLES,
  EVENT_TYPE_LABELS,
  fromLocalInputValue,
  isSession,
  isUserOwned,
  toLocalInputValue,
} from './timeline-model';

export interface TimelineEventPanelProps {
  readonly entry: TimelineEntryDto;
  readonly timeZone: string;
  readonly onOpenNode: (nodeId: string) => void;
  /** Called with the updated entry after a change, or null after deleting it. */
  readonly onChanged: (entry: TimelineEntryDto | null) => void;
  readonly onClose: () => void;
}

export function TimelineEventPanel({
  entry,
  timeZone,
  onOpenNode,
  onChanged,
  onClose,
}: TimelineEventPanelProps) {
  const [learnedInput, setLearnedInput] = useState(
    toLocalInputValue(effectiveTime(entry), timeZone),
  );
  const [title, setTitle] = useState(entry.title ?? '');
  const [reflection, setReflection] = useState(entry.reflection ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const learnedId = useId();
  const titleId = useId();
  const reflectionId = useId();
  const owned = isUserOwned(entry);

  const update = async (changes: {
    title?: string;
    reflection?: string | null;
    learnedAt?: string | null;
  }) => {
    setError(null);
    try {
      onChanged(await unwrap(window.mmap.timeline.updateEntry({ eventId: entry.id, ...changes })));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const saveLearningDate = () => {
    const learnedAt = fromLocalInputValue(learnedInput, timeZone);
    if (learnedAt === null) {
      setError('Enter a valid date and time.');
      return;
    }
    void update({ learnedAt });
  };

  return (
    <aside
      aria-label="Timeline event"
      className="flex w-80 shrink-0 flex-col gap-3 overflow-auto rounded-md border bg-background p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-1 size-3 shrink-0 rounded-sm"
          style={{ backgroundColor: EVENT_STYLES[entry.eventType].color }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase text-muted-foreground">
            {EVENT_TYPE_LABELS[entry.eventType]}
          </p>
          <h2 className="break-words text-base font-semibold" dir="auto">
            {describeEntry(entry)} {entrySubject(entry)}
          </h2>
        </div>
        <Button size="icon" variant="ghost" aria-label="Close event details" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {entry.learnedAt !== null && (
          <>
            <dt className="text-muted-foreground">Learned</dt>
            <dd>{formatDateTime(entry.learnedAt, timeZone)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Recorded</dt>
        <dd>
          {formatDateTime(entry.occurredAt, timeZone)}
          {isSession(entry) && ` – ${formatTime(entry.lastActivityAt, timeZone)} (editing session)`}
        </dd>
        {entry.isImported && (
          <>
            <dt className="text-muted-foreground">Source</dt>
            <dd>Imported history</dd>
          </>
        )}
      </dl>

      {entry.nodeId !== null ? (
        <Button
          size="sm"
          variant="outline"
          className="justify-start"
          onClick={() => entry.nodeId !== null && onOpenNode(entry.nodeId)}
        >
          <ExternalLink aria-hidden="true" />
          <span className="truncate" dir="auto">
            Open {entry.nodeTitle ?? 'node'}
          </span>
        </Button>
      ) : (
        entry.nodeTitle !== null && (
          <p className="text-muted-foreground" dir="auto">
            {entry.nodeTitle} (deleted)
          </p>
        )
      )}

      {!owned && entry.reflection !== null && (
        <p className="whitespace-pre-wrap" dir="auto">
          {entry.reflection}
        </p>
      )}

      <section aria-labelledby={learnedId} className="space-y-1 border-t pt-3">
        <label id={learnedId} htmlFor={`${learnedId}-input`} className="block font-medium">
          When did the learning happen?
        </label>
        <p className="text-xs text-muted-foreground">
          Defaults to the recorded time. Changing it moves the event on the timeline; the recorded
          time stays.
        </p>
        <Input
          id={`${learnedId}-input`}
          type="datetime-local"
          value={learnedInput}
          onChange={(event) => setLearnedInput(event.target.value)}
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={saveLearningDate}>
            Save learning date
          </Button>
          {entry.learnedAt !== null && (
            <Button size="sm" variant="ghost" onClick={() => void update({ learnedAt: null })}>
              Use recorded time
            </Button>
          )}
        </div>
      </section>

      {owned && (
        <section className="space-y-2 border-t pt-3">
          {entry.eventType === 'milestone' && (
            <div className="space-y-1">
              <label htmlFor={titleId} className="block font-medium">
                Title
              </label>
              <Input
                id={titleId}
                dir="auto"
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
          )}
          <div className="space-y-1">
            <label htmlFor={reflectionId} className="block font-medium">
              {entry.eventType === 'milestone' ? 'Details' : 'Reflection'}
            </label>
            <textarea
              id={reflectionId}
              dir="auto"
              rows={4}
              maxLength={2_000}
              className="w-full rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={reflection}
              onChange={(event) => setReflection(event.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                void update({
                  ...(entry.eventType === 'milestone' ? { title } : {}),
                  reflection: reflection.trim() === '' ? null : reflection,
                })
              }
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden="true" />
              Delete
            </Button>
          </div>
        </section>
      )}

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={entry.eventType === 'milestone' ? 'Delete this milestone?' : 'Delete this review?'}
        confirmLabel="Delete"
        onConfirm={() => {
          setConfirmDelete(false);
          unwrap(window.mmap.timeline.deleteEntry({ eventId: entry.id })).then(
            () => onChanged(null),
            (caught: unknown) => setError(errorMessage(caught)),
          );
        }}
      >
        <p>The entry is removed from the timeline. Nodes are not changed.</p>
      </ConfirmDialog>
    </aside>
  );
}
