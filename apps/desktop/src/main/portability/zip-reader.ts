/**
 * Safe reading of untrusted ZIP archives (PRD §5.11, §8: "archive size/entry limits, path
 * traversal protection"; §11: "malicious archives, traversal, symlinks").
 *
 * The central directory is read and checked completely before any entry is decompressed:
 *
 * - **Size and count limits.** The archive file, the number of entries and the declared total
 *   uncompressed size are bounded, so a "zip bomb" is rejected before it is inflated. While an
 *   entry is read, its actual bytes are counted against its own limit as well, and `yauzl`'s
 *   `validateEntrySizes` fails the stream if the bytes differ from the declared size.
 * - **Names.** `yauzl` with `strictFileNames` rejects absolute paths, backslashes and `..`
 *   segments. On top of that, names with control characters, drive letters or empty segments,
 *   and names that repeat (also differing only in case, which collide on Windows) are rejected.
 * - **Entry kinds.** Encrypted entries and symbolic links are rejected. Directory entries are
 *   allowed (some tools write them) and ignored.
 *
 * Nothing is ever extracted to a path taken from the archive: callers read an entry into memory
 * or into a file whose path they chose themselves (see `extractEntry`).
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { TransferError } from './transfer-errors';

export interface ZipLimits {
  /** Size of the archive file itself. */
  readonly maxArchiveBytes: number;
  /** Number of central directory entries, including directories. */
  readonly maxEntries: number;
  /** Sum of the declared uncompressed sizes of all files. */
  readonly maxTotalUncompressedBytes: number;
}

export interface ZipEntryInfo {
  readonly name: string;
  readonly uncompressedSize: number;
}

const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;
const MAX_NAME_LENGTH = 512;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose.
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f:\\]/u;

export class ZipReader {
  private constructor(
    private readonly zipFile: ZipFile,
    private readonly files: ReadonlyMap<string, Entry>,
  ) {}

