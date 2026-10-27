/**
 * Turns a plain service function into a safe IPC handler (PRD §7.2, §8).
 *
 * Every request passes three gates before the service runs:
 * 1. Sender check: the message must come from the main frame of a page on a trusted origin.
 *    Sub-frames are rejected even if same-origin, because the app never embeds frames.
 * 2. Request validation against the channel's schema from `@mmap/contracts`.
 * 3. Response validation on the way out, so a service bug cannot leak extra fields (for example
 *    a filesystem path) to the renderer.
 *
 * Errors are converted to the result envelope. Unexpected errors are logged locally without
 * request payloads and reported to the renderer only as `INTERNAL_ERROR`.
 */

import {
  IPC_CATALOGUE,
  type IpcChannel,
  type IpcErrorCode,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from '@mmap/contracts';
import { isDomainError } from '@mmap/domain';

import { isTrustedUrl } from '../security/trusted-origins';
import { isWorkspaceError } from '../workspaces/workspace-errors';

/** The parts of Electron's `IpcMainInvokeEvent` the handler needs; keeps this module testable. */
export interface IpcSenderInfo {
  readonly senderFrame: { readonly url: string } | null;
  readonly sender: { readonly mainFrame: unknown };
}

export interface IpcHandlerDependencies {
  readonly trustedOrigins: ReadonlySet<string>;
  /** Receives redacted failure details: channel and error name only, never payloads. */
  readonly logFailure: (channel: IpcChannel, error: unknown) => void;
}

export type IpcService<Channel extends IpcChannel> = (
  request: IpcRequest<Channel>,
) => Promise<IpcResponse<Channel>>;

export function isTrustedSender(
  event: IpcSenderInfo,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const frame = event.senderFrame;
  if (frame === null) {
    // The frame navigated away or was destroyed before the message was handled.
    return false;
  }
  return frame === event.sender.mainFrame && isTrustedUrl(frame.url, trustedOrigins);
}

function failure(code: IpcErrorCode, message: string): IpcResult<never> {
  return { ok: false, error: { code, message } };
}

export function createIpcHandler<Channel extends IpcChannel>(
  channel: Channel,
  service: IpcService<Channel>,
  dependencies: IpcHandlerDependencies,
): (event: IpcSenderInfo, payload: unknown) => Promise<IpcResult<IpcResponse<Channel>>> {
  const contract = IPC_CATALOGUE[channel];

  return async (event, payload) => {
    if (!isTrustedSender(event, dependencies.trustedOrigins)) {
      return failure('FORBIDDEN_SENDER', 'This request is not allowed.');
    }

    const parsedRequest = contract.request.safeParse(payload);
    if (!parsedRequest.success) {
      return failure('INVALID_REQUEST', 'The request was not in the expected format.');
    }

    try {
      const data = await service(parsedRequest.data as IpcRequest<Channel>);
      const parsedResponse = contract.response.safeParse(data);
      if (!parsedResponse.success) {
        dependencies.logFailure(channel, new Error('Response failed contract validation.'));
        return failure('INTERNAL_ERROR', 'Something went wrong. Please try again.');
      }
      return { ok: true, data: parsedResponse.data as IpcResponse<Channel> };
    } catch (error) {
      if (isDomainError(error) || isWorkspaceError(error)) {
        // Domain and workspace error messages are written for display (see their classes).
        return failure(error.code, error.message);
      }
      dependencies.logFailure(channel, error);
      return failure('INTERNAL_ERROR', 'Something went wrong. Please try again.');
    }
  };
}
