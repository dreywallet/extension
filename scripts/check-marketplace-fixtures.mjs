import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Marketplace policy and its pinned fixtures live in @drey/core (ADR 0005);
// audit the exact core this build resolves.
const requireCore = createRequire(import.meta.url);
const coreRoot = join(requireCore.resolve('@drey/core/package.json'), '..');

const fixtures = join(coreRoot, 'tests', 'fixtures', 'marketplaces');
const manifestPath = join(fixtures, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const failures = [];

if (manifest.schemaVersion !== 1 || manifest.generatorVersion !== 'drey-marketplace-fixtures-1' ||
    manifest.generatedForNetwork !== 'signet' || !Array.isArray(manifest.entries)) {
  failures.push('marketplace fixture manifest header is invalid');
}
const ids = new Set();
const paths = new Set();
for (const entry of manifest.entries ?? []) {
  if (!entry || typeof entry !== 'object' || !['satflow', 'ordnet', 'omb-wiki'].includes(entry.marketplace) ||
      !/^https:\/\//u.test(entry.sourceUrl) || !/^2026-[0-9]{2}-[0-9]{2}$/u.test(entry.accessedAt) ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) || typeof entry.transformation !== 'string') {
    failures.push(`invalid manifest entry ${entry?.id ?? '<unknown>'}`);
    continue;
  }
  if (ids.has(entry.id) || paths.has(entry.path) || entry.path.includes('/') || entry.path.includes('..')) {
    failures.push(`duplicate or unsafe manifest entry ${entry.id}`);
    continue;
  }
  ids.add(entry.id);
  paths.add(entry.path);
  const bytes = readFileSync(join(fixtures, entry.path));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256) failures.push(`${entry.path} digest changed: ${digest}`);
  const value = JSON.parse(bytes.toString('utf8'));
  const canonicalHeader = entry.marketplace === 'omb-wiki'
    ? value.origin === 'https://ordinalmaxibiz.wiki' && value.network === 'mainnet' && value.sanitized === true
    : value.marketplace === entry.marketplace && value.network === 'mainnet';
  if (value.schemaVersion !== 1 || !canonicalHeader) {
    failures.push(`${entry.path} canonical contract header is invalid`);
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Marketplace fixture check passed: ${manifest.entries.length} pinned canonical subsets.`);
}
