/**
 * Attachment file-type policy (PRD §5.10).
 *
 * Before the main process copies a user-selected file into the workspace's managed attachments
 * directory, it reads the first {@link SNIFF_BYTES} bytes and asks this module whether the file
 * may be attached and how it should be presented. The policy is deliberately conservative:
 *
 * - It never trusts the file name alone. Executables are detected by extension *and* by magic
 *   bytes, and images are only recognised from their magic bytes.
 * - It fails closed. Anything that cannot be proven safe (unknown sizes, hidden characters that
 *   disguise an extension, names Windows would interpret specially) is rejected or neutralised.
 * - It is pure and runtime-agnostic: no filesystem, Node or DOM APIs, so it can be unit tested
 *   and reused by a future server without change.
 *
 * Accepting a file here never means it will be executed: mmap never executes attachments. The
 * blocklist exists so that a file the user later opens or exports from mmap cannot launch code
 * through the operating system's file associations.
 */

import { DomainError } from '../errors';

/** Default maximum attachment size (20 MB). Users may configure a different limit locally. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Number of leading bytes callers must supply in {@link AttachmentCandidate.leadingBytes}. Files
 * shorter than this are passed in full. Every signature checked here fits in this window.
 */
export const SNIFF_BYTES = 64;

export interface AttachmentCandidate {
  /** Name as reported by the OS file dialog. May contain directory parts or hostile characters. */
  readonly originalName: string;
  /** Total size of the file in bytes. */
  readonly byteSize: number;
  /** The first `min(byteSize, SNIFF_BYTES)` bytes of the file (more is allowed and ignored). */
  readonly leadingBytes: Uint8Array;
}

export type AttachmentRejectionReason = 'EMPTY_FILE' | 'TOO_LARGE' | 'EXECUTABLE' | 'INVALID_NAME';

export type AttachmentClassification =
  | {
      readonly accepted: true;
      /** Content type to store and serve the file with. */
      readonly mimeType: string;
      /** `image` only when the bytes are a recognised raster image format. */
      readonly kind: 'image' | 'file';
      /** Whether the renderer may show an inline preview (bytes and extension agree). */
      readonly previewable: boolean;
      /** Sanitized name, safe to display and to suggest when exporting. */
      readonly displayName: string;
    }
  | { readonly accepted: false; readonly reason: AttachmentRejectionReason };

/**
 * Decides whether a file may be attached and how it should be presented.
 *
 * Checks run in a fixed order and the first failure wins: invalid name, empty file, too large,
 * executable. Sizes that are not a non-negative safe integer (negative, fractional, `NaN`,
 * `Infinity`) are rejected as `TOO_LARGE` because the policy cannot prove such a file fits within
 * the limit.
 *
 * @param maxBytes Inclusive size limit; a file of exactly `maxBytes` bytes is accepted.
 * @throws DomainError `VALIDATION_FAILED` when `maxBytes` is not a non-negative safe integer, or
 *   when fewer leading bytes were supplied than the contract requires. Both are caller bugs or
 *   misconfiguration; silently continuing would weaken the size limit or the executable sniffing.
 */
export function classifyAttachment(
  candidate: AttachmentCandidate,
  maxBytes: number = DEFAULT_MAX_ATTACHMENT_BYTES,
): AttachmentClassification {
  assertValidMaxBytes(maxBytes);

  const displayName = sanitizeDisplayName(candidate.originalName);
  if (displayName === null) {
    return reject('INVALID_NAME');
  }

  const sizeProblem = checkSize(candidate.byteSize, maxBytes);
  if (sizeProblem !== null) {
    return reject(sizeProblem);
  }

  assertEnoughLeadingBytes(candidate);

  const extension = extensionOf(displayName);
  if (EXECUTABLE_EXTENSIONS.has(extension) || hasExecutableSignature(candidate.leadingBytes)) {
    return reject('EXECUTABLE');
  }

  return { accepted: true, displayName, ...describeContent(extension, candidate.leadingBytes) };
}

/**
 * Turns an untrusted file name into a name that is safe to display and to reuse when exporting.
 *
 * The name is only ever used for display: stored files are addressed by generated storage keys,
 * so this function is about honesty (what the user sees is what the OS will see) rather than
 * path safety. Steps:
 *
 * 1. Lone UTF-16 surrogates are replaced with U+FFFD so the result is well-formed.
 * 2. Control characters (C0, DEL, C1) and Unicode bidirectional controls are removed. Bidi
 *    overrides are the classic way to disguise an extension: `invoice‮fdp.exe` renders as
 *    `invoiceexe.pdf` but is an `.exe`.
 * 3. Any directory part is dropped, for both `/` and `\` separators.
 * 4. Surrounding whitespace and trailing dots/spaces are removed; Windows ignores the latter, so
 *    `evil.exe.` would otherwise slip past the extension check yet still run as `.exe`.
 * 5. The name is truncated to 255 UTF-16 code units without splitting a surrogate pair. A short
 *    final extension is preserved so that truncation can never hide or change the file type.
 *
 * @returns The sanitized name, or `null` when nothing usable remains, when the name contains `:`
 *   (NTFS alternate data streams, drive-relative paths) or when it is a Windows reserved device
 *   name such as `CON` or `nul.txt`.
 */
