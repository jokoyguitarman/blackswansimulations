import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, prettier, {
  // Type-aware linting only applies to files included by the root
  // tsconfig. The Vercel bridge under api/ is intentionally excluded from
  // that project and still receives the recommended syntax rules above.
  files: [
    'src/**/*.{ts,tsx}',
    'server/**/*.{ts,tsx}',
    'shared/**/*.{ts,tsx}',
    'scripts/**/*.{ts,tsx}',
  ],
  ignores: ['dist', 'node_modules', 'frontend/**'],
  languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
    },
  },
  rules: {},
});
