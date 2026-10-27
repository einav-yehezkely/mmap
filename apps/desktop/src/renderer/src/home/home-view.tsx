/**
 * Home: the first screen when the app opens. It answers "where was I, and what can I do?" at a
 * glance, without competing with the real work views:
 *
 * - a greeting with the workspace name and today's date;
 * - quick actions (new note, search, mind maps, graph);
 * - "Continue where you left off": the most recently edited notes;
 * - recent mind maps and recent learning activity;
 * - a quiet line with counts and the last backup.
 *
 * A new, empty workspace instead shows three first steps. Every item is a real button with a
 * visible focus ring, and lists are lists, so the page works well with a keyboard and a screen
 * reader.
 */

import type { BackupStatusDto, IpcResponse, TimelineEntryDto } from '@mmap/contracts';
import {
  ArrowRight,
  Clock3,
  FileText,
  Network,
  Plus,
  Search,
  ShieldCheck,
  ShieldAlert,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '../components/ui/button';
import { formatCalendarDate } from '../lib/format-date';
import { unwrap } from '../lib/ipc';
import { useNodesChanged } from '../nodes/node-events';
import { localDateOf } from '@mmap/domain';
import {
  describeEntry,
  entrySubject,
  EVENT_STYLES,
  effectiveTime,
} from '../timeline/timeline-model';
import { greeting, relativeTime } from './home-model';

type NodeSummary = IpcResponse<'nodes:list'>['items'][number];
type MapSummary = IpcResponse<'maps:list'>['items'][number];

interface HomeData {
  readonly recentNodes: readonly NodeSummary[];
  readonly nodeCount: number;
  readonly maps: readonly MapSummary[];
  readonly activity: readonly TimelineEntryDto[];
  readonly backups: BackupStatusDto | null;
}

export interface HomeViewProps {
  readonly workspaceName: string;
  readonly timeZone: string;
  readonly onOpenNode: (nodeId: string) => void;
  readonly onOpenMap: (mapId: string) => void;
  readonly onNavigate: (view: 'maps' | 'graph' | 'timeline' | 'settings' | 'library') => void;
  readonly onCreateNode: () => void;
  readonly onFocusSearch: () => void;
}

export function HomeView({
  workspaceName,
  timeZone,
  onOpenNode,
  onOpenMap,
  onNavigate,
  onCreateNode,
  onFocusSearch,
}: HomeViewProps) {
  const [data, setData] = useState<HomeData | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [now] = useState(() => Date.now());
  useNodesChanged(() => setReloadToken((token) => token + 1));

  useEffect(() => {
    let cancelled = false;
    // Each part loads on its own, so one failure (for example backups) never empties the page.
    const optional = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
    void Promise.all([
      optional(unwrap(window.mmap.nodes.list({ sort: 'updated-desc', limit: 6 })), null),
      optional(unwrap(window.mmap.maps.list()), null),
      optional(unwrap(window.mmap.timeline.list({ limit: 6 })), null),
      optional(unwrap(window.mmap.backups.getStatus({})), null),
    ]).then(([nodes, maps, timeline, backups]) => {
      if (cancelled) return;
      setData({
        recentNodes: nodes?.items ?? [],
        nodeCount: nodes?.totalCount ?? 0,
        maps: maps?.items ?? [],
        activity: timeline?.items ?? [],
        backups,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const today = formatCalendarDate(localDateOf(new Date(now).toISOString(), timeZone));

  return (
    <section aria-labelledby="home-title" className="mx-auto max-w-5xl space-y-8 pb-8">
      <header className="space-y-1 pt-2">
        <p className="text-sm text-muted-foreground">{today}</p>
        <h1 id="home-title" className="text-3xl font-semibold tracking-tight">
          {greeting(now, timeZone)}
        </h1>
        <p className="text-muted-foreground" dir="auto">
          You are in <span className="font-medium text-foreground">{workspaceName}</span>.
        </p>
      </header>

      <div
        role="group"
        aria-label="Quick actions"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <QuickAction
          icon={Plus}
          title="New node"
          hint="Start a new note"
          primary
          onClick={onCreateNode}
        />
        <QuickAction
          icon={Search}
          title="Search"
          hint="Find anything · Ctrl+K"
          onClick={onFocusSearch}
        />
        <QuickAction
          icon={Workflow}
          title="Mind maps"
          hint="Arrange ideas visually"
          onClick={() => onNavigate('maps')}
        />
        <QuickAction
          icon={Network}
          title="Knowledge graph"
          hint="See how ideas connect"
          onClick={() => onNavigate('graph')}
        />
      </div>

      {data === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : data.nodeCount === 0 ? (
        <GettingStarted onCreateNode={onCreateNode} onNavigate={onNavigate} />
      ) : (
        <>
          <Panel
            title="Continue where you left off"
            action={{ label: 'All notes', onClick: () => onNavigate('library') }}
          >
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.recentNodes.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => onOpenNode(node.id)}
                    className="group flex h-full w-full flex-col gap-1 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex items-start gap-2">
                      <FileText
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="line-clamp-2 font-medium" dir="auto">
                        {node.title}
                      </span>
                    </span>
                    <span className="mt-auto pl-6 text-xs text-muted-foreground">
                      Edited {relativeTime(node.updatedAt, now)}
                      {node.tags.length > 0 && ` · ${node.tags.map((tag) => tag.label).join(', ')}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>

          <div className="grid gap-8 lg:grid-cols-2">
            <Panel
              title="Mind maps"
              action={{ label: 'All maps', onClick: () => onNavigate('maps') }}
            >
              {data.maps.length === 0 ? (
                <EmptyLine>
                  No mind maps yet.{' '}
                  <InlineLink onClick={() => onNavigate('maps')}>Create your first map</InlineLink>
                </EmptyLine>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {data.maps.slice(0, 5).map((map) => (
                    <li key={map.id}>
                      <button
                        type="button"
                        onClick={() => onOpenMap(map.id)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <Workflow
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
                          {map.title}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {map.placementCount === 1 ? '1 item' : `${map.placementCount} items`} ·{' '}
                          {relativeTime(map.updatedAt, now)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Recent activity"
              action={{ label: 'Timeline', onClick: () => onNavigate('timeline') }}
            >
              {data.activity.length === 0 ? (
                <EmptyLine>Nothing recorded yet.</EmptyLine>
              ) : (
                <ul className="space-y-1">
                  {data.activity.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        disabled={entry.nodeId === null}
                        onClick={() => entry.nodeId !== null && onOpenNode(entry.nodeId)}
                        className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: EVENT_STYLES[entry.eventType].color }}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-muted-foreground">{describeEntry(entry)} </span>
                          <span dir="auto">{entrySubject(entry)}</span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {relativeTime(effectiveTime(entry), now)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <AtAGlance data={data} now={now} onNavigate={onNavigate} />
        </>
      )}
    </section>
  );
}

function QuickAction({
  icon: Icon,
  title,
  hint,
  primary = false,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-center gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
        (primary
          ? 'border-primary/50 bg-primary/10 hover:bg-primary/20'
          : 'bg-card hover:border-primary/60 hover:bg-accent/40')
      }
    >
      <span
        className={
          'flex size-9 shrink-0 items-center justify-center rounded-md ' +
          (primary ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')
        }
      >
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={action.onClick}
        >
          {action.label}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      {children}
    </section>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{children}</p>
  );
}

function InlineLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function AtAGlance({
  data,
  now,
  onNavigate,
}: {
  data: HomeData;
  now: number;
  onNavigate: HomeViewProps['onNavigate'];
}) {
  const backups = data.backups;
  const backupProblem =
    backups !== null && (backups.lastFailure !== null || backups.lastSuccessAt === null);
  const BackupIcon = backupProblem ? ShieldAlert : ShieldCheck;
  return (
    <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-4 text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <FileText aria-hidden="true" className="size-4" />
        {data.nodeCount === 1 ? '1 note' : `${data.nodeCount.toLocaleString()} notes`}
      </span>
      <span className="flex items-center gap-2">
        <Workflow aria-hidden="true" className="size-4" />
        {data.maps.length === 1 ? '1 mind map' : `${data.maps.length.toLocaleString()} mind maps`}
      </span>
      {data.activity[0] !== undefined && (
        <span className="flex items-center gap-2">
          <Clock3 aria-hidden="true" className="size-4" />
          Last activity {relativeTime(effectiveTime(data.activity[0]), now)}
        </span>
      )}
      {backups !== null && (
        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className={
            'ml-auto flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
            (backupProblem ? 'text-amber-700 dark:text-amber-400' : '')
          }
        >
          <BackupIcon aria-hidden="true" className="size-4" />
          {backups.lastFailure !== null
            ? 'The last backup failed — check Settings'
            : backups.lastSuccessAt === null
              ? 'No backup yet'
              : `Backed up ${relativeTime(backups.lastSuccessAt, now)}`}
        </button>
      )}
    </footer>
  );
}

function GettingStarted({
  onCreateNode,
  onNavigate,
}: {
  onCreateNode: () => void;
  onNavigate: HomeViewProps['onNavigate'];
}) {
  const steps: { title: string; text: string; action: string; onClick: () => void }[] = [
    {
      title: 'Write your first note',
      text: 'A note is one idea: a concept, a question, a summary. Add formatting, math and files.',
      action: 'New node',
      onClick: onCreateNode,
    },
    {
      title: 'Link ideas together',
      text: 'Type [[ in a note to link another note, or add a typed relationship such as "explains".',
      action: 'Open the library',
      onClick: () => onNavigate('library'),
    },
    {
      title: 'See the big picture',
      text: 'Arrange notes on mind maps, or explore every connection in the knowledge graph.',
      action: 'Open mind maps',
      onClick: () => onNavigate('maps'),
    },
  ];
  return (
    <section aria-labelledby="getting-started" className="space-y-3">
      <h2 id="getting-started" className="text-lg font-semibold tracking-tight">
        Get started
      </h2>
      <ol className="grid gap-3 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
              {index + 1}
            </span>
            <h3 className="font-medium">{step.title}</h3>
            <p className="flex-1 text-sm text-muted-foreground">{step.text}</p>
            <Button variant="outline" size="sm" className="self-start" onClick={step.onClick}>
              {step.action}
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
