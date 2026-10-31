import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = resolve(import.meta.dirname, 'client');
const apiServer = `http://localhost:${process.env.PORT ?? 3000}`;

/**
 * Serves the TypeScript service worker at /sw.js in dev, the same path the production build uses,
 * so the worker's scope is the whole site in both modes.
 */
function serviceWorkerInDev(): Plugin {
  return {
    name: 'webchat-service-worker-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_req, res, next) => {
        server
          .transformRequest('/src/sw.ts')
          .then((result) => {
            if (!result) return next();
            res.setHeader('Content-Type', 'text/javascript');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(result.code);
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), serviceWorkerInDev()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist', 'client'),
    emptyOutDir: true,
    rolldownOptions: {
      input: { main: resolve(root, 'index.html'), sw: resolve(root, 'src', 'sw.ts') },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiServer,
    },
  },
});
