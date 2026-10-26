// eslint.config.js — flat config. The point of this file is `no-undef` as a safety net: the app is
// plain ESM with no build step, so a reference to a name that isn't imported or defined only fails
// at runtime, on the request that reaches it. Rules that only restyle working code are off.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'private-docs/', 'backups/', 'public/chat-media/', 'public/avatars/'],
  },
  js.configs.recommended,
  {
    // Server code, scripts, fixtures and tests run on Node.
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'warn',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
  {
    // Files served to the browser (the service worker today).
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker },
    },
  },
];
