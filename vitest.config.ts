import { defineConfig } from 'vitest/config'

// Standalone test config so the crx build plugin (vite.config.ts) isn't loaded
// during tests. The unit-tested logic (Timer, storage key helpers) is pure and
// needs no DOM, so the node environment is enough.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
