/**
 * Worker thread entry that writes one planned import (see `portability/import-writer.ts`).
 * Built as its own file next to the main bundle (`electron.vite.config.ts`); it receives one job,
 * answers with the outcome, and is then terminated by the main process.
 */

import { parentPort } from 'node:worker_threads';

import {
  toTransferredError,
  writeImport,
  type ImportWriteJob,
  type ImportWriteOutcome,
} from '../portability/import-writer';

const port = parentPort;
if (port === null) {
  throw new Error('import-worker must run as a worker thread.');
}

port.once('message', (job: ImportWriteJob) => {
  writeImport(job).then(
    () => port.postMessage({ ok: true } satisfies ImportWriteOutcome),
    (error: unknown) =>
      port.postMessage({
        ok: false,
        error: toTransferredError(error),
      } satisfies ImportWriteOutcome),
  );
});
