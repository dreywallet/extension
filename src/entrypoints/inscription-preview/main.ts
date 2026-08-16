import './preview.css';
import { previewObjectFit } from './fit';

const INSCRIPTION_ID = /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_RASTER_BASE64_LENGTH = 1_398_104;
const root = document.getElementById('preview');

async function renderMessage(event: MessageEvent<unknown>): Promise<void> {
  if (event.source !== window.parent || !root) return;
  const message = event.data;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return;
  const candidate = message as Record<string, unknown>;
  if (candidate['type'] !== 'drey:inert-inscription-preview' || candidate['protocolVersion'] !== 1 ||
      typeof candidate['inscriptionId'] !== 'string' || !INSCRIPTION_ID.test(candidate['inscriptionId']) ||
      typeof candidate['rasterBase64'] !== 'string' || candidate['rasterBase64'].length === 0 ||
      candidate['rasterBase64'].length > MAX_RASTER_BASE64_LENGTH || !BASE64.test(candidate['rasterBase64']) ||
      typeof candidate['pngSha256'] !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate['pngSha256']) ||
      typeof candidate['pngWidth'] !== 'number' || !Number.isSafeInteger(candidate['pngWidth']) ||
      candidate['pngWidth'] < 1 || candidate['pngWidth'] > 512 ||
      typeof candidate['pngHeight'] !== 'number' || !Number.isSafeInteger(candidate['pngHeight']) ||
      candidate['pngHeight'] < 1 || candidate['pngHeight'] > 512) return;

  const bytes = Uint8Array.from(atob(candidate['rasterBase64']), (character) => character.charCodeAt(0));
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < pngSignature.length || pngSignature.some((byte, index) => bytes[index] !== byte)) return;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== candidate['pngSha256']) return;

  const image = document.createElement('img');
  image.alt = `Inert preview for inscription ${candidate['inscriptionId']}`;
  image.decoding = 'async';
  image.src = `data:image/png;base64,${candidate['rasterBase64']}`;
  try { await image.decode(); } catch { return; }
  if (image.naturalWidth !== candidate['pngWidth'] || image.naturalHeight !== candidate['pngHeight']) return;
  // Set only alongside a preview that actually renders, so an empty frame never
  // carries a stale fill hint.
  root.dataset['fit'] = previewObjectFit(
    candidate['fit'], candidate['pngWidth'], candidate['pngHeight'],
  );
  root.replaceChildren(image);
  window.parent.postMessage({
    type: 'drey:inert-inscription-preview-ready',
    protocolVersion: 1,
    inscriptionId: candidate['inscriptionId'],
  }, '*');
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  void renderMessage(event);
}, { passive: true });
