// Builds the service worker on its own, as one self-contained classic script at dist/client/sw.js.
// It shares the encryption code with the page, and a shared chunk would need an `import`, which a
// classic service worker cannot do.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { browserTargets } from './vite.config.ts';

const root = resolve(import.meta.dirname, 'client');

export default defineConfig({
  root,
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist', 'client'),
    emptyOutDir: false,
    copyPublicDir: false,
    target: browserTargets,
    lib: {
      entry: resolve(root, 'src', 'sw.ts'),
      formats: ['iife'],
      name: 'WebChatServiceWorker',
      fileName: () => 'sw.js',
    },
  },
});
