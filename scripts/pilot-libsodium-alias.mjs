/**
 * Make `libsodium-wrappers-sumo` importable from plain Node.
 *
 * The package ships a broken ESM entry: `modules-sumo-esm/libsodium-wrappers.mjs`
 * imports `./libsodium-sumo.mjs`, which actually lives in the separate
 * `libsodium-sumo` package next to it. `vitest.config.ts` and `wxt.config.ts`
 * both work around it with a bundler `resolve.alias`; the pilot script has no
 * bundler, so it needs the same repair as a Node resolve hook.
 *
 * The CommonJS build those two configs point at is not usable here: esbuild's
 * interop snapshots `module.exports` at import time, and libsodium fills that
 * object only once its WASM is ready, so the snapshot is empty. Pointing at the
 * ESM wrapper and repairing its one bad specifier keeps the live binding.
 *
 * Registered through `module.registerHooks`, so it is synchronous, in-thread,
 * and changes nothing about how any other specifier resolves.
 */
import { registerHooks } from 'node:module';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// The package's `exports` map hides package.json, so resolve the CommonJS entry
// (which the map does expose) and walk up from it rather than asking for the
// manifest directly.
const wrappersRoot = dirname(
  dirname(dirname(require.resolve('libsodium-wrappers-sumo'))),
);
const WRAPPERS_ESM = pathToFileURL(
  join(wrappersRoot, 'dist/modules-sumo-esm/libsodium-wrappers.mjs'),
).href;
// Resolved from the wrapper package's own tree: pnpm keeps `libsodium-sumo`
// beside it, and the relative specifier in the .mjs is simply wrong about where.
const SUMO_ESM = pathToFileURL(
  join(wrappersRoot, '..', 'libsodium-sumo', 'dist/modules-sumo-esm/libsodium-sumo.mjs'),
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'libsodium-wrappers-sumo') {
      return { url: WRAPPERS_ESM, format: 'module', shortCircuit: true };
    }
    if (specifier === './libsodium-sumo.mjs' && context.parentURL === WRAPPERS_ESM) {
      return { url: SUMO_ESM, format: 'module', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
