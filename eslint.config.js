import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        chrome: 'readonly',
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Date: 'readonly',
        HTMLDivElement: 'readonly',
        Promise: 'readonly',
        Record: 'readonly',
      },
    },
  },
  {
    files: ['vite.config.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  }
)
