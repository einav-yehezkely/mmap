/**
 * Search parsing unit tests (PRD §11): user text must never become FTS5 syntax, and snippet
 * markers must never leak into plain-text segments.
 */

import { describe, expect, it } from 'vitest';

import {
  buildFtsMatchExpression,
  extractSearchTokens,
  MAX_QUERY_TOKENS,
  MAX_TOKEN_LENGTH,
} from './fts-query';
import { parseSnippetSegments, SNIPPET_MATCH_END, SNIPPET_MATCH_START } from './snippet-segments';

/**
 * A safe expression is a space-separated list of `"word"` or `"word"*` items whose words contain
 * no quote. Anything else would mean user text escaped the string literals.
 */
const SAFE_EXPRESSION = /^"[^"]+"\*?(?: "[^"]+"\*?)*$/u;

describe('buildFtsMatchExpression', () => {
  it('quotes words, joins them with implicit AND and prefixes only the last word', () => {
    expect(buildFtsMatchExpression('quantum entro')).toBe('"quantum" "entro"*');
  });

  it('does not prefix a one-character last word', () => {
    expect(buildFtsMatchExpression('vitamin c')).toBe('"vitamin" "c"');
  });

  it.each([
    ['empty', ''],
    ['whitespace', '  \t\n '],
    ['a lone quote', '"'],
    ['a lone star', '*'],
    ['a parenthesis', '('],
    ['a caret', '^'],
    ['emoji only', '😀🎉'],
    ['punctuation only', '!@#$%^&*()_+-=[]{};:\'",.<>/?\\|`~'],
    ['a lone combining mark', 'ָ'],
  ])('returns null for %s', (_name, text) => {
    expect(buildFtsMatchExpression(text)).toBeNull();
  });

  it.each([
    ['a column filter', 'title:secret', '"title" "secret"*'],
    ['an OR operator', 'a OR b', '"a" "OR" "b"'],
    ['a NOT operator', 'cats NOT dogs', '"cats" "NOT" "dogs"*'],
    ['a NEAR group', 'NEAR(a b)', '"NEAR" "a" "b"'],
    ['a minus sign', '-x', '"x"'],
    ['an initial-token anchor', '^start', '"start"*'],
    ['an embedded quote', 'say "hi" now', '"say" "hi" "now"*'],
    ['a column list', '{title summary}: x', '"title" "summary" "x"'],
    ['a plus join', 'one+two', '"one" "two"*'],
  ])('neutralizes %s', (_name, text, expected) => {
    const expression = buildFtsMatchExpression(text);
    expect(expression).toBe(expected);
    expect(expression).toMatch(SAFE_EXPRESSION);
  });

  it('keeps emoji out while keeping the surrounding words', () => {
    expect(buildFtsMatchExpression('rocket🚀science')).toBe('"rocket" "science"*');
  });

  it('keeps Hebrew niqqud inside the word', () => {
    expect(buildFtsMatchExpression('שָׁלוֹם עולם')).toBe('"שָׁלוֹם" "עולם"*');
  });

  it('handles Arabic and mixed right-to-left and left-to-right text', () => {
    expect(buildFtsMatchExpression('مرحبا')).toBe('"مرحبا"*');
    expect(buildFtsMatchExpression('‫שלום‬ world مرحبا 42')).toBe('"שלום" "world" "مرحبا" "42"*');
  });

  it('bounds a 10,000-character input', () => {
    const expression = buildFtsMatchExpression('word '.repeat(2_000));
    expect(expression?.match(/"word"/gu)).toHaveLength(MAX_QUERY_TOKENS);
    expect(expression).toMatch(SAFE_EXPRESSION);

    const [longWord] = extractSearchTokens('x'.repeat(10_000));
    expect(longWord).toHaveLength(MAX_TOKEN_LENGTH);
  });

  it('truncates by code points so surrogate pairs are never split', () => {
    // U+1D400 (mathematical bold A) is a letter outside the BMP: two UTF-16 units each.
    const [token] = extractSearchTokens('\u{1D400}'.repeat(100));
    expect(Array.from(token ?? '')).toHaveLength(MAX_TOKEN_LENGTH);
    expect(token).toBe('\u{1D400}'.repeat(MAX_TOKEN_LENGTH));
  });

  it('caps the number of words', () => {
    const words = Array.from({ length: 40 }, (_, index) => `w${index}`);
    expect(extractSearchTokens(words.join(' '))).toEqual(words.slice(0, MAX_QUERY_TOKENS));
  });
});

describe('parseSnippetSegments', () => {
  const marked = (text: string): string => `${SNIPPET_MATCH_START}${text}${SNIPPET_MATCH_END}`;

  it('splits marked text into plain and matched segments', () => {
    expect(parseSnippetSegments(`…about ${marked('entropy')} and heat…`)).toEqual([
      { text: '…about ', isMatch: false },
      { text: 'entropy', isMatch: true },
      { text: ' and heat…', isMatch: false },
    ]);
  });

  it('merges adjacent segments of the same kind', () => {
    expect(parseSnippetSegments(`${marked('heat')}${marked('death')} x`)).toEqual([
      { text: 'heatdeath', isMatch: true },
      { text: ' x', isMatch: false },
    ]);
  });

  it('drops stray and unbalanced markers without leaking them', () => {
    const segments = parseSnippetSegments(
      `a${SNIPPET_MATCH_END}b${SNIPPET_MATCH_START}${SNIPPET_MATCH_START}c`,
    );
    expect(segments).toEqual([
      { text: 'ab', isMatch: false },
      { text: 'c', isMatch: true },
    ]);
    expect(segments.map((segment) => segment.text).join('')).not.toMatch(/[]/u);
  });

  it('returns no segments for empty input', () => {
    expect(parseSnippetSegments('')).toEqual([]);
  });
});
