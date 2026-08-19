import type { ApprovalSnapshot } from '../../src/provider/approval';

// Isolation marker: production builds are audited to prove this gallery-only
// fixture text never enters the browser extension artifact.
export const APPROVAL_GALLERY_ISOLATION_MARKER = 'DREY_APPROVAL_GALLERY_ONLY';

const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

export interface ApprovalGalleryScenario {
  id: string;
  label: string;
  description: string;
  snapshot: ApprovalSnapshot;
}

function request(
  nonce: string,
  method: string,
  origin: string,
  review: NonNullable<ApprovalSnapshot['request']>['review'],
  details: unknown,
  options: {
    warnings?: string[];
    requiresPassword?: boolean;
    confirmationPhrase?: string | null;
  } = {},
): ApprovalSnapshot {
  return {
    type: 'drey:approval:snapshot',
    protocolVersion: 1,
    request: {
      requestNonce: nonce,
      method,
      origin,
      unicodeOrigin: origin,
      warnings: options.warnings ?? [],
      createdAt: 1,
      expiresAt: FAR_FUTURE,
      approveAfter: 1,
      review,
      details,
      requiresPassword: options.requiresPassword ?? false,
      confirmationPhrase: options.confirmationPhrase ?? null,
      approvalError: null,
    },
  };
}

const identity = {
  walletName: 'Preview wallet',
  account: 0,
  network: 'mainnet' as const,
};

const LONG_TAPROOT_ADDRESS =
  'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38';

