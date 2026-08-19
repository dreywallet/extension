import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Marketplace policy and its pinned fixtures live in @drey/core (ADR 0005);
// audit the exact core this build resolves.
const requireCore = createRequire(import.meta.url);
const coreRoot = join(requireCore.resolve('@drey/core/package.json'), '..');

const registry = readFileSync(join(coreRoot, 'src', 'domain', 'marketplaces', 'registry.ts'), 'utf8');
const manifest = readFileSync(join(coreRoot, 'tests', 'fixtures', 'marketplaces', 'manifest.json'));
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

assert(!/origins:\s*\[[^\]]*\*/u.test(registry), 'wildcard marketplace origin found');
assert(!/origins:\s*\[[^\]]*http:\/\//u.test(registry), 'non-HTTPS marketplace origin found');
assert(!/process\.env|import\.meta\.env|fetch\s*\(/u.test(registry), 'marketplace registry depends on runtime/remote policy');
assert(!/magic.?eden|dotswap|runes|\btap\b/iu.test(registry), 'excluded marketplace/asset was activated');
assert(registry.includes('ORDNET_SALE_PUBLIC_KEY') === false,
  'pinned signing keys belong in the verified adapter, not a remotely replaceable registry field');
assert(registry.includes(createHash('sha256').update(manifest).digest('hex')),
  'compile-time registry is not bound to the pinned fixture manifest');
// Reviewed activation scope: ord.net single-inscription templates plus the
// exact-origin OMB Wiki buyer-only ORD.NET/Satflow contracts.
for (const block of registry.split(/template\(\{/u).slice(1)) {
  if (!block.includes("activation: 'enabled'")) continue;
  const nativeOrdnet = block.includes("marketplaceId: 'ordnet'") &&
    block.includes("assetKind: 'inscription'");
  const ombBuyer = block.includes('origins: OMB_WIKI_ORIGIN') &&
    block.includes("role: 'buyer'") && block.includes("assetKind: 'inscription'") &&
    block.includes("broadcaster: 'site'") &&
    (block.includes("action: 'buy'") || block.includes("action: 'secure_buy'"));
  assert(nativeOrdnet || ombBuyer,
    'marketplace template enabled outside the reviewed ord.net/OMB buyer scope');
}

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Marketplace registry audit passed: compile-time exact-origin policy only.');
}
