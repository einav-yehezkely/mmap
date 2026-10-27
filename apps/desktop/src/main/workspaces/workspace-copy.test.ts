/**
 * Verified workspace copy tests against real folders in a temporary directory, including Windows
 * junctions (which need no administrator rights) for the link refusal.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkspaceCopyErrorCode } from './workspace-copy';
import { copyDirectoryVerified, verifyCopy, WorkspaceCopyError } from './workspace-copy';

let sandbox: string;
let source: string;
let destination: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-copy-'));
  source = join(sandbox, 'Workspace');
  destination = join(sandbox, 'Moved');
  mkdirSync(source);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Writes a file below the source, creating parent folders. `path` uses forward slashes. */
function put(path: string, content: Uint8Array | string): void {
  const absolute = join(source, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

/** Every entry below `root` as sorted forward-slash paths, directories suffixed with `/`. */
function listTree(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const relative = join(entry.parentPath, entry.name).slice(root.length + 1);
      return relative.replaceAll('\\', '/') + (entry.isDirectory() ? '/' : '');
    })
    .sort();
}

/** Hash over the paths and contents of a whole tree, for "source unchanged" checks. */
function treeHash(root: string): string {
  const hash = createHash('sha256');
  for (const entry of listTree(root)) {
    hash.update(entry);
    if (!entry.endsWith('/')) {
      hash.update(readFileSync(join(root, ...entry.split('/'))));
    }
  }
  return hash.digest('hex');
}

function sampleTree(): void {
  put('workspace.json', '{"name":"Physics"}');
  put('db/mmap.sqlite', randomBytes(300 * 1024));
  put('attachments/3f/3f2c0001.pdf', randomBytes(70 * 1024));
  put('attachments/ab/ab01.txt', '');
  mkdirSync(join(source, 'exports', 'empty'), { recursive: true });
}

async function expectCopyError(
  operation: Promise<unknown>,
  code: WorkspaceCopyErrorCode,
): Promise<void> {
  const error = await operation.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WorkspaceCopyError);
  expect((error as WorkspaceCopyError).code).toBe(code);
}

