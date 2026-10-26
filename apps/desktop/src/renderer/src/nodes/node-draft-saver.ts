/**
 * Autosave state machine for one node being edited (PRD §5.2, §9).
 *
 * Kept free of React and DOM APIs so its timing and failure behaviour can be unit-tested.
 *
 * Rules:
 * - An edit marks the draft `unsaved` and (re)starts an idle timer; after `idleDelayMs` without
 *   further edits the changed fields are sent.
 * - "Saved" is shown only after the main process confirms a durable commit.
 * - Only one save is in flight. Edits made during a save are kept and saved afterwards.
 * - A failed save never discards the draft. Failures are classified:
 *   `conflict` (someone saved a newer revision), `invalid` (the input is rejected and retrying
 *   will not help), `failed` (anything else; the user can retry).
 * - Until a save succeeds, the draft is also persisted through `persistRecovery`, so a crash or a
 *   closed window can be recovered on the next open.
 */

export interface NodeFields {
  readonly title: string;
  readonly summary: string | null;
  readonly note: unknown;
}

export interface SavedVersion {
  readonly fields: NodeFields;
  readonly revision: number;
}

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed' | 'conflict' | 'invalid';

export interface DraftState {
  readonly draft: NodeFields;
  readonly status: SaveStatus;
  /** Message to show for `failed` / `invalid` / `conflict`; never contains note content. */
  readonly message: string | null;
  /** Revision of the last version known to be stored. */
  readonly revision: number;
}

/** Rejection reason for `NodeDraftSaverOptions.save`, classifying how the UI should react. */
export class SaveFailure extends Error {
  public constructor(
    public readonly kind: 'conflict' | 'invalid' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'SaveFailure';
  }
}

export interface NodeDraftSaverOptions {
  readonly initial: SavedVersion;
  /** Sends the changed fields. Resolves with the stored version or rejects with a SaveFailure. */
  readonly save: (changes: Partial<NodeFields>, expectedRevision: number) => Promise<SavedVersion>;
  /** Stores (or clears, with `null`) the recovery copy of an unsaved draft. */
  readonly persistRecovery: (draft: { fields: NodeFields; baseRevision: number } | null) => void;
  readonly idleDelayMs?: number;
  readonly timers?: {
    readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
  };
}

export const DEFAULT_IDLE_DELAY_MS = 1_000;

export class NodeDraftSaver {
  private saved: SavedVersion;
  private state: DraftState;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private readonly listeners = new Set<(state: DraftState) => void>();
  private readonly idleDelayMs: number;
  private readonly timers: Required<NodeDraftSaverOptions>['timers'];

  public constructor(private readonly options: NodeDraftSaverOptions) {
    this.saved = options.initial;
    this.state = {
      draft: options.initial.fields,
      status: 'saved',
      message: null,
      revision: options.initial.revision,
    };
    this.idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  public getState(): DraftState {
    return this.state;
  }

  public subscribe(listener: (state: DraftState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies a user edit. */
  public edit(changes: Partial<NodeFields>): void {
    const draft = { ...this.state.draft, ...changes };
    const dirty = hasChanges(this.saved.fields, draft);
    this.update({
      draft,
      status: dirty ? 'unsaved' : this.state.status === 'saving' ? 'saving' : 'saved',
      message: null,
    });
    this.options.persistRecovery(
      dirty ? { fields: draft, baseRevision: this.saved.revision } : null,
    );
    this.restartTimer(dirty);
  }

  /** Saves immediately and resolves when nothing unsaved remains or a save failed. */
  public async flush(): Promise<void> {
    this.cancelTimer();
    await this.inFlight;
    if (this.state.status === 'unsaved' || this.state.status === 'failed') {
      await this.startSave();
    }
  }

  /** Retries after a `failed` or `invalid` state (e.g. after the user fixed the title). */
  public retry(): Promise<void> {
    return this.flush();
  }

  /**
   * Resolves a conflict.
   * - `keep-mine`: the draft becomes the new version on top of `latest` (overwrites theirs).
   * - `use-theirs`: the draft is replaced by `latest` and the local recovery copy is dropped.
   */
  public async resolveConflict(
    latest: SavedVersion,
    choice: 'keep-mine' | 'use-theirs',
  ): Promise<void> {
    this.saved = latest;
    if (choice === 'use-theirs') {
      this.options.persistRecovery(null);
      this.update({
        draft: latest.fields,
        status: 'saved',
        message: null,
        revision: latest.revision,
      });
      return;
    }
    this.update({ status: 'unsaved', message: null, revision: latest.revision });
    await this.flush();
  }

  /** Stops timers. Call when the editor closes, after `flush`. */
  public dispose(): void {
    this.cancelTimer();
    this.listeners.clear();
  }

  private async startSave(): Promise<void> {
    const sentDraft = this.state.draft;
    const changes = changedFields(this.saved.fields, sentDraft);
    if (Object.keys(changes).length === 0) {
      this.update({ status: 'saved', message: null });
      this.options.persistRecovery(null);
      return;
    }

    this.update({ status: 'saving', message: null });
    let editsArrivedDuringSave = false;
    this.inFlight = this.options.save(changes, this.saved.revision).then(
      (stored) => {
        this.saved = stored;
        editsArrivedDuringSave = hasChanges(stored.fields, this.state.draft);
        this.update({
          status: editsArrivedDuringSave ? 'unsaved' : 'saved',
          message: null,
          revision: stored.revision,
        });
        this.options.persistRecovery(
          editsArrivedDuringSave
            ? { fields: this.state.draft, baseRevision: stored.revision }
            : null,
        );
      },
      (failure: unknown) => {
        const { kind, message } =
          failure instanceof SaveFailure
            ? failure
            : new SaveFailure('failed', 'Saving failed. Your changes are kept; try again.');
        this.update({ status: kind, message });
      },
    );
    await this.inFlight;
    // Cleared before scheduling the follow-up, because `restartTimer` skips scheduling while a
    // save is in flight.
    this.inFlight = null;
    if (editsArrivedDuringSave) {
      this.restartTimer(true);
    }
  }

  private restartTimer(dirty: boolean): void {
    this.cancelTimer();
    // While a save is in flight its completion handler schedules the follow-up save.
    if (!dirty || this.inFlight !== null) {
      return;
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.startSave();
    }, this.idleDelayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private update(changes: Partial<DraftState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

/** Fields of `draft` that differ from `saved`. Notes are compared by their JSON form. */
export function changedFields(saved: NodeFields, draft: NodeFields): Partial<NodeFields> {
  const changes: { -readonly [Key in keyof NodeFields]?: NodeFields[Key] } = {};
  if (draft.title !== saved.title) changes.title = draft.title;
  if (draft.summary !== saved.summary) changes.summary = draft.summary;
  if (JSON.stringify(draft.note) !== JSON.stringify(saved.note)) changes.note = draft.note;
  return changes;
}

function hasChanges(saved: NodeFields, draft: NodeFields): boolean {
  return Object.keys(changedFields(saved, draft)).length > 0;
}
