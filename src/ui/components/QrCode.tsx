import { useMemo, type ReactNode } from 'react';
import encodeQR from 'qr';

type QrDrawing = {
  path: string;
  size: number;
};

function drawingFor(value: string): QrDrawing | null {
  try {
    // ISO/IEC 18004 requires a four-module quiet zone. Render the encoder's
    // raw matrix directly so extension-page CSP can remain `default-src self`
    // without allowing data: or blob: image sources.
    const matrix = encodeQR(value, 'raw', { ecc: 'medium', border: 4 });
    const path: string[] = [];
    for (let y = 0; y < matrix.length; y += 1) {
      const row = matrix[y]!;
      for (let x = 0; x < row.length;) {
        if (!row[x]) {
          x += 1;
          continue;
        }
        const start = x;
        while (row[x]) x += 1;
        path.push(`M${start} ${y}h${x - start}v1H${start}z`);
      }
    }
    return { path: path.join(''), size: matrix.length };
  } catch {
    return null;
  }
}

/**
 * CSP-independent QR rendering for wallet-controlled addresses/BIP-321 URIs
 * (§10.6). The encoder's boolean matrix becomes one inert SVG path; no SVG
 * markup is parsed and no image source is loaded.
 */
export function QrCode(props: { value: string; alt: string; errorText?: string; size?: number }): ReactNode {
  const { value, alt, size = 180 } = props;
  const drawing = useMemo(() => drawingFor(value), [value]);
  if (drawing === null) return <p role="alert">{props.errorText ?? alt}</p>;
  // QR modules must stay dark-on-light for scanners regardless of the UI
  // palette. The encoded four-module quiet zone is sufficient, so avoid adding
  // a second border or padding layer around it.
  return (
    <svg
      role="img"
      aria-label={alt}
      focusable="false"
      width={size}
      height={size}
      viewBox={`0 0 ${drawing.size} ${drawing.size}`}
      shapeRendering="crispEdges"
      style={{ alignSelf: 'center' }}
    >
      <rect width={drawing.size} height={drawing.size} fill="#fff" />
      <path d={drawing.path} fill="#000" />
    </svg>
  );
}
