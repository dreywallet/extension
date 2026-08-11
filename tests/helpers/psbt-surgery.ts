/**
 * Byte-level PSBT map surgery, for modelling what a third-party signer emits
 * (Workstream C5 compatibility probe).
 *
 * `@scure/btc-signer` will not build most of these shapes: it emits the fields
 * it understands, in its own order, and normalizes as it goes. That is fine for
 * a well-behaved library and useless for asking "would core accept the PSBT a
 * real device actually produced?" — the interesting cases are precisely the
 * ones a well-behaved library will not construct. So this operates on the wire
 * bytes: parse the maps, edit them as key/value lists, and write them back.
 *
 * It deliberately does no validation. Producing an invalid PSBT is often the
 * point.
 */
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';

const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);

export interface PsbtEntry {
  key: Uint8Array;
  value: Uint8Array;
}

export interface PsbtMaps {
  global: PsbtEntry[];
  inputs: PsbtEntry[][];
  outputs: PsbtEntry[][];
}

function readCompactSize(bytes: Uint8Array, cursor: { offset: number }): number {
  const prefix = bytes[cursor.offset++]!;
  if (prefix < 0xfd) return prefix;
  const width = prefix === 0xfd ? 2 : prefix === 0xfe ? 4 : 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset + cursor.offset, width);
  const value =
    width === 2 ? view.getUint16(0, true) : width === 4 ? view.getUint32(0, true) : Number(view.getBigUint64(0, true));
  cursor.offset += width;
  return value;
}

function writeCompactSize(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, (value >> 8) & 0xff);
  return Uint8Array.of(
    0xfe,
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  );
}

function readMap(bytes: Uint8Array, cursor: { offset: number }): PsbtEntry[] {
  const entries: PsbtEntry[] = [];
  for (;;) {
    const keyLength = readCompactSize(bytes, cursor);
    if (keyLength === 0) return entries;
    const key = bytes.slice(cursor.offset, cursor.offset + keyLength);
    cursor.offset += keyLength;
    const valueLength = readCompactSize(bytes, cursor);
    const value = bytes.slice(cursor.offset, cursor.offset + valueLength);
    cursor.offset += valueLength;
    entries.push({ key, value });
  }
}

export function parsePsbtMaps(psbtHex: string, inputCount: number, outputCount: number): PsbtMaps {
  const bytes = hexToBytes(psbtHex);
  const cursor = { offset: PSBT_MAGIC.length };
  const global = readMap(bytes, cursor);
  const inputs = Array.from({ length: inputCount }, () => readMap(bytes, cursor));
  const outputs = Array.from({ length: outputCount }, () => readMap(bytes, cursor));
  return { global, inputs, outputs };
}

function serializeMap(entries: readonly PsbtEntry[]): number[] {
  const out: number[] = [];
  for (const { key, value } of entries) {
    out.push(...writeCompactSize(key.length), ...key);
    out.push(...writeCompactSize(value.length), ...value);
  }
  out.push(0x00);
  return out;
}

export function serializePsbtMaps(maps: PsbtMaps): string {
  const out: number[] = [...PSBT_MAGIC];
  out.push(...serializeMap(maps.global));
  for (const map of maps.inputs) out.push(...serializeMap(map));
  for (const map of maps.outputs) out.push(...serializeMap(map));
  return bytesToHex(Uint8Array.from(out));
}

/** Rewrite one PSBT through an editor over its parsed maps. */
export function editPsbt(
  psbtHex: string,
  shape: { inputCount: number; outputCount: number },
  edit: (maps: PsbtMaps) => void,
): string {
  const maps = parsePsbtMaps(psbtHex, shape.inputCount, shape.outputCount);
  edit(maps);
  return serializePsbtMaps(maps);
}

/** The entries of one BIP174 key type, in the order they appear on the wire. */
export function entriesOfType(map: readonly PsbtEntry[], type: number): PsbtEntry[] {
  return map.filter(({ key }) => key[0] === type);
}
