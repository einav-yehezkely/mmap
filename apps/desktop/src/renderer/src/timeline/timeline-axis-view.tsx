/**
 * The visual learning timeline: a horizontal time axis (older left, newer right) with date ticks
 * in the workspace timezone, a "now" line, and event markers placed at each event's effective time
 * (the learning date when set, otherwise when it was recorded).
 *
 * - Each event type has its own shape and icon (and color); editing sessions are bars spanning the
 *   session. Markers sit in rows above the axis so they never overlap.
 * - At wide zoom, nearby events are grouped into a cluster with a count; activating a cluster zooms
 *   in on it, revealing the individual events.
 * - Pan by dragging the background or with the mouse wheel / touchpad; Ctrl + wheel zooms.
 * - Every marker and cluster is a focusable button with a spoken label (Enter or Space activates).
 *   The List tab presents the same events as an accessible list.
 */

import type { TimelineEntryDto } from '@mmap/contracts';
import { BookCheck, Flag, Link2, Pencil, Plus, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { formatDateTime } from '../lib/format-date';
import {
  layoutMarkers,
  narrowerZoom,
  panByPixels,
  ticksFor,
  widerZoom,
  xFor,
  zoomWindow,
  msFor,
  type TimeWindow,
  type ZoomLevel,
} from './timeline-axis';
import {
  describeEntry,
  effectiveTime,
  entrySubject,
  EVENT_STYLES,
  markerInputs,
  type EventType,
} from './timeline-model';

const ROW_HEIGHT = 34;
const MAX_ROWS = 8;
const AXIS_HEIGHT = 44;
const TOP_PADDING = 12;
const MARKER_SIZE = 22;

const ICONS: Record<EventType, LucideIcon> = {
  node_created: Plus,
  note_updated: Pencil,
  relationship_created: Link2,
  reviewed: BookCheck,
  milestone: Flag,
};

export interface TimelineAxisViewProps {
  readonly entries: readonly TimelineEntryDto[];
  readonly window: TimeWindow;
  readonly zoom: ZoomLevel;
  readonly timeZone: string;
  readonly nowMs: number;
  readonly selectedId: string | null;
  readonly onSelect: (entryId: string) => void;
  readonly onWindowChange: (window: TimeWindow, zoom: ZoomLevel) => void;
}

export function TimelineAxisView({
  entries,
  window,
  zoom,
  timeZone,
  nowMs,
  selectedId,
  onSelect,
  onWindowChange,
}: TimelineAxisViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const drag = useRef<{ startX: number; startWindow: TimeWindow; moved: boolean } | null>(null);
  // Latest values for the native wheel listener, which is registered once.
  const latest = useRef({ window, zoom, width, onWindowChange });
  useEffect(() => {
    latest.current = { window, zoom, width, onWindowChange };
  }, [window, zoom, width, onWindowChange]);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(200, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    // A non-passive listener, so wheel gestures move the timeline instead of the page.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const state = latest.current;
      if (event.ctrlKey) {
        const anchor = msFor(
          event.clientX - element.getBoundingClientRect().left,
          state.window,
          state.width,
        );
        const next = event.deltaY > 0 ? widerZoom(state.zoom) : narrowerZoom(state.zoom);
        if (next !== state.zoom) state.onWindowChange(zoomWindow(state.window, next, anchor), next);
        return;
      }
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      state.onWindowChange(panByPixels(state.window, -delta, state.width), state.zoom);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', onWheel);
    };
  }, []);

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const placed = useMemo(
    () =>
      layoutMarkers(markerInputs(entries), window, width, {
        clusterRadiusPx: zoom === 'year' ? 18 : zoom === 'month' ? 12 : 8,
        minGapPx: MARKER_SIZE + 6,
        maxRows: MAX_ROWS,
      }),
    [entries, window, width, zoom],
  );
  const ticks = useMemo(() => ticksFor(window, zoom, timeZone), [window, zoom, timeZone]);
  const rows = Math.max(3, ...placed.map((item) => item.row + 1));
  const height = TOP_PADDING + rows * ROW_HEIGHT + AXIS_HEIGHT;
  const axisY = height - AXIS_HEIGHT + 8;
  const rowY = (row: number) => axisY - 8 - ROW_HEIGHT * (row + 0.5);
  const nowX = xFor(nowMs, window, width);

  const onPointerDown = (event: PointerEvent<SVGRectElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWindow: window, moved: false };
  };
  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const state = drag.current;
    if (state === null) return;
    const delta = event.clientX - state.startX;
    if (Math.abs(delta) > 2) state.moved = true;
    onWindowChange(panByPixels(state.startWindow, delta, width), zoom);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const activate = (handler: () => void) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handler();
    }
  };

  const zoomIntoCluster = (startMs: number, endMs: number) => {
    const next = narrowerZoom(zoom);
    if (next === zoom) return;
    onWindowChange(zoomWindow(window, next, (startMs + endMs) / 2), next);
  };

  return (
    <div ref={container} className="w-full select-none">
      <svg
        width={width}
        height={height}
        role="group"
        aria-label="Learning timeline. Use the List tab for the same events as a list."
        className="block touch-none"
      >
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          className="cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {/* Ticks and their labels along the axis. */}
        {ticks.map((tick) => {
          const x = xFor(tick.ms, window, width);
          return (
            <g key={tick.ms} className="pointer-events-none">
              <line
                x1={x}
                x2={x}
                y1={tick.major ? TOP_PADDING : axisY - 4}
                y2={axisY + (tick.major ? 8 : 4)}
                stroke="currentColor"
                className={tick.major ? 'text-border' : 'text-muted-foreground/40'}
                strokeDasharray={tick.major ? '2 4' : undefined}
              />
              {tick.label !== '' && (
                <text
                  x={x + 3}
                  y={axisY + 22}
                  fontSize={11}
                  fill="currentColor"
                  className={tick.major ? 'font-semibold text-foreground' : 'text-muted-foreground'}
                >
                  {tick.label}
                </text>
              )}
            </g>
          );
        })}
        <line
          x1={0}
          x2={width}
          y1={axisY}
          y2={axisY}
          stroke="currentColor"
          className="pointer-events-none text-muted-foreground"
          strokeWidth={1.5}
        />
        {nowX >= 0 && nowX <= width && (
          <g className="pointer-events-none">
            <line
              x1={nowX}
              x2={nowX}
              y1={TOP_PADDING - 4}
              y2={axisY + 6}
              stroke="currentColor"
              className="text-primary"
              strokeWidth={1.5}
            />
            <text
              x={nowX + 4}
              y={TOP_PADDING + 6}
              fontSize={11}
              fill="currentColor"
              className="text-primary"
            >
              Now
            </text>
          </g>
        )}

        {placed.map((item) => {
          const y = rowY(item.row);
          if (item.kind === 'cluster') {
            const label = `${item.ids.length} events between ${formatDateTime(
              new Date(item.startMs).toISOString(),
              timeZone,
            )} and ${formatDateTime(new Date(item.endMs).toISOString(), timeZone)}. Activate to zoom in.`;
            return (
              <g
                key={`cluster-${item.ids.join(',')}`}
                role="button"
                tabIndex={0}
                aria-label={label}
                className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-ring"
                onClick={() => zoomIntoCluster(item.startMs, item.endMs)}
                onKeyDown={activate(() => zoomIntoCluster(item.startMs, item.endMs))}
              >
                <title>{label}</title>
                <line
                  x1={item.x}
                  x2={item.x}
                  y1={y + 12}
                  y2={axisY}
                  stroke="currentColor"
                  className="text-border"
                />
                <circle
                  cx={item.x}
                  cy={y}
                  r={13}
                  fill="currentColor"
                  className="text-muted"
                  stroke="currentColor"
                  strokeWidth={2}
                />
                <text
                  x={item.x}
                  y={y + 4}
                  fontSize={11}
                  textAnchor="middle"
                  fill="currentColor"
                  className="font-semibold text-foreground"
                >
                  {item.ids.length}
                </text>
              </g>
            );
          }
          const entry = byId.get(item.id);
          if (entry === undefined) return null;
          return (
            <EventMarker
              key={item.id}
              entry={entry}
              x1={item.x1}
              x2={item.x2}
              y={y}
              axisY={axisY}
              timeZone={timeZone}
              selected={entry.id === selectedId}
              onSelect={() => {
                if (drag.current?.moved !== true) onSelect(entry.id);
              }}
              onKeyDown={activate(() => onSelect(entry.id))}
            />
          );
        })}
      </svg>
    </div>
  );
}

