import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'codemirror/**', 'out/**', 'dist/**'],
  },
  {
    ...sonarjs.configs.recommended,
    files: ['**/*.js'],
    languageOptions: {
      ...sonarjs.configs.recommended.languageOptions,
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
];
