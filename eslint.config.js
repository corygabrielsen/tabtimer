import { defineConfig } from 'eslint/config'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

export default defineConfig(
  {
    ignores: ['dist/', 'dist-e2e/', 'node_modules/', 'coverage/', '.claude/', 'test-results/', 'playwright-report/'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    // Playwright fixtures must destructure their first argument, even when
    // they depend on no other fixture (`async ({}, use) => …`).
    files: ['e2e/**/*.ts'],
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
  {
    // src/core is pure: no chrome.*, no DOM, and no imports from outside core
    // (ports and adapters depend on core, never the reverse).
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['chrome', 'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage'].map((name) => ({
          name,
          message: 'src/core is pure: pass browser state in through src/ports.ts.',
        })),
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../*'], message: 'src/core may only import from src/core.' }] },
      ],
    },
  },
  {
    // content.js is injected into every tracked page: keep the public suffix
    // list (and the site module built on it) out of its bundle.
    files: ['src/content/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'tldts', message: 'Too large for content.js; resolve sites in the service worker.' }],
          patterns: [
            {
              group: ['**/core/site', '**/core/site.ts'],
              message: 'Too large for content.js; resolve sites in the service worker.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier
)
