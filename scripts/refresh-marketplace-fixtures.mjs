import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Marketplace policy and its pinned fixtures live in @drey/core (ADR 0005);
// audit the exact core this build resolves.
const requireCore = createRequire(import.meta.url);
const coreRoot = join(requireCore.resolve('@drey/core/package.json'), '..');

const fixtures = join(coreRoot, 'tests', 'fixtures', 'marketplaces');
const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8'));
const candidates = join(fixtures, 'refresh-candidates');
mkdirSync(candidates, { recursive: true });

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

async function digestPinnedSource(entry) {
  const source = new URL(entry.sourceUrl);
  if (source.protocol !== 'https:') throw new Error(`${entry.id} source must use HTTPS`);
  const response = await fetch(source, {
    redirect: 'manual',
    signal: globalThis.AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${entry.id} source redirected; pin the reviewed canonical HTTPS URL`);
  }
  if (!response.ok) throw new Error(`${entry.id} refresh failed with HTTP ${response.status}`);
  if (response.url !== source.href) throw new Error(`${entry.id} response URL changed unexpectedly`);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    throw new Error(`${entry.id} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) throw new Error(`${entry.id} response body is unavailable`);

  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of response.body) {
    byteLength += chunk.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(`${entry.id} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    hash.update(chunk);
  }
  return { byteLength, upstreamSha256: hash.digest('hex'), contentType: response.headers.get('content-type') };
}

for (const entry of manifest.entries) {
  const fetched = await digestPinnedSource(entry);
  const candidate = {
    schemaVersion: 1,
    id: entry.id,
    sourceUrl: entry.sourceUrl,
    fetchedAt: new Date().toISOString(),
    contentType: fetched.contentType,
    byteLength: fetched.byteLength,
    upstreamSha256: fetched.upstreamSha256,
    pinnedCanonicalSubsetSha256: entry.sha256,
    reviewRequired: true,
    note: 'This evidence does not update a fixture or activate signing policy. Review the upstream source and edit the canonical subset manually.',
  };
  writeFileSync(join(candidates, `${entry.id}.json`), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'w' });
}
console.log(`Wrote ${manifest.entries.length} refresh candidates for explicit human review.`);
