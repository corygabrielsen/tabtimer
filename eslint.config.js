import { defineConfig } from 'eslint/config'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

export default defineConfig(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '.claude/'],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier
)
