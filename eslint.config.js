// ESLint flat config — `npm run lint`. Keeps the codebase free of dead code and oversized functions.
import js from '@eslint/js';
import globals from 'globals';

const rules = {
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-unused-private-class-members': 'error',
  'no-useless-return': 'error',
  'no-else-return': 'error',
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'smart'],
  complexity: ['warn', 15],
  'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
  'max-depth': ['warn', 4],
  'max-params': ['warn', 5],
};

export default [
  { ignores: ['node_modules/', '.npm-cache/', '.cache/', 'samples/', 'web/vendor/'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules,
  },
  {
    files: ['web/js/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, maplibregl: 'readonly', uPlot: 'readonly' } },
    rules,
  },
  {
    files: ['tests/**/*.js'],
    rules: { 'max-lines-per-function': 'off' },
  },
];
