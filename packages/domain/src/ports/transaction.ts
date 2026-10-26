/**
 * Transaction port.
 *
 * Application services group related writes (for example: save note JSON, rewrite derived plain
 * text, reconcile note references) into one atomic unit (PRD §14 "Editor/reference divergence").
 *
 * The interface is asynchronous so that a future PostgreSQL adapter can implement it. The local
 * SQLite adapter executes the work through a single write coordinator, which guarantees that no
 * other write interleaves while a transaction is open (PRD §7.3).
 */
export interface TransactionRunner {
  /**
   * Runs `work` inside a write transaction. Commits when the returned promise resolves and rolls
   * back when it rejects; the rejection is re-thrown to the caller unchanged.
   *
   * `work` must only perform database operations. It must not wait on user input, network
   * calls or long file copies, because the write lock is held for its whole duration.
   */
  runInTransaction<Result>(work: () => Promise<Result>): Promise<Result>;
}
