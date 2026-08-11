import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_C_RECORD_MAX_BYTES,
  downloadRecoveryCRecord,
  readRecoveryCRecord,
  recoveryCRecordBytes,
} from '../../src/entrypoints/fullpage/vault/recovery-c-files';

afterEach(() => vi.restoreAllMocks());

describe('Recovery C public file boundary', () => {
  it('round-trips arbitrary binary bytes without trusting a name or MIME type', async () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 254, 255]);
    const file = new File([bytes], 'misleading.txt', { type: 'text/html' });
    await expect(readRecoveryCRecord(file)).resolves.toBe('00017f80feff');
  });

  it('rejects empty and oversized files before reading them', async () => {
    await expect(readRecoveryCRecord(new File([], 'empty'))).rejects.toBeInstanceOf(RangeError);
    const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(0)));
    const oversized = {
      size: RECOVERY_C_RECORD_MAX_BYTES + 1,
      arrayBuffer,
    } as unknown as File;
    await expect(readRecoveryCRecord(oversized)).rejects.toBeInstanceOf(RangeError);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('distinguishes filesystem read failures from the size boundary', async () => {
    const failure = new Error('device removed');
    const unreadable = {
      size: 10,
      arrayBuffer: () => Promise.reject(failure),
    } as unknown as File;
    await expect(readRecoveryCRecord(unreadable)).rejects.toBe(failure);
  });

  it('accepts only canonical bounded lowercase hex for downloads', () => {
    expect(recoveryCRecordBytes('00017f80feff')).toEqual(
      Uint8Array.from([0, 1, 127, 128, 254, 255]),
    );
    expect(() => recoveryCRecordBytes('AA')).toThrow(/canonical/u);
    expect(() => recoveryCRecordBytes('0')).toThrow(/canonical/u);
    expect(() => recoveryCRecordBytes('00'.repeat(RECOVERY_C_RECORD_MAX_BYTES + 1))).toThrow(
      /limit/u,
    );
  });

  it('downloads the exact binary record under the worker-provided name', async () => {
    const captured: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: vi.fn((blob: Blob) => {
        captured.push(blob);
        return 'blob:recovery-c-test';
      }),
      revokeObjectURL: vi.fn(),
    }));
    let name = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      name = this.download;
    });
    downloadRecoveryCRecord('00017f80feff', 'challenge.sqvb');
    expect(name).toBe('challenge.sqvb');
    expect(captured).toHaveLength(1);
    expect(new Uint8Array(await captured[0]!.arrayBuffer())).toEqual(
      Uint8Array.from([0, 1, 127, 128, 254, 255]),
    );
  });
});
