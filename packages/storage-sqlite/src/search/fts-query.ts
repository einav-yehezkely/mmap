/**
 * Turns raw user search text into a safe SQLite FTS5 MATCH expression (PRD §5.8, §11 "search
 * parsing").
 *
 * Security invariant: user text is NEVER interpreted as FTS5 syntax. FTS5 has a small query
 * language (`OR`, `NOT`, `NEAR(...)`, `column:` filters, `^` initial-token anchors, parentheses,
 * `*` prefixes, `"` phrases). Passing user text through unchanged would let a query such as
 * `title:secret` or an unbalanced `"` change the meaning of the search or raise a syntax error.
 * Instead we extract plain word tokens and wrap each one in a double-quoted FTS5 string, inside
 * which every character is literal. The only syntax we emit ourselves is the quotes, the spaces
 * between tokens (implicit AND) and one trailing `*` for prefix matching.
 *
 * Tokens are bounded (count and length) so a pasted 10,000-character string cannot produce an
 * unbounded query.
 */

/** Maximum number of words used from one query; later words are ignored. */
export const MAX_QUERY_TOKENS = 16;

/** Maximum length of one word, in code points; longer words are truncated. */
export const MAX_TOKEN_LENGTH = 64;

/**
 * Minimum length of the last word before it is treated as a prefix. A one-letter prefix would
 * match most of the index and is rarely what the user means.
 */
const MIN_PREFIX_LENGTH = 2;

/**
 * A word is a run of Unicode letters, combining marks and numbers. Marks are kept so that
 * scripts written with combining characters (Hebrew niqqud, Arabic harakat, Indic vowel signs)
 * stay one word. Everything else — punctuation, symbols, emoji, whitespace and the FTS5
 * operators `" * ^ ( ) : + -` — separates words and never reaches the MATCH expression.
 */
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;

/** A word must contain at least one letter or number; a run of marks alone is not searchable. */
const SEARCHABLE_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Splits user text into bounded search words, in input order.
 *
 * Truncation counts code points (not UTF-16 units) so a surrogate pair is never split.
 */
export function extractSearchTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const word = Array.from(match[0]).slice(0, MAX_TOKEN_LENGTH).join('');
    if (SEARCHABLE_CHARACTER.test(word)) {
      tokens.push(word);
    }
    if (tokens.length === MAX_QUERY_TOKENS) {
      break;
    }
  }
  return tokens;
}

/**
 * Builds the FTS5 MATCH expression for `text`, or `null` when the text contains no searchable
 * word (the caller then returns an empty result instead of querying).
 *
 * Every word must occur (implicit AND). The last word also matches as a prefix when it has at
 * least two characters, so results appear while the user is still typing ("entro" finds
 * "entropy"). Earlier words match whole tokens only.
 *
 * Inside an FTS5 string the tokenizer (unicode61, case-folding, diacritics removed) splits the
 * quoted text exactly as it split the indexed text, so matching is consistent with the index.
 */
export function buildFtsMatchExpression(text: string): string | null {
  const tokens = extractSearchTokens(text);
  if (tokens.length === 0) {
    return null;
  }
  const lastIndex = tokens.length - 1;
  return tokens
    .map((token, index) => {
      const quoted = quoteFtsString(token);
      const isPrefix = index === lastIndex && Array.from(token).length >= MIN_PREFIX_LENGTH;
      return isPrefix ? `${quoted}*` : quoted;
    })
    .join(' ');
}

/**
 * Wraps `value` in an FTS5 string literal. A `"` inside the string is escaped by doubling it,
 * which is FTS5's only escape rule. `WORD_PATTERN` already excludes quotes; escaping anyway keeps
 * this function safe if the tokenization rules change.
 */
function quoteFtsString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
