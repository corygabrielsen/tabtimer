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
  eslintConfigPrettier
)
