import { describe, expect, it } from 'vitest';

import { IPC_CATALOGUE } from './catalogue';
import { IPC_CHANNELS } from './channels';
import { ipcErrorSchema } from './envelope';

describe('IPC catalogue', () => {
  it('defines a contract for every channel and no others', () => {
    expect(Object.keys(IPC_CATALOGUE).sort()).toEqual(Object.values(IPC_CHANNELS).sort());
  });

  it('rejects any payload for app:get-info, which takes no arguments', () => {
    const { request } = IPC_CATALOGUE['app:get-info'];

    expect(request.safeParse(undefined).success).toBe(true);
    expect(request.safeParse({ path: 'C:\\Windows' }).success).toBe(false);
    expect(request.safeParse('SELECT 1').success).toBe(false);
  });

  it('rejects responses with unexpected properties', () => {
    const { response } = IPC_CATALOGUE['app:get-info'];
    const valid = {
      appVersion: '0.1.0',
      isPackaged: false,
      platform: 'win32',
      arch: 'x64',
      electronVersion: '44.9.3',
      chromeVersion: '1',
      nodeVersion: '24.22.0',
      storage: { sqliteVersion: '3.53.4', fts5Available: true, latestSchemaVersion: 1 },
    };

    expect(response.safeParse(valid).success).toBe(true);
    expect(response.safeParse({ ...valid, workspacePath: 'C:\\secret' }).success).toBe(false);
  });
});

describe('ipcErrorSchema', () => {
  it.each([
    ['FORBIDDEN_SENDER', true],
    ['REVISION_CONFLICT', true],
    ['SOMETHING_ELSE', false],
  ])('code %s → valid: %s', (code, expected) => {
    expect(ipcErrorSchema.safeParse({ code, message: 'No.' }).success).toBe(expected);
  });
});
