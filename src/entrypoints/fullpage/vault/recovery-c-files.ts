/** Public, bounded file transport for the offline Recovery C ceremony. */
export const RECOVERY_C_RECORD_MAX_BYTES = 65_536;

export function recoveryCRecordBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) {
    throw new Error('Recovery C record is not canonical lowercase hex');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  if (bytes.byteLength > RECOVERY_C_RECORD_MAX_BYTES) {
    throw new Error('Recovery C record exceeds the public file limit');
  }
  return bytes;
}

export function downloadRecoveryCRecord(hex: string, fileName: string): void {
  const bytes = recoveryCRecordBytes(hex);
  const url = URL.createObjectURL(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function readRecoveryCRecord(file: File): Promise<string> {
  if (file.size === 0 || file.size > RECOVERY_C_RECORD_MAX_BYTES) {
    throw new RangeError('Recovery C response file is empty or too large');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > RECOVERY_C_RECORD_MAX_BYTES) {
    throw new RangeError('Recovery C response file is empty or too large');
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
