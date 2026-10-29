import { defineConfig } from 'vitest/config'

// Standalone test config so the crx build plugin (vite.config.ts) isn't loaded
// during tests. Pure modules run in node; files that need a DOM opt in with a
// `// @vitest-environment happy-dom` docblock. Every test gets a fresh in-memory
// chrome.* fake from src/test/setup.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Test-only code isn't product code.
      exclude: ['src/**/*.test.ts', 'src/test/**'],
      reporter: ['text', 'json-summary', 'html'],
      // Just below current coverage so a regression fails CI; raise as it grows.
      thresholds: {
        lines: 98,
        branches: 91,
        functions: 95,
        statements: 97,
      },
    },
  },
})
