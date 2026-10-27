import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NodeDraftSaver,
  SaveFailure,
  type NodeFields,
  type SavedVersion,
} from './node-draft-saver';

const initialFields: NodeFields = { title: 'Title', summary: null, note: { type: 'doc' } };

interface Harness {
  saver: NodeDraftSaver;
  save: ReturnType<
    typeof vi.fn<(changes: Partial<NodeFields>, revision: number) => Promise<SavedVersion>>
  >;
  recovery: Array<{ fields: NodeFields; baseRevision: number } | null>;
}

function setup(
  respond: (changes: Partial<NodeFields>, revision: number) => Promise<SavedVersion> = (
    changes,
    revision,
  ) => Promise.resolve({ fields: { ...initialFields, ...changes }, revision: revision + 1 }),
): Harness {
  const recovery: Harness['recovery'] = [];
  const save = vi.fn(respond);
  const saver = new NodeDraftSaver({
    initial: { fields: initialFields, revision: 1 },
    save,
    persistRecovery: (draft) => recovery.push(draft),
    idleDelayMs: 1_000,
  });
  return { saver, save, recovery };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NodeDraftSaver', () => {
  it('saves only the changed fields after one second of inactivity', async () => {
    const { saver, save } = setup();

    saver.edit({ title: 'T' });
    saver.edit({ title: 'Ti' });
    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    expect(saver.getState().status).toBe('unsaved');

    await vi.advanceTimersByTimeAsync(1);

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ title: 'Ti' }, 1);
    expect(saver.getState()).toMatchObject({ status: 'saved', revision: 2 });
  });

  it('reports saved only after the save resolves', async () => {
    let resolveSave!: (version: SavedVersion) => void;
    const { saver } = setup(() => new Promise((resolve) => (resolveSave = resolve)));

    saver.edit({ title: 'New' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saver.getState().status).toBe('saving');

    resolveSave({ fields: { ...initialFields, title: 'New' }, revision: 2 });
    await vi.runAllTimersAsync();
    expect(saver.getState().status).toBe('saved');
  });

  it('keeps edits made during a save and saves them next with the new revision', async () => {
    let resolveFirst!: (version: SavedVersion) => void;
    const responses = [
      () => new Promise<SavedVersion>((resolve) => (resolveFirst = resolve)),
      (changes: Partial<NodeFields>) =>
        Promise.resolve({ fields: { ...initialFields, title: 'B', ...changes }, revision: 3 }),
    ];
    const { saver, save } = setup((changes) => {
      const next = responses.shift();
      if (!next) throw new Error('unexpected save');
      return next(changes);
    });

    saver.edit({ title: 'A' });
    await vi.advanceTimersByTimeAsync(1_000);
    saver.edit({ title: 'B' });
    resolveFirst({ fields: { ...initialFields, title: 'A' }, revision: 2 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(save.mock.calls).toEqual([
      [{ title: 'A' }, 1],
      [{ title: 'B' }, 2],
    ]);
    expect(saver.getState()).toMatchObject({ status: 'saved', revision: 3 });
  });

  it('keeps the draft and a recovery copy when saving fails, and retries on request', async () => {
    let attempts = 0;
    const { saver, recovery } = setup((changes, revision) => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new SaveFailure('failed', 'Disk is full.'))
        : Promise.resolve({ fields: { ...initialFields, ...changes }, revision: revision + 1 });
    });

    saver.edit({ title: 'Precious' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(saver.getState()).toMatchObject({
      status: 'failed',
      message: 'Disk is full.',
      draft: { title: 'Precious' },
    });
    expect(recovery.at(-1)).toEqual({
      fields: { ...initialFields, title: 'Precious' },
      baseRevision: 1,
    });

    await saver.retry();

    expect(saver.getState().status).toBe('saved');
    expect(recovery.at(-1)).toBeNull();
  });

  it('enters conflict state and can keep the local version on top of the latest one', async () => {
    let attempts = 0;
    const { saver, save } = setup((changes, revision) => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new SaveFailure('conflict', 'Changed elsewhere.'))
        : Promise.resolve({ fields: { ...initialFields, ...changes }, revision: revision + 1 });
    });

    saver.edit({ title: 'Mine' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saver.getState().status).toBe('conflict');

    await saver.resolveConflict(
      { fields: { ...initialFields, title: 'Theirs', summary: 'their summary' }, revision: 5 },
      'keep-mine',
    );

    expect(save.mock.calls.at(-1)).toEqual([{ title: 'Mine', summary: null }, 5]);
    expect(saver.getState()).toMatchObject({ status: 'saved', revision: 6 });
  });

  it('can resolve a conflict by taking the other version', async () => {
    const { saver, recovery } = setup(() =>
      Promise.reject(new SaveFailure('conflict', 'Changed elsewhere.')),
    );
    saver.edit({ title: 'Mine' });
    await vi.advanceTimersByTimeAsync(1_000);

    await saver.resolveConflict(
      { fields: { ...initialFields, title: 'Theirs' }, revision: 5 },
      'use-theirs',
    );

    expect(saver.getState()).toMatchObject({
      status: 'saved',
      revision: 5,
      draft: { title: 'Theirs' },
    });
    expect(recovery.at(-1)).toBeNull();
  });

  it('flush saves immediately without waiting for the idle timer', async () => {
    const { saver, save } = setup();

    saver.edit({ summary: 'quick' });
    await saver.flush();

    expect(save).toHaveBeenCalledWith({ summary: 'quick' }, 1);
    expect(saver.getState().status).toBe('saved');
  });

  it('treats undoing an edit as no change', async () => {
    const { saver, save, recovery } = setup();

    saver.edit({ title: 'Changed' });
    saver.edit({ title: 'Title' });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(save).not.toHaveBeenCalled();
    expect(saver.getState().status).toBe('saved');
    expect(recovery.at(-1)).toBeNull();
  });

  it('does not retry automatically when input is invalid', async () => {
    const { saver, save } = setup(() =>
      Promise.reject(new SaveFailure('invalid', 'A node needs a title.')),
    );

    saver.edit({ title: '' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(save).toHaveBeenCalledOnce();
    expect(saver.getState()).toMatchObject({ status: 'invalid', message: 'A node needs a title.' });
  });
});
