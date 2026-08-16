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

export interface OrdinalBatchSelectionDraft {
  inscriptionId: string;
  outpoint: { txid: string; vout: number };
  satpoint: string;
  classificationRevision: string;
  presentation?: OrdinalActionPresentation | undefined;
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
      kind: 'ordinal_batch_transfer';
      account: number;
      selections: OrdinalBatchSelectionDraft[];
    }
  | {
      kind: 'ordinal_postage_manage';
      account: number;
      selection: OrdinalBatchSelectionDraft;
    }
  | {
      kind: 'rescue' | 'ordinal_sweep';
      outpoint: { txid: string; vout: number };
      presentation?: OrdinalActionPresentation | undefined;
    };
