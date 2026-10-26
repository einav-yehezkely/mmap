/**
 * Maps an `app://mmap/...` request to a file inside the bundled renderer directory.
 *
 * Security: this is the only place the custom protocol touches the filesystem, so it must never
 * serve a file outside `rendererRoot` (PRD §8: prevent traversal, symlink escapes and arbitrary
 * file access). Checks, in order:
 * 1. The URL must use the app scheme and host.
 * 2. The decoded path must not contain NUL bytes, backslashes or drive letters.
 * 3. The normalized absolute path must stay under `rendererRoot` (lexical check).
 * 4. The real path (symlinks resolved) must also stay under the real `rendererRoot`.
 * 5. The target must be a regular file (directories are not listed).
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { APP_HOST, APP_SCHEME } from './trusted-origins';

export type AssetResolution =
  | { readonly kind: 'file'; readonly absolutePath: string }
  | { readonly kind: 'rejected'; readonly status: 400 | 403 | 404 };

/** Returns true when `candidate` equals `root` or lies inside it. Both must be absolute. */
export function isInsideDirectory(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

export async function resolveRendererAsset(
  requestUrl: string,
  rendererRoot: string,
): Promise<AssetResolution> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: 'rejected', status: 400 };
  }

  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) {
    return { kind: 'rejected', status: 403 };
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { kind: 'rejected', status: 400 };
  }

  if (pathname.includes('\0') || pathname.includes('\\') || /^\/?[a-zA-Z]:/.test(pathname)) {
    return { kind: 'rejected', status: 400 };
  }

  const relativePath = pathname === '/' || pathname === '' ? 'index.html' : pathname.slice(1);
  const root = resolve(rendererRoot);
  const lexicalPath = resolve(join(root, ...relativePath.split('/')));
  if (!isInsideDirectory(root, lexicalPath)) {
    return { kind: 'rejected', status: 403 };
  }

  let realRoot: string;
  let realPath: string;
  try {
    [realRoot, realPath] = await Promise.all([realpath(root), realpath(lexicalPath)]);
  } catch {
    return { kind: 'rejected', status: 404 };
  }

  if (!isInsideDirectory(realRoot, realPath)) {
    return { kind: 'rejected', status: 403 };
  }

  if (!(await stat(realPath)).isFile()) {
    return { kind: 'rejected', status: 404 };
  }

  return { kind: 'file', absolutePath: realPath };
}
