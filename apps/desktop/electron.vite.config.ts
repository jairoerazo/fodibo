import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

const CSP = "default-src 'self'; img-src 'self' data:";

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        // Un preload con sandbox no puede ser ESM: se emite CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [
      react(),
      {
        // La CSP estricta se inyecta solo en la compilación: el servidor de desarrollo
        // necesita scripts en línea (React Refresh).
        name: 'fodibo-csp',
        apply: 'build',
        transformIndexHtml: () => [
          { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
        ],
      },
    ],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