describe('copyDirectoryVerified', () => {
  it('copies a nested tree byte-identically, including empty directories', async () => {
    sampleTree();
    const before = treeHash(source);

    const result = await copyDirectoryVerified(source, destination);

    expect(listTree(destination)).toEqual(listTree(source));
    expect(treeHash(destination)).toBe(before);
    expect(treeHash(source)).toBe(before);
    expect(listTree(destination)).toContain('exports/empty/');
    expect(result).toEqual({ fileCount: 4, byteCount: 18 + 300 * 1024 + 70 * 1024 });
  });

  it('copies an empty workspace folder', async () => {
    const result = await copyDirectoryVerified(source, destination);

    expect(result).toEqual({ fileCount: 0, byteCount: 0 });
    expect(listTree(destination)).toEqual([]);
  });

  it('skips excluded files and directories', async () => {
    sampleTree();
    put('.lock', 'pid 42');
    put('db/mmap.sqlite-shm', 'shared memory');
    put('db/mmap.sqlite-wal', 'wal');
    put('cache/thumbs/1.png', randomBytes(10));
    const seen: Array<[string, boolean]> = [];

    const result = await copyDirectoryVerified(source, destination, {
      exclude: (relativePath, isDirectory) => {
        seen.push([relativePath, isDirectory]);
        return (
          relativePath === '.lock' ||
          relativePath.endsWith('.sqlite-shm') ||
          relativePath.endsWith('.sqlite-wal') ||
          (isDirectory && relativePath === 'cache')
        );
      },
    });

    expect(listTree(destination)).toEqual([
      'attachments/',
      'attachments/3f/',
      'attachments/3f/3f2c0001.pdf',
      'attachments/ab/',
      'attachments/ab/ab01.txt',
      'db/',
      'db/mmap.sqlite',
      'exports/',
      'exports/empty/',
      'workspace.json',
    ]);
    expect(result.fileCount).toBe(4);
    expect(seen).toContainEqual(['cache', true]);
    expect(seen).toContainEqual(['db/mmap.sqlite-shm', false]);
    // Excluded directories are not descended into.
    expect(seen.some(([path]) => path.startsWith('cache/'))).toBe(false);
  });

  it('copies Unicode and Hebrew names', async () => {
    put('הערות/מכניקה קוונטית.md', 'שלום עולם');
    put('notes/Ünïcödé — ✓.txt', 'ok');

    await copyDirectoryVerified(source, destination);

    expect(listTree(destination)).toEqual(listTree(source));
    expect(readFileSync(join(destination, 'הערות', 'מכניקה קוונטית.md'), 'utf8')).toBe('שלום עולם');
  });

  it('reports progress ending at the total byte count', async () => {
    sampleTree();
    const calls: Array<[number, number]> = [];

    const result = await copyDirectoryVerified(source, destination, {
      onProgress: (copied, total) => calls.push([copied, total]),
    });

    expect(calls[0]).toEqual([0, result.byteCount]);
    expect(calls.at(-1)).toEqual([result.byteCount, result.byteCount]);
    const copied = calls.map(([value]) => value);
    expect(copied).toEqual([...copied].sort((a, b) => a - b));
  });

  it('copies read-only files and keeps them read-only', async () => {
    put('readonly.txt', 'frozen');
    const file = join(source, 'readonly.txt');
    chmodSync(file, 0o444);
    try {
      await copyDirectoryVerified(source, destination);

      const copy = join(destination, 'readonly.txt');
      expect(readFileSync(copy, 'utf8')).toBe('frozen');
      expect(statSync(copy).mode & 0o200).toBe(0);
      chmodSync(copy, 0o666);
    } finally {
      chmodSync(file, 0o666);
    }
  });

  it('refuses an existing destination and changes nothing', async () => {
    sampleTree();
    mkdirSync(destination);
    writeFileSync(join(destination, 'keep.txt'), 'mine');
    const before = treeHash(source);

    await expectCopyError(copyDirectoryVerified(source, destination), 'DESTINATION_EXISTS');

    expect(listTree(destination)).toEqual(['keep.txt']);
    expect(treeHash(source)).toBe(before);
  });

  it('refuses a destination that is an existing file', async () => {
    writeFileSync(destination, 'file');

    await expectCopyError(copyDirectoryVerified(source, destination), 'DESTINATION_EXISTS');
    expect(readFileSync(destination, 'utf8')).toBe('file');
  });

  it('refuses a destination inside the source', async () => {
    sampleTree();
    const before = treeHash(source);

    await expectCopyError(
      copyDirectoryVerified(source, join(source, 'exports', 'copy')),
      'DESTINATION_INSIDE_SOURCE',
    );
    await expectCopyError(copyDirectoryVerified(source, source), 'DESTINATION_INSIDE_SOURCE');

    expect(treeHash(source)).toBe(before);
  });

  it.runIf(process.platform === 'win32')(
    'refuses the source itself spelled with different letter case',
    async () => {
      await expectCopyError(
        copyDirectoryVerified(source, source.toUpperCase()),
        'DESTINATION_INSIDE_SOURCE',
      );
    },
  );

  it('refuses a destination reached through a junction into the source', async () => {
    mkdirSync(join(source, 'inner'));
    const alias = join(sandbox, 'alias');
    symlinkSync(join(source, 'inner'), alias, 'junction');

    await expectCopyError(
      copyDirectoryVerified(source, join(alias, 'copy')),
      'DESTINATION_INSIDE_SOURCE',
    );
    expect(existsSync(join(source, 'inner', 'copy'))).toBe(false);
  });

  it('refuses a source containing a junction before copying anything', async () => {
    sampleTree();
    const outside = join(sandbox, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside data');
    symlinkSync(outside, join(source, 'attachments', 'linked'), 'junction');
    const before = treeHash(outside);

    await expectCopyError(copyDirectoryVerified(source, destination), 'SOURCE_HAS_LINKS');

    expect(existsSync(destination)).toBe(false);
    expect(treeHash(outside)).toBe(before);
  });

  it('refuses a junction even when the exclude callback would skip it', async () => {
    const outside = join(sandbox, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(source, 'linked'), 'junction');

    await expectCopyError(
      copyDirectoryVerified(source, destination, { exclude: (path) => path === 'linked' }),
      'SOURCE_HAS_LINKS',
    );
    expect(existsSync(destination)).toBe(false);
  });

  it('fails with IO_ERROR when the destination parent does not exist', async () => {
    sampleTree();

    await expectCopyError(
      copyDirectoryVerified(source, join(sandbox, 'missing', 'Moved')),
      'IO_ERROR',
    );
    expect(existsSync(join(sandbox, 'missing'))).toBe(false);
  });

  it('fails with IO_ERROR when the source is missing or not a folder', async () => {
    await expectCopyError(copyDirectoryVerified(join(sandbox, 'nope'), destination), 'IO_ERROR');
    writeFileSync(join(sandbox, 'file.txt'), 'x');
    await expectCopyError(
      copyDirectoryVerified(join(sandbox, 'file.txt'), destination),
      'IO_ERROR',
    );
    expect(existsSync(destination)).toBe(false);
  });

  it('removes the destination and keeps the source when verification fails', async () => {
    sampleTree();
    const before = treeHash(source);
    const target = join(destination, 'db', 'mmap.sqlite');

    // The final progress call happens after the last file was copied and before verification:
    // corrupt one copied byte without changing the size, as a failing disk could.
    const operation = copyDirectoryVerified(source, destination, {
      onProgress: (copied, total) => {
        if (copied === total) {
          const bytes = readFileSync(target);
          bytes[0] = (bytes[0] ?? 0) ^ 0xff;
          writeFileSync(target, bytes);
        }
      },
    });

    await expectCopyError(operation, 'VERIFICATION_FAILED');
    expect(existsSync(destination)).toBe(false);
    expect(treeHash(source)).toBe(before);
  });

  it('removes the partial destination when copying fails midway', async () => {
    sampleTree();
    const before = treeHash(source);
    let calls = 0;

    const operation = copyDirectoryVerified(source, destination, {
      onProgress: () => {
        calls += 1;
        if (calls === 3) {
          throw new Error('simulated failure');
        }
      },
    });

    await expectCopyError(operation, 'IO_ERROR');
    expect(existsSync(destination)).toBe(false);
    expect(treeHash(source)).toBe(before);
  });

  describe('verifyCopy', () => {
    beforeEach(async () => {
      sampleTree();
      await copyDirectoryVerified(source, destination);
    });

    const files = [
      { relativePath: 'attachments/3f/3f2c0001.pdf', byteSize: 70 * 1024 },
      { relativePath: 'attachments/ab/ab01.txt', byteSize: 0 },
      { relativePath: 'db/mmap.sqlite', byteSize: 300 * 1024 },
      { relativePath: 'workspace.json', byteSize: 18 },
    ];

    it('accepts an identical copy', async () => {
      await expect(verifyCopy(source, destination, files)).resolves.toBeUndefined();
    });

    it('detects a corrupted file of the same size', async () => {
      const target = join(destination, 'attachments', '3f', '3f2c0001.pdf');
      const bytes = readFileSync(target);
      bytes[100] = (bytes[100] ?? 0) ^ 0x01;
      writeFileSync(target, bytes);

      await expectCopyError(verifyCopy(source, destination, files), 'VERIFICATION_FAILED');
    });

    it('detects a size difference', async () => {
      writeFileSync(join(destination, 'workspace.json'), '{"name":"Physics!"}');
      await expectCopyError(verifyCopy(source, destination, files), 'VERIFICATION_FAILED');
    });

    it('detects missing and extra files', async () => {
      writeFileSync(join(destination, 'extra.txt'), 'x');
      await expectCopyError(verifyCopy(source, destination, files), 'VERIFICATION_FAILED');

      rmSync(join(destination, 'extra.txt'));
      rmSync(join(destination, 'workspace.json'));
      await expectCopyError(verifyCopy(source, destination, files), 'VERIFICATION_FAILED');
    });
  });
});
