// Builds the Claude Code plugin's program, agent/mcp.ts, into one self-contained file at
// plugin/server.mjs (R-030). It runs on the owner's Node, which may be older than the repository's.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    ssr: resolve(import.meta.dirname, 'agent', 'mcp.ts'),
    outDir: resolve(import.meta.dirname, 'plugin'),
    emptyOutDir: false,
    target: 'node20',
    rollupOptions: { output: { entryFileNames: 'server.mjs' } },
  },
  ssr: { noExternal: true },
});
