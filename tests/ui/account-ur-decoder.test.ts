import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { UR, UREncoder } from '@ngraveio/bc-ur';
import { AccountUrFrameDecoder } from '../../src/ui/accounts/account-ur-decoder';

describe('public-account fountain QR decoder', () => {
  it('reconstructs randomized fountain frames emitted after the fixed sequence', () => {
    const payload = Uint8Array.from({ length: 600 }, (_, index) => (index * 37) & 0xff);
    const encoder = new UREncoder(
      new UR(Buffer.from(payload), 'account-descriptor'),
      80,
      100,
      20,
    );
    const decoder = new AccountUrFrameDecoder();
    let completed: ReturnType<AccountUrFrameDecoder['receive']> | undefined;
    for (let index = 0; index < 200 && completed?.status !== 'complete'; index += 1) {
      completed = decoder.receive(encoder.nextPart());
    }
    expect(completed).toEqual({
      status: 'complete',
      type: 'account-descriptor',
      cbor: payload,
    });
  });

  it('rejects a different UR session and enforces a per-frame bound', () => {
    const first = new UREncoder(new UR(Buffer.alloc(300, 1), 'account-descriptor'), 80).nextPart();
    const other = new UREncoder(new UR(Buffer.alloc(300, 2), 'crypto-account'), 80).nextPart();
    const decoder = new AccountUrFrameDecoder();
    expect(decoder.receive(first).status).toBe('progress');
    expect(() => decoder.receive(other)).toThrow(/conflicts/iu);
    expect(() => decoder.receive(`ur:bytes/${'a'.repeat(5000)}`)).toThrow(/too large/iu);
  });
});
