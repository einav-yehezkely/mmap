/**
 * Writes a ZIP archive to a destination the user chose (PRD §5.11).
 *
 * The archive is written to a temporary file next to the destination and renamed into place
 * only when complete and flushed to disk, so a failed or interrupted export never leaves a
 * truncated archive under the chosen name (and never replaces an older archive with one).
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import yazl from 'yazl';

import { toWriteError } from './transfer-errors';

export class ZipWriter {
  private readonly zipFile = new yazl.ZipFile();

  /** `modifiedAt` is stored as every entry's time, so the archive does not reveal file times. */
  public constructor(private readonly modifiedAt: Date) {}

  /** Adds in-memory content (manifest, data), compressed. */
  public addBuffer(name: string, content: Buffer): void {
    this.zipFile.addBuffer(content, name, { mtime: this.modifiedAt, compress: true });
  }

  /**
   * Adds a file from disk without compression: attachments are mostly compressed formats already,
   * and storing them keeps exports fast.
   */
  public addFile(name: string, absolutePath: string): void {
    this.zipFile.addFile(absolutePath, name, { mtime: this.modifiedAt, compress: false });
  }

  /**
   * Finishes the archive at `destinationPath`, replacing an existing file there only after the
   * new one is complete (the user confirmed the replacement in the save dialog).
   *
   * @throws TransferError `TRANSFER_FAILED` (disk full, no permission, …).
   */
  public async writeTo(destinationPath: string, what = 'The export'): Promise<void> {
    const temporaryPath = `${destinationPath}.${randomUUID()}.partial`;
    try {
      this.zipFile.end();
      await pipeline(this.zipFile.outputStream, createWriteStream(temporaryPath, { flags: 'wx' }));
      const handle = await open(temporaryPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw toWriteError(error, what);
    }
  }
}
