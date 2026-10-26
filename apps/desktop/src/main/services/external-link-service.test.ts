import { describe, expect, it, vi } from 'vitest';

import { createExternalLinkService } from './external-link-service';

describe('external link service', () => {
  it.each(['https://example.org/page', 'http://example.org', 'mailto:someone@example.org'])(
    'opens %s',
    async (href) => {
      const open = vi.fn(() => Promise.resolve());

      await expect(createExternalLinkService(open)({ href })).resolves.toEqual({ opened: true });
      expect(open).toHaveBeenCalledWith(href);
    },
  );

  it.each([
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'ms-settings:privacy',
    'C:\\Windows\\notepad.exe',
    '\\\\server\\share\\run.bat',
    'vbscript:msgbox',
    'data:text/html,<script>',
    '',
  ])('refuses %j without calling the OS', async (href) => {
    const open = vi.fn(() => Promise.resolve());

    await expect(createExternalLinkService(open)({ href })).resolves.toEqual({ opened: false });
    expect(open).not.toHaveBeenCalled();
  });
});
