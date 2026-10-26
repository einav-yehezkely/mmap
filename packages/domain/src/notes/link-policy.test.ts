import { describe, expect, it } from 'vitest';

import { isSafeLinkHref, MAX_LINK_HREF_LENGTH, normalizeLinkHref } from './link-policy';

describe('isSafeLinkHref', () => {
  it.each([
    'https://example.com',
    'http://example.com/path?q=1#frag',
    'HTTPS://EXAMPLE.COM',
    'https://user@example.com:8443/',
    'https://[::1]:8080/',
    'https://xn--4dbrk0ce.example/%D7%A9%D7%9C%D7%95%D7%9D',
    'https://example.com/שלום',
    'mailto:someone@example.com',
    'MailTo:someone@example.com?subject=hi',
  ])('accepts %s', (href) => {
    expect(isSafeLinkHref(href)).toBe(true);
  });

  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['java\tscript:alert(1)'],
    ['java\nscript:alert(1)'],
    ['java\u200bscript:alert(1)'],
    ['%6Aavascript:alert(1)'],
    [' javascript:alert(1)'],
    ['\u0000javascript:alert(1)'],
    ['\u0000https://example.com'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
    ['ftp://example.com'],
    ['blob:https://example.com/uuid'],
    ['/relative/path'],
    ['relative/path'],
    ['#anchor'],
    ['?query'],
    ['//example.com'],
    ['https:example.com'],
    ['https:/example.com'],
    ['https://'],
    ['https:///path'],
    ['https://@'],
    ['https://:443'],
    ['https:\\\\example.com'],
    ['https://exa mple.com'],
    ['https://example.com/\u202epath'],
    ['https://example.com/\u0085'],
    ['mailto:'],
    [':no-scheme'],
    [''],
    ['   '],
    ['https://example.com/\ud800'],
  ])('rejects %j', (href) => {
    expect(isSafeLinkHref(href)).toBe(false);
  });

  it('trims surrounding whitespace but rejects whitespace inside', () => {
    expect(normalizeLinkHref('  https://example.com/a \n')).toBe('https://example.com/a');
    expect(isSafeLinkHref('https://example.com/a b')).toBe(false);
  });

  it('enforces the maximum length', () => {
    const prefix = 'https://example.com/';
    const atLimit = prefix + 'a'.repeat(MAX_LINK_HREF_LENGTH - prefix.length);

    expect(isSafeLinkHref(atLimit)).toBe(true);
    expect(isSafeLinkHref(`${atLimit}a`)).toBe(false);
  });
});
