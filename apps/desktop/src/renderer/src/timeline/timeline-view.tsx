/**
 * Learning timeline (PRD §5.9): a visual time axis of recorded activity and learning milestones,
 * with an accessible list alongside.
 *
 * - Timeline tab: a horizontal axis (older left, newer right) that opens on recent activity, or
 *   on the latest event if nothing happened recently, so the axis and events are visible at once.
 *   Pan (buttons, drag, wheel), zoom between day, week, month and year, and return to today.
 *   Events sit at their effective time (the learning date when the user set one, otherwise when
 *   they were recorded); nearby events are grouped at wide zoom.
 * - List tab: the same events newest first, grouped by day, fully keyboard and screen-reader
 *   accessible.
 * - Clicking an event (in either tab) opens a side panel with its dates, details and node link.
 * - Filters (dates, event types, tags, node) apply to both tabs. A date range also moves the axis
 *   to that range.
 *
 * The timeline shows what happened. It does not infer or score understanding.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import { localDateRangeToUtc } from '@mmap/domain';
import { ChevronLeft, ChevronRight, Flag, LocateFixed, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { formatCalendarDate, formatTime } from '../lib/format-date';
import { errorMessage, unwrap } from '../lib/ipc';
import { cn } from '../lib/utils';
import { notifyNodesChanged, useNodesChanged } from '../nodes/node-events';
import { NodePicker, type PickedNode } from '../nodes/node-picker';
import { TagFilterBar, type TagOption } from '../nodes/tag-filter-bar';
import { MilestoneDialog } from './milestone-dialog';
import {
  initialWindow,
  panWindow,
  todayWindow,
  windowFor,
  windowLabel,
  zoomWindow,
  ZOOM_LEVELS,
  ZOOM_SPANS_MS,
  type TimeWindow,
  type ZoomLevel,
} from './timeline-axis';
import { TimelineAxisView } from './timeline-axis-view';
import { TimelineEventPanel } from './timeline-event-panel';
import {
  describeEntry,
  effectiveTime,
  entrySubject,
  EVENT_STYLES,
  EVENT_TYPE_LABELS,
  groupByLocalDay,
  isSession,
  type EventType,
} from './timeline-model';

const EVENT_TYPES = Object.keys(EVENT_TYPE_LABELS) as EventType[];
const PAGE_SIZE = 50;
const ZOOM_LABELS: Record<ZoomLevel, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
};

interface Filters {
  readonly fromDate: string;
  readonly toDate: string;
  readonly eventTypes: readonly EventType[];
  readonly tagIds: readonly string[];
  readonly node: PickedNode | null;
}

const NO_FILTERS: Filters = { fromDate: '', toDate: '', eventTypes: [], tagIds: [], node: null };

function filterFields(filters: Filters) {
  return {
    eventTypes: [...filters.eventTypes],
    tagIds: [...filters.tagIds],
    nodeId: filters.node?.id ?? null,
  };
}

function listRequest(filters: Filters, cursor?: string) {
  return {
    fromDate: filters.fromDate === '' ? null : filters.fromDate,
    toDate: filters.toDate === '' ? null : filters.toDate,
    ...filterFields(filters),
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** The date-range filter as UTC bounds, or null bounds when not set (or invalid). */
function dateBounds(
  filters: Filters,
  timeZone: string,
): { from: number | null; to: number | null } {
  try {
    const range = localDateRangeToUtc(
      filters.fromDate === '' ? null : filters.fromDate,
      filters.toDate === '' ? null : filters.toDate,
      timeZone,
    );
    return {
      from: range.fromUtc === null ? null : Date.parse(range.fromUtc),
      to: range.toUtcExclusive === null ? null : Date.parse(range.toUtcExclusive),
    };
  } catch {
    return { from: null, to: null };
  }
}

/** The narrowest zoom whose span holds `spanMs`. */
function zoomForSpan(spanMs: number): ZoomLevel {
  return ZOOM_LEVELS.find((level) => ZOOM_SPANS_MS[level] >= spanMs) ?? 'year';
}

