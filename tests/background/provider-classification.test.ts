import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GatewayClient } from '@drey/core/gateway-client';
import {
  statusCapabilitiesSchema,
  type UtxoClassification,
} from '@drey/core/domain/gateway/contract';
import { classifyProviderOutpointsChunked } from '../../src/background/provider-classification';
import { coreFixturesDir } from '../helpers/core-fixtures';

const status = statusCapabilitiesSchema.parse(JSON.parse(readFileSync(
  join(coreFixturesDir, 'gateway', 'status.signed.json'),
  'utf8',
)));

function classification(
  txid: string,
  vout: number,
  evidence = status,
): UtxoClassification {
  return {
    txid,
    vout,
    valueSats: '10000',
    scriptPubKey: `0014${'11'.repeat(20)}`,
    confirmations: 10,
    primaryClass: 'cardinal_clean',
    inscriptions: [],
    satRanges: null,
    unsupportedAssetDetected: false,
    confidence: 'authoritative',
    classifiedTip: evidence.coreTip,
    classificationRevision: evidence.activeRevision,
  };
}

describe('provider group classification', () => {
  it('classifies 500 roots in three stable chunks and restores requested order', async () => {
    const requested = Array.from({ length: 500 }, (_, index) => ({
      txid: index.toString(16).padStart(64, '0'),
      vout: index % 3,
    }));
    const calls: Array<Array<{ txid: string; vout: number }>> = [];
    const classify = (async (request: {
      outpoints: Array<{ txid: string; vout: number }>;
    }) => {
      calls.push(request.outpoints);
      return {
        ok: true as const,
        value: {
          ...status,
          classifications: [...request.outpoints].reverse().map((outpoint) =>
            classification(outpoint.txid, outpoint.vout)),
          unknownOutpoints: [],
        },
        verifiedAtMs: Date.parse(status.timestamp),
      };
    }) as GatewayClient['classifyOutpoints'];

    const combined = await classifyProviderOutpointsChunked({
      network: 'signet', requested, classify,
    });

    expect(calls.map((chunk) => chunk.length)).toEqual([200, 200, 100]);
    expect(calls.flat()).toEqual(requested);
    expect(combined.classifications.map(({ txid, vout }) => ({ txid, vout })))
      .toEqual(requested);
  });

  it('rejects chunks signed against different source evidence', async () => {
    const requested = Array.from({ length: 201 }, (_, index) => ({
      txid: index.toString(16).padStart(64, '0'),
      vout: 0,
    }));
    let calls = 0;
    const classify = (async (request: {
      outpoints: Array<{ txid: string; vout: number }>;
    }) => {
      calls += 1;
      const evidence = calls === 1 ? status : { ...status, instanceId: 'changed-instance' };
      return {
        ok: true as const,
        value: {
          ...evidence,
          classifications: request.outpoints.map((outpoint) =>
            classification(outpoint.txid, outpoint.vout, evidence)),
          unknownOutpoints: [],
        },
        verifiedAtMs: Date.parse(status.timestamp),
      };
    }) as GatewayClient['classifyOutpoints'];

    await expect(classifyProviderOutpointsChunked({
      network: 'signet', requested, classify,
    })).rejects.toMatchObject({ code: 'ERR_DATA_STALE' });
    expect(calls).toBe(2);
  });

  it('preserves explicitly unknown future inputs only when the caller opts in', async () => {
    const requested = [
      { txid: 'aa'.repeat(32), vout: 0 },
      { txid: 'bb'.repeat(32), vout: 1 },
      { txid: 'cc'.repeat(32), vout: 2 },
    ];
    const classify = (async () => ({
      ok: true as const,
      value: {
        ...status,
        classifications: [classification(requested[1]!.txid, requested[1]!.vout)],
        unknownOutpoints: [requested[2]!, requested[0]!],
      },
      verifiedAtMs: Date.parse(status.timestamp),
    })) as GatewayClient['classifyOutpoints'];

    await expect(classifyProviderOutpointsChunked({
      network: 'mainnet', requested, classify,
    })).rejects.toMatchObject({ code: 'ERR_DATA_STALE' });
    await expect(classifyProviderOutpointsChunked({
      network: 'mainnet', requested, classify, allowUnknown: true,
    })).resolves.toMatchObject({
      classifications: [{ txid: requested[1]!.txid, vout: requested[1]!.vout }],
      unknownOutpoints: [requested[0], requested[2]],
    });
  });
});
