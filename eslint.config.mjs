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
  rules: {
    // Underscore-prefixed parameters are intentional no-ops (e.g. the `_openAiApiKey`
    // parameters kept for call-site compatibility during the AI provider migration).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // sessions and scenarios rows carry multi-MB JSON (current_state, initial_state,
    // insider_knowledge). Genuine full-row reads opt out with an eslint-disable comment.
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "CallExpression[callee.property.name='select'][callee.object.callee.property.name='from'][callee.object.arguments.0.value=/^(sessions|scenarios)$/][arguments.0.value=/^\\s*\\*/]",
        message:
          "Don't select('*') from sessions or scenarios: list the columns the route needs.",
      },
    ],
  },
});
