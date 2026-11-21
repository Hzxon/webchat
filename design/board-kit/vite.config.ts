import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the board's parts as one module and one stylesheet, for the design system's converter.
// React stays outside: the converter supplies it.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: { entry: resolve(import.meta.dirname, 'src/index.ts'), formats: ['es'], fileName: 'index', cssFileName: 'style' },
    rollupOptions: { external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'] },
  },
});
