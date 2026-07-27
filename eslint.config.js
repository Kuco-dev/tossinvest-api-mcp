import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'src/openapi/openapi.snapshot.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        TextEncoder: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'smart'],
      'no-restricted-globals': [
        'error',
        { name: 'console', message: 'stdout 오염 방지를 위해 logger를 사용하세요.' },
      ],
    },
  },
  {
    // 테스트와 빌드 스크립트는 stdio MCP 채널과 무관하므로 console 사용을 허용한다.
    files: ['tests/**/*.{ts,mjs}', 'scripts/**/*.{ts,mjs}'],
    rules: {
      'no-console': 'off',
      'no-restricted-globals': 'off',
    },
  }
);
