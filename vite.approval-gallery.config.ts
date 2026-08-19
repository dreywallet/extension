import { fileURLToPath } from 'node:url';

const galleryRoot = fileURLToPath(new URL('./tools/approval-gallery', import.meta.url));

export default {
  root: galleryRoot,
  base: './',
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  build: {
    emptyOutDir: true,
    outDir: fileURLToPath(new URL('./.output/approval-gallery', import.meta.url)),
  },
  server: {
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
  },
  define: {
    __EXTENSION_VERSION__: JSON.stringify('approval-gallery'),
    __PASSKEY_ENROLLMENT_ENABLED__: JSON.stringify(false),
    __VAULT_COORDINATOR_ENABLED__: JSON.stringify(false),
  },
  resolve: {
    alias: {
      'libsodium-wrappers-sumo': fileURLToPath(
        new URL('./node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js', import.meta.url),
      ),
    },
  },
};
