import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FixedRateUrDecoder, FixedRateUrEncoder } from '@drey/core/domain/ur/fixed-rate';
import { hexToBytes } from '@drey/core/domain/vault/encoding';

const vectors = JSON.parse(
  readFileSync(require.resolve('@drey/core/vectors/bc-ur-v2.json'), 'utf8'),
) as {
  singlePart: { type: string; cborHex: string; ur: string };
  fixedRate: { messageHex: string; minFragmentLength: number; maxFragmentLength: number };
};

describe('installed core BC-UR transport', () => {
  it('replays the published single-part vector through the shipping package', () => {
    const message = hexToBytes(vectors.singlePart.cborHex);
    const encoder = new FixedRateUrEncoder(vectors.singlePart.type, message);
    expect(encoder.frames).toEqual([vectors.singlePart.ur]);
    const decoded = new FixedRateUrDecoder({ expectedType: vectors.singlePart.type });
    expect(decoded.receive(vectors.singlePart.ur)).toEqual({
      status: 'complete',
      type: vectors.singlePart.type,
      cborMessage: message,
    });
  });

  it('reconstructs the published multipart message out of order', () => {
    const message = hexToBytes(vectors.fixedRate.messageHex);
    const encoder = new FixedRateUrEncoder('test-vector', message, {
      minFragmentLength: vectors.fixedRate.minFragmentLength,
      maxFragmentLength: vectors.fixedRate.maxFragmentLength,
    });
    const decoder = new FixedRateUrDecoder({ expectedType: 'test-vector' });
    for (const frame of [...encoder.frames].reverse()) decoder.receive(frame);
    expect(decoder.result()).toEqual({ type: 'test-vector', cborMessage: message });
  });
});
