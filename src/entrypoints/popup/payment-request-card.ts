import { satsToBtcDecimal } from '@drey/core/domain/sats';
import encodeQR from 'qr';

export interface PaymentRequestCardModel {
  address: string;
  amountBtc: string | null;
  amountSats: string | null;
  label: string | null;
  network: 'mainnet' | 'signet' | 'regtest';
  qrValue: string;
}

export function paymentRequestCardModel(input: {
  address: string;
  amountSats?: bigint | undefined;
  label: string;
  network: 'mainnet' | 'signet' | 'regtest';
  qrValue: string;
}): PaymentRequestCardModel {
  return {
    address: input.address,
    amountBtc: input.amountSats === undefined ? null : satsToBtcDecimal(input.amountSats),
    amountSats: input.amountSats?.toString() ?? null,
    label: input.label.trim() === '' ? null : input.label.trim(),
    network: input.network,
    qrValue: input.qrValue,
  };
}

export function paymentRequestQrFits(value: string): boolean {
  try {
    encodeQR(value, 'raw', { ecc: 'medium', border: 4 });
    return true;
  } catch {
    return false;
  }
}

function wrapText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
): string[] {
  const words = value.split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      if (line !== '') lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

function drawQr(
  context: CanvasRenderingContext2D,
  value: string,
  left: number,
  top: number,
  size: number,
  background: string,
): void {
  const matrix = encodeQR(value, 'raw', { ecc: 'medium', border: 4 });
  const moduleSize = size / matrix.length;
  context.fillStyle = background;
  context.fillRect(left, top, size, size);
  context.fillStyle = '#000';
  for (let y = 0; y < matrix.length; y += 1) {
    const row = matrix[y]!;
    for (let x = 0; x < row.length; x += 1) {
      if (!row[x]) continue;
      const x0 = Math.round(left + x * moduleSize);
      const y0 = Math.round(top + y * moduleSize);
      const x1 = Math.round(left + (x + 1) * moduleSize);
      const y1 = Math.round(top + (y + 1) * moduleSize);
      context.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

/** Render a metadata-free, wallet-controlled PNG. No external content is loaded. */
export async function renderPaymentRequestPng(input: {
  model: PaymentRequestCardModel;
  accent: string;
  testNetworkWarning: string;
  title: string;
}): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('canvas-unavailable');

  const ink = '#080808';
  const paper = '#f4f4ef';
  const muted = '#575650';
  const requestedAccent = input.accent.trim().toLowerCase();
  const accent = requestedAccent === '' || requestedAccent === '#f4f4ef' || requestedAccent === '#fff'
    ? ink
    : input.accent;
  context.fillStyle = paper;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = accent;
  context.fillRect(0, 0, canvas.width, 22);
  context.strokeStyle = ink;
  context.lineWidth = 5;
  context.strokeRect(42, 42, canvas.width - 84, canvas.height - 84);

  context.fillStyle = ink;
  context.font = '900 78px Anton, Impact, sans-serif';
  context.fillText('DREY', 88, 140);
  context.font = '700 30px Inter, Arial, sans-serif';
  context.textAlign = 'right';
  if (input.model.network !== 'mainnet') context.fillText(input.testNetworkWarning, 992, 126);
  context.textAlign = 'left';
  context.font = '700 38px Inter, Arial, sans-serif';
  context.fillText(input.title, 88, 204);

  drawQr(context, input.model.qrValue, 190, 245, 700, paper);

  context.textAlign = 'center';
  context.fillStyle = ink;
  if (input.model.amountSats !== null) {
    context.font = '900 58px Anton, Impact, sans-serif';
    context.fillText(`${input.model.amountSats} sats`, 540, 1005);
    context.font = '500 30px Inter, Arial, sans-serif';
    context.fillText(`${input.model.amountBtc ?? ''} BTC`, 540, 1050);
  }

  if (input.model.label !== null) {
    context.font = '600 31px Inter, Arial, sans-serif';
    context.fillStyle = muted;
    const lines = wrapText(context, input.model.label, 860).slice(0, 2);
    lines.forEach((line, index) => context.fillText(line, 540, 1105 + index * 38));
  }

  context.fillStyle = ink;
  let addressFontSize = 25;
  context.font = `500 ${addressFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  while (context.measureText(input.model.address).width > 860 && addressFontSize > 18) {
    addressFontSize -= 1;
    context.font = `500 ${addressFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  }
  context.fillText(input.model.address, 540, 1232);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('png-unavailable'));
      else resolve(blob);
    }, 'image/png');
  });
}

export async function shareOrSavePaymentRequest(blob: Blob): Promise<'shared' | 'saved'> {
  const file = new File([blob], 'drey-bitcoin-request.png', { type: 'image/png' });
  if (typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file] });
    return 'shared';
  }
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.download = file.name;
    link.href = url;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return 'saved';
}