export function sanitizeDisplayName(originalName: string): string | null {
  const cleaned = trimName(baseName(removeHiddenCharacters(originalName.toWellFormed())));
  // Checked before truncation so a colon cannot be pushed out of the kept range.
  if (cleaned.includes(':')) {
    return null;
  }

  const name = trimName(truncateName(cleaned));
  if (name === '' || isReservedDeviceName(name)) {
    return null;
  }
  return name;
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

function reject(reason: AttachmentRejectionReason): AttachmentClassification {
  return { accepted: false, reason };
}

function assertValidMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      'The attachment size limit must be a non-negative integer.',
    );
  }
}

function checkSize(byteSize: number, maxBytes: number): AttachmentRejectionReason | null {
  if (byteSize === 0) {
    return 'EMPTY_FILE';
  }
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maxBytes) {
    return 'TOO_LARGE';
  }
  return null;
}

/** Without enough leading bytes, a disguised executable could pass the signature checks. */
function assertEnoughLeadingBytes(candidate: AttachmentCandidate): void {
  const required = Math.min(candidate.byteSize, SNIFF_BYTES);
  if (candidate.leadingBytes.length < required) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `Attachment classification needs the first ${required} bytes of the file.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------------------------

const MAX_DISPLAY_NAME_LENGTH = 255;

/**
 * Longest extension (without the dot) that truncation preserves. Covers every extension in the
 * blocklist, including `settingcontent-ms`.
 */
const MAX_PRESERVED_EXTENSION_LENGTH = 32;

/**
 * Code units removed from names: C0 controls, DEL and C1 controls, plus the bidirectional
 * formatting characters (embeddings/overrides U+202A–U+202E, isolates U+2066–U+2069, and the
 * implicit marks LRM, RLM and ALM) that can visually reorder a name. All of them are in the BMP,
 * so filtering by code unit never touches surrogate pairs.
 */
function isHiddenCodeUnit(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function removeHiddenCharacters(name: string): string {
  let result = '';
  for (let index = 0; index < name.length; index += 1) {
    if (!isHiddenCodeUnit(name.charCodeAt(index))) {
      result += name.charAt(index);
    }
  }
  return result;
}

function baseName(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(lastSeparator + 1);
}

/**
 * Trims whitespace on both ends and any trailing dots or whitespace (ignored by Windows). Written
 * as a scan rather than a `/[\s.]+$/` regex, which backtracks quadratically on long runs.
 */
function trimName(name: string): string {
  const trimmed = name.trim();
  let end = trimmed.length;
  while (end > 0 && isTrailingJunk(trimmed.charAt(end - 1))) {
    end -= 1;
  }
  return trimmed.slice(0, end);
}

function isTrailingJunk(character: string): boolean {
  return character === '.' || character.trim() === '';
}

function truncateName(name: string): string {
  if (name.length <= MAX_DISPLAY_NAME_LENGTH) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const keepsExtension = dot > 0 && name.length - dot - 1 <= MAX_PRESERVED_EXTENSION_LENGTH;
  const suffix = keepsExtension ? name.slice(dot) : '';
  const stem = name.slice(0, name.length - suffix.length);
  return truncateCodeUnits(stem, MAX_DISPLAY_NAME_LENGTH - suffix.length) + suffix;
}

/** Cuts `text` to at most `limit` code units, backing off one unit to avoid a split pair. */
function truncateCodeUnits(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const lastKept = text.charCodeAt(limit - 1);
  const isHighSurrogate = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return text.slice(0, isHighSurrogate ? limit - 1 : limit);
}

/**
 * Windows reserved device names. Windows applies them to the part before the first dot, with
 * trailing spaces ignored, so `nul.txt` and `CON .tar.gz` are reserved too. COM0/LPT0, the
 * superscript-digit variants and the console aliases are included because Windows also treats
 * them specially.
 */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/iu;

function isReservedDeviceName(name: string): boolean {
  const firstDot = name.indexOf('.');
  const stem = firstDot === -1 ? name : name.slice(0, firstDot);
  return RESERVED_DEVICE_NAME.test(stem.trimEnd());
}

/** Lowercased text after the last dot, or `''` when there is none. `.exe` yields `exe`. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Executable detection
// ---------------------------------------------------------------------------------------------

/**
 * Extensions that the OS may execute, install, mount or hand to a script host when opened.
 *
 * Besides native binaries and scripts, this includes macro-enabled Office documents (macros run
 * when the document is opened and trusted) and disk images (`iso`, `img`, `vhd`, `vhdx`, `dmg`),
 * which mount on double-click and are a common way to smuggle executables past download
 * protections such as Mark-of-the-Web.
 */
// prettier-ignore
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows binaries, installers and packages
  'exe', 'dll', 'com', 'scr', 'pif', 'cpl', 'sys', 'drv', 'ocx', 'msi', 'msp', 'mst', 'msc',
  'appx', 'appxbundle', 'msix', 'msixbundle', 'application', 'appref-ms', 'gadget', 'xbap',
  'diagcab',
  // Windows script hosts and shell
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'vb', 'vbs', 'vbe', 'js', 'jse', 'ws', 'wsf',
  'wsh', 'wsc', 'sct', 'hta', 'chm',
  // Windows shortcuts, registry and shell integration files
  'lnk', 'reg', 'inf', 'scf', 'url', 'settingcontent-ms', 'library-ms', 'searchconnector-ms',
  'shb', 'shs',
  // Java
  'jar',
  // Disk images
  'iso', 'img', 'vhd', 'vhdx', 'dmg',
  // Macro-enabled Office documents, templates and add-ins
  'docm', 'dotm', 'xlsm', 'xltm', 'xlsb', 'xlam', 'xll', 'pptm', 'potm', 'ppsm', 'ppam', 'sldm',
  // Unix and macOS
  'sh', 'bash', 'zsh', 'ksh', 'csh', 'command', 'app', 'pkg', 'deb', 'rpm', 'apk', 'elf', 'so',
  'dylib',
]);

/** Leading-byte signatures of native executables and interpreter scripts. */
const EXECUTABLE_SIGNATURES: readonly (readonly number[])[] = [
  /** DOS/PE (`MZ`): Windows .exe, .dll, .sys and friends. */
  [0x4d, 0x5a],
  /** ELF: Linux and most Unix binaries and shared objects. */
  [0x7f, 0x45, 0x4c, 0x46],
  /** Mach-O 32/64-bit, both byte orders. */
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  /** Mach-O universal (fat) binary; shares its magic with Java class files, also code. */
  [0xca, 0xfe, 0xba, 0xbe],
  /** Shebang (`#!`): a script the kernel runs through the named interpreter. */
  [0x23, 0x21],
];

