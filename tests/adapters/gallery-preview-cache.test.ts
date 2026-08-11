import { beforeAll, describe, expect, it } from 'vitest';
import type { InscriptionPreviewPayload } from '@drey/core/domain/gateway/contract';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import {
  createDurableGalleryPreviewCache,
  GALLERY_DURABLE_PREVIEW_MAX_ITEMS,
} from '../../src/adapters/storage/gallery-preview-cache';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';

beforeAll(installTestCryptoProvider);

const vaultId = 'vault-gallery-preview';
const accountId = `acct_signet_${'a'.repeat(64)}`;
const dek = new Uint8Array(32).fill(7);

const raster = (inscriptionId: string): InscriptionPreviewPayload => ({
  disposition: 'raster',
  reason: null,
  requestedInscriptionId: inscriptionId,
  sourceInscriptionId: inscriptionId,
  resolvedInscriptionId: inscriptionId,
  delegateInscriptionId: null,
  sourceContentSha256: 'd'.repeat(64),
  declaredMime: 'image/png',
  declaredContentLength: 1,
  detectedMime: 'image/png',
  detectedFormat: 'png',
  sourceContentLength: 1,
  policyRevision: 'm9p-preview-v2',
  rendererRevision: 'renderer-1',
  pngSha256: 'e'.repeat(64),
  pngWidth: 1,
  pngHeight: 1,
  pngByteLength: 1,
  bytesBase64: 'AQ==',
});

function input(seed: string) {
  const txid = seed.repeat(64).slice(0, 64);
  const inscriptionId = `${txid}i0`;
  return {
    inscriptionId,
    satpoint: `${txid}:0:0`,
    outpoint: { txid, vout: 0 },
    classificationRevision: `revision-${seed}`,
    preview: raster(inscriptionId),
  };
}

function numberedInput(index: number) {
  const txid = index.toString(16).padStart(64, '0');
  const inscriptionId = `${txid}i0`;
  return {
    inscriptionId,
    satpoint: `${txid}:0:0`,
    outpoint: { txid, vout: 0 },
    classificationRevision: `revision-${index}`,
    preview: raster(inscriptionId),
  };
}

function rig(options: { cache?: MemoryWalletCache; budgetBytes?: number } = {}) {
  const cache = options.cache ?? new MemoryWalletCache();
  let now = 100;
  let nonce = 1;
  const service = createDurableGalleryPreviewCache({
    cache,
    network: 'signet',
    random: (length) => {
      const bytes = new Uint8Array(length);
      new DataView(bytes.buffer).setUint32(0, nonce++, false);
      return bytes;
    },
    now: () => now,
    ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes }),
  });
  return { cache, service, advance: () => { now += 25; } };
}

