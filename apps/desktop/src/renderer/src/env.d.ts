import type { MmapRendererApi } from '@mmap/contracts';

declare global {
  interface Window {
    /** Narrow, typed bridge exposed by the preload script. See `src/preload/index.ts`. */
    readonly mmap: MmapRendererApi;
  }
}

export {};
