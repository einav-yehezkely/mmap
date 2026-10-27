/**
 * Connection pair and write coordinator for one open workspace database (PRD §7.3: "a single
 * write coordinator, bounded busy handling, and transactional cycle/reference updates").
 *
 * Design:
 * - One **writer** connection. Write transactions are queued so only one is open at a time,
 *   even when application services `await` inside the transaction. Without the queue, two
 *   overlapping async transactions would share the same connection and interleave statements.
 * - One read-only **reader** connection for queries outside a write transaction. In WAL mode it
 *   sees the last committed state, so a reader never observes a half-finished write.
 * - Inside a transaction, reads go to the writer so the service sees its own uncommitted changes.
 *   The active transaction is tracked with `AsyncLocalStorage`, which follows `await` chains, so
 *   repositories pick the right connection without it being passed through every call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';

import type { TransactionRunner } from '@mmap/domain';

interface TransactionContext {
  readonly connection: DatabaseSync;
}

export class NotInTransactionError extends Error {
  public constructor() {
    super('Database writes must run inside runInTransaction().');
    this.name = 'NotInTransactionError';
  }
}

export class SqliteConnections implements TransactionRunner {
  private readonly transactionContext = new AsyncLocalStorage<TransactionContext>();
  /** Tail of the write queue. Each transaction waits for the previous one to settle. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly writer: DatabaseSync,
    private readonly reader: DatabaseSync,
  ) {}

  /** Connection for reads: the open transaction's connection, otherwise the reader. */
  public forRead(): DatabaseSync {
    return this.transactionContext.getStore()?.connection ?? this.reader;
  }

  /** Connection for writes. Throws when called outside `runInTransaction`. */
  public forWrite(): DatabaseSync {
    const context = this.transactionContext.getStore();
    if (context === undefined) {
      throw new NotInTransactionError();
    }
    return context.connection;
  }

  public runInTransaction<Result>(work: () => Promise<Result>): Promise<Result> {
    if (this.transactionContext.getStore() !== undefined) {
      // Nested calls join the outer transaction. Queuing them instead would deadlock, because
      // the outer transaction cannot finish until the nested work does.
      return work();
    }

    const run = async (): Promise<Result> => {
      this.writer.exec('BEGIN IMMEDIATE;');
      try {
        const result = await this.transactionContext.run({ connection: this.writer }, work);
        this.writer.exec('COMMIT;');
        return result;
      } catch (error) {
        if (this.writer.isTransaction) {
          this.writer.exec('ROLLBACK;');
        }
        throw error;
      }
    };

    const result = this.writeQueue.then(run, run);
    // Keep the queue alive regardless of this transaction's outcome.
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * Waits for queued transactions to finish, then closes both connections. Used when the
   * workspace is closed or the app quits, so pending saves are flushed (PRD §5.1).
   */
  public async close(): Promise<void> {
    await this.writeQueue;
    if (this.reader.isOpen) {
      this.reader.close();
    }
    if (this.writer.isOpen) {
      // Fold the WAL into the main file so the folder is self-contained when closed.
      this.writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.writer.close();
    }
  }

  /** Exposed for the backup helper, which must read from a consistent connection. */
  public get writerConnection(): DatabaseSync {
    return this.writer;
  }
}
