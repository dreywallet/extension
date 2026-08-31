import type { GatewayClient } from '@drey/core/gateway-client';
import type { Network } from '@drey/core/domain/keys/derivation';
import {
  CLASSIFY_MAX_OUTPOINTS,
  type OutpointsClassifyResponse,
  type UtxoClassification,
} from '@drey/core/domain/gateway/contract';
import { RpcError } from './errors';

type Outpoint = { txid: string; vout: number };
type EvidenceSource = Pick<
  OutpointsClassifyResponse,
  'instanceId' | 'classificationRevision' | 'coreTip' | 'indexTip'
>;

function sourceOf(response: OutpointsClassifyResponse): EvidenceSource {
  return {
    instanceId: response.instanceId,
    classificationRevision: response.classificationRevision,
    coreTip: response.coreTip,
    indexTip: response.indexTip,
  };
}

function sameTip(
  left: { height: number; hash: string },
  right: { height: number; hash: string },
): boolean {
  return left.height === right.height && left.hash === right.hash;
}

function sameSource(left: EvidenceSource, right: EvidenceSource): boolean {
  return left.instanceId === right.instanceId &&
    left.classificationRevision === right.classificationRevision &&
    sameTip(left.coreTip, right.coreTip) &&
    sameTip(left.indexTip, right.indexTip);
}

/**
 * Classify a large provider group through the gateway's bounded endpoint.
 * Every signed chunk must come from one authority snapshot, and the combined
 * response follows request order even if a gateway returns records reordered.
 */
export async function classifyProviderOutpointsChunked(input: {
  network: Network;
  requested: Outpoint[];
  classify: GatewayClient['classifyOutpoints'];
  allowUnknown?: boolean;
  guard?: () => void;
}): Promise<OutpointsClassifyResponse> {
  const requestedKeys = input.requested.map((item) => `${item.txid}:${item.vout}`);
  if (input.requested.length === 0 || new Set(requestedKeys).size !== input.requested.length) {
    throw new RpcError('ERR_DATA_STALE', 'classification request is invalid');
  }
  let first: OutpointsClassifyResponse | null = null;
  let source: EvidenceSource | null = null;
  const byOutpoint = new Map<string, UtxoClassification>();
  const unknown = new Map<string, Outpoint>();
  for (let offset = 0; offset < input.requested.length; offset += CLASSIFY_MAX_OUTPOINTS) {
    input.guard?.();
    const chunk = input.requested.slice(offset, offset + CLASSIFY_MAX_OUTPOINTS);
    const classified = await input.classify({ network: input.network, outpoints: chunk });
    input.guard?.();
    if (!classified.ok) throw new RpcError('ERR_DATA_STALE', 'classification incomplete');
    const chunkSource = sourceOf(classified.value);
    if (source !== null && !sameSource(source, chunkSource)) {
      throw new RpcError('ERR_DATA_STALE', 'classification responses changed source');
    }
    first ??= classified.value;
    source ??= chunkSource;
    const expected = new Set(chunk.map((item) => `${item.txid}:${item.vout}`));
    if ((!input.allowUnknown && classified.value.unknownOutpoints.length > 0) ||
        classified.value.classifications.length + classified.value.unknownOutpoints.length !== expected.size) {
      throw new RpcError('ERR_DATA_STALE', 'classification response incomplete');
    }
    for (const record of classified.value.classifications) {
      const key = `${record.txid}:${record.vout}`;
      if (!expected.has(key) || byOutpoint.has(key) || record.confidence !== 'authoritative' ||
          record.classificationRevision !== classified.value.classificationRevision ||
          !sameTip(record.classifiedTip, classified.value.coreTip)) {
        throw new RpcError('ERR_DATA_STALE', 'classification response is not authoritative');
      }
      byOutpoint.set(key, record);
    }
    for (const record of classified.value.unknownOutpoints) {
      const key = `${record.txid}:${record.vout}`;
      if (!expected.has(key) || byOutpoint.has(key) || unknown.has(key)) {
        throw new RpcError('ERR_DATA_STALE', 'classification response is not authoritative');
      }
      unknown.set(key, record);
    }
  }
  if (first === null || byOutpoint.size + unknown.size !== input.requested.length) {
    throw new RpcError('ERR_DATA_STALE', 'classification response incomplete');
  }
  return {
    ...first,
    classifications: input.requested.flatMap((item) => {
      const record = byOutpoint.get(`${item.txid}:${item.vout}`);
      return record ? [record] : [];
    }),
    unknownOutpoints: input.requested.flatMap((item) => {
      const record = unknown.get(`${item.txid}:${item.vout}`);
      return record ? [record] : [];
    }),
  };
}
