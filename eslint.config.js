import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      // `interface` for object shapes, `type` for unions and aliases.
      //
      // Sealing against declaration merging argued for `type` everywhere, but
      // the AST is a ~40-node hierarchy built on `extends NodeBase` and mixins
      // such as `extends LiteralExpressionBase, Fuzzable`. Expressed as
      // intersections that hierarchy produces markedly worse error messages and
      // a worse published .d.ts, and every consumer pays that cost daily —
      // whereas merging an exported interface requires a consumer to write a
      // deliberate `declare module` block. The rarer hazard loses.
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        // noUncheckedIndexedAccess makes `arr[i]` possibly-undefined, and the
        // tokenizer leans on that; the rule cannot always see it.
        { allowConstantLoopConditions: true },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Config files and the runnable examples are plain JS, outside the TS
    // project graph. The examples import from dist/ on purpose: they exercise
    // the published package rather than the source tree.
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // A console program by design: printing real output is the entire point of
    // these files, and neither ships (package.json `files` is ["dist"]).
    files: ['examples/**/*.mjs', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  prettier,
);
