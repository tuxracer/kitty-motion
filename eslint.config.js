import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import preferArrowFunctions from 'eslint-plugin-prefer-arrow-functions';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'prefer-arrow-functions': preferArrowFunctions,
    },
    rules: {
      // Enforce arrow function style
      'prefer-arrow-functions/prefer-arrow-functions': [
        'error',
        {
          allowNamedFunctions: false,
          classPropertiesAllowed: false,
          disallowPrototype: false,
          returnStyle: 'unchanged',
          singleReturnOnly: false,
        },
      ],
      // Also enforce arrow functions for callbacks
      'prefer-arrow-callback': 'error',
      // Enforce const for variables that are never reassigned
      'prefer-const': 'error',
      // Disallow var declarations, use let or const instead
      'no-var': 'error',
      // Require === and !== instead of == and !=
      'eqeqeq': 'error',
      // Require braces around all blocks
      'curly': 'error',
      // Ensure promises are awaited or handled
      '@typescript-eslint/no-floating-promises': 'error',
      // Catch common promise mistakes
      '@typescript-eslint/no-misused-promises': 'error',
      // Only await things that are actually promises
      '@typescript-eslint/await-thenable': 'error',
      // Catch conditions that are always true/false
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // Catch unnecessary type conversions
      '@typescript-eslint/no-unnecessary-type-conversion': 'error',
      // Disallow unsafe operations with `any` types
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      // Only throw Error objects, not strings or literals
      'no-throw-literal': 'error',
      // Enforce using interface instead of type for object type definitions
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      // Prevent importing from /index paths directly and .js extensions
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/index', '**/index.*'],
              message:
                'Import the module root ("module") instead of "module/index".',
            },
            {
              group: ['**/*.js'],
              message:
                'Do not include .js in import paths; use the bare path instead.',
            },
          ],
        },
      ],
      // Disallow magic numbers - use named constants instead
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },
  {
    files: ['src/**/tests.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
];
