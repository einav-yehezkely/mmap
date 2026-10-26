/**
 * Managed attachment storage tests against real files in a temporary directory, including
 * Windows junctions (which need no administrator rights) for symlink escape checks.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AttachmentStoreErrorCode } from './file-attachment-store';
import { AttachmentStoreError, FileAttachmentStore } from './file-attachment-store';

const MiB = 1024 * 1024;

let sandbox: string;
let attachments: string;
let sources: string;
let outside: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'mmap-attachments-'));
  attachments = join(sandbox, 'workspace', 'attachments');
  sources = join(sandbox, 'sources');
  outside = join(sandbox, 'outside');
  for (const directory of [attachments, sources, outside]) {
    mkdirSync(directory, { recursive: true });
  }
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Returns IDs from the list in order, so stored names are predictable. */
function sequentialIds(...ids: string[]): () => string {
  const queue = [...ids];
  return () => {
    const id = queue.shift();
    if (id === undefined) {
      throw new Error('No more test IDs');
    }
    return id;
  };
}

function writeSource(name: string, content: Uint8Array | string): string {
  const path = join(sources, name);
  writeFileSync(path, content);
  return path;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** All entries under the attachments folder (POSIX form), for "nothing left behind" checks. */
function storeEntries(): string[] {
  return readdirSync(attachments, { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .sort();
}

async function expectStoreError(
  operation: Promise<unknown>,
  code: AttachmentStoreErrorCode,
): Promise<void> {
  const error = await operation.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AttachmentStoreError);
  expect((error as AttachmentStoreError).code).toBe(code);
}

describe('FileAttachmentStore', () => {
  describe('importFile', () => {
    it('stores a verified copy under a generated name and leaves the source untouched', async () => {
      // Larger than one copy chunk, so the streaming loop runs several times.
      const content = randomBytes(600 * 1024);
      const source = writeSource('Lecture notes.pdf', content);
      const store = new FileAttachmentStore(attachments, { newId: sequentialIds('3f2c0001') });

      const stored = await store.importFile(source, 'pdf', 10 * MiB);

      expect(stored).toEqual({
        relativePath: '3f/3f2c0001.pdf',
        byteSize: content.length,
        sha256: sha256(content),
      });
      const storedPath = join(attachments, '3f', '3f2c0001.pdf');
      expect(readFileSync(storedPath).equals(content)).toBe(true);
      expect(readFileSync(source).equals(content)).toBe(true);
      expect(storeEntries()).toEqual(['.staging', '3f', '3f/3f2c0001.pdf']);

      rmSync(source);
      expect(readFileSync(storedPath).equals(content)).toBe(true);
      expect(await store.resolveExisting(stored.relativePath)).toBe(realpathSync(storedPath));
    });

    it('uses random UUIDs sharded by their first two characters by default', async () => {
      const store = new FileAttachmentStore(attachments);
      const stored = await store.importFile(writeSource('a.txt', 'hello'), 'txt', MiB);

      expect(stored.relativePath).toMatch(/^([0-9a-f]{2})\/\1[0-9a-f]{6}-[0-9a-f-]{27}\.txt$/);
      expect(stored.sha256).toBe(sha256(Buffer.from('hello')));
    });

    it.each([null, '../x', 'EXE!', 'p/df', '', 'a'.repeat(17)])(
      'omits the extension %j when it is null or invalid',
      async (extension) => {
        const store = new FileAttachmentStore(attachments, { newId: sequentialIds('ab01') });
        const stored = await store.importFile(writeSource('file', 'data'), extension, MiB);

        expect(stored.relativePath).toBe('ab/ab01');
        expect(readFileSync(join(attachments, 'ab', 'ab01'), 'utf8')).toBe('data');
      },
    );

    it('accepts an empty file', async () => {
      const store = new FileAttachmentStore(attachments, { newId: sequentialIds('ab01') });
      const stored = await store.importFile(writeSource('empty.txt', ''), 'txt', MiB);

      expect(stored).toEqual({
        relativePath: 'ab/ab01.txt',
        byteSize: 0,
        sha256: sha256(new Uint8Array()),
      });
    });

    it('rejects a file larger than maxBytes without leaving any file behind', async () => {
      const store = new FileAttachmentStore(attachments, { newId: sequentialIds('ab01') });
      const source = writeSource('big.bin', randomBytes(100));

      await expectStoreError(store.importFile(source, 'bin', 99), 'TOO_LARGE');
      expect(storeEntries()).toEqual([]);
      expect(existsSync(source)).toBe(true);
    });

    it('aborts with TOO_LARGE when the source grows past the limit during the copy', async () => {
      const source = writeSource('growing.bin', randomBytes(50));
      // The ID is requested after the initial size check and before copying starts.
      const store = new FileAttachmentStore(attachments, {
        newId: () => {
          appendFileSync(source, randomBytes(20));
          return 'ab01';
        },
      });

      await expectStoreError(store.importFile(source, 'bin', 60), 'TOO_LARGE');
      expect(storeEntries()).toEqual(['.staging']);
    });

    it('reports SOURCE_CHANGED when the size differs from the initial stat', async () => {
      const source = writeSource('changing.txt', 'original');
      const store = new FileAttachmentStore(attachments, {
        newId: () => {
          appendFileSync(source, ' and more');
          return 'ab01';
        },
      });

      await expectStoreError(store.importFile(source, 'txt', MiB), 'SOURCE_CHANGED');
      expect(storeEntries()).toEqual(['.staging']);
      expect(readFileSync(source, 'utf8')).toBe('original and more');
    });

    it('rejects a directory source with NOT_A_FILE', async () => {
      const store = new FileAttachmentStore(attachments);
      await expectStoreError(store.importFile(sources, null, MiB), 'NOT_A_FILE');
      expect(storeEntries()).toEqual([]);
    });

    it('rejects a missing source with SOURCE_UNREADABLE', async () => {
      const store = new FileAttachmentStore(attachments);
      await expectStoreError(
        store.importFile(join(sources, 'missing.pdf'), 'pdf', MiB),
        'SOURCE_UNREADABLE',
      );
    });

    it('rejects an ID generator that returns an unsafe file name', async () => {
      const store = new FileAttachmentStore(attachments, { newId: () => '../evil' });
      await expect(store.importFile(writeSource('a.txt', 'x'), 'txt', MiB)).rejects.toThrow(
        'unusable file name',
      );
      expect(existsSync(join(sandbox, 'workspace', 'evil'))).toBe(false);
    });

    it('refuses to stage through a .staging junction that points outside the store', async () => {
      symlinkSync(outside, join(attachments, '.staging'), 'junction');
      const store = new FileAttachmentStore(attachments, { newId: sequentialIds('ab01') });

      await expectStoreError(
        store.importFile(writeSource('a.txt', 'x'), 'txt', MiB),
        'PERMISSION_DENIED',
      );
      expect(readdirSync(outside)).toEqual([]);
    });
  });

  describe('readLeadingBytes and statSource', () => {
    it('reads at most the requested number of leading bytes', async () => {
      const store = new FileAttachmentStore(attachments);
      const source = writeSource('doc.pdf', '%PDF-1.7 rest of file');

      expect(Buffer.from(await store.readLeadingBytes(source, 5)).toString()).toBe('%PDF-');
      expect(Buffer.from(await store.readLeadingBytes(source, 1000)).toString()).toBe(
        '%PDF-1.7 rest of file',
      );
      expect((await store.readLeadingBytes(source, 0)).length).toBe(0);
    });

    it('returns the size of a regular file', async () => {
      const store = new FileAttachmentStore(attachments);
      expect(await store.statSource(writeSource('a.txt', '12345'))).toEqual({ byteSize: 5 });
    });

    it('rejects directories and missing files', async () => {
      const store = new FileAttachmentStore(attachments);
      const missing = join(sources, 'missing.txt');

      await expectStoreError(store.statSource(sources), 'NOT_A_FILE');
      await expectStoreError(store.readLeadingBytes(sources, 8), 'NOT_A_FILE');
      await expectStoreError(store.statSource(missing), 'SOURCE_UNREADABLE');
      await expectStoreError(store.readLeadingBytes(missing, 8), 'SOURCE_UNREADABLE');
    });
  });

  describe('resolveExisting', () => {
    it.each([
      '../outside.txt',
      'ab/../../outside.txt',
      './ab/ab01.txt',
      'ab//ab01.txt',
      '/abs',
      'C:/Windows/win.ini',
      'c:relative',
      'a\\b',
      'ab/ab01.txt\0',
      'ab/ab01.txt:stream',
      'ab/ab01.txt.',
      '.staging/x.tmp',
      '.STAGING/x.tmp',
      '',
    ])('rejects the unsafe path %j', async (relativePath) => {
      writeFileSync(join(sandbox, 'workspace', 'outside.txt'), 'secret');
      mkdirSync(join(attachments, 'ab'));
      writeFileSync(join(attachments, 'ab', 'ab01.txt'), 'stored');
      mkdirSync(join(attachments, '.staging'));
      writeFileSync(join(attachments, '.staging', 'x.tmp'), 'partial');
      const store = new FileAttachmentStore(attachments);

      expect(await store.resolveExisting(relativePath)).toBeNull();
    });

    it('rejects an absolute path to an existing file outside the store', async () => {
      const secret = join(outside, 'secret.txt');
      writeFileSync(secret, 'secret');
      const store = new FileAttachmentStore(attachments);

      expect(await store.resolveExisting(secret)).toBeNull();
      expect(await store.resolveExisting(secret.replaceAll('\\', '/'))).toBeNull();
    });

    it('rejects a junction inside the store that points outside it', async () => {
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(outside, join(attachments, 'zz'), 'junction');
      const store = new FileAttachmentStore(attachments);

      expect(await store.resolveExisting('zz/secret.txt')).toBeNull();
    });

    it('returns null for a missing file or a directory', async () => {
      mkdirSync(join(attachments, 'ab'));
      const store = new FileAttachmentStore(attachments);

      expect(await store.resolveExisting('ab/missing.pdf')).toBeNull();
      expect(await store.resolveExisting('ab')).toBeNull();
    });
  });

  describe('remove', () => {
    it('deletes a stored file and is idempotent', async () => {
      const store = new FileAttachmentStore(attachments, { newId: sequentialIds('ab01') });
      const stored = await store.importFile(writeSource('a.txt', 'x'), 'txt', MiB);

      await store.remove(stored.relativePath);
      expect(existsSync(join(attachments, 'ab', 'ab01.txt'))).toBe(false);
      await expect(store.remove(stored.relativePath)).resolves.toBeUndefined();
      await expect(store.remove('zz/never-existed.pdf')).resolves.toBeUndefined();
    });

    it('refuses traversal, absolute paths and junction escapes', async () => {
      const neighbour = join(sandbox, 'workspace', 'outside.txt');
      const secret = join(outside, 'secret.txt');
      writeFileSync(neighbour, 'keep');
      writeFileSync(secret, 'keep');
      symlinkSync(outside, join(attachments, 'zz'), 'junction');
      const store = new FileAttachmentStore(attachments);

      await store.remove('../outside.txt');
      await store.remove('ab/../../outside.txt');
      await store.remove(neighbour);
      await store.remove('..\\outside.txt');
      await store.remove('zz/secret.txt');

      expect(readFileSync(neighbour, 'utf8')).toBe('keep');
      expect(readFileSync(secret, 'utf8')).toBe('keep');
    });

    it('does not delete directories', async () => {
      mkdirSync(join(attachments, 'ab'));
      writeFileSync(join(attachments, 'ab', 'ab01'), 'x');
      const store = new FileAttachmentStore(attachments);

      await store.remove('ab');
      expect(existsSync(join(attachments, 'ab', 'ab01'))).toBe(true);
    });
  });

  describe('reconcile', () => {
    it('removes staging leftovers and orphans, keeps known files and reports missing ones', async () => {
      const store = new FileAttachmentStore(attachments, {
        newId: sequentialIds('aa01', 'aa02', 'bb01'),
      });
      const kept = await store.importFile(writeSource('kept.txt', 'kept'), 'txt', MiB);
      const orphanSameShard = await store.importFile(writeSource('o1.txt', 'o1'), 'txt', MiB);
      const orphanOwnShard = await store.importFile(writeSource('o2.txt', 'o2'), null, MiB);
      mkdirSync(join(attachments, '.staging', 'nested'), { recursive: true });
      writeFileSync(join(attachments, '.staging', 'cc01.tmp'), 'partial');
      writeFileSync(join(attachments, '.staging', 'nested', 'deep.tmp'), 'partial');
      mkdirSync(join(attachments, 'dd'));
      writeFileSync(join(attachments, 'stray.txt'), 'stray');

      const report = await store.reconcile(
        new Set([kept.relativePath, 'ee/ee01.pdf', '../outside.txt']),
      );

      expect(report).toEqual({
        removedOrphans: [orphanSameShard.relativePath, orphanOwnShard.relativePath, 'stray.txt'],
        missingFiles: ['../outside.txt', 'ee/ee01.pdf'],
        failedRemovals: [],
      });
      expect(storeEntries()).toEqual(['aa', kept.relativePath]);
      expect(readFileSync(join(attachments, 'aa', 'aa01.txt'), 'utf8')).toBe('kept');
    });

    it('does not descend into junctions and only removes the link itself', async () => {
      writeFileSync(join(outside, 'secret.txt'), 'keep');
      mkdirSync(join(outside, 'zz'));
      writeFileSync(join(outside, 'zz', 'zz01.pdf'), 'keep');
      symlinkSync(outside, join(attachments, 'zz'), 'junction');
      mkdirSync(join(attachments, '.staging'));
      symlinkSync(outside, join(attachments, '.staging', 'link'), 'junction');
      const store = new FileAttachmentStore(attachments);

      const report = await store.reconcile(new Set(['zz/secret.txt']));

      expect(report.removedOrphans).toEqual(['zz']);
      expect(report.missingFiles).toEqual(['zz/secret.txt']);
      expect(report.failedRemovals).toEqual([]);
      expect(existsSync(join(attachments, 'zz'))).toBe(false);
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('keep');
      expect(readFileSync(join(outside, 'zz', 'zz01.pdf'), 'utf8')).toBe('keep');
      expect(lstatSync(outside).isDirectory()).toBe(true);
    });

    it('works on an empty store', async () => {
      const store = new FileAttachmentStore(attachments);
      expect(await store.reconcile(new Set())).toEqual({
        removedOrphans: [],
        missingFiles: [],
        failedRemovals: [],
      });
    });
  });
});
