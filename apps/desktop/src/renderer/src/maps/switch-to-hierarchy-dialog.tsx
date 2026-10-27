/**
 * Reviewed switch from freeform to hierarchical mode (PRD §5.6).
 *
 * mmap suggests parents from the map's connectors (a connector A → B suggests "A is the parent of
 * B"). Items with no connector pointing at them become top-level. Where the suggestion is
 * ambiguous (several connectors point at an item, or following them would form a loop) the user
 * must choose before switching; nothing is guessed. Every suggestion can also be changed here.
 * Freeform positions are kept, so switching back restores the previous layout.
 */

import type { MapViewDto } from '@mmap/contracts';
import { useEffect, useId, useMemo, useState } from 'react';

import { FormDialog } from '../components/ui/dialog';
import { errorMessage, unwrap } from '../lib/ipc';
import { findParentLoops } from './map-model';

const TOP_LEVEL = '';

export interface SwitchToHierarchyDialogProps {
  readonly view: MapViewDto;
  /** Why the last attempt to switch was refused (for example, the chosen parents form a loop). */
  readonly submitError: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: (
    parents: readonly { placementId: string; parentPlacementId: string | null }[],
  ) => void;
}

interface Proposal {
  /** Whether the map's earlier hierarchy is being restored or parents come from connectors. */
  readonly source: 'previous-hierarchy' | 'connectors';
  readonly ambiguous: readonly { placementId: string; candidates: readonly string[] }[];
  /** Suggested parents (not ambiguous), shown for review. */
  readonly suggested: readonly { placementId: string; parentPlacementId: string }[];
}

export function SwitchToHierarchyDialog({
  view,
  submitError,
  onCancel,
  onConfirm,
}: SwitchToHierarchyDialogProps) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  /** Choice per placement: a parent placement ID, TOP_LEVEL, or undefined (still undecided). */
  const [choices, setChoices] = useState<Map<string, string | undefined>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();
  const titles = useMemo(
    () => new Map(view.placements.map((placement) => [placement.id, placement.nodeTitle])),
    [view],
  );
  const titleOf = (placementId: string) => titles.get(placementId) ?? 'Unknown item';

  useEffect(() => {
    let cancelled = false;
    unwrap(window.mmap.maps.proposeHierarchy({ mapId: view.map.id })).then(
      (result) => {
        if (cancelled) return;
        const ambiguousIds = new Set(result.ambiguous.map((item) => item.placementId));
        const initial = new Map<string, string | undefined>();
        for (const { placementId, parentPlacementId } of result.parents) {
          initial.set(
            placementId,
            ambiguousIds.has(placementId) ? undefined : (parentPlacementId ?? TOP_LEVEL),
          );
        }
        setChoices(initial);
        setProposal({
          source: result.source,
          ambiguous: result.ambiguous,
          suggested: result.parents.flatMap(({ placementId, parentPlacementId }) =>
            parentPlacementId === null || ambiguousIds.has(placementId)
              ? []
              : [{ placementId, parentPlacementId }],
          ),
        });
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
    // Fetched again when the map changes while the dialog is open (for example after a reload
    // following a conflict), so the assignment always covers exactly the current items.
  }, [view.map.id, view.map.revision]);

  const undecided = proposal?.ambiguous.filter(
    (item) => choices.get(item.placementId) === undefined,
  ).length;
  const loops = useMemo(
    () =>
      findParentLoops(
        new Map(
          [...choices].map(([placementId, choice]) => [
            placementId,
            choice === undefined || choice === TOP_LEVEL ? null : choice,
          ]),
        ),
      ),
    [choices],
  );
  const topLevelCount = [...choices.values()].filter((choice) => choice === TOP_LEVEL).length;

  const choose = (placementId: string, value: string) =>
    setChoices((current) => new Map(current).set(placementId, value));

  const submit = () => {
    onConfirm(
      [...choices].map(([placementId, choice]) => ({
        placementId,
        parentPlacementId: choice === undefined || choice === TOP_LEVEL ? null : choice,
      })),
    );
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title="Switch to hierarchy"
      description={
        proposal?.source === 'previous-hierarchy'
          ? 'The hierarchy this map had before is restored; items added since then start at the top level. Review it before switching. Positions on the freeform canvas are kept.'
          : 'Each item gets at most one parent. Suggestions come from the connectors on this map; review them before switching. Positions on the freeform canvas are kept for switching back.'
      }
      submitLabel="Switch to hierarchy"
      submitDisabled={proposal === null || (undecided ?? 0) > 0 || loops.length > 0}
      onSubmit={submit}
    >
      {(error ?? submitError) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? submitError}
        </p>
      )}
      {loops.length > 0 && (
        <p role="alert" className="text-sm text-destructive">
          These choices form a loop: {loops.map(titleOf).join(', ')}. Choose “Top level” for one of
          them.
        </p>
      )}
      {proposal === null && error === null && (
        <p role="status" className="text-sm text-muted-foreground">
          Preparing suggestions…
        </p>
      )}
      {proposal !== null && (
        <div className="max-h-[50vh] space-y-4 overflow-auto">
          <p className="text-sm">
            {topLevelCount} of {view.placements.length} items will start at the top level.
          </p>
          {proposal.ambiguous.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Choose a parent ({undecided} still to decide)
              </legend>
              {proposal.ambiguous.map(({ placementId, candidates }) => {
                const selectId = `${baseId}-${placementId}`;
                return (
                  <div key={placementId} className="space-y-1">
                    <label htmlFor={selectId} className="block text-sm">
                      Parent of <span dir="auto">“{titleOf(placementId)}”</span>
                      {candidates.length === 1 && (
                        <span className="text-muted-foreground">
                          {' '}
                          (its connector would form a loop)
                        </span>
                      )}
                    </label>
                    <ParentSelect
                      id={selectId}
                      value={choices.get(placementId)}
                      options={candidates}
                      titleOf={titleOf}
                      onChange={(value) => choose(placementId, value)}
                    />
                  </div>
                );
              })}
            </fieldset>
          )}
          {proposal.suggested.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm">
                Review the {proposal.suggested.length} suggested parents
              </summary>
              <div className="mt-2 space-y-2">
                {proposal.suggested.map(({ placementId, parentPlacementId }) => {
                  const selectId = `${baseId}-${placementId}`;
                  return (
                    <div key={placementId} className="space-y-1">
                      <label htmlFor={selectId} className="block text-sm">
                        Parent of <span dir="auto">“{titleOf(placementId)}”</span>
                      </label>
                      <ParentSelect
                        id={selectId}
                        value={choices.get(placementId)}
                        options={[parentPlacementId]}
                        titleOf={titleOf}
                        onChange={(value) => choose(placementId, value)}
                      />
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      )}
    </FormDialog>
  );
}

function ParentSelect({
  id,
  value,
  options,
  titleOf,
  onChange,
}: {
  id: string;
  value: string | undefined;
  options: readonly string[];
  titleOf: (placementId: string) => string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
      value={value ?? 'undecided'}
      onChange={(event) => onChange(event.target.value)}
    >
      {value === undefined && (
        <option value="undecided" disabled>
          Choose…
        </option>
      )}
      {options.map((option) => (
        <option key={option} value={option}>
          {titleOf(option)}
        </option>
      ))}
      <option value={TOP_LEVEL}>Top level (no parent)</option>
    </select>
  );
}
