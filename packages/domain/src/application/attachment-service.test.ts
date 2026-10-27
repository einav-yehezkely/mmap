import { describe, expect, it } from 'vitest';

import { isPreviewableAttachment } from './attachment-service';

describe('isPreviewableAttachment', () => {
  it.each([
    ['image/png', 'diagram.png', true],
    ['image/jpeg', 'photo.JPG', true],
    ['image/jpeg', 'photo.jpeg', true],
    ['image/gif', 'anim.gif', true],
    ['image/webp', 'pic.webp', true],
    // Bytes say JPEG but the name says PNG: kept as an attachment, not previewed.
    ['image/jpeg', 'photo.png', false],
    ['image/png', 'no-extension', false],
    // SVG can contain scripts and is never previewed.
    ['image/svg+xml', 'drawing.svg', false],
    ['application/pdf', 'paper.pdf', false],
  ])('%s named %s → %s', (mimeType, name, expected) => {
    expect(isPreviewableAttachment(mimeType, name)).toBe(expected);
  });
});