function hasExecutableSignature(bytes: Uint8Array): boolean {
  return EXECUTABLE_SIGNATURES.some((signature) => startsWithBytes(bytes, signature));
}

// ---------------------------------------------------------------------------------------------
// Content classification
// ---------------------------------------------------------------------------------------------

interface RasterImageFormat {
  readonly mimeType: string;
  /** Extensions that agree with this format; only then is an inline preview allowed. */
  readonly extensions: readonly string[];
  readonly matches: (bytes: Uint8Array) => boolean;
}

/** Raster formats the renderer can preview. Recognised only from magic bytes. */
const RASTER_IMAGE_FORMATS: readonly RasterImageFormat[] = [
  {
    mimeType: 'image/png',
    extensions: ['png'],
    matches: (bytes) => startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mimeType: 'image/jpeg',
    extensions: ['jpg', 'jpeg'],
    matches: (bytes) => startsWithBytes(bytes, [0xff, 0xd8, 0xff]),
  },
  {
    mimeType: 'image/gif',
    extensions: ['gif'],
    matches: (bytes) =>
      startsWithBytes(bytes, ascii('GIF87a')) || startsWithBytes(bytes, ascii('GIF89a')),
  },
  {
    mimeType: 'image/webp',
    extensions: ['webp'],
    matches: (bytes) =>
      startsWithBytes(bytes, ascii('RIFF')) && startsWithBytes(bytes, ascii('WEBP'), 8),
  },
];

/**
 * Content types for non-image files, chosen by extension. Unknown extensions fall back to
 * `application/octet-stream`, which browsers and Electron never render or sniff as active
 * content.
 */
const MIME_TYPES_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['odt', 'application/vnd.oasis.opendocument.text'],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ['zip', 'application/zip'],
  ['rtf', 'application/rtf'],
  ['epub', 'application/epub+zip'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['mp4', 'video/mp4'],
  ['tex', 'application/x-tex'],
  ['bib', 'application/x-bibtex'],
]);

const OCTET_STREAM = 'application/octet-stream';

type ContentDescription = Pick<
  Extract<AttachmentClassification, { accepted: true }>,
  'mimeType' | 'kind' | 'previewable'
>;

function describeContent(extension: string, bytes: Uint8Array): ContentDescription {
  const image = RASTER_IMAGE_FORMATS.find((format) => format.matches(bytes));
  if (image !== undefined) {
    // A mismatched extension is accepted (cameras and tools mislabel files) but not previewed,
    // so the renderer never displays bytes under a type the user did not expect.
    return {
      mimeType: image.mimeType,
      kind: 'image',
      previewable: image.extensions.includes(extension),
    };
  }
  return { mimeType: fileMimeType(extension, bytes), kind: 'file', previewable: false };
}

function fileMimeType(extension: string, bytes: Uint8Array): string {
  if (extension === 'svg') {
    // SVG is XML that can carry scripts and external references, so it is stored as a plain
    // file and never previewed inline.
    return 'image/svg+xml';
  }
  if (extension === 'pdf') {
    return startsWithBytes(bytes, ascii('%PDF-')) ? 'application/pdf' : OCTET_STREAM;
  }
  return MIME_TYPES_BY_EXTENSION.get(extension) ?? OCTET_STREAM;
}

// ---------------------------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------------------------

function startsWithBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Byte values of an ASCII-only signature string. */
function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}
