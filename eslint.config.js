import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
    {
        ignores: [
            'node_modules/**',
            '**/dist/**',
            '**/.next/**', // Next.js build output (generated .ts/.tsx)
            'storage/**',
            'fixtures/**',
            '.chrome-debug-profile/**',
            'src/**', // upstream reference code (JS, retired runtime)
            'scripts/**', // one-off local helpers
            'scrape-real-chrome.mjs',
        ],
    },
    js.configs.recommended,
    {
        files: ['packages/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx', 'tests/**/*.ts'],
        languageOptions: {
            parser: tsparser,
            parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
        },
        plugins: { '@typescript-eslint': tseslint },
        rules: {
            ...tseslint.configs.recommended.rules,
            // TS compiler already catches undefined identifiers; the core rule
            // false-positives on browser/node globals in .ts files.
            'no-undef': 'off',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                destructuredArrayIgnorePattern: '^_',
                ignoreRestSiblings: true,
            }],
            'no-console': 'off',
        },
    },
];
