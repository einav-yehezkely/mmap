import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from './content-security-policy';
import { isInsideDirectory, resolveRendererAsset } from './resolve-renderer-asset';
import {
  isTrustedUrl,
  PRODUCTION_ENTRY_URL,
  PRODUCTION_ORIGIN,
  resolveRendererLocation,
} from './trusted-origins';

describe('resolveRendererLocation', () => {
  it('ignores the dev server URL in packaged builds', () => {
    const location = resolveRendererLocation(true, 'http://localhost:5173');

    expect(location.entryUrl).toBe(PRODUCTION_ENTRY_URL);
    expect([...location.trustedOrigins]).toEqual([PRODUCTION_ORIGIN]);
  });

  it('uses a loopback dev server in development', () => {
    const location = resolveRendererLocation(false, 'http://localhost:5173/');

    expect(location.isDevelopmentServer).toBe(true);
    expect([...location.trustedOrigins]).toEqual(['http://localhost:5173']);
  });

  it.each([
    'https://evil.example/',
    'http://192.168.1.5:5173',
    'file:///C:/index.html',
    'nonsense',
  ])('refuses non-loopback dev server %s even in development', (url) => {
    expect(resolveRendererLocation(false, url).entryUrl).toBe(PRODUCTION_ENTRY_URL);
  });
});

describe('isTrustedUrl', () => {
  const trusted = new Set([PRODUCTION_ORIGIN]);

  it.each([
    ['app://mmap/index.html', true],
    ['app://mmap/assets/x.js', true],
    ['app://other/index.html', false],
    ['https://mmap/index.html', false],
    ['file:///C:/Windows/win.ini', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isTrustedUrl(url, trusted)).toBe(expected);
  });
});

describe('buildContentSecurityPolicy', () => {
  it('production policy allows no remote origins and no inline or eval scripts', () => {
    const policy = buildContentSecurityPolicy(null);

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toMatch(/https?:|ws:|'unsafe-eval'/);
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('development policy only adds the loopback dev server socket', () => {
    const policy = buildContentSecurityPolicy('http://localhost:5173');

    expect(policy).toContain("connect-src 'self' ws://localhost:5173");
    expect(policy).not.toContain("'unsafe-eval'");
  });
});

describe('isInsideDirectory', () => {
  const root = join(tmpdir(), 'root');

  it.each([
    [root, true],
    [join(root, 'a', 'b.js'), true],
    [join(root, '..', 'secret.txt'), false],
    [join(root, '..', 'root-sibling', 'x'), false],
    [join(tmpdir(), 'rootkit'), false],
  ])('%s → %s', (candidate, expected) => {
    expect(isInsideDirectory(root, candidate)).toBe(expected);
  });
});

describe('resolveRendererAsset', () => {
  let sandbox: string;
  let rendererRoot: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'mmap-protocol-'));
    rendererRoot = join(sandbox, 'renderer');
    mkdirSync(join(rendererRoot, 'assets'), { recursive: true });
    writeFileSync(join(rendererRoot, 'index.html'), '<html></html>');
    writeFileSync(join(rendererRoot, 'assets', 'app.js'), '');
    writeFileSync(join(sandbox, 'secret.txt'), 'outside the renderer root');
    mkdirSync(join(sandbox, 'outside-dir'));
    writeFileSync(join(sandbox, 'outside-dir', 'leak.txt'), 'outside');
    // A directory junction inside the renderer root that points outside it. Junctions do not
    // require administrator rights on Windows, unlike file symlinks.
    symlinkSync(join(sandbox, 'outside-dir'), join(rendererRoot, 'escape'), 'junction');
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('serves files inside the renderer root', async () => {
    const resolution = await resolveRendererAsset('app://mmap/assets/app.js', rendererRoot);
    expect(resolution.kind === 'file' && resolution.absolutePath).toMatch(/assets[\\/]app\.js$/);
    await expect(resolveRendererAsset('app://mmap/', rendererRoot)).resolves.toMatchObject({
      kind: 'file',
    });
  });

  it.each([
    // The URL parser treats %2e%2e as a dot segment and normalizes it away, so this resolves to
    // a non-existent /secret.txt inside the root rather than escaping it.
    ['encoded parent traversal', 'app://mmap/%2e%2e/secret.txt', 404],
    ['encoded backslash traversal', 'app://mmap/..%5Csecret.txt', 400],
    ['drive letter', 'app://mmap/C:/Windows/win.ini', 400],
    ['NUL byte', 'app://mmap/index.html%00.js', 400],
    ['malformed escape', 'app://mmap/%E0%A4%A', 400],
    ['wrong host', 'app://evil/index.html', 403],
    ['wrong scheme', 'file:///C:/Windows/win.ini', 403],
    ['symlink escape', 'app://mmap/escape/leak.txt', 403],
    ['missing file', 'app://mmap/missing.js', 404],
    ['directory', 'app://mmap/assets', 404],
  ])('rejects %s', async (_label, url, status) => {
    await expect(resolveRendererAsset(url, rendererRoot)).resolves.toEqual({
      kind: 'rejected',
      status,
    });
  });
});
