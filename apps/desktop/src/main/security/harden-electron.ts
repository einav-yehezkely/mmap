/**
 * Process-wide Electron hardening (PRD §8). Applied before any window is created.
 *
 * Every `webContents` (including ones we never intend to create) gets the same guards, so a
 * future feature cannot accidentally open an unguarded window or webview.
 */

import { app, type Session, type WebContents } from 'electron';

import { buildContentSecurityPolicy } from './content-security-policy';
import { isTrustedUrl, type RendererLocation } from './trusted-origins';

/**
 * Installs guards on every web contents created by the app:
 * - navigation away from the trusted origin is cancelled (`will-navigate`, `will-redirect`);
 * - new windows are denied (`window.open`, `target=_blank`). External links will be opened
 *   through a dedicated, user-initiated IPC call with a scheme allow-list (Phase 1/2), never by
 *   letting the renderer open windows;
 * - `<webview>` tags cannot be attached.
 */
export function guardAllWebContents(location: RendererLocation): void {
  app.on('web-contents-created', (_event, contents) => {
    guardWebContents(contents, location);
  });
}

function guardWebContents(contents: WebContents, location: RendererLocation): void {
  const blockUntrustedNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (!isTrustedUrl(url, location.trustedOrigins)) {
      event.preventDefault();
    }
  };

  contents.on('will-navigate', blockUntrustedNavigation);
  contents.on('will-redirect', blockUntrustedNavigation);
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/**
 * Session-level policy:
 * - deny every permission request and check (camera, microphone, notifications, geolocation,
 *   clipboard-read, HID/serial/USB, …). The app needs none of them;
 * - attach the Content Security Policy to every response (dev server and, in Electron 44, the
 *   custom `app://` protocol too). `app-protocol.ts` also sets the header on its own responses
 *   so production protection does not depend on `webRequest` covering custom protocols in
 *   future Electron versions. The packaged smoke test verifies the policy is enforced.
 */
export function hardenSession(session: Session, location: RendererLocation): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);

  const devServerOrigin = location.isDevelopmentServer ? new URL(location.entryUrl).origin : null;
  const contentSecurityPolicy = buildContentSecurityPolicy(devServerOrigin);

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
      },
    });
  });
}
