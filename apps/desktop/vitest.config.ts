import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Las pruebas del renderer (.tsx) declaran `// @vitest-environment jsdom`.
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
});
