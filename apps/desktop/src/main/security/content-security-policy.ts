/**
 * Content Security Policy for the renderer (PRD §8: "use CSP").
 *
 * The production policy allows only resources from the app's own origin. There are no remote
 * origins at all: the app works offline and must not depend on a CDN (PRD §3), so any network
 * request from the renderer is either a bug or an injection attempt and is blocked.
 *
 * Tradeoff: `style-src 'unsafe-inline'` is allowed because React Flow, Tiptap and KaTeX position
 * and size elements with inline `style` attributes. Inline *scripts* remain forbidden, which is
 * what protects against script injection from note content.
 */

const PRODUCTION_DIRECTIVES: Readonly<Record<string, string>> = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self' 'unsafe-inline'",
  // mmap-attachment: serves previews of image attachments only (see attachment-preview.ts).
  'img-src': "'self' data: blob: mmap-attachment:",
  'font-src': "'self' data:",
  'connect-src': "'self'",
  'worker-src': "'self' blob:",
  'manifest-src': "'none'",
  'media-src': "'self' blob:",
  'object-src': "'none'",
  'frame-src': "'none'",
  'child-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'frame-ancestors': "'none'",
};

/**
 * Development additions for the Vite dev server: React Fast Refresh injects an inline preamble
 * script, and hot module replacement uses a WebSocket. Never used in packaged builds.
 */
function developmentDirectives(devServerOrigin: string): Readonly<Record<string, string>> {
  const socketOrigin = devServerOrigin.replace(/^http:/, 'ws:');
  return {
    ...PRODUCTION_DIRECTIVES,
    'script-src': "'self' 'unsafe-inline'",
    'connect-src': `'self' ${socketOrigin}`,
  };
}

function serialize(directives: Readonly<Record<string, string>>): string {
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

export function buildContentSecurityPolicy(devServerOrigin: string | null): string {
  return serialize(
    devServerOrigin === null ? PRODUCTION_DIRECTIVES : developmentDirectives(devServerOrigin),
  );
}
