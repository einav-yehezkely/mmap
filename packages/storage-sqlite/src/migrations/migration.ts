/**
 * A versioned schema migration (PRD §7.1 "versioned SQL migrations").
 *
 * Migrations are immutable once released: the runner stores a SHA-256 of each applied migration's
 * SQL and refuses to open a database whose history does not match the code. To change the
 * schema, add a new migration; never edit an existing one.
 *
 * Migrations are TypeScript modules exporting SQL text (rather than loose `.sql` files) so they
 * are bundled into the Electron main process and cannot go missing from an installed build.
 * SQL must not contain statements that are invalid inside a transaction (VACUUM, journal_mode).
 */
export interface Migration {
  /** Sequential version, starting at 1 with no gaps. */
  readonly version: number;
  /** Short kebab-case description, stored for diagnostics. */
  readonly name: string;
  readonly sql: string;
}
