/**
 * Local, redacted logging (PRD §8: "Keep content out of logs").
 *
 * Only structural information is logged: the operation name and the error's class name and code.
 * Error messages are dropped because messages from lower layers (SQLite, filesystem) can embed
 * values such as titles or paths. Stack traces are included only in development builds.
 */

export interface RedactedLogger {
  error(operation: string, error: unknown): void;
}

export function createRedactedLogger(options: { includeStacks: boolean }): RedactedLogger {
  return {
    error(operation, error) {
      const name = error instanceof Error ? error.name : typeof error;
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : undefined;
      const stack = options.includeStacks && error instanceof Error ? `\n${error.stack ?? ''}` : '';
      console.error(`[mmap] ${operation} failed: ${name}${code ? ` (${code})` : ''}${stack}`);
    },
  };
}
