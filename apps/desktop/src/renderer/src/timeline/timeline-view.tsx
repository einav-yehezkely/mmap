/**
 * Learning timeline (PRD §5.9): recorded activity, newest first, grouped by day in the
 * workspace timezone, with date-range, event-type, tag and node filters. Review entries carry the
 * user's reflection, which can be edited or removed; recorded activity cannot.
 *
 * The timeline shows what happened. It does not infer or score understanding.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import { Pencil, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';

import { ConfirmDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { formatCalendarDate, formatTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';
import { cn } from '../lib/utils';
import { notifyNodesChanged, useNodesChanged } from '../nodes/node-events';
import { NodePicker, type PickedNode } from '../nodes/node-picker';
import { TagFilterBar, type TagOption } from '../nodes/tag-filter-bar';
import { ReviewDialog } from './review-dialog';
import { describeEntry, EVENT_TYPE_LABELS, groupByLocalDay, isSession } from './timeline-model';

type EventType = TimelineEntryDto['eventType'];
const EVENT_TYPES = Object.keys(EVENT_TYPE_LABELS) as EventType[];
const PAGE_SIZE = 50;

interface Filters {
  readonly fromDate: string;
  readonly toDate: string;
  readonly eventTypes: readonly EventType[];
  readonly tagIds: readonly string[];
  readonly node: PickedNode | null;
}

const NO_FILTERS: Filters = { fromDate: '', toDate: '', eventTypes: [], tagIds: [], node: null };

function listRequest(filters: Filters, cursor?: string) {
  return {
    fromDate: filters.fromDate === '' ? null : filters.fromDate,
    toDate: filters.toDate === '' ? null : filters.toDate,
    eventTypes: [...filters.eventTypes],
    tagIds: [...filters.tagIds],
    nodeId: filters.node?.id ?? null,
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function TimelineView({
  timeZone,
  onOpenNode,
}: {
  timeZone: string;
  onOpenNode: (nodeId: string) => void;
}) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [entries, setEntries] = useState<readonly TimelineEntryDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagOptions, setTagOptions] = useState<readonly TagOption[]>([]);
  const [editing, setEditing] = useState<TimelineEntryDto | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TimelineEntryDto | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const fromId = useId();
  const toId = useId();

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.timeline.list(listRequest(filters))).then(
      (page) => {
        if (cancelled) return;
        setEntries(page.items);
        setNextCursor(page.nextCursor);
        setError(null);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    unwrap(window.mmap.tags.list()).then(
      (tags) => {
        if (!cancelled) setTagOptions(tags.items);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [filters, reloadToken, timeZone]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  useNodesChanged(reload);

  const loadMore = async () => {
    if (nextCursor === null) return;
    try {
      const page = await unwrap(window.mmap.timeline.list(listRequest(filters, nextCursor)));
      setEntries((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const saveReflection = async (reflection: string | null) => {
    if (editing === null) return;
    setEditError(null);
    try {
      await unwrap(window.mmap.timeline.updateReflection({ eventId: editing.id, reflection }));
      setEditing(null);
      reload();
    } catch (caught) {
      setEditError(errorMessage(caught));
    }
  };

  const toggleType = (type: EventType) =>
    setFilters((current) => ({
      ...current,
      eventTypes: current.eventTypes.includes(type)
        ? current.eventTypes.filter((item) => item !== type)
        : [...current.eventTypes, type],
    }));

  const days = entries === null ? [] : groupByLocalDay(entries, timeZone);
  const hasFilters =
    filters.fromDate !== '' ||
    filters.toDate !== '' ||
    filters.eventTypes.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.node !== null;

  return (
    <section aria-labelledby="timeline-heading" className="space-y-4">
      <div>
        <h1 id="timeline-heading" className="text-2xl font-semibold tracking-tight">
          Timeline
        </h1>
        <p className="text-sm text-muted-foreground">
          What you created, edited, connected and reviewed, newest first. Dates and times are in{' '}
          {timeZone} (change it in Settings).
        </p>
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor={fromId} className="block text-sm text-muted-foreground">
              From
            </label>
            <Input
              id={fromId}
              type="date"
              className="w-40"
              value={filters.fromDate}
              onChange={(event) =>
                setFilters((current) => ({ ...current, fromDate: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={toId} className="block text-sm text-muted-foreground">
              To
            </label>
            <Input
              id={toId}
              type="date"
              className="w-40"
              value={filters.toDate}
              onChange={(event) =>
                setFilters((current) => ({ ...current, toDate: event.target.value }))
              }
            />
          </div>
          <div role="group" aria-label="Event types" className="flex flex-wrap gap-1.5">
            {EVENT_TYPES.map((type) => {
              const isSelected = filters.eventTypes.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggleType(type)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'hover:bg-accent',
                  )}
                >
                  {EVENT_TYPE_LABELS[type]}
                </button>
              );
            })}
          </div>
        </div>
        <TagFilterBar
          options={tagOptions}
          selected={filters.tagIds}
          onChange={(tagIds) => setFilters((current) => ({ ...current, tagIds }))}
        />
        {filters.node === null ? (
          <div className="max-w-sm">
            <NodePicker
              label="Only this node"
              placeholder="Filter by node"
              onPick={(node) => setFilters((current) => ({ ...current, node }))}
            />
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm">
            Only <strong dir="auto">{filters.node.title}</strong>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Show all nodes"
              onClick={() => setFilters((current) => ({ ...current, node: null }))}
            >
              <X aria-hidden="true" />
            </Button>
          </p>
        )}
        {hasFilters && (
          <Button size="sm" variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
            Clear all filters
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {entries === null && error === null && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the timeline…
        </p>
      )}
      {entries !== null && entries.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {hasFilters ? 'Nothing matches these filters.' : 'No activity recorded yet.'}
        </p>
      )}

      {days.map((day) => (
        <section key={day.date} aria-label={formatCalendarDate(day.date)} className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {formatCalendarDate(day.date)}
          </h2>
          <ol className="space-y-2">
            {day.entries.map((entry) => (
              <li key={entry.id} className="rounded-md border px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="text-muted-foreground tabular-nums">
                    {formatTime(entry.occurredAt, timeZone)}
                    {isSession(entry) && `–${formatTime(entry.lastActivityAt, timeZone)}`}
                  </span>
                  <span>{describeEntry(entry)}</span>
                  {entry.nodeId !== null ? (
                    <button
                      type="button"
                      className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      dir="auto"
                      onClick={() => entry.nodeId !== null && onOpenNode(entry.nodeId)}
                    >
                      {entry.nodeTitle ?? 'Untitled'}
                    </button>
                  ) : (
                    <span className="font-medium" dir="auto">
                      {entry.nodeTitle ?? 'a node'}{' '}
                      <span className="font-normal text-muted-foreground">(deleted)</span>
                    </span>
                  )}
                  {entry.isImported && (
                    <span className="rounded border px-1 text-xs text-muted-foreground">
                      Imported
                    </span>
                  )}
                  {entry.eventType === 'reviewed' && (
                    <span className="ml-auto flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Edit reflection"
                        title="Edit reflection"
                        onClick={() => {
                          setEditError(null);
                          setEditing(entry);
                        }}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Delete this review"
                        title="Delete this review"
                        onClick={() => setDeleting(entry)}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </span>
                  )}
                </div>
                {entry.reflection !== null && (
                  <p className="mt-1 whitespace-pre-wrap text-sm" dir="auto">
                    {entry.reflection}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}

      {nextCursor !== null && (
        <Button variant="outline" onClick={() => void loadMore()}>
          Load more
        </Button>
      )}

      {editing !== null && (
        <ReviewDialog
          mode="edit"
          nodeTitle={editing.nodeTitle ?? 'this node'}
          initialReflection={editing.reflection}
          error={editError}
          onSubmit={(reflection) => void saveReflection(reflection)}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this review?"
        confirmLabel="Delete review"
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target === null) return;
          unwrap(window.mmap.timeline.deleteReviewed({ eventId: target.id })).then(
            () => notifyNodesChanged(),
            (caught: unknown) => setError(errorMessage(caught)),
          );
        }}
      >
        <p>
          The review entry and its reflection are removed from the timeline. The node is not
          changed.
        </p>
      </ConfirmDialog>
    </section>
  );
}
