/**
 * Application service behind `app:get-info`.
 *
 * Reports versions and storage capabilities only. Deliberately excludes paths, user names and
 * workspace data so the result is safe to show and to include in diagnostics exports.
 */

import type { AppInfo } from '@mmap/contracts';
import { probeStorageCapabilities } from '@mmap/storage-sqlite';

export interface RuntimeDescription {
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly platform: string;
  readonly arch: string;
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
}

export function createAppInfoService(runtime: RuntimeDescription): () => Promise<AppInfo> {
  // The engine cannot change while the process runs, so probe once on first use.
  let cachedInfo: AppInfo | undefined;

  return () => {
    cachedInfo ??= {
      appVersion: runtime.appVersion,
      isPackaged: runtime.isPackaged,
      platform: runtime.platform,
      arch: runtime.arch,
      electronVersion: runtime.versions.electron,
      chromeVersion: runtime.versions.chrome,
      nodeVersion: runtime.versions.node,
      storage: probeStorageCapabilities(),
    };
    return Promise.resolve(cachedInfo);
  };
}
