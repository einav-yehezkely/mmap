import type { AppInfo } from '@mmap/contracts';
import { DomainError } from '@mmap/domain';
import { describe, expect, it, vi } from 'vitest';

import { PRODUCTION_ORIGIN } from '../security/trusted-origins';
import { createIpcHandler, type IpcSenderInfo } from './ipc-handler';

const appInfo: AppInfo = {
  appVersion: '0.1.0',
  isPackaged: false,
  platform: 'win32',
  arch: 'x64',
  electronVersion: '44.9.3',
  chromeVersion: '1',
  nodeVersion: '24.22.0',
  storage: { sqliteVersion: '3.53.4', fts5Available: true, latestSchemaVersion: 1 },
};

function eventFrom(url: string | null, options: { subFrame?: boolean } = {}): IpcSenderInfo {
  const mainFrame = { url: url ?? '' };
  const senderFrame = url === null ? null : options.subFrame ? { url } : mainFrame;
  return { senderFrame, sender: { mainFrame } };
}

function setup(service: () => Promise<AppInfo> = async () => appInfo) {
  const logFailure = vi.fn();
  const serviceSpy = vi.fn(service);
  const handler = createIpcHandler('app:get-info', serviceSpy, {
    trustedOrigins: new Set([PRODUCTION_ORIGIN]),
    logFailure,
  });
  return { handler, logFailure, serviceSpy };
}

describe('createIpcHandler', () => {
  it('returns data for a valid request from the trusted main frame', async () => {
    const { handler } = setup();

    await expect(handler(eventFrom('app://mmap/index.html'), undefined)).resolves.toEqual({
      ok: true,
      data: appInfo,
    });
  });

  it.each([
    ['an untrusted origin', eventFrom('https://evil.example/')],
    ['a file URL', eventFrom('file:///C:/evil.html')],
    ['a destroyed frame', eventFrom(null)],
    ['a same-origin sub-frame', eventFrom('app://mmap/index.html', { subFrame: true })],
  ])('rejects requests from %s without calling the service', async (_label, event) => {
    const { handler, serviceSpy } = setup();

    await expect(handler(event, undefined)).resolves.toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN_SENDER' },
    });
    expect(serviceSpy).not.toHaveBeenCalled();
  });

  it('rejects payloads that do not match the contract without calling the service', async () => {
    const { handler, serviceSpy } = setup();

    await expect(
      handler(eventFrom('app://mmap/index.html'), { sql: 'DROP TABLE knowledge_nodes' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(serviceSpy).not.toHaveBeenCalled();
  });

  it('does not leak fields that are not part of the response contract', async () => {
    const { handler, logFailure } = setup(async () => ({
      ...appInfo,
      workspacePath: 'C:\\Users\\someone\\private',
    }));

    const result = await handler(eventFrom('app://mmap/index.html'), undefined);

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(logFailure).toHaveBeenCalledOnce();
  });

  it('maps domain errors to their code and message', async () => {
    const { handler } = setup(async () => {
      throw new DomainError('REVISION_CONFLICT', 'This node was changed in another window.');
    });

    await expect(handler(eventFrom('app://mmap/index.html'), undefined)).resolves.toEqual({
      ok: false,
      error: { code: 'REVISION_CONFLICT', message: 'This node was changed in another window.' },
    });
  });

  it('hides unexpected error details from the renderer', async () => {
    const { handler, logFailure } = setup(async () => {
      throw new Error('SQLITE_CORRUPT at C:\\Users\\someone\\mmap.sqlite');
    });

    const result = await handler(eventFrom('app://mmap/index.html'), undefined);

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(result)).not.toContain('someone');
    expect(logFailure).toHaveBeenCalledOnce();
  });
});