describe('durable encrypted gallery preview cache', () => {
  it('survives a service relaunch and a later unlock with the same vault DEK', async () => {
    const first = rig();
    const candidate = input('b');
    await first.service.merge(dek, vaultId, accountId, [candidate]);

    const reopened = rig({ cache: first.cache });
    const reopenedDek = new Uint8Array(dek);
    expect((await reopened.service.load(
      reopenedDek,
      vaultId,
      accountId,
      [candidate],
    )).get(candidate.inscriptionId)).toEqual(candidate.preview);
  });

  it.each([
    ['satpoint', (candidate: ReturnType<typeof input>) => ({
      ...candidate,
      satpoint: `${'f'.repeat(64)}:0:0`,
    })],
    ['outpoint txid', (candidate: ReturnType<typeof input>) => ({
      ...candidate,
      outpoint: { ...candidate.outpoint, txid: 'f'.repeat(64) },
    })],
    ['outpoint vout', (candidate: ReturnType<typeof input>) => ({
      ...candidate,
      outpoint: { ...candidate.outpoint, vout: 1 },
    })],
    ['classification revision', (candidate: ReturnType<typeof input>) => ({
      ...candidate,
      classificationRevision: 'changed-revision',
    })],
  ])('refuses a cached preview after its %s changes', async (_label, change) => {
    const r = rig();
    const candidate = input('c');
    await r.service.merge(dek, vaultId, accountId, [candidate]);

    expect((await r.service.load(dek, vaultId, accountId, [change(candidate)])).size).toBe(0);
  });

  it('isolates vaults and accounts and clears only the requested account', async () => {
    const r = rig();
    const first = input('a');
    const second = input('b');
    const otherAccount = `acct_signet_${'b'.repeat(64)}`;
    await r.service.merge(dek, vaultId, accountId, [first]);
    await r.service.merge(dek, vaultId, otherAccount, [second]);

    expect((await r.service.load(dek, 'other-vault', accountId, [first])).size).toBe(0);
    expect((await r.service.load(dek, vaultId, otherAccount, [first])).size).toBe(0);

    await r.service.clearAccount(vaultId, accountId);
    expect((await r.service.load(dek, vaultId, accountId, [first])).size).toBe(0);
    expect((await r.service.load(dek, vaultId, otherAccount, [second])).size).toBe(1);
  });

  it('stores only ciphertext and self-repairs corruption or the wrong DEK', async () => {
    const r = rig();
    const candidate = input('d');
    await r.service.merge(dek, vaultId, accountId, [candidate]);
    const storedKeys = await r.cache.listKeys(vaultId, 'signet', 'gallery');
    const storedKey = storedKeys.find((key) => key.startsWith(`preview-item:${accountId}:`));
    if (!storedKey) throw new Error('missing opaque preview slot');
    expect(storedKey).not.toContain(candidate.inscriptionId);
    const key = {
      vaultId,
      network: 'signet' as const,
      type: 'gallery' as const,
      key: storedKey,
    };
    const record = await r.cache.get(key);
    if (!record) throw new Error('missing sealed preview record');
    expect(JSON.stringify(record)).not.toContain(candidate.preview.bytesBase64);

    await r.cache.put({
      ...record,
      box: {
        ...record.box,
        ciphertextB64: `${record.box.ciphertextB64[0] === 'A' ? 'B' : 'A'}${
          record.box.ciphertextB64.slice(1)}`,
      },
    });
    expect((await r.service.load(dek, vaultId, accountId, [candidate])).size).toBe(0);

    await r.service.merge(dek, vaultId, accountId, [candidate]);
    expect((await r.service.load(
      new Uint8Array(32).fill(9),
      vaultId,
      accountId,
      [candidate],
    )).size).toBe(0);
  });

  it('evicts the least-recently-used preview at the byte budget', async () => {
    const measure = rig();
    const first = input('a');
    await measure.service.merge(dek, vaultId, accountId, [first]);
    const measuredKeys = await measure.cache.listKeys(vaultId, 'signet', 'gallery');
    const measuredKey = measuredKeys.find((key) => key.startsWith(`preview-item:${accountId}:`));
    if (!measuredKey) throw new Error('missing measured preview slot');
    const stored = await measure.cache.get({
      vaultId,
      network: 'signet',
      type: 'gallery',
      key: measuredKey,
    });
    if (!stored) throw new Error('missing measured preview');

    const r = rig({ budgetBytes: stored.box.ciphertextB64.length + 8 });
    const second = input('b');
    await r.service.merge(dek, vaultId, accountId, [first]);
    r.advance();
    await r.service.merge(dek, vaultId, accountId, [second]);

    const loaded = await r.service.load(dek, vaultId, accountId, [first, second]);
    expect([...loaded.keys()]).toEqual([second.inscriptionId]);
  });

  it('enforces the item cap even when the byte budget has room', async () => {
    const r = rig();
    const inputs = Array.from(
      { length: GALLERY_DURABLE_PREVIEW_MAX_ITEMS + 1 },
      (_unused, index) => numberedInput(index + 1),
    );
    await r.service.merge(dek, vaultId, accountId, inputs);

    const keys = await r.cache.listKeys(vaultId, 'signet', 'gallery');
    expect(keys.filter((key) => key.startsWith(`preview-item:${accountId}:`)))
      .toHaveLength(GALLERY_DURABLE_PREVIEW_MAX_ITEMS);
    const loaded = await r.service.load(dek, vaultId, accountId, [inputs[0]!, inputs.at(-1)!]);
    expect(loaded.has(inputs[0]!.inscriptionId)).toBe(false);
    expect(loaded.has(inputs.at(-1)!.inscriptionId)).toBe(true);
  });

  it('persists settled badges but never pending or unavailable placeholders', async () => {
    const r = rig();
    const candidate = input('e');
    const badge: InscriptionPreviewPayload = {
      disposition: 'mediaBadge',
      reason: null,
      requestedInscriptionId: candidate.inscriptionId,
      sourceInscriptionId: candidate.inscriptionId,
      resolvedInscriptionId: candidate.inscriptionId,
      delegateInscriptionId: null,
      sourceContentSha256: null,
      declaredMime: 'video/mp4',
      declaredContentLength: 1234,
      detectedMime: null,
      detectedFormat: null,
      sourceContentLength: null,
      mediaKind: 'video',
      pngSha256: null,
      pngWidth: null,
      pngHeight: null,
      pngByteLength: null,
      policyRevision: 'm9p-preview-v3',
      rendererRevision: 'renderer-1',
      bytesBase64: null,
    };
    await r.service.merge(dek, vaultId, accountId, [{ ...candidate, preview: badge }]);
    expect((await r.service.load(dek, vaultId, accountId, [candidate]))
      .get(candidate.inscriptionId)).toMatchObject({ disposition: 'mediaBadge' });

    const pending: InscriptionPreviewPayload = {
      disposition: 'placeholder',
      reason: 'render_pending',
      requestedInscriptionId: candidate.inscriptionId,
      sourceInscriptionId: candidate.inscriptionId,
      resolvedInscriptionId: candidate.inscriptionId,
      delegateInscriptionId: null,
      sourceContentSha256: null,
      declaredMime: 'text/html',
      declaredContentLength: 24,
      detectedMime: null,
      detectedFormat: null,
      sourceContentLength: null,
      pngSha256: null,
      pngWidth: null,
      pngHeight: null,
      pngByteLength: null,
      policyRevision: 'm9p-preview-v3',
      rendererRevision: 'renderer-1',
      bytesBase64: null,
    };
    const other = input('f');
    await r.service.merge(dek, vaultId, accountId, [{ ...other, preview: pending }]);
    expect((await r.service.load(dek, vaultId, accountId, [other])).size).toBe(0);
  });
});
