/**
 * Opens links from notes outside the app (PRD §8: "Open approved HTTP(S) links through the OS only
 * after user action; reject executable/custom command schemes").
 *
 * The renderer only calls this from an explicit user gesture (Ctrl+click or the link menu). The
 * URL is validated again here with the same allow-list the domain applies when notes are saved
 * (`http`, `https`, `mailto`), so a compromised renderer still cannot launch `file:`, custom
 * protocol handlers or executables through the OS.
 */

import { normalizeLinkHref } from '@mmap/domain';

export type ExternalOpener = (url: string) => Promise<void>;

export function createExternalLinkService(
  openExternal: ExternalOpener,
): (request: { href: string }) => Promise<{ opened: boolean }> {
  return async ({ href }) => {
    const safeHref = normalizeLinkHref(href);
    if (safeHref === null) {
      return { opened: false };
    }
    await openExternal(safeHref);
    return { opened: true };
  };
}