function EventMarker({
  entry,
  x1,
  x2,
  y,
  axisY,
  timeZone,
  selected,
  onSelect,
  onKeyDown,
}: {
  entry: TimelineEntryDto;
  x1: number;
  x2: number;
  y: number;
  axisY: number;
  timeZone: string;
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>) => void;
}) {
  const style = EVENT_STYLES[entry.eventType];
  const Icon = ICONS[entry.eventType];
  const half = MARKER_SIZE / 2;
  const when = formatDateTime(effectiveTime(entry), timeZone);
  const label = `${describeEntry(entry)} ${entrySubject(entry)}, ${when}${
    entry.learnedAt === null ? '' : ' (learning date)'
  }`;
  const ring = selected ? 'stroke-foreground' : 'stroke-background';
  let shape;
  switch (style.shape) {
    case 'bar':
      // Editing sessions span their duration (at least the marker's size).
      shape = (
        <rect
          x={x1 - half}
          y={y - half}
          width={Math.max(MARKER_SIZE, x2 - x1 + MARKER_SIZE)}
          height={MARKER_SIZE}
          rx={half}
          fill={style.color}
          className={ring}
          strokeWidth={2}
        />
      );
      break;
    case 'diamond':
      shape = (
        <rect
          x={x1 - half + 2}
          y={y - half + 2}
          width={MARKER_SIZE - 4}
          height={MARKER_SIZE - 4}
          transform={`rotate(45 ${x1} ${y})`}
          fill={style.color}
          className={ring}
          strokeWidth={2}
        />
      );
      break;
    case 'square':
      shape = (
        <rect
          x={x1 - half}
          y={y - half}
          width={MARKER_SIZE}
          height={MARKER_SIZE}
          rx={4}
          fill={style.color}
          className={ring}
          strokeWidth={2}
        />
      );
      break;
    case 'flag':
      // Milestones stand out: a larger pennant-like badge.
      shape = (
        <path
          d={`M ${x1 - half - 2} ${y - half - 2} H ${x1 + half + 4} L ${x1 + half} ${y} L ${x1 + half + 4} ${y + half + 2} H ${x1 - half - 2} Z`}
          fill={style.color}
          className={ring}
          strokeWidth={2}
        />
      );
      break;
    case 'circle':
      shape = (
        <circle cx={x1} cy={y} r={half} fill={style.color} className={ring} strokeWidth={2} />
      );
  }
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      className="cursor-pointer outline-none [&:focus-visible]:opacity-90"
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <title>{label}</title>
      <line x1={x1} x2={x1} y1={y + half} y2={axisY} stroke={style.color} strokeOpacity={0.5} />
      {selected && (
        <circle
          cx={x1}
          cy={y}
          r={half + 5}
          fill="none"
          stroke="currentColor"
          className="text-ring"
          strokeWidth={2}
        />
      )}
      {shape}
      <Icon
        x={x1 - 6}
        y={y - 6}
        width={12}
        height={12}
        color="#0b0d12"
        strokeWidth={2.5}
        aria-hidden="true"
      />
      {entry.learnedAt !== null && (
        // A small dot marks events placed at a user-set learning date.
        <circle
          cx={x1 + half}
          cy={y - half}
          r={3}
          fill="currentColor"
          className="text-foreground"
        />
      )}
    </g>
  );
}
