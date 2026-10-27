/**
 * Converts an FTS5 `snippet()` result into plain-text highlight segments (PRD §5.8, §8).
 *
 * FTS5 surrounds each matched term with caller-chosen start/end markers. Using HTML tags such as
 * `<b>` would force the renderer to parse stored text as markup, which is an injection risk for
 * note content like `<script>`. Instead we use two characters from the Unicode private-use area
 * as markers and split the text on them, so every segment is plain text that the UI renders as a
 * text node.
 *
 * Note content could itself contain these private-use characters. They are never treated as
 * text: a marker that does not fit the expected start/end alternation is dropped, and no marker
 * character survives into a segment. At worst such content shifts a highlight; it can never
 * produce markup.
 */

import type { SnippetSegment } from '@mmap/domain';

/** Marks the start of a matched term in snippet output (U+E000, private use). */
export const SNIPPET_MATCH_START = '';

/** Marks the end of a matched term in snippet output (U+E001, private use). */
export const SNIPPET_MATCH_END = '';

/** Ellipsis FTS5 inserts where the snippet cuts surrounding text. */
export const SNIPPET_ELLIPSIS = '…';

const MARKER_PATTERN = /([])/u;

/**
 * Splits marked snippet text into segments. Adjacent segments of the same kind are merged and
 * empty segments are omitted, so consumers never see `[{match}, {match}]` for one phrase.
 */
export function parseSnippetSegments(marked: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let isMatch = false;
  for (const part of marked.split(MARKER_PATTERN)) {
    if (part === SNIPPET_MATCH_START) {
      isMatch = true;
    } else if (part === SNIPPET_MATCH_END) {
      isMatch = false;
    } else {
      appendSegment(segments, part, isMatch);
    }
  }
  return segments;
}

function appendSegment(segments: SnippetSegment[], text: string, isMatch: boolean): void {
  if (text.length === 0) {
    return;
  }
  const previous = segments.at(-1);
  if (previous !== undefined && previous.isMatch === isMatch) {
    segments[segments.length - 1] = { text: previous.text + text, isMatch };
  } else {
    segments.push({ text, isMatch });
  }
}
