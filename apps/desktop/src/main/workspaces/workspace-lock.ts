/**
 * Per-workspace process lock (PRD §5.1: "a process lock per workspace with safe stale-lock
 * recovery").
 *
 * The lock is a small JSON file created with the exclusive `wx` flag, so creation is atomic: two
 * processes racing for the same workspace cannot both succeed. It records who holds it.
 *
 * Stale-lock recovery: a lock is stale only if it was written on this computer by a process that
 * no longer exists (for example after a crash or power loss). Locks from another computer (a
 * folder on removable or shared storage) are never assumed stale, because we cannot check that
 * machine's processes. Known limitation: if the OS reuses the dead process's PID, the lock looks
 * alive; the user then sees a "workspace in use" message instead of silent concurrent access,
 * which is the safe failure.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { WorkspaceError } from './workspace-errors';

const lockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  hostname: z.string(),
  instanceId: z.string(),
  acquiredAt: z.string(),
});

export type LockOwner = z.infer<typeof lockOwnerSchema>;

export interface LockEnvironment {
  readonly pid: number;
  readonly hostname: string;
  /** Random ID for this app run; distinguishes our own lock from a stale one with a reused PID. */
  readonly instanceId: string;
  readonly now: () => Date;
  /** Returns true when a process with this PID exists on this computer. */
  readonly isProcessAlive: (pid: number) => boolean;
}

export interface WorkspaceLock {
  /** Removes the lock file if it is still ours. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Acquires the lock at `lockPath`.
 *
 * @throws WorkspaceError `WORKSPACE_LOCKED` when another live process (or another computer) holds it.
 */
export async function acquireWorkspaceLock(
  lockPath: string,
  environment: LockEnvironment,
): Promise<WorkspaceLock> {
  const owner: LockOwner = {
    pid: environment.pid,
    hostname: environment.hostname,
    instanceId: environment.instanceId,
    acquiredAt: environment.now().toISOString(),
  };

  // At most two attempts: the second only after removing a lock proven stale.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
      return createLockHandle(lockPath, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    const existing = await readLockOwner(lockPath);
    if (existing !== null && existing.instanceId === owner.instanceId) {
      // Already held by this app run (e.g. reopening the current workspace).
      return createLockHandle(lockPath, existing);
    }
    if (!isStale(existing, environment)) {
      throw new WorkspaceError('WORKSPACE_LOCKED', describeHolder(existing, environment));
    }
    await rm(lockPath, { force: true });
  }

  throw new WorkspaceError(
    'WORKSPACE_LOCKED',
    'The workspace is being opened by another process. Try again.',
  );
}

/** Returns true by default on Node: signal 0 checks existence without affecting the process. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(owner: LockOwner | null, environment: LockEnvironment): boolean {
  if (owner === null) {
    // Unreadable or damaged lock file: nobody can prove ownership, and a live mmap process
    // always writes a complete file, so treat it as left behind by a crash.
    return true;
  }
  return owner.hostname === environment.hostname && !environment.isProcessAlive(owner.pid);
}

function describeHolder(owner: LockOwner | null, environment: LockEnvironment): string {
  if (owner !== null && owner.hostname !== environment.hostname) {
    return `This workspace is open on another computer (${owner.hostname}). Close it there first.`;
  }
  return 'This workspace is already open in another mmap window or process. Close it there first.';
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed = lockOwnerSchema.safeParse(JSON.parse(await readFile(lockPath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function createLockHandle(lockPath: string, owner: LockOwner): WorkspaceLock {
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      const current = await readLockOwner(lockPath);
      // Never delete a lock that another process took over (e.g. after we were considered stale).
      if (current?.instanceId === owner.instanceId) {
        await rm(lockPath, { force: true });
      }
    },
  };
}
