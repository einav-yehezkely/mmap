/**
 * Link policy for rich notes (PRD §5.3, §8: "restrict links and embeds to safe schemes").
 *
 * Note JSON is untrusted: it comes from the renderer and, later, from imported archives. A link
 * mark's `href` ends up in an `<a>` element, so a `javascript:` or `data:` URL would be script
 * execution waiting for a click. The policy is an allow-list: only absolute `http:`, `https:` and
 * `mailto:` URLs pass. Everything else (other schemes, relative URLs, protocol-relative `//host`,
 * obfuscated schemes) is rejected without trying to decode or "repair" it, because any decoding
 * step we do not share exactly with the browser's URL parser is a bypass opportunity.
 *
 * The domain package has no DOM or Node types, so the global `URL` parser is not available here.
 * The check below is deliberately small and conservative instead: anything a browser might
 * interpret differently from us (control characters, embedded whitespace, backslashes,
 * invisible formatting characters) is rejected outright.
 */

/** Schemes a note link may use. Compared case-insensitively. */
export const SAFE_LINK_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

/** Longest accepted href, after trimming. Long enough for real URLs, short enough to bound abuse. */
export const MAX_LINK_HREF_LENGTH = 2048;

/** RFC 3986 scheme syntax: a letter followed by letters, digits, `+`, `-` or `.`. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

/**
 * Unicode whitespace plus zero-width and bidirectional formatting characters. They have no place
 * in a URL and can hide the real target from the user (or split a scheme like `java\u200bscript:`).
 */
const INVISIBLE_OR_WHITESPACE = /[\s\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]/u;

/**
 * Returns the trimmed href when it satisfies the link policy, or `null` when it does not.
 *
 * Callers that persist links should store the returned value rather than the raw input, so the
 * stored form is exactly the form that was checked.
 */
export function normalizeLinkHref(href: string): string | null {
  const candidate = href.trim();
  if (candidate.length === 0 || candidate.length > MAX_LINK_HREF_LENGTH) {
    return null;
  }
  if (!candidate.isWellFormed() || containsForbiddenCharacter(candidate)) {
    return null;
  }

  const colon = candidate.indexOf(':');
  if (colon <= 0) {
    // No scheme at all: a relative or protocol-relative URL.
    return null;
  }
  const scheme = candidate.slice(0, colon).toLowerCase();
  if (!SCHEME_PATTERN.test(scheme) || !SAFE_LINK_SCHEMES.includes(scheme)) {
    return null;
  }

  const rest = candidate.slice(colon + 1);
  const valid = scheme === 'mailto' ? rest.length > 0 : hasNonEmptyHost(rest);
  return valid ? candidate : null;
}

/** Returns true when `href` may be used as a note link target. See `normalizeLinkHref`. */
export function isSafeLinkHref(href: string): boolean {
  return normalizeLinkHref(href) !== null;
}

/**
 * Rejects C0/C1 control characters (including NUL and tab), spaces, backslashes (which browsers
 * treat as `/` in http URLs) and invisible formatting characters anywhere in the href.
 */
function containsForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x5c) {
      return true;
    }
  }
  return INVISIBLE_OR_WHITESPACE.test(value);
}

/**
 * For hierarchical http(s) URLs: requires `//` followed by an authority whose host part (after
 * any `user@` and before any `:port`) is non-empty, so `https:` and `https:///path` are rejected.
 */
function hasNonEmptyHost(afterScheme: string): boolean {
  if (!afterScheme.startsWith('//')) {
    return false;
  }
  const authority = afterScheme.slice(2).split(/[/?#]/, 1)[0] ?? '';
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);
  const host = hostAndPort.startsWith('[') ? hostAndPort : (hostAndPort.split(':', 1)[0] ?? '');
  return host.length > 0;
}
