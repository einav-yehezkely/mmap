/**
 * Build configuration for the three Electron targets.
 *
 * - main: ESM, Node target. Workspace packages (@mmap/*) and all libraries are bundled because the
 *   app declares no runtime `dependencies`; the installed app therefore ships no node_modules.
 * - preload: CommonJS. Sandboxed preload scripts cannot be ES modules (Electron limitation).
 * - renderer: React + Tailwind. All assets are bundled; no CDN is allowed (PRD §3).
 */
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // Worker thread for writing large imports (src/main/portability/import-writer.ts).
          'import-worker': resolve(import.meta.dirname, 'src/main/workers/import-worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@renderer': resolve(import.meta.dirname, 'src/renderer/src') },
    },
    build: {
      outDir: 'out/renderer',
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
