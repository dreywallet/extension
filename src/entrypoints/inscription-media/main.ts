import './media.css';

const INSCRIPTION_ID = /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/mpeg', 'audio/ogg', 'audio/wav',
  'video/mp4', 'video/webm', 'text/plain', 'application/json',
]);
const root = document.getElementById('media');
let objectUrl: string | null = null;

function matchesMagic(bytes: Uint8Array, mime: string): boolean {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  if (mime === 'image/png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .every((byte, index) => bytes[index] === byte);
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
  if (mime === 'image/gif') return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
  if (mime === 'audio/ogg') return ascii(0, 4) === 'OggS';
  if (mime === 'audio/wav') return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE';
  if (mime === 'audio/mpeg') return ascii(0, 3) === 'ID3' ||
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
  if (mime === 'video/mp4') return ascii(4, 4) === 'ftyp';
  if (mime === 'video/webm') return [0x1a, 0x45, 0xdf, 0xa3]
    .every((byte, index) => bytes[index] === byte);
  if (mime === 'text/plain' || mime === 'application/json') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (bytes.length > 256 * 1024 || text.length === 0 ||
          bytes.some((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
            byte === 0x7f)) return false;
      if (mime === 'application/json') {
        JSON.parse(text);
      }
      return true;
    } catch { return false; }
  }
  return false;
}

async function render(event: MessageEvent<unknown>): Promise<void> {
  if (event.source !== window.parent || !root) return;
  const value = event.data;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (message['type'] !== 'drey:verified-inscription-media' || message['protocolVersion'] !== 1 ||
      typeof message['inscriptionId'] !== 'string' || !INSCRIPTION_ID.test(message['inscriptionId']) ||
      typeof message['contentType'] !== 'string' || !ALLOWED_MIMES.has(message['contentType']) ||
      typeof message['contentSha256'] !== 'string' || !HEX_64.test(message['contentSha256']) ||
      typeof message['contentByteLength'] !== 'number' || !Number.isSafeInteger(message['contentByteLength']) ||
      message['contentByteLength'] < 1 || message['contentByteLength'] > MAX_BYTES ||
      typeof message['bytesBase64'] !== 'string' || !BASE64.test(message['bytesBase64'])) return;
  const bytes = Uint8Array.from(atob(message['bytesBase64']), (character) => character.charCodeAt(0));
  if (bytes.length !== message['contentByteLength'] || !matchesMagic(bytes, message['contentType'])) return;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== message['contentSha256']) return;

  if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if (message['contentType'] === 'text/plain' || message['contentType'] === 'application/json') {
    const pre = document.createElement('pre');
    const text = new TextDecoder().decode(bytes);
    if (message['contentType'] === 'application/json') {
      // Verified parseable above; pretty-print for reading, never execution.
      try {
        pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        pre.textContent = text;
      }
    } else {
      pre.textContent = text;
    }
    root.replaceChildren(pre);
    return;
  }
  objectUrl = URL.createObjectURL(new Blob([bytes], { type: message['contentType'] }));
  const element = message['contentType'].startsWith('image/')
    ? document.createElement('img')
    : message['contentType'].startsWith('audio/')
      ? document.createElement('audio')
      : document.createElement('video');
  element.setAttribute('aria-label', `Verified media for inscription ${message['inscriptionId']}`);
  element.src = objectUrl;
  if (element instanceof HTMLMediaElement) {
    element.controls = true;
    element.autoplay = false;
    element.preload = 'metadata';
  }
  root.replaceChildren(element);
}

window.addEventListener('message', (event) => { void render(event); }, { passive: true });
window.addEventListener('pagehide', () => {
  if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  root?.replaceChildren();
});
