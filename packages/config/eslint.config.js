import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Shared flat ESLint config for all TypeScript workspaces. */
export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**', '**/migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
);
