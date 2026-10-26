/**
 * Where the renderer is allowed to come from.
 *
 * Production loads the UI from the custom `app://mmap` origin served by `app-protocol.ts`.
 * Development loads it from the local Vite dev server, but only when the app is not packaged, so
 * an environment variable can never redirect an installed build to arbitrary web content.
 */

export const APP_SCHEME = 'app';
export const APP_HOST = 'mmap';
export const PRODUCTION_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const PRODUCTION_ENTRY_URL = `${PRODUCTION_ORIGIN}/index.html`;

export interface RendererLocation {
  /** URL loaded into the main window. */
  readonly entryUrl: string;
  /** Origins allowed to navigate in the window and to call IPC handlers. */
  readonly trustedOrigins: ReadonlySet<string>;
  readonly isDevelopmentServer: boolean;
}

/**
 * Decides which URL to load and which origins to trust.
 *
 * @param isPackaged `app.isPackaged`. Packaged builds ignore `devServerUrl` entirely.
 * @param devServerUrl Value of `ELECTRON_RENDERER_URL` set by electron-vite in development.
 */
export function resolveRendererLocation(
  isPackaged: boolean,
  devServerUrl: string | undefined,
): RendererLocation {
  if (!isPackaged && devServerUrl !== undefined && isLoopbackHttpUrl(devServerUrl)) {
    const origin = new URL(devServerUrl).origin;
    return {
      entryUrl: devServerUrl,
      trustedOrigins: new Set([origin]),
      isDevelopmentServer: true,
    };
  }

  return {
    entryUrl: PRODUCTION_ENTRY_URL,
    trustedOrigins: new Set([PRODUCTION_ORIGIN]),
    isDevelopmentServer: false,
  };
}

/** Returns the origin of `url`, or `null` when it cannot be parsed. Never throws. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Custom schemes such as `app:` report origin "null" in WHATWG URL; build it explicitly.
    return parsed.protocol === `${APP_SCHEME}:`
      ? `${parsed.protocol}//${parsed.host}`
      : parsed.origin;
  } catch {
    return null;
  }
}

export function isTrustedUrl(url: string, trustedOrigins: ReadonlySet<string>): boolean {
  const origin = originOf(url);
  return origin !== null && trustedOrigins.has(origin);
}

/** Only `http://localhost` / `http://127.0.0.1` dev servers are accepted. */
function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}
