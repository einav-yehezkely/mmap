/**
 * Progress and cancellation of long operations (exports, imports, backups, restores).
 *
 * The renderer generates an operation ID (a UUID) and passes it as `operationId` with the request
 * that starts the work. While that request is pending, it reads the progress with `get-progress`
 * and may ask to stop with `cancel`. IDs are only labels for work the renderer itself started;
 * they grant nothing. A cancelled operation's request fails with `OPERATION_CANCELLED`.
 */

import { z } from 'zod';

/** Optional field added to the requests of long operations. */
export const operationIdField = { operationId: z.uuid().optional() } as const;

export const operationContracts = {
  getProgress: {
    request: z.strictObject({ operationId: z.uuid() }),
    response: z.discriminatedUnion('running', [
      /** Not started yet (a dialog may still be open), already finished, or unknown. */
      z.strictObject({ running: z.literal(false) }),
      z.strictObject({
        running: z.literal(true),
        /** English text for the current phase, e.g. "Copying attached files". */
        phase: z.string().max(200),
        done: z.number().int().nonnegative(),
        /** Units in the phase, or null when unknown (show an indeterminate bar). */
        total: z.number().int().nonnegative().nullable(),
        /** Whether Cancel is possible now; false while changes are being made visible. */
        cancellable: z.boolean(),
      }),
    ]),
  },
  cancel: {
    request: z.strictObject({ operationId: z.uuid() }),
    /** `cancelling` is false when the operation is not running or cannot stop at this point. */
    response: z.strictObject({ cancelling: z.boolean() }),
  },
} as const;