export function TimelineView({
  timeZone,
  onOpenNode,
}: {
  timeZone: string;
  onOpenNode: (nodeId: string) => void;
}) {
  const [tab, setTab] = useState<'timeline' | 'list'>('timeline');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>('month');
  const [timeWindow, setWindow] = useState<TimeWindow | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [windowData, setWindowData] = useState<{
    items: readonly TimelineEntryDto[];
    total: number;
  } | null>(null);
  const [listEntries, setListEntries] = useState<readonly TimelineEntryDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<TimelineEntryDto | null>(null);
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagOptions, setTagOptions] = useState<readonly TagOption[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const fromId = useId();
  const toId = useId();

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  useNodesChanged(reload);

  // "Now" moves on, so the now line and Today stay right during a long session.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.tags.list()).then(
      (tags) => {
        if (!cancelled) setTagOptions(tags.items);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Opening position: recent activity, or the latest event when nothing happened recently.
  useEffect(() => {
    if (timeWindow !== null) return;
    let cancelled = false;
    unwrap(window.mmap.timeline.list({ ...filterFields(NO_FILTERS), limit: 1 })).then(
      (page) => {
        if (cancelled) return;
        const latest = page.items[0];
        setWindow(
          initialWindow(
            'month',
            Date.now(),
            latest === undefined ? null : Date.parse(effectiveTime(latest)),
          ),
        );
      },
      (caught: unknown) => {
        if (!cancelled) {
          setError(errorMessage(caught));
          setWindow(initialWindow('month', Date.now(), null));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [timeWindow]);

  const bounds = useMemo(() => dateBounds(filters, timeZone), [filters, timeZone]);

  /** Changing the date range also moves the axis to that range. */
  const changeDates = (dates: { fromDate?: string; toDate?: string }) => {
    const next = { ...filters, ...dates };
    setFilters(next);
    const range = dateBounds(next, timeZone);
    if (range.from === null && range.to === null) return;
    const from = range.from ?? (range.to ?? Date.now()) - ZOOM_SPANS_MS.month;
    const to = range.to ?? from + ZOOM_SPANS_MS.month;
    const level = zoomForSpan(to - from);
    setZoom(level);
    setWindow(windowFor(level, (from + to) / 2));
  };

  // Events of the visible window (intersected with the date range), reloaded after edits.
  useEffect(() => {
    if (timeWindow === null) return;
    let cancelled = false;
    const start = Math.max(timeWindow.startMs, bounds.from ?? -Infinity);
    const end = Math.min(timeWindow.endMs, bounds.to ?? Infinity);
    const timer = setTimeout(() => {
      if (end <= start) {
        setWindowData({ items: [], total: 0 });
        return;
      }
      unwrap(
        window.mmap.timeline.window({
          fromUtc: new Date(start).toISOString(),
          toUtcExclusive: new Date(end).toISOString(),
          ...filterFields(filters),
        }),
      ).then(
        (result) => {
          if (!cancelled) {
            setWindowData(result);
            setError(null);
          }
        },
        (caught: unknown) => {
          if (!cancelled) setError(errorMessage(caught));
        },
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [timeWindow, filters, bounds.from, bounds.to, reloadToken]);

  // The list tab.
  useEffect(() => {
    if (tab !== 'list') return;
    let cancelled = false;
    unwrap(window.mmap.timeline.list(listRequest(filters))).then(
      (page) => {
        if (cancelled) return;
        setListEntries(page.items);
        setNextCursor(page.nextCursor);
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tab, filters, reloadToken]);

  const loadMore = async () => {
    if (nextCursor === null) return;
    try {
      const page = await unwrap(window.mmap.timeline.list(listRequest(filters, nextCursor)));
      setListEntries((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const changeWindow = useCallback((next: TimeWindow, level: ZoomLevel) => {
    setWindow(next);
    setZoom(level);
  }, []);

  /** Zoom keeps the selected event in place, else now when visible, else the center. */
  const zoomAnchor = (current: TimeWindow): number | undefined => {
    const inside = (ms: number) => ms >= current.startMs && ms <= current.endMs;
    const selectedMs = selected === null ? null : Date.parse(effectiveTime(selected));
    if (selectedMs !== null && inside(selectedMs)) return selectedMs;
    return inside(nowMs) ? nowMs : undefined;
  };

  const goToLatest = () => {
    unwrap(window.mmap.timeline.list({ ...filterFields(filters), limit: 1 })).then(
      (page) => {
        const latest = page.items[0];
        if (latest !== undefined) setWindow(windowFor(zoom, Date.parse(effectiveTime(latest))));
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  };

  const toggleType = (type: EventType) =>
    setFilters((current) => ({
      ...current,
      eventTypes: current.eventTypes.includes(type)
        ? current.eventTypes.filter((item) => item !== type)
        : [...current.eventTypes, type],
    }));

  const filterCount =
    (filters.fromDate === '' ? 0 : 1) +
    (filters.toDate === '' ? 0 : 1) +
    filters.eventTypes.length +
    filters.tagIds.length +
    (filters.node === null ? 0 : 1);
  const days = listEntries === null ? [] : groupByLocalDay(listEntries, timeZone);
  const items = windowData?.items ?? [];

  return (
    <section aria-labelledby="timeline-heading" className="flex h-full flex-col gap-2">
      <h1 id="timeline-heading" className="sr-only">
        Timeline
      </h1>

      <div
        role="toolbar"
        aria-label="Timeline tools"
        className="flex flex-wrap items-center gap-1.5 rounded-md border p-1.5"
      >
        <div
          role="tablist"
          aria-label="Timeline presentation"
          className="flex rounded-md border p-0.5"
        >
          {(['timeline', 'list'] as const).map((value) => (
            <Button
              key={value}
              role="tab"
              size="sm"
              variant={tab === value ? 'outline' : 'ghost'}
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {value === 'timeline' ? 'Timeline' : 'List'}
            </Button>
          ))}
        </div>
        {tab === 'timeline' && timeWindow !== null && (
          <>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
            <Button
              size="icon"
              variant="ghost"
              aria-label="Earlier"
              title="Earlier"
              onClick={() => setWindow(panWindow(timeWindow, -0.5))}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setWindow(todayWindow(zoom, Date.now()))}
            >
              <LocateFixed aria-hidden="true" />
              Today
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Later"
              title="Later"
              onClick={() => setWindow(panWindow(timeWindow, 0.5))}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
            <div role="group" aria-label="Zoom" className="flex rounded-md border p-0.5">
              {ZOOM_LEVELS.map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={zoom === level ? 'outline' : 'ghost'}
                  aria-pressed={zoom === level}
                  onClick={() =>
                    changeWindow(zoomWindow(timeWindow, level, zoomAnchor(timeWindow)), level)
                  }
                >
                  {ZOOM_LABELS[level]}
                </Button>
              ))}
            </div>
            <span className="px-2 text-sm font-medium" aria-live="polite">
              {windowLabel(timeWindow, zoom, timeZone)}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setAddingMilestone(true)}>
            <Flag aria-hidden="true" />
            Add milestone
          </Button>
          <Button
            size="sm"
            variant={filtersOpen || filterCount > 0 ? 'outline' : 'ghost'}
            aria-expanded={filtersOpen}
            aria-controls="timeline-filters"
            onClick={() => setFiltersOpen((value) => !value)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filters{filterCount > 0 ? ` (${filterCount})` : ''}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <div id="timeline-filters" className="space-y-2 rounded-md border p-3">
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
                onChange={(event) => changeDates({ fromDate: event.target.value })}
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
                onChange={(event) => changeDates({ toDate: event.target.value })}
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
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'hover:bg-accent',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="size-2.5 rounded-sm"
                      style={{ backgroundColor: EVENT_STYLES[type].color }}
                    />
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
                size="icon"
                variant="ghost"
                aria-label="Show all nodes"
                onClick={() => setFilters((current) => ({ ...current, node: null }))}
              >
                <X aria-hidden="true" />
              </Button>
            </p>
          )}
          {filterCount > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
              Clear all filters
            </Button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        <div className="min-w-0 flex-1 overflow-auto">
          {tab === 'timeline' && timeWindow !== null && (
            <div className="space-y-2">
              <div className="rounded-md border p-2">
                <TimelineAxisView
                  entries={items}
                  window={timeWindow}
                  zoom={zoom}
                  timeZone={timeZone}
                  nowMs={nowMs}
                  selectedId={selected?.id ?? null}
                  onSelect={(id) => setSelected(items.find((item) => item.id === id) ?? null)}
                  onWindowChange={changeWindow}
                />
              </div>
              <div
                role="status"
                className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground"
              >
                {windowData !== null && windowData.total === 0 && (
                  <>
                    <span>No events in this period.</span>
                    <Button size="sm" variant="ghost" className="h-6 px-2" onClick={goToLatest}>
                      Go to the latest event
                    </Button>
                  </>
                )}
                {windowData !== null && windowData.total > items.length && (
                  <span className="text-amber-600 dark:text-amber-400">
                    Showing {items.length.toLocaleString()} of {windowData.total.toLocaleString()}{' '}
                    events in this period, spread across it; zoom in to see them all.
                  </span>
                )}
                {windowData !== null &&
                  windowData.total > 0 &&
                  windowData.total === items.length && (
                    <span>
                      {windowData.total === 1
                        ? '1 event'
                        : `${windowData.total.toLocaleString()} events`}{' '}
                      in this period. Drag or scroll to move through time; Ctrl + scroll zooms.
                    </span>
                  )}
              </div>
              <TimelineLegend />
            </div>
          )}

          {tab === 'list' && (
            <div className="space-y-4">
              {listEntries !== null && listEntries.length === 0 && (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {filterCount > 0 ? 'Nothing matches these filters.' : 'No activity recorded yet.'}
                </p>
              )}
              {days.map((day) => (
                <section
                  key={day.date}
                  aria-label={formatCalendarDate(day.date)}
                  className="space-y-2"
                >
                  <h2 className="text-sm font-semibold text-muted-foreground">
                    {formatCalendarDate(day.date)}
                  </h2>
                  <ol className="space-y-2">
                    {day.entries.map((entry) => (
                      <li key={entry.id}>
                        <button
                          type="button"
                          className={cn(
                            'w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
                            selected?.id === entry.id && 'border-primary',
                          )}
                          onClick={() => setSelected(entry)}
                        >
                          <span className="flex flex-wrap items-baseline gap-x-2">
                            <span
                              aria-hidden="true"
                              className="size-2.5 self-center rounded-sm"
                              style={{ backgroundColor: EVENT_STYLES[entry.eventType].color }}
                            />
                            <span className="tabular-nums text-muted-foreground">
                              {formatTime(effectiveTime(entry), timeZone)}
                              {entry.learnedAt === null &&
                                isSession(entry) &&
                                `–${formatTime(entry.lastActivityAt, timeZone)}`}
                            </span>
                            <span>{describeEntry(entry)}</span>
                            <span className="font-medium" dir="auto">
                              {entrySubject(entry)}
                              {entry.nodeId === null && entry.eventType !== 'milestone' && (
                                <span className="font-normal text-muted-foreground">
                                  {' '}
                                  (deleted)
                                </span>
                              )}
                            </span>
                            {entry.learnedAt !== null && (
                              <span className="rounded border px-1 text-xs text-muted-foreground">
                                learning date
                              </span>
                            )}
                            {entry.isImported && (
                              <span className="rounded border px-1 text-xs text-muted-foreground">
                                Imported
                              </span>
                            )}
                          </span>
                          {entry.reflection !== null && (
                            <span className="mt-1 block whitespace-pre-wrap" dir="auto">
                              {entry.reflection}
                            </span>
                          )}
                        </button>
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
            </div>
          )}
        </div>

        {selected !== null && (
          <TimelineEventPanel
            key={`${selected.id}-${selected.learnedAt ?? ''}-${selected.reflection ?? ''}-${selected.title ?? ''}`}
            entry={selected}
            timeZone={timeZone}
            onOpenNode={onOpenNode}
            onChanged={(entry) => {
              setSelected(entry);
              reload();
              notifyNodesChanged();
            }}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      {addingMilestone && (
        <MilestoneDialog
          timeZone={timeZone}
          onClose={() => setAddingMilestone(false)}
          onAdded={() => {
            setAddingMilestone(false);
            reload();
          }}
        />
      )}
    </section>
  );
}

/** Explains the marker shapes in words (no color-only meaning, PRD §6). */
function TimelineLegend() {
  const shapes: Record<string, string> = {
    circle: 'circle',
    bar: 'bar',
    diamond: 'diamond',
    square: 'square',
    flag: 'pennant',
  };
  return (
    <ul
      aria-label="Event types"
      className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground"
    >
      {EVENT_TYPES.map((type) => (
        <li key={type} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 rounded-sm"
            style={{ backgroundColor: EVENT_STYLES[type].color }}
          />
          {EVENT_TYPE_LABELS[type]} ({shapes[EVENT_STYLES[type].shape]})
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground" />
        dot: placed at a learning date you set
      </li>
    </ul>
  );
}
