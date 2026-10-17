import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import readability, { READABILITY_RULES } from './tooling/eslint/readability.mjs';

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'test-results/**',
      'docs/planning/**',
      '.codex/**',
    ],
  },
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    plugins: { readability },
    rules: READABILITY_RULES,
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { readability },
    rules: {
      ...READABILITY_RULES,
      'no-restricted-imports': ['error', { patterns: ['./*', '../*'] }],
    },
  },
);
