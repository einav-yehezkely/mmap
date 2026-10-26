import { describe, expect, it } from 'vitest';

import { DomainError } from '../errors';
import type { AttachmentCandidate } from './attachment-policy';
import {
  classifyAttachment,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  sanitizeDisplayName,
  SNIFF_BYTES,
} from './attachment-policy';

/** A full sniff window starting with `prefix`, padded with harmless ASCII letters. */
function sniff(prefix: readonly number[] | string = []): Uint8Array {
  const bytes = new Uint8Array(SNIFF_BYTES).fill(0x41);
  bytes.set(typeof prefix === 'string' ? Array.from(prefix, (c) => c.charCodeAt(0)) : prefix);
  return bytes;
}

function candidate(
  originalName: string,
  leadingBytes: Uint8Array = sniff('plain text'),
  byteSize = 1_000,
): AttachmentCandidate {
  return { originalName, byteSize, leadingBytes };
}

const PNG = sniff([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = sniff([0xff, 0xd8, 0xff, 0xe0]);
const GIF87 = sniff('GIF87a');
const GIF89 = sniff('GIF89a');
const WEBP = sniff('RIFF\x24\x00\x00\x00WEBPVP8 ');

describe('sanitizeDisplayName', () => {
  it.each([
    ['C:\\Users\\x\\a.png', 'a.png'],
    ['../../a.png', 'a.png'],
    ['/home/user/docs/a.png', 'a.png'],
    ['mixed/dirs\\a.png', 'a.png'],
  ])('strips directory parts from %j', (input, expected) => {
    expect(sanitizeDisplayName(input)).toBe(expected);
  });

  it('removes control characters and bidi controls that disguise extensions', () => {
    expect(sanitizeDisplayName('re\u0000port\u0007.txt\u007F')).toBe('report.txt');
    expect(sanitizeDisplayName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeDisplayName('a\u2066b\u2069\u200F.txt')).toBe('ab.txt');
  });

  it('trims surrounding whitespace and trailing dots and spaces', () => {
    expect(sanitizeDisplayName('  notes.md  ')).toBe('notes.md');
    expect(sanitizeDisplayName('evil.exe. . .')).toBe('evil.exe');
    expect(sanitizeDisplayName('.gitignore')).toBe('.gitignore');
  });

  it.each(['', '   ', '..', '...', 'folder/', '\u202E\u0000'])(
    'returns null when nothing usable remains (%j)',
    (input) => {
      expect(sanitizeDisplayName(input)).toBeNull();
    },
  );

  it('rejects names with a colon (NTFS alternate data streams)', () => {
    expect(sanitizeDisplayName('notes.txt:evil.exe')).toBeNull();
    expect(sanitizeDisplayName('C:a.png')).toBeNull();
  });

  it.each([
    'CON',
    'con',
    'nul.txt',
    'Aux.tar.gz',
    'PRN ',
    'com1',
    'COM9.log',
    'lpt1.txt',
    'LPT9',
    'CON .txt',
  ])('rejects the Windows reserved device name %j', (input) => {
    expect(sanitizeDisplayName(input)).toBeNull();
  });

  it.each(['console.txt', 'COM10', 'nullable.md', 'my CON.txt'])(
    'keeps names that only resemble reserved names (%j)',
    (input) => {
      expect(sanitizeDisplayName(input)).toBe(input);
    },
  );

  it('preserves Hebrew and emoji names', () => {
    expect(sanitizeDisplayName('סיכום פגישה 📎.pdf')).toBe('סיכום פגישה 📎.pdf');
  });

  it('replaces lone surrogates so the result is well-formed', () => {
    expect(sanitizeDisplayName('a\uD800b.txt')).toBe('a\uFFFDb.txt');
  });

  it('truncates long names to 255 code units, keeping the extension and surrogate pairs', () => {
    // 251 units are available for the stem; unit 250 is a high surrogate, so the cut backs off.
    const name = sanitizeDisplayName(`${'😀'.repeat(200)}.txt`);

    expect(name).not.toBeNull();
    expect(name!.length).toBeLessThanOrEqual(255);
    expect(name!.isWellFormed()).toBe(true);
    expect(name!.endsWith('😀.txt')).toBe(true);
  });

  it('truncates long names without an extension without splitting a surrogate pair', () => {
    const name = sanitizeDisplayName('😀'.repeat(200));

    expect(name).toBe('😀'.repeat(127));
    expect(name!.isWellFormed()).toBe(true);
  });

  it('truncates plain long names to exactly 255 code units', () => {
    expect(sanitizeDisplayName(`${'a'.repeat(300)}.md`)).toBe(`${'a'.repeat(252)}.md`);
    expect(sanitizeDisplayName('b'.repeat(300))).toBe('b'.repeat(255));
  });
});

describe('classifyAttachment: rejections', () => {
  it.each([
    'report.pdf.exe',
    'evil.exe.',
    'evil.exe ',
    'SETUP.EXE',
    'invoice\u202Efdp.exe',
    'script.ps1',
    'payload.js',
    'shortcut.lnk',
    'trap.settingcontent-ms',
    'budget.xlsm',
    'letter.docm',
    'installer.iso',
    'disk.vhdx',
    'tool.dmg',
    'run.sh',
    '.exe',
  ])('rejects %j as EXECUTABLE by extension', (name) => {
    expect(classifyAttachment(candidate(name))).toEqual({ accepted: false, reason: 'EXECUTABLE' });
  });

  it('keeps the extension check effective after long names are truncated', () => {
    expect(classifyAttachment(candidate(`${'a'.repeat(400)}.bat`))).toEqual({
      accepted: false,
      reason: 'EXECUTABLE',
    });
  });

  it.each([
    ['PE/DOS (MZ)', [0x4d, 0x5a, 0x90, 0x00]],
    ['ELF', [0x7f, 0x45, 0x4c, 0x46]],
    ['Mach-O 32-bit', [0xfe, 0xed, 0xfa, 0xce]],
    ['Mach-O 64-bit', [0xfe, 0xed, 0xfa, 0xcf]],
    ['Mach-O 32-bit reversed', [0xce, 0xfa, 0xed, 0xfe]],
    ['Mach-O 64-bit reversed', [0xcf, 0xfa, 0xed, 0xfe]],
    ['Mach-O universal', [0xca, 0xfe, 0xba, 0xbe]],
  ])('rejects %s bytes even when named like an image', (_label, prefix) => {
    expect(classifyAttachment(candidate('photo.png', sniff(prefix)))).toEqual({
      accepted: false,
      reason: 'EXECUTABLE',
    });
  });

  it('rejects a text file that starts with a shebang', () => {
    expect(classifyAttachment(candidate('notes.txt', sniff('#!/bin/sh\nrm -rf ~')))).toEqual({
      accepted: false,
      reason: 'EXECUTABLE',
    });
  });

  it.each(['notes.txt:evil.exe', 'CON', 'nul.txt', '../..'])(
    'rejects %j as INVALID_NAME',
    (name) => {
      expect(classifyAttachment(candidate(name))).toEqual({
        accepted: false,
        reason: 'INVALID_NAME',
      });
    },
  );

  it('rejects empty files', () => {
    expect(classifyAttachment(candidate('empty.txt', new Uint8Array(0), 0))).toEqual({
      accepted: false,
      reason: 'EMPTY_FILE',
    });
  });

  it('accepts a file exactly at the default limit and rejects one byte more', () => {
    const atLimit = candidate('big.pdf', sniff('%PDF-1.7'), DEFAULT_MAX_ATTACHMENT_BYTES);
    const overLimit = candidate('big.pdf', sniff('%PDF-1.7'), DEFAULT_MAX_ATTACHMENT_BYTES + 1);

    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
    expect(classifyAttachment(atLimit)).toMatchObject({ accepted: true });
    expect(classifyAttachment(overLimit)).toEqual({ accepted: false, reason: 'TOO_LARGE' });
  });

  it('honours a custom size limit', () => {
    expect(classifyAttachment(candidate('a.txt', sniff(), 100), 100)).toMatchObject({
      accepted: true,
    });
    expect(classifyAttachment(candidate('a.txt', sniff(), 101), 100)).toEqual({
      accepted: false,
      reason: 'TOO_LARGE',
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'rejects the untrustworthy size %s as TOO_LARGE (fail closed)',
    (byteSize) => {
      expect(classifyAttachment(candidate('a.txt', sniff(), byteSize))).toEqual({
        accepted: false,
        reason: 'TOO_LARGE',
      });
    },
  );

  it('applies checks in order: name, empty, size, executable', () => {
    expect(classifyAttachment(candidate('CON', new Uint8Array(0), 0))).toMatchObject({
      reason: 'INVALID_NAME',
    });
    expect(classifyAttachment(candidate('evil.exe', new Uint8Array(0), 0))).toMatchObject({
      reason: 'EMPTY_FILE',
    });
    expect(classifyAttachment(candidate('evil.exe', sniff('MZ'), 101), 100)).toMatchObject({
      reason: 'TOO_LARGE',
    });
  });
});

describe('classifyAttachment: caller contract', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws VALIDATION_FAILED for the invalid size limit %s',
    (maxBytes) => {
      const attempt = () => classifyAttachment(candidate('a.txt'), maxBytes);

      expect(attempt).toThrow(DomainError);
      expect(attempt).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    },
  );

  it('throws VALIDATION_FAILED when fewer leading bytes than required are supplied', () => {
    const attempt = () => classifyAttachment(candidate('a.txt', new Uint8Array([0x41]), 1_000));

    expect(attempt).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('accepts files shorter than the sniff window when all their bytes are supplied', () => {
    const tiny = candidate('hi.txt', new Uint8Array([0x68, 0x69, 0x0a]), 3);

    expect(classifyAttachment(tiny)).toMatchObject({ accepted: true, mimeType: 'text/plain' });
  });

  it('still detects a two-byte executable', () => {
    expect(classifyAttachment(candidate('x.txt', new Uint8Array([0x4d, 0x5a]), 2))).toEqual({
      accepted: false,
      reason: 'EXECUTABLE',
    });
  });
});

describe('classifyAttachment: classification', () => {
  it.each([
    ['photo.png', PNG, 'image/png'],
    ['photo.jpg', JPEG, 'image/jpeg'],
    ['photo.JPEG', JPEG, 'image/jpeg'],
    ['anim.gif', GIF87, 'image/gif'],
    ['anim.gif', GIF89, 'image/gif'],
    ['photo.webp', WEBP, 'image/webp'],
  ])('accepts %s as a previewable image', (name, bytes, mimeType) => {
    expect(classifyAttachment(candidate(name, bytes))).toEqual({
      accepted: true,
      mimeType,
      kind: 'image',
      previewable: true,
      displayName: name,
    });
  });

  it('uses the detected type but disables preview when the extension disagrees', () => {
    expect(classifyAttachment(candidate('photo.jpg', PNG))).toEqual({
      accepted: true,
      mimeType: 'image/png',
      kind: 'image',
      previewable: false,
      displayName: 'photo.jpg',
    });
  });

  it('does not trust an image extension without image bytes', () => {
    expect(classifyAttachment(candidate('fake.png'))).toEqual({
      accepted: true,
      mimeType: 'application/octet-stream',
      kind: 'file',
      previewable: false,
      displayName: 'fake.png',
    });
  });

  it('accepts SVG as a non-previewable file because it can carry scripts', () => {
    expect(classifyAttachment(candidate('diagram.svg', sniff('<svg xmlns="">')))).toEqual({
      accepted: true,
      mimeType: 'image/svg+xml',
      kind: 'file',
      previewable: false,
      displayName: 'diagram.svg',
    });
  });

  it('labels a PDF as application/pdf only when its bytes start with %PDF-', () => {
    expect(classifyAttachment(candidate('paper.pdf', sniff('%PDF-1.4')))).toMatchObject({
      mimeType: 'application/pdf',
      kind: 'file',
      previewable: false,
    });
    expect(classifyAttachment(candidate('paper.pdf', sniff('<html>')))).toMatchObject({
      accepted: true,
      mimeType: 'application/octet-stream',
    });
  });

  it.each([
    ['notes.txt', 'text/plain'],
    ['README.md', 'text/markdown'],
    ['data.csv', 'text/csv'],
    ['data.json', 'application/json'],
    ['thesis.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['deck.odp', 'application/vnd.oasis.opendocument.presentation'],
    ['archive.zip', 'application/zip'],
    ['book.epub', 'application/epub+zip'],
    ['talk.mp3', 'audio/mpeg'],
    ['clip.mp4', 'video/mp4'],
    ['paper.tex', 'application/x-tex'],
    ['refs.bib', 'application/x-bibtex'],
  ])('maps %s to %s', (name, mimeType) => {
    expect(classifyAttachment(candidate(name))).toEqual({
      accepted: true,
      mimeType,
      kind: 'file',
      previewable: false,
      displayName: name,
    });
  });

  it.each(['data.xyz', 'Makefile'])('falls back to application/octet-stream for %j', (name) => {
    expect(classifyAttachment(candidate(name))).toMatchObject({
      accepted: true,
      mimeType: 'application/octet-stream',
      kind: 'file',
    });
  });

  it('returns the sanitized display name', () => {
    expect(classifyAttachment(candidate('C:\\Users\\x\\סיכום 📎.png', PNG))).toMatchObject({
      accepted: true,
      displayName: 'סיכום 📎.png',
      previewable: true,
    });
  });
});
