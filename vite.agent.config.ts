// Bundles the agent daemon, agent/index.ts, into one file that `node --build-sea agent/sea.json` then
// wraps with Node into dist/agent/webchat-agent: a program that runs on a laptop without Node.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    ssr: resolve(import.meta.dirname, 'agent', 'index.ts'),
    outDir: resolve(import.meta.dirname, 'dist', 'agent'),
    target: 'node26',
    rollupOptions: { output: { entryFileNames: 'webchat-agent.mjs' } },
  },
  ssr: { noExternal: true },
});
