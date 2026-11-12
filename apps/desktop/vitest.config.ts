import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test-portal/**/*.test.ts'],
    // Las pruebas del renderer (.tsx) declaran `// @vitest-environment jsdom`.
    environment: 'node',
    // node:sqlite emite un ExperimentalWarning al cargarse; se silencia solo ese aviso para mantener limpia la salida.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
