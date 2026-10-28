import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkspaceService,
  DomainError,
  type IdGenerator,
  type UtcTimestamp,
  type WorkspaceId,
} from '@mmap/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, readPragmaNumber } from './connection';
import { ALL_MIGRATIONS, MigrationFailedError, type Migration } from './migrations';
import { SqliteRelationshipTypeRepository } from './repositories/sqlite-relationship-type-repository';
import { SqliteWorkspaceRepository } from './repositories/sqlite-workspace-repository';
import { NotInTransactionError, type SqliteConnections } from './sqlite-connections';
import { nextTestId } from './test-support/temporary-database';
import { openWorkspaceDatabase } from './workspace-database';

let directory: string;
let databasePath: string;
let backupDirectory: string;
const openConnections: SqliteConnections[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mmap-connections-'));
  databasePath = join(directory, 'mmap.sqlite');
  backupDirectory = directory;
});

afterEach(async () => {
  for (const connections of openConnections.splice(0)) {
    await connections.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

async function open(migrations?: readonly Migration[]): Promise<SqliteConnections> {
  const opened = await openWorkspaceDatabase(databasePath, {
    backupDirectory,
    ...(migrations ? { migrations } : {}),
  });
  openConnections.push(opened.connections);
  return opened.connections;
}

function countWorkspaces(connections: SqliteConnections): number {
  return Number(connections.forRead().prepare('SELECT count(*) AS n FROM workspaces').get()?.n);
}

const insertWorkspace = (connections: SqliteConnections, name: string): void => {
  connections
    .forWrite()
    .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(nextTestId(), name, '2026-10-26T12:00:00.000Z', '2026-10-26T12:00:00.000Z');
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('SqliteConnections', () => {
  it('refuses writes outside a transaction', async () => {
    const connections = await open();

    expect(() => connections.forWrite()).toThrow(NotInTransactionError);
  });

  it('hides uncommitted writes from readers outside the transaction', async () => {
    const connections = await open();
    let releaseTransaction!: () => void;
    const transactionHeldOpen = new Promise<void>((resolve) => (releaseTransaction = resolve));

    const transaction = connections.runInTransaction(async () => {
      insertWorkspace(connections, 'A');
      await transactionHeldOpen;
    });
    await tick();
    // This code runs outside the transaction's async context, so it uses the reader connection.
    const seenWhileOpen = countWorkspaces(connections);
    releaseTransaction();
    await transaction;

    expect(seenWhileOpen).toBe(0);
    expect(countWorkspaces(connections)).toBe(1);
  });

  it('serializes overlapping transactions instead of interleaving them', async () => {
    const connections = await open();
    const events: string[] = [];

    const first = connections.runInTransaction(async () => {
      events.push('first:start');
      insertWorkspace(connections, 'first');
      await tick();
      events.push('first:end');
    });
    const second = connections.runInTransaction(async () => {
      events.push('second:start');
      insertWorkspace(connections, 'second');
      await tick();
      events.push('second:end');
    });
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(countWorkspaces(connections)).toBe(2);
  });

  it('rolls back a failed transaction and keeps processing the queue', async () => {
    const connections = await open();

    await expect(
      connections.runInTransaction(async () => {
        insertWorkspace(connections, 'doomed');
        await tick();
        throw new Error('service failure');
      }),
    ).rejects.toThrow('service failure');
    await connections.runInTransaction(async () => {
      insertWorkspace(connections, 'survivor');
    });

    expect(
      connections
        .forRead()
        .prepare('SELECT name FROM workspaces')
        .all()
        .map((row) => row.name),
    ).toEqual(['survivor']);
  });

  it('joins nested transactions into the outer one', async () => {
    const connections = await open();

    await expect(
      connections.runInTransaction(async () => {
        await connections.runInTransaction(async () => {
          insertWorkspace(connections, 'inner');
        });
        throw new Error('outer fails after inner succeeded');
      }),
    ).rejects.toThrow();

    expect(countWorkspaces(connections)).toBe(0);
  });

  it('close waits for queued transactions to finish', async () => {
    const connections = await open();
    openConnections.pop();

    const pending = connections.runInTransaction(async () => {
      await tick();
      insertWorkspace(connections, 'flushed');
    });
    await connections.close();
    await pending;

    const check = openDatabase(databasePath);
    expect(Number(check.prepare('SELECT count(*) AS n FROM workspaces').get()?.n)).toBe(1);
    check.close();
  });
});

describe('runExclusive (writes through another connection)', () => {
  it('lets a second connection write while transactions wait', async () => {
    const connections = await open();
    const order: string[] = [];
    let finishExclusive!: () => void;
    const exclusive = connections.runExclusive(async () => {
      order.push('exclusive started');
      const other = openDatabase(databasePath);
      try {
        other.exec('BEGIN IMMEDIATE;');
        other
          .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(
            nextTestId(),
            'from the other connection',
            '2026-10-26T12:00:00.000Z',
            '2026-10-26T12:00:00.000Z',
          );
        other.exec('COMMIT;');
      } finally {
        other.close();
      }
      await new Promise<void>((resolve) => {
        finishExclusive = resolve;
      });
      order.push('exclusive finished');
    });
    const queued = connections.runInTransaction(async () => {
      order.push('transaction ran');
    });
    await tick();
    await tick();
    expect(order).toEqual(['exclusive started']);
    // Reads keep working while the slot is held, and see the other connection's commit.
    expect(countWorkspaces(connections)).toBe(1);

    finishExclusive();
    await exclusive;
    await queued;
    expect(order).toEqual(['exclusive started', 'exclusive finished', 'transaction ran']);
  });

  it('waits for a running transaction and keeps the queue alive after a failure', async () => {
    const connections = await open();
    const order: string[] = [];
    const running = connections.runInTransaction(async () => {
      await tick();
      order.push('transaction');
    });
    const failing = connections.runExclusive(async () => {
      order.push('exclusive');
      throw new Error('worker failed');
    });
    await running;
    await expect(failing).rejects.toThrow('worker failed');
    await connections.runInTransaction(async () => {
      order.push('after');
    });
    expect(order).toEqual(['transaction', 'exclusive', 'after']);
  });

  it('counts committed writes, not failed ones (windows use it to know whether to reload)', async () => {
    const connections = await open();
    const start = connections.commitCount;
    await connections.runInTransaction(async () => insertWorkspace(connections, 'one'));
    await expect(
      connections.runInTransaction(async () => {
        insertWorkspace(connections, 'rolled back');
        throw new Error('fails');
      }),
    ).rejects.toThrow('fails');
    await connections.runExclusive(async () => undefined);
    await expect(
      connections.runExclusive(async () => {
        throw new Error('worker failed');
      }),
    ).rejects.toThrow('worker failed');

    expect(connections.commitCount - start).toBe(2);
  });

  it('is refused inside a transaction', async () => {
    const connections = await open();
    await expect(
      connections.runInTransaction(async () => {
        await connections.runExclusive(async () => undefined);
      }),
    ).rejects.toThrow('runExclusive cannot be used inside a transaction.');
  });
});

describe('openWorkspaceDatabase', () => {
  it('takes no backup for a brand-new database', async () => {
    const opened = await openWorkspaceDatabase(databasePath, { backupDirectory });
    openConnections.push(opened.connections);

    expect(opened.preMigrationBackupPath).toBeNull();
    expect(readdirSync(directory).filter((name) => name.startsWith('pre-migration'))).toEqual([]);
  });

  it('backs up existing data before applying a new migration', async () => {
    const first = await open();
    await first.runInTransaction(async () => insertWorkspace(first, 'before upgrade'));
    await first.close();
    openConnections.pop();
    const upgrade: Migration = {
      version: ALL_MIGRATIONS.length + 1,
      name: 'add-test-table',
      sql: 'CREATE TABLE upgrade_marker (id INTEGER PRIMARY KEY) STRICT;',
    };

    const opened = await openWorkspaceDatabase(databasePath, {
      backupDirectory,
      migrations: [...ALL_MIGRATIONS, upgrade],
    });
    openConnections.push(opened.connections);

    expect(opened.preMigrationBackupPath).not.toBeNull();
    const backup = openDatabase(opened.preMigrationBackupPath ?? '', { readOnly: true });
    expect(readPragmaNumber(backup, 'user_version')).toBe(ALL_MIGRATIONS.length);
    expect(backup.prepare('SELECT name FROM workspaces').get()?.name).toBe('before upgrade');
    backup.close();
  });

  it('keeps the original and the backup when a migration fails', async () => {
    const first = await open();
    await first.runInTransaction(async () => insertWorkspace(first, 'precious'));
    await first.close();
    openConnections.pop();
    const broken: Migration = {
      version: ALL_MIGRATIONS.length + 1,
      name: 'broken',
      sql: 'INSERT INTO missing_table VALUES (1);',
    };

    await expect(
      openWorkspaceDatabase(databasePath, {
        backupDirectory,
        migrations: [...ALL_MIGRATIONS, broken],
      }),
    ).rejects.toBeInstanceOf(MigrationFailedError);

    const original = openDatabase(databasePath);
    expect(readPragmaNumber(original, 'user_version')).toBe(ALL_MIGRATIONS.length);
    expect(original.prepare('SELECT name FROM workspaces').get()?.name).toBe('precious');
    original.close();
    expect(readdirSync(directory).some((name) => name.startsWith('pre-migration'))).toBe(true);
  });
});

describe('workspace service on SQLite', () => {
  function createService(connections: SqliteConnections) {
    let counter = 0;
    const ids: IdGenerator = {
      newId: () => `10000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`,
    };
    return createWorkspaceService({
      transactions: connections,
      workspaces: new SqliteWorkspaceRepository(connections),
      relationshipTypes: new SqliteRelationshipTypeRepository(connections),
      ids,
      clock: { now: () => '2026-10-26T12:00:00.000Z' as UtcTimestamp },
    });
  }

  const workspaceId = '20000000-0000-4000-8000-000000000001' as WorkspaceId;

  it('initializes the workspace with the built-in relationship types', async () => {
    const connections = await open();
    const service = createService(connections);

    const workspace = await service.initialize(workspaceId, '  Research  ', 'Asia/Jerusalem');
    const types = await new SqliteRelationshipTypeRepository(connections).listByWorkspace(
      workspaceId,
    );

    expect(workspace).toMatchObject({ name: 'Research', timezone: 'Asia/Jerusalem' });
    expect(types.map((type) => [type.label, type.directionality])).toEqual([
      ['contradicts', 'undirected'],
      ['depends on', 'directed'],
      ['example of', 'directed'],
      ['part of', 'directed'],
      ['related to', 'undirected'],
    ]);
  });

  it('renames with validation', async () => {
    const connections = await open();
    const service = createService(connections);
    await service.initialize(workspaceId, 'Old', 'UTC');

    await expect(service.rename(workspaceId, 'New name')).resolves.toMatchObject({
      name: 'New name',
    });
    await expect(service.rename(workspaceId, '   ')).rejects.toBeInstanceOf(DomainError);
  });

  it('reports unknown workspaces as NOT_FOUND', async () => {
    const connections = await open();

    await expect(createService(connections).get(workspaceId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
