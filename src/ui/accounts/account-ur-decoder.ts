import { URDecoder } from '@ngraveio/bc-ur';

const MAX_FRAME_CHARACTERS = 4096;
const MAX_UNIQUE_FRAMES = 1024;
const DEFAULT_MAX_CBOR_BYTES = 65_536;

export type AccountUrFrameResult =
  | { status: 'progress'; received: number; expected: number; percent: number }
  | { status: 'duplicate'; received: number; expected: number; percent: number }
  | { status: 'complete'; type: string; cbor: Uint8Array };

/** Bounded standards-compatible fountain decoder for public-account URs. */
export class AccountUrFrameDecoder {
  private readonly decoder = new URDecoder();
  private readonly frames = new Set<string>();

  constructor(private readonly maxCborBytes = DEFAULT_MAX_CBOR_BYTES) {}

  receive(frame: string): AccountUrFrameResult {
    if (frame.length > MAX_FRAME_CHARACTERS) throw new Error('Animated QR frame is too large.');
    const normalized = frame.toLowerCase();
    const duplicate = this.frames.has(normalized);
    if (!duplicate && this.frames.size >= MAX_UNIQUE_FRAMES) {
      throw new Error('Animated QR exceeds the local frame limit.');
    }
    this.frames.add(normalized);
    if (!this.decoder.receivePart(frame) && !duplicate) {
      throw new Error('This frame conflicts with the animated QR already being scanned.');
    }
    if (this.decoder.isError()) throw new Error(this.decoder.resultError());
    if (this.decoder.isSuccess()) {
      const ur = this.decoder.resultUR();
      const cbor = new Uint8Array(ur.cbor);
      if (cbor.length === 0 || cbor.length > this.maxCborBytes) {
        throw new Error('Animated QR is too large.');
      }
      return { status: 'complete', type: ur.type, cbor };
    }
    const expected = Math.max(this.decoder.expectedPartCount(), 1);
    const received = Math.min(this.frames.size, expected);
    const percent = Math.max(0, Math.min(1, this.decoder.estimatedPercentComplete()));
    return { status: duplicate ? 'duplicate' : 'progress', received, expected, percent };
  }
}
