/**
 * Settings › About. In Phase 0 this shows runtime diagnostics fetched through the preload bridge,
 * which also proves end to end that IPC, validation and the storage engine work.
 */

import type { AppInfo, IpcError } from '@mmap/contracts';
import { useEffect, useState } from 'react';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly info: AppInfo }
  | { readonly status: 'failed'; readonly error: IpcError };

export function SettingsView() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    window.mmap.app
      .getInfo()
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: 'loaded', info: result.data }
            : { status: 'failed', error: result.error },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          status: 'failed',
          error: { code: 'INTERNAL_ERROR', message: 'Could not reach the application service.' },
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-labelledby="settings-title" className="max-w-2xl">
      <h1 id="settings-title" className="text-2xl font-semibold tracking-tight">
        Settings
      </h1>
      <h2 className="mt-6 text-lg font-medium">About this installation</h2>
      <div aria-live="polite" className="mt-3">
        {state.status === 'loading' && <p className="text-muted-foreground">Loading…</p>}
        {state.status === 'failed' && (
          <p role="alert" className="text-destructive">
            {state.error.message}
          </p>
        )}
        {state.status === 'loaded' && <AppInfoTable info={state.info} />}
      </div>
    </section>
  );
}

function AppInfoTable({ info }: { info: AppInfo }) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['mmap version', `${info.appVersion}${info.isPackaged ? '' : ' (development)'}`],
    ['Platform', `${info.platform} ${info.arch}`],
    ['Electron', info.electronVersion],
    ['Chromium', info.chromeVersion],
    ['Node.js', info.nodeVersion],
    ['SQLite', info.storage.sqliteVersion],
    // Text, not color alone, conveys status (WCAG: no color-only meaning).
    ['Full-text search (FTS5)', info.storage.fts5Available ? 'Available' : 'Not available'],
    ['Database schema version', String(info.storage.latestSchemaVersion)],
  ];

  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Application and storage engine versions</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b last:border-b-0">
            <th scope="row" className="py-2 pr-4 text-left font-medium text-muted-foreground">
              {label}
            </th>
            <td className="py-2 font-mono">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
