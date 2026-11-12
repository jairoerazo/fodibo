import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { cpSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const CSP =
  "default-src 'self'; script-src 'self'; img-src 'self' data: fodibo-doc:; connect-src 'self' fodibo-doc:; worker-src 'self'; object-src 'none'; base-uri 'none'";

/** Copia el portal de prueba a `out/test-portal` (sin sus pruebas); el proceso principal lo sirve desde ahí. */
const copyTestPortal = {
  name: 'fodibo-copy-test-portal',
  writeBundle(): void {
    const src = resolve('test-portal');
    const dest = resolve('out/test-portal');
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, {
      recursive: true,
      filter: (p: string) => !p.split(sep).includes('__tests__'),
    });
  },
};

export default defineConfig({
  main: {
    plugins: [copyTestPortal],
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
