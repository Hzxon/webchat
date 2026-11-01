import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = resolve(import.meta.dirname, 'client');
const apiServer = `http://localhost:${process.env.PORT ?? 3000}`;

/**
 * The browsers the build must run in, for the page's JavaScript and CSS (D-051). Vite's default
 * starts at Safari 16.4, and Lightning CSS then writes `max-width` media queries as `width<=` ranges,
 * which Safari before 16.4 ignores: iPhones on older iOS got the desktop layout. The floor is iOS 15.4,
 * the first that has `<dialog>` and `Array.prototype.at`.
 */
export const browserTargets = ['chrome111', 'edge111', 'firefox114', 'safari15.4', 'ios15.4'];

/**
 * Serves the TypeScript service worker at /sw.js in dev, the same path the production build uses,
 * so the worker's scope is the whole site in both modes. In dev it runs as an ES module; the
 * production build (vite.sw.config.ts) bundles it into one plain script.
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
    target: browserTargets,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiServer,
    },
  },
});
