/**
 * IPC-facing progress and cancellation of long operations (see `operations/operation-progress.ts`).
 */

import type { IpcServices } from '../ipc/register-ipc-handlers';
import type { OperationRegistry } from '../operations/operation-progress';

type OperationChannel = Extract<keyof IpcServices, `operations:${string}`>;

export function createOperationIpcServices(
  operations: OperationRegistry,
): Pick<IpcServices, OperationChannel> {
  return {
    'operations:get-progress': ({ operationId }) => {
      const progress = operations.progress(operationId);
      return Promise.resolve(
        progress === null ? { running: false as const } : { running: true as const, ...progress },
      );
    },
    'operations:cancel': ({ operationId }) =>
      Promise.resolve({ cancelling: operations.cancel(operationId) }),
  };
}