export const APPROVAL_GALLERY_SCENARIOS: readonly ApprovalGalleryScenario[] = [
  {
    id: 'connect',
    label: 'Connect',
    description: 'Information sharing without spending permission.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000001',
      'wallet_connect',
      'https://gallery.example',
      {
        kind: 'connection',
        ...identity,
        categories: ['account_identity', 'addresses', 'balance', 'network'],
        purposes: ['payment', 'ordinals'],
      },
      { fixture: APPROVAL_GALLERY_ISOLATION_MARKER },
    ),
  },
  {
    id: 'payment',
    label: 'Payment',
    description: 'A fully committed payment with change and a normal fee.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000002',
      'sendTransfer',
      'https://checkout.example',
      {
        kind: 'transaction',
        ...identity,
        authorization: 'complete',
        feeSats: '411',
        walletInputSats: '130000',
        walletOutputSats: '79589',
        externalOutputSats: '50000',
        netWalletDebitSats: '50411',
        economicClaims: [],
        outputs: [
          {
            index: 0,
            address: 'bc1q8y4n0rmalpayment000000000000000000000example',
            valueSats: '50000',
            ownership: 'external',
            role: 'recipient',
            committed: true,
          },
          {
            index: 1,
            address: 'bc1qpreviewchange000000000000000000000000example',
            valueSats: '79589',
            ownership: 'wallet',
            role: 'payment_change',
            committed: true,
          },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        feeSats: '411',
        feeRateSatPerVb: '5',
        security: { protectedValueExposedToFees: '0' },
      },
    ),
  },
  {
    id: 'long-message',
    label: 'Long message',
    description: 'An ORD.NET verification message containing an unbroken Taproot address.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000007',
      'signMessage',
      'https://omb.example',
      {
        kind: 'message',
        ...identity,
        address: LONG_TAPROOT_ADDRESS,
        message: [
          'ORD.NET wallet verification',
          'Domain: ord.net',
          'Address:',
          LONG_TAPROOT_ADDRESS,
          'Nonce: 82baff77fc6a6c01f04e6e9b290d30ad',
          'Issued At: 2026-08-16T20:19:47.112Z',
          'Expiration Time: 2026-08-16T20:29:47.112Z',
        ].join('\n'),
      },
      { fixture: APPROVAL_GALLERY_ISOLATION_MARKER },
    ),
  },
  {
    id: 'marketplace',
    label: 'Marketplace sale',
    description: 'Guaranteed proceeds plus a flexible, partially committed request.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000003',
      'signPsbt',
      'https://market.example',
      {
        kind: 'transaction',
        ...identity,
        authorization: 'partial',
        feeSats: '0',
        walletInputSats: '0',
        walletOutputSats: '25000',
        externalOutputSats: '0',
        netWalletDebitSats: '-25000',
        economicClaims: [
          { kind: 'guaranteed_proceeds', valueSats: '25000' },
        ],
        outputs: [
          {
            index: 0,
            address: 'bc1qpreviewseller000000000000000000000000example',
            valueSats: '25000',
            ownership: 'wallet',
            role: 'recipient',
            committed: true,
          },
          {
            index: 1,
            address: null,
            valueSats: '1000',
            ownership: 'unproven',
            role: 'unknown',
            committed: false,
          },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        security: { requiresAdvanced: false, rawPsbtHex: '70736274ff' },
        marketplace: {
          name: 'Example Market',
          action: 'list',
          role: 'seller',
          assetKind: 'inscription',
          step: 2,
          stepCount: 3,
          broadcaster: 'site',
          flexible: true,
          economics: { sellerProceedsSats: '25000' },
        },
      },
      { requiresPassword: true, confirmationPhrase: 'SIGN PSBT' },
    ),
  },
  {
    id: 'fee-warning',
    label: 'Fee warning',
    description: 'A committed payment whose fee needs extra attention.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000004',
      'sendTransfer',
      'https://payments.example',
      {
        kind: 'transaction',
        ...identity,
        authorization: 'complete',
        feeSats: '15000',
        walletInputSats: '100000',
        walletOutputSats: '35000',
        externalOutputSats: '50000',
        netWalletDebitSats: '65000',
        economicClaims: [],
        outputs: [
          {
            index: 0,
            address: 'bc1qfeewarning00000000000000000000000000example',
            valueSats: '50000',
            ownership: 'external',
            role: 'recipient',
            committed: true,
          },
          {
            index: 1,
            address: 'bc1qpreviewchange000000000000000000000000example',
            valueSats: '35000',
            ownership: 'wallet',
            role: 'payment_change',
            committed: true,
          },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        feeSats: '15000',
        feeRateSatPerVb: '160',
        warnings: [{ code: 'high_relative_fee' }, { code: 'high_absolute_fee' }],
        security: { protectedValueExposedToFees: '0' },
      },
    ),
  },
  {
    id: 'protected-fee-block',
    label: 'Protected fee block',
    description: 'A transaction Drey refuses because protected value would pay fees.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000006',
      'signPsbt',
      'https://unsafe.example',
      {
        kind: 'transaction',
        ...identity,
        authorization: 'complete',
        feeSats: '10000',
        walletInputSats: '60000',
        walletOutputSats: '0',
        externalOutputSats: '50000',
        netWalletDebitSats: '60000',
        economicClaims: [],
        outputs: [
          {
            index: 0,
            address: 'bc1qprotectedrecipient00000000000000000000example',
            valueSats: '50000',
            ownership: 'external',
            role: 'recipient',
            committed: true,
          },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        security: { protectedValueExposedToFees: '10000', rawPsbtHex: '70736274ff0101' },
      },
    ),
  },
  {
    id: 'advanced',
    label: 'Advanced PSBT',
    description: 'An arbitrary request with raw details and stronger confirmation.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000005',
      'signPsbt',
      'https://tools.example',
      {
        kind: 'transaction',
        ...identity,
        authorization: 'complete',
        feeSats: '820',
        walletInputSats: '125000',
        walletOutputSats: '74180',
        externalOutputSats: '50000',
        netWalletDebitSats: '50820',
        economicClaims: [],
        outputs: [
          {
            index: 0,
            address: 'bc1qadvancedrecipient000000000000000000000example',
            valueSats: '50000',
            ownership: 'external',
            role: 'recipient',
            committed: true,
          },
          {
            index: 1,
            address: 'bc1qpreviewchange000000000000000000000000example',
            valueSats: '74180',
            ownership: 'wallet',
            role: 'payment_change',
            committed: true,
          },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        security: { requiresAdvanced: true, rawPsbtHex: '70736274ff0100' },
      },
      { requiresPassword: true, confirmationPhrase: 'SIGN PSBT' },
    ),
  },
] as const;
