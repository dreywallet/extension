export interface OrdinalActionPresentation {
  number: number | null;
  preview:
    | {
        kind: 'raster';
        rasterBase64: string;
        pngSha256: string;
        pngWidth: number;
        pngHeight: number;
      }
    | { kind: 'placeholder' }
    | {
        kind: 'text';
        textMime: 'text/plain' | 'application/json';
        excerpt: string;
        truncated: boolean;
      }
    | { kind: 'mediaBadge'; mediaKind: 'audio' | 'video'; contentLength: number };
}

export type OrdinalActionDraft =
  | {
      kind: 'ordinal_transfer';
      account: number;
      inscriptionId: string;
      outpoint: { txid: string; vout: number };
      presentation?: OrdinalActionPresentation | undefined;
    }
  | {
      kind: 'rescue' | 'ordinal_sweep';
      outpoint: { txid: string; vout: number };
      presentation?: OrdinalActionPresentation | undefined;
    };