  /**
   * Opens `path` and validates its central directory against `limits`.
   *
   * @throws TransferError `ARCHIVE_TOO_LARGE`, `ARCHIVE_UNSAFE` or `ARCHIVE_INVALID`.
   */
  public static async open(path: string, limits: ZipLimits): Promise<ZipReader> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      throw new TransferError('ARCHIVE_INVALID', 'The archive file could not be read.', {
        cause: error,
      });
    }
    if (size > limits.maxArchiveBytes) {
      throw new TransferError('ARCHIVE_TOO_LARGE', 'The archive file is too large to import.');
    }

    const zipFile = await openZip(path);
    try {
      const files = await readCentralDirectory(zipFile, limits);
      return new ZipReader(zipFile, files);
    } catch (error) {
      zipFile.close();
      throw error;
    }
  }

  /** The archive's files (directories excluded), by name. */
  public entries(): ZipEntryInfo[] {
    return [...this.files.values()].map((entry) => ({
      name: entry.fileName,
      uncompressedSize: entry.uncompressedSize,
    }));
  }

  public has(name: string): boolean {
    return this.files.has(name);
  }

  /** Reads a whole entry into memory, failing when it is larger than `maxBytes`. */
  public async readEntry(name: string, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await pipeline(
      await this.openEntry(name, maxBytes),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      }),
    );
    return Buffer.concat(chunks);
  }

  /** Reads up to `count` leading bytes of an entry (for file type sniffing). */
  public async readEntryStart(name: string, count: number): Promise<Buffer> {
    const entry = this.files.get(name);
    const chunks: Buffer[] = [];
    let total = 0;
    // Leaving the loop early destroys the stream, which stops inflating the rest of the entry.
    for await (const chunk of await this.openEntry(name, entry?.uncompressedSize ?? 0)) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
      if (total >= count) break;
    }
    return Buffer.concat(chunks).subarray(0, count);
  }

  /**
   * Writes an entry to `destinationPath` (chosen by the caller, never derived from the entry
   * name; the file must not exist yet) and returns its size and SHA-256.
   */
  public async extractEntry(
    name: string,
    destinationPath: string,
    maxBytes: number,
  ): Promise<{ readonly byteSize: number; readonly sha256: string }> {
    const hash = createHash('sha256');
    let byteSize = 0;
    await pipeline(
      await this.openEntry(name, maxBytes),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          byteSize += chunk.length;
          done(null, chunk);
        },
      }),
      createWriteStream(destinationPath, { flags: 'wx' }),
    );
    return { byteSize, sha256: hash.digest('hex') };
  }

  public close(): void {
    this.zipFile.close();
  }

  private async openEntry(name: string, maxBytes: number): Promise<Readable> {
    const entry = this.files.get(name);
    if (entry === undefined) {
      throw new TransferError('ARCHIVE_INVALID', 'The archive is missing a required file.');
    }
    if (entry.uncompressedSize > maxBytes) {
      throw new TransferError('ARCHIVE_TOO_LARGE', 'A file in the archive is too large.');
    }
    const stream = await new Promise<Readable>((resolve, reject) => {
      this.zipFile.openReadStream(entry, (error, readStream) => {
        if (error !== null || readStream === undefined) {
          reject(invalid(error));
          return;
        }
        resolve(readStream);
      });
    });
    // Counts the bytes actually inflated; `validateEntrySizes` also stops at the declared size.
    let total = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        total += chunk.length;
        if (total > maxBytes) {
          done(new TransferError('ARCHIVE_TOO_LARGE', 'A file in the archive is too large.'));
          return;
        }
        done(null, chunk);
      },
    });
    // `pipe` does not forward errors: a damaged or lying entry must fail the reader's pipeline,
    // and a failed reader must stop inflating.
    stream.on('error', (error: Error) => counter.destroy(invalid(error)));
    counter.on('close', () => stream.destroy());
    return stream.pipe(counter);
  }
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error !== null || zipFile === undefined) {
          reject(invalid(error));
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

function readCentralDirectory(zipFile: ZipFile, limits: ZipLimits): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const files = new Map<string, Entry>();
    const foldedNames = new Set<string>();
    let entryCount = 0;
    let totalBytes = 0;
    let settled = false;
    const fail = (error: TransferError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    zipFile.on('entry', (entry: Entry) => {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        fail(new TransferError('ARCHIVE_TOO_LARGE', 'The archive contains too many files.'));
        return;
      }
      const name = entry.fileName;
      const problem = nameProblem(name);
      if (problem !== null) {
        fail(
          new TransferError(
            'ARCHIVE_UNSAFE',
            `The archive contains an unsafe file name (${problem}).`,
          ),
        );
        return;
      }
      if (entry.isEncrypted()) {
        fail(new TransferError('ARCHIVE_UNSAFE', 'The archive contains encrypted files.'));
        return;
      }
      // The upper 16 bits of the external attributes hold the Unix file mode, if any.
      if (((entry.externalFileAttributes >>> 16) & FILE_TYPE_MASK) === SYMLINK_MODE) {
        fail(new TransferError('ARCHIVE_UNSAFE', 'The archive contains a symbolic link.'));
        return;
      }
      const folded = name.toLowerCase();
      if (foldedNames.has(folded)) {
        fail(new TransferError('ARCHIVE_UNSAFE', 'The archive contains a file name twice.'));
        return;
      }
      foldedNames.add(folded);
      if (!name.endsWith('/')) {
        totalBytes += entry.uncompressedSize;
        if (totalBytes > limits.maxTotalUncompressedBytes) {
          fail(new TransferError('ARCHIVE_TOO_LARGE', 'The archive is too large to import.'));
          return;
        }
        files.set(name, entry);
      }
      zipFile.readEntry();
    });
    zipFile.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(files);
    });
    zipFile.on('error', (error: Error) => fail(invalid(error)));
    zipFile.readEntry();
  });
}

/** Why a name is unsafe, or null. Runs after `yauzl`'s own checks (absolute paths, `..`). */
function nameProblem(name: string): string | null {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return 'length';
  if (UNSAFE_NAME_CHARACTERS.test(name)) return 'special characters';
  const segments = name.replace(/\/$/u, '').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'path segments';
  }
  return null;
}

function invalid(error: Error | null | undefined): TransferError {
  // yauzl reports traversal and other name problems as errors; they are unsafe, not just broken.
  const message = error?.message ?? '';
  if (/invalid relative path|absolute path|invalid characters/iu.test(message)) {
    return new TransferError('ARCHIVE_UNSAFE', 'The archive contains an unsafe file name.', {
      cause: error,
    });
  }
  return new TransferError('ARCHIVE_INVALID', 'The file is not a valid ZIP archive.', {
    cause: error ?? undefined,
  });
}
