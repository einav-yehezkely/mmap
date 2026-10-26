/**
 * Serves the bundled renderer from `app://mmap/...` instead of `file://`.
 *
 * Why a custom protocol: `file://` pages share one opaque origin with every local file, which
 * makes origin checks meaningless and widens the impact of an injection. A dedicated standard
 * scheme gives the UI a stable, unique origin that CSP and IPC sender checks can rely on.
 */

import { pathToFileURL } from 'node:url';

import { net, protocol } from 'electron';

import { buildContentSecurityPolicy } from './content-security-policy';
import { resolveRendererAsset } from './resolve-renderer-asset';
import { APP_SCHEME } from './trusted-origins';

/**
 * Must run before the `ready` event. Declares the scheme as standard (so relative URLs and
 * `'self'` in CSP work) and secure (treated like HTTPS). It deliberately does not bypass CSP
 * and does not enable fetch from other origins.
 */
export function registerAppSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
};

/** Registers the request handler. Must run after `ready`. */
export function serveRendererFromAppProtocol(rendererRoot: string): void {
  const contentSecurityPolicy = buildContentSecurityPolicy(null);

  protocol.handle(APP_SCHEME, async (request) => {
    const resolution = await resolveRendererAsset(request.url, rendererRoot);
    if (resolution.kind === 'rejected') {
      return new Response(null, {
        status: resolution.status,
        statusText: STATUS_TEXT[resolution.status] ?? 'Error',
      });
    }

    const fileResponse = await net.fetch(pathToFileURL(resolution.absolutePath).toString());
    const headers = new Headers(fileResponse.headers);
    headers.set('Content-Security-Policy', contentSecurityPolicy);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(fileResponse.body, { status: fileResponse.status, headers });
  });
}
