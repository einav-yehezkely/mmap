/**
 * Automated accessibility check of the primary views inside the packaged app (PRD §6: "Target
 * WCAG 2.2 AA for primary flows"; §11 "Performance/accessibility: … keyboard workflows").
 *
 * axe-core is not part of the app. The smoke runner passes the path of its script (from the
 * development dependencies) with `--smoke-axe=<path>`; this check injects it into the renderer
 * and runs the WCAG 2.0/2.1/2.2 A and AA rules on each view: Home, the New node dialog, Library
 * with the node editor open, Mind Maps, the Knowledge Graph and its list, the Timeline and its list, and Settings.
 * Rendering in the real app means color contrast is computed from the actual theme; every view is
 * checked in both the light and the dark theme, since a color can pass in one and fail in the other.
 *
 * Automated rules find roughly a third of accessibility problems; the manual keyboard and
 * screen-reader checklist in docs/testing.md covers the rest.
 */

import { readFile } from 'node:fs/promises';

import { nativeTheme, type BrowserWindow } from 'electron';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface ViewStep {
  readonly name: string;
  /** Script run in the renderer to reach the view. */
  readonly open: string;
}

const clickNav = (label: string) =>
  `[...document.querySelectorAll('nav[aria-label="Main"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click();`;
const clickButton = (label: string) =>
  `[...document.querySelectorAll('main button, header button, aside button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click();`;

const clickDialogButton = (label: string) =>
  `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click();`;

const VIEWS: readonly ViewStep[] = [
  { name: 'Home', open: clickNav('Home') },
  { name: 'New node dialog', open: `${clickNav('Library')} ${clickButton('New node')}` },
  { name: 'Library with the node editor', open: clickDialogButton('Create node') },
  { name: 'Mind Maps', open: `${clickButton('Close node')} ${clickNav('Mind Maps')}` },
  { name: 'Knowledge Graph', open: clickNav('Knowledge Graph') },
  { name: 'Knowledge Graph list', open: clickButton('List') },
  { name: 'Timeline', open: clickNav('Timeline') },
  { name: 'Timeline list', open: clickButton('List') },
  { name: 'Settings', open: clickNav('Settings') },
];

export async function checkAccessibility(window: BrowserWindow, axePath: string): Promise<void> {
  const source = await readFile(axePath, 'utf8');
  const problems: string[] = [];
  const original = nativeTheme.themeSource;
  try {
    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme;
      await reloadInTheme(window, theme);
      await window.webContents.executeJavaScript(`${source};'loaded'`);
      for (const view of VIEWS) {
        const violations = await scanView(window, view);
        for (const violation of violations) problems.push(`${view.name} (${theme}): ${violation}`);
      }
    }
  } finally {
    nativeTheme.themeSource = original;
  }
  await window.webContents.executeJavaScript(`(() => { ${clickNav('Home')} return 'ok'; })()`);
  if (problems.length > 0) {
    throw new Error(`${problems.length} accessibility violations:\n${problems.join('\n')}`);
  }
}

/**
 * Reloads the window after a theme switch and waits until it shows the app again in that theme.
 * Without the reload, colors already on screen lag behind the switch for a few seconds and axe
 * measures some of them half-switched.
 */
async function reloadInTheme(window: BrowserWindow, theme: 'light' | 'dark'): Promise<void> {
  window.webContents.reload();
  const ready = `matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'} &&
    document.querySelector('nav[aria-label="Main"] button') !== null`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const shown = (await window.webContents.executeJavaScript(ready).catch(() => false)) as boolean;
    if (shown) break;
    if (Date.now() > deadline) throw new Error(`The app did not come back in the ${theme} theme.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

/** Opens one view and returns its WCAG violations, one line each. */
async function scanView(window: BrowserWindow, view: ViewStep): Promise<string[]> {
  await window.webContents.executeJavaScript(`(() => { ${view.open} return 'ok'; })()`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  return (await window.webContents.executeJavaScript(`(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ${JSON.stringify(WCAG_TAGS)} },
      resultTypes: ['violations'],
    });
    return result.violations.map((violation) =>
      violation.id + ' (' + violation.impact + ', ' + violation.nodes.length + '): ' +
      violation.help + ' — ' + violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | '));
  })()`)) as string[];
}
