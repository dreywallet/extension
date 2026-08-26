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
const reviewedEnabledTemplates = new Set([
  'ordnet-auth', 'ordnet-list', 'ordnet-buy', 'ordnet-offer', 'ordnet-counter',
  'ordnet-accept-offer', 'ordnet-accept-counter', 'omb-wiki-ordnet-buy',
  'omb-wiki-satflow-secure-buy',
]);
const enabledTemplates = new Set();
assert(registry.includes("providerMethod: input.steps.length === 0 ? 'signMessage' : 'signPsbt'"),
  'marketplace templates do not bind an explicit single-request provider method');
assert(!registry.includes("providerMethod: 'signMultipleTransactions'"),
  'batch marketplace activation requires an explicit reviewed policy expansion');
assert(!registry.includes("providerMethod: 'signMultipleMessages'"),
  'message-batch marketplace activation requires an explicit reviewed policy expansion');
// Reviewed activation scope is an exact ID set, not a broad marketplace category.
for (const block of registry.split(/template\(\{/u).slice(1)) {
  if (!block.includes("activation: 'enabled'")) continue;
  const id = /templateId:\s*'([^']+)'/u.exec(block)?.[1];
  assert(id !== undefined && reviewedEnabledTemplates.has(id),
    `marketplace template enabled outside the exact reviewed set: ${id ?? 'unknown'}`);
  if (id !== undefined) enabledTemplates.add(id);
}
assert(enabledTemplates.size === reviewedEnabledTemplates.size &&
  [...reviewedEnabledTemplates].every((id) => enabledTemplates.has(id)),
'reviewed marketplace activation set is incomplete or changed');

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Marketplace registry audit passed: compile-time exact-origin policy only.');
}
