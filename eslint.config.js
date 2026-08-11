import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// ADR 0001: only the @scure stack may ship; the bitcoinjs-lib ecosystem must not
// appear anywhere in src/. Kept as shared values because flat-config blocks for
// overlapping files replace (not merge) a rule's options — every block that sets
// no-restricted-imports must restate the ban.
const bannedBitcoinPaths = ['bitcoinjs-lib', 'bip32', 'bip39', 'tiny-secp256k1'].map((name) => ({
  name,
  message: `ADR 0001: use the @scure stack; ${name} must not be imported in src/.`,
}));
const bannedBitcoinPatterns = [
  {
    group: ['bitcoinjs-lib/*', 'bip32/*', 'bip39/*', 'tiny-secp256k1/*'],
    message: 'ADR 0001: use the @scure stack; the bitcoinjs-lib ecosystem must not be imported in src/.',
  },
];
const bannedQrDecoderPaths = [{
  name: 'jsqr',
  message: 'The QR decoder may be imported only by src/adapters/qr/jsqr-decoder.ts.',
}];

const bitcoinLibraryBan = {
  files: ['src/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [...bannedBitcoinPaths, ...bannedQrDecoderPaths],
      patterns: bannedBitcoinPatterns,
    }],
  },
};

// The platform-free domain/messaging boundary moved to core/ (ADR 0005); its
// ESLint rules live in core/eslint.config.js.

// Keep protocol contracts and browser-facing UI independently testable. These
// rules run only at build time; they add no runtime abstractions or user-facing
// concepts.
const providerBoundary = {
  files: ['src/provider/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [...bannedBitcoinPaths, ...bannedQrDecoderPaths],
        patterns: [
          {
            group: [
              'react', 'react-dom', 'react/*', 'react-dom/*', 'wxt', 'wxt/*', '@wxt-dev/*',
              '**/entrypoints/**', '**/ui/**', '**/background/**', '**/adapters/**',
            ],
            message: 'Provider contracts must not depend on browser composition, UI, or infrastructure.',
          },
          ...bannedBitcoinPatterns,
        ],
      },
    ],
  },
};

const uiBoundary = {
  files: [
    'src/ui/**/*.{ts,tsx}',
    'src/entrypoints/{approval,fullpage,onboarding,popup}/**/*.{ts,tsx}',
  ],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [...bannedBitcoinPaths, ...bannedQrDecoderPaths],
        patterns: [
          {
            group: ['**/background/**'],
            message: 'UI must cross the validated messaging boundary instead of importing worker services.',
          },
          ...bannedBitcoinPatterns,
        ],
      },
    ],
  },
};

const infrastructureBoundary = {
  files: ['src/adapters/**/*.{ts,tsx}', 'src/background/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [...bannedBitcoinPaths, ...bannedQrDecoderPaths],
        patterns: [
          {
            group: ['**/entrypoints/**', '**/ui/**'],
            message: 'Infrastructure and worker services must not import presentation modules.',
          },
          ...bannedBitcoinPatterns,
        ],
      },
    ],
  },
};

// The bundled decoder sees only RGBA pixels and returns text. It cannot import
// UI or extension composition, and every other source file is lint-blocked
// from importing the package directly.
const qrDecoderAdapterBoundary = {
  files: ['src/adapters/qr/jsqr-decoder.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: bannedBitcoinPaths,
        patterns: [
          {
            group: ['**/entrypoints/**', '**/ui/**'],
            message: 'The QR pixel decoder must not depend on presentation modules.',
          },
          ...bannedBitcoinPatterns,
        ],
      },
    ],
  },
};

// Node maintenance scripts (fixture sync etc.) legitimately use Node globals.
const nodeScripts = {
  files: ['scripts/**/*.mjs'],
  languageOptions: {
    globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly' },
  },
};

export default tseslint.config(
  { ignores: ['.wxt/**', '.output/**', 'node_modules/**', 'prototype/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  bitcoinLibraryBan,
  providerBoundary,
  uiBoundary,
  infrastructureBoundary,
  qrDecoderAdapterBoundary,
  nodeScripts,
);
