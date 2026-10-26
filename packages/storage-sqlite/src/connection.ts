/**
 * Opening workspace databases with the connection settings the PRD requires (§7.3, §9).
 *
 * Driver choice: Node's built-in `node:sqlite` (see docs/adr/0002-sqlite-driver-node-sqlite.md).
 * It ships inside Electron's Node runtime, so the app has no native module to compile or
 * package, and tests on Node 24 exercise the same SQLite engine as the installed app.
 */

import { DatabaseSync } from 'node:sqlite';

export interface OpenDatabaseOptions {
  /**
   * How long a statement waits for a competing lock before failing with SQLITE_BUSY.
   * Bounded so a stuck process produces a visible error instead of an endless hang (PRD §7.3).
   */
  readonly busyTimeoutMs?: number;
  /**
   * Opens the file read-only. Used for the reader connection that serves queries outside write
   * transactions; under WAL it sees only committed data. The file must already exist.
   */
  readonly readOnly?: boolean;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Path value that opens a private, temporary in-memory database (tests and capability probes). */
export const IN_MEMORY_DATABASE = ':memory:';

export class DatabaseConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

/**
 * Opens (or creates) a SQLite database file and applies mmap's connection settings.
 *
 * Settings and why they matter:
 * - `foreign_keys = ON`: SQLite disables foreign keys per connection by default; every invariant
 *   that relies on referential integrity would silently stop working without it.
 * - `journal_mode = WAL`: readers do not block the single writer, and commits are atomic.
 *   Only supported on local disks, which is why network shares are unsupported (ADR-0005).
 * - `synchronous = FULL`: the UI shows "Saved" only after a durable commit (PRD §9). In WAL
 *   mode, NORMAL can lose the last commits on power failure, which would make "Saved" a lie.
 * - `trusted_schema = OFF`: functions and virtual tables referenced from the schema (triggers,
 *   views) are restricted to ones SQLite marks as safe. Defends against a tampered workspace
 *   database file that tries to run risky SQL functions when opened.
 * - Double-quoted string literals disabled: `"text"` is always an identifier, which turns a whole
 *   class of silent SQL typos into errors.
 * - Extension loading disabled: a database file must never be able to load native code.
 */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const database = new DatabaseSync(filePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    readOnly: options.readOnly ?? false,
    timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  });

  try {
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA trusted_schema = OFF;');
    database.exec('PRAGMA synchronous = FULL;');

    if (filePath !== IN_MEMORY_DATABASE) {
      // A read-only connection cannot change the journal mode; it only confirms the writer set it.
      const journalMode = readPragmaText(
        database,
        options.readOnly === true ? 'journal_mode' : 'journal_mode = WAL',
      );
      if (journalMode !== 'wal') {
        // Happens on filesystems without shared-memory support (e.g. some network shares).
        throw new DatabaseConfigurationError(
          `Write-ahead logging is not available for this location (journal mode: ${journalMode}).`,
        );
      }
    }

    if (readPragmaNumber(database, 'foreign_keys') !== 1) {
      throw new DatabaseConfigurationError('Foreign key enforcement could not be enabled.');
    }
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}

/** Reads a single-value PRAGMA as text. `pragma` must be a trusted literal, never user input. */
export function readPragmaText(database: DatabaseSync, pragma: string): string {
  const row = database.prepare(`PRAGMA ${pragma};`).get();
  const value = row === undefined ? undefined : Object.values(row)[0];
  return String(value);
}

/** Reads a single-value PRAGMA as a number. `pragma` must be a trusted literal, never user input. */
export function readPragmaNumber(database: DatabaseSync, pragma: string): number {
  return Number(readPragmaText(database, pragma));
}
