import type { ApprovalSnapshot } from '../../src/provider/approval';
import { bip322MessageHash } from '@drey/core/domain/transactions/bip322';
import { createProviderPsbtApprovalExplanation } from
  '@drey/core/domain/transactions/provider-psbt-approval';
import { bytesToHex } from '@drey/core/domain/vault/encoding';

// Isolation marker: production builds are audited to prove this gallery-only
// fixture text never enters the browser extension artifact.
export const APPROVAL_GALLERY_ISOLATION_MARKER = 'DREY_APPROVAL_GALLERY_ONLY';

const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

function messageHash(message: string): string {
  return bytesToHex(bip322MessageHash(new TextEncoder().encode(message)));
}

export interface ApprovalGalleryScenario {
  id: string;
  label: string;
  description: string;
  snapshot: ApprovalSnapshot;
  providerError?: string;
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

function psbtReview(input: {
  authorization?: 'complete' | 'partial';
  feeSats?: string;
  walletInputSats?: string;
  walletOutputSats?: string;
  externalOutputSats?: string;
  netWalletDebitSats?: string;
  outputs?: Array<{
    index: number;
    address: string | null;
    valueSats: string;
    ownership: 'wallet' | 'external' | 'unproven';
    role: 'recipient' | 'payment_change' | 'ordinal_change' | 'postage' | 'unknown';
    committed: boolean;
  }>;
}) {
  return {
    kind: 'transaction' as const,
    ...identity,
    authorization: input.authorization ?? 'complete',
    feeSats: input.feeSats ?? '600',
    walletInputSats: input.walletInputSats ?? '100000',
    walletOutputSats: input.walletOutputSats ?? '49400',
    externalOutputSats: input.externalOutputSats ?? '50000',
    netWalletDebitSats: input.netWalletDebitSats ?? '50600',
    economicClaims: [],
    outputs: input.outputs ?? [
      { index: 0, address: 'Preview recipient · P2WPKH', valueSats: '50000',
        ownership: 'external' as const, role: 'recipient' as const, committed: true },
      { index: 1, address: 'Preview wallet change', valueSats: '49400',
        ownership: 'wallet' as const, role: 'payment_change' as const, committed: true },
    ],
  };
}

function approvalExplanation(input: {
  intent?: 'send_btc' | 'list_inscription' | 'custom_transaction';
  walletInputSats?: string;
  walletOutputSats?: string;
  guaranteedWalletReturnSats?: string;
  guaranteedProceedsSats?: string;
  maximumWalletDebitSats?: string;
  sighashes?: Array<{
    inputIndex: number;
    raw: 0 | 1 | 3 | 129 | 131;
    name: 'DEFAULT' | 'ALL' | 'SINGLE' | 'ALL|ANYONECANPAY' | 'SINGLE|ANYONECANPAY';
    inputSet: 'fixed' | 'changeable';
    outputs: 'all' | 'corresponding';
    correspondingOutputIndex: number | null;
    fee: 'fixed' | 'changeable';
  }>;
  outputs?: Array<{
    valueSats: string;
    address: string | null;
    ownership: 'wallet' | 'external';
    role: 'recipient' | 'payment_change' | 'ordinal_change' | 'postage' | 'data' | 'unknown';
    commitment: 'fixed' | 'changeable';
  }>;
  assetMovements?: Array<{
    inscriptionId: string;
    inputIndex: number;
    outputIndex: number;
    movement: 'received' | 'sent' | 'retained';
    destinationAddress: string | null;
    guaranteed: boolean;
  }>;
}) {
  const sighashes = input.sighashes ?? [{
    inputIndex: 0, raw: 1 as const, name: 'ALL' as const, inputSet: 'fixed' as const,
    outputs: 'all' as const, correspondingOutputIndex: null, fee: 'fixed' as const,
  }];
  const outputs = input.outputs ?? [
    { valueSats: '50000', address: 'Preview recipient', ownership: 'external' as const,
      role: 'recipient' as const, commitment: 'fixed' as const },
    { valueSats: '49400', address: 'Preview wallet change', ownership: 'wallet' as const,
      role: 'payment_change' as const, commitment: 'fixed' as const },
  ];
  const inputCount = Math.max(...sighashes.map((item) => item.inputIndex)) + 1;
  const walletInputSats = BigInt(input.walletInputSats ?? '100000');
  const inputShare = walletInputSats / BigInt(inputCount);
  const accountId = `acct_mainnet_${'ab'.repeat(32)}`;
  const derivation = (index: number, chain: 0 | 1) => ({
    accountId,
    account: 0,
    lane: 'payment' as const,
    chain,
    index,
    path: `m/84'/0'/0'/${chain}/${index}`,
    publicKeyHex: `02${String(index + 1).padStart(2, '0').repeat(32)}`,
  });
  const explanation = createProviderPsbtApprovalExplanation({
    selectedInputIndexes: sighashes.map((item) => item.inputIndex),
    inputs: Array.from({ length: inputCount }, (_unused, index) => {
      const declared = sighashes.find((item) => item.inputIndex === index);
      if (!declared) throw new Error('approval gallery sighash indexes must be contiguous');
      return {
        valueSats: index === inputCount - 1
          ? walletInputSats - inputShare * BigInt(inputCount - 1)
          : inputShare,
        ownership: 'wallet' as const,
        derivation: derivation(index, 0),
        sighash: declared.raw,
        classification: {
          inscriptions: (input.assetMovements ?? [])
            .filter((movement) => movement.inputIndex === index)
            .map((movement) => ({ inscriptionId: movement.inscriptionId })),
        },
      };
    }),
    outputs: outputs.map((output, index) => ({
      valueSats: BigInt(output.valueSats),
      scriptPubKey: `0014${String(index + 1).padStart(2, '0').repeat(20)}`,
      scriptType: 'p2wpkh' as const,
      address: output.address,
      role: output.role,
      ...(output.ownership === 'wallet' ? { derivation: derivation(index, 1) } : {}),
    })),
    protectedSatFlow: [],
    inscriptionEffects: (input.assetMovements ?? []).map((movement) => ({
      inscriptionId: movement.inscriptionId,
      inputIndex: movement.inputIndex,
      outputIndex: movement.outputIndex,
      movement: movement.movement,
    })),
    analysisWarnings: [],
    feeRateSatPerKvB: 5_000n,
    rbf: true,
    broadcast: false,
    ...(input.intent === 'list_inscription' ? { marketplaceAction: 'list' } : {}),
    genericListing: input.intent === 'list_inscription',
    ...(input.guaranteedProceedsSats === undefined ? {} : {
      guaranteedProceedsSats: BigInt(input.guaranteedProceedsSats),
    }),
  });
  const expected = {
    currentWalletOutputSats: input.walletOutputSats,
    guaranteedWalletReturnSats: input.guaranteedWalletReturnSats,
    maximumWalletDebitSats: input.maximumWalletDebitSats,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && explanation[key as keyof typeof expected] !== value) {
      throw new Error(`approval gallery ${key} differs from the shared core explanation`);
    }
  }
  return explanation;
}

const LONG_TAPROOT_ADDRESS =
  'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38';
const PAYMENT_ADDRESS = 'bc1qexamplepaymentaddress0000000000000000000000000';
const ORDINAL_ADDRESS = LONG_TAPROOT_ADDRESS;
const PAYMENT_PROOF = 'Sign in to ORD.NET\nPurpose: payment address\nNonce: 8bf1b1f09e2a4d4c';
const ORDINAL_PROOF = 'Sign in to ORD.NET\nPurpose: Ordinals address\nNonce: 8bf1b1f09e2a4d4c';

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
    id: 'p2wpkh-all',
    label: 'P2WPKH · ALL',
    description: 'A fully committed payment with change and a normal fee.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000002',
      'signPsbt',
      'https://preview.example',
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
        approvalModelVersion: 1,
        approvalExplanation: approvalExplanation({
          walletInputSats: '130000', walletOutputSats: '79589',
          guaranteedWalletReturnSats: '79589', maximumWalletDebitSats: '50411',
          outputs: [
            { valueSats: '50000', address: 'bc1q8y4n0rmalpayment000000000000000000000example',
              ownership: 'external', role: 'recipient', commitment: 'fixed' },
            { valueSats: '79589', address: 'bc1qpreviewchange000000000000000000000000example',
              ownership: 'wallet', role: 'payment_change', commitment: 'fixed' },
          ],
        }),
        feeSats: '411',
        feeRateSatPerVb: '5',
        security: { protectedValueExposedToFees: '0', psbtHash: '10'.repeat(32), psbtBytes: 5 },
        inputs: [{
          index: 0,
          outpoint: `${'aa'.repeat(32)}:0`,
          valueSats: '130000',
          ownership: 'wallet',
          classification: 'cardinal',
          sighash: 1,
        }],
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
        warnings: [],
        effectCount: 0,
        inscriptions: [],
        requiresPreviewAcknowledgement: false,
        signingInputs: [{ index: 0, script: 'p2wpkh', sighash: 1 }],
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
    id: 'message-batch',
    label: 'Message batch',
    description: 'One easy review for payment and Ordinals address proofs.',
    snapshot: request(
      '10000000-0000-4000-8000-000000000008',
      'signMultipleMessages',
      'https://ord.example',
      {
        kind: 'message_batch',
        ...identity,
        messageCount: 2,
        totalMessageBytes: new TextEncoder().encode(PAYMENT_PROOF).length +
          new TextEncoder().encode(ORDINAL_PROOF).length,
        messages: [
          {
            index: 0,
            address: PAYMENT_ADDRESS,
            addressKind: 'payment',
            message: PAYMENT_PROOF,
            messageBytes: new TextEncoder().encode(PAYMENT_PROOF).length,
            messageHash: messageHash(PAYMENT_PROOF),
            protocol: 'BIP322',
          },
          {
            index: 1,
            address: ORDINAL_ADDRESS,
            addressKind: 'ordinals',
            message: ORDINAL_PROOF,
            messageBytes: new TextEncoder().encode(ORDINAL_PROOF).length,
            messageHash: messageHash(ORDINAL_PROOF),
            protocol: 'BIP322',
          },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        messageBatch: {
          messageCount: 2,
          totalMessageBytes: new TextEncoder().encode(PAYMENT_PROOF).length +
            new TextEncoder().encode(ORDINAL_PROOF).length,
          batchHash: '83'.repeat(32),
          items: [
            { index: 0, address: PAYMENT_ADDRESS, addressKind: 'payment',
              messageBytes: new TextEncoder().encode(PAYMENT_PROOF).length,
              messageHash: messageHash(PAYMENT_PROOF), protocol: 'BIP322' },
            { index: 1, address: ORDINAL_ADDRESS, addressKind: 'ordinals',
              messageBytes: new TextEncoder().encode(ORDINAL_PROOF).length,
              messageHash: messageHash(ORDINAL_PROOF), protocol: 'BIP322' },
          ],
        },
      },
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
        approvalModelVersion: 1,
        approvalExplanation: approvalExplanation({
          intent: 'list_inscription', walletInputSats: '1000', walletOutputSats: '25000',
          guaranteedWalletReturnSats: '25000', guaranteedProceedsSats: '25000',
          maximumWalletDebitSats: '0',
          sighashes: [{ inputIndex: 0, raw: 131, name: 'SINGLE|ANYONECANPAY',
            inputSet: 'changeable', outputs: 'corresponding', correspondingOutputIndex: 0,
            fee: 'changeable' }],
          outputs: [
            { valueSats: '25000', address: 'bc1qpreviewseller000000000000000000000000example',
              ownership: 'wallet', role: 'recipient', commitment: 'fixed' },
            { valueSats: '1000', address: null, ownership: 'external', role: 'unknown',
              commitment: 'changeable' },
          ],
          assetMovements: [{ inscriptionId: `${'11'.repeat(32)}i0`, inputIndex: 0,
            outputIndex: 0, movement: 'sent', destinationAddress: 'bc1qpreviewseller', guaranteed: true }],
        }),
        security: { requiresAdvanced: false, psbtHash: '20'.repeat(32), psbtBytes: 5 },
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
      { requiresPassword: false, confirmationPhrase: null },
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
        security: { protectedValueExposedToFees: '10000', psbtHash: '30'.repeat(32), psbtBytes: 7 },
      },
    ),
  },
  {
    id: 'custom',
    label: 'Custom transaction',
    description: 'An ordinary custom request with expert details available on demand.',
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
        approvalModelVersion: 1,
        approvalExplanation: approvalExplanation({
          intent: 'custom_transaction', walletInputSats: '125000', walletOutputSats: '74180',
          guaranteedWalletReturnSats: '74180', maximumWalletDebitSats: '50820',
          outputs: [
            { valueSats: '50000', address: 'bc1qadvancedrecipient000000000000000000000example',
              ownership: 'external', role: 'recipient', commitment: 'fixed' },
            { valueSats: '74180', address: 'bc1qpreviewchange000000000000000000000000example',
              ownership: 'wallet', role: 'payment_change', commitment: 'fixed' },
          ],
        }),
        security: { psbtHash: '40'.repeat(32), psbtBytes: 7 },
      },
      { requiresPassword: false, confirmationPhrase: null },
    ),
  },
  {
    id: 'p2tr-default',
    label: 'P2TR · DEFAULT',
    description: 'A normal Taproot key-path payment using SIGHASH_DEFAULT.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000001', 'signPsbt', 'https://preview.example',
      psbtReview({}),
      { fixture: APPROVAL_GALLERY_ISOLATION_MARKER, approvalModelVersion: 1,
        approvalExplanation: approvalExplanation({ sighashes: [{ inputIndex: 0, raw: 0,
          name: 'DEFAULT', inputSet: 'fixed', outputs: 'all', correspondingOutputIndex: null,
          fee: 'fixed' }] }), security: { psbtHash: '50'.repeat(32), psbtBytes: 5 },
        signingInputs: [{ index: 0, script: 'p2tr', sighash: 0 }] },
    ),
  },
  {
    id: 'all-anyonecanpay',
    label: 'ALL | ANYONECANPAY',
    description: 'The site may change other inputs and the final fee; destinations stay fixed.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000002', 'signPsbt', 'https://preview.example',
      psbtReview({}),
      { fixture: APPROVAL_GALLERY_ISOLATION_MARKER, approvalModelVersion: 1,
        approvalExplanation: approvalExplanation({ sighashes: [{ inputIndex: 0, raw: 129,
          name: 'ALL|ANYONECANPAY', inputSet: 'changeable', outputs: 'all',
          correspondingOutputIndex: null, fee: 'changeable' }] }),
        security: { psbtHash: '60'.repeat(32), psbtBytes: 5 },
        signingInputs: [{ index: 0, script: 'p2wpkh', sighash: 129 }] },
    ),
  },
  {
    id: 'single',
    label: 'SINGLE',
    description: 'One output is guaranteed; other outputs and the final fee may change.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000003', 'signPsbt', 'https://preview.example',
      psbtReview({
        authorization: 'partial', walletOutputSats: '0', externalOutputSats: '99400',
        netWalletDebitSats: '100000',
        outputs: [
          { index: 0, address: 'Guaranteed recipient', valueSats: '50000', ownership: 'external',
            role: 'recipient', committed: true },
          { index: 1, address: 'Changeable completion output', valueSats: '49400', ownership: 'unproven',
            role: 'unknown', committed: false },
        ],
      }),
      { fixture: APPROVAL_GALLERY_ISOLATION_MARKER, approvalModelVersion: 1,
        approvalExplanation: approvalExplanation({ intent: 'custom_transaction',
          walletInputSats: '100000', walletOutputSats: '0',
          guaranteedWalletReturnSats: '0', maximumWalletDebitSats: '100000',
          sighashes: [{ inputIndex: 0, raw: 3, name: 'SINGLE', inputSet: 'fixed',
            outputs: 'corresponding', correspondingOutputIndex: 0, fee: 'changeable' }],
          outputs: [
            { valueSats: '50000', address: 'Guaranteed recipient', ownership: 'external',
              role: 'recipient', commitment: 'fixed' },
            { valueSats: '49400', address: 'Changeable completion output', ownership: 'external',
              role: 'unknown', commitment: 'changeable' },
          ] }), security: { psbtHash: '70'.repeat(32), psbtBytes: 5 },
        signingInputs: [{ index: 0, script: 'p2wpkh', sighash: 3 }] },
    ),
  },
  {
    id: 'single-anyonecanpay-listing',
    label: 'SINGLE | ANYONECANPAY listing',
    description: 'A generic inscription listing with one guaranteed seller payout.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000004', 'signPsbt', 'https://preview.example',
      {
        ...psbtReview({
          authorization: 'partial', walletInputSats: '1000', walletOutputSats: '25000',
          externalOutputSats: '1000', netWalletDebitSats: '-24000',
          outputs: [
            { index: 0, address: 'Preview seller proceeds', valueSats: '25000', ownership: 'wallet',
              role: 'recipient', committed: true },
            { index: 1, address: 'Changeable completion output', valueSats: '1000', ownership: 'unproven',
              role: 'unknown', committed: false },
          ],
        }),
        economicClaims: [{ kind: 'guaranteed_proceeds' as const, valueSats: '25000' }],
      },
      { fixture: APPROVAL_GALLERY_ISOLATION_MARKER, approvalModelVersion: 1,
        approvalExplanation: approvalExplanation({ intent: 'list_inscription', walletInputSats: '1000',
          walletOutputSats: '25000', guaranteedWalletReturnSats: '25000',
          guaranteedProceedsSats: '25000', maximumWalletDebitSats: '0',
          sighashes: [{ inputIndex: 0, raw: 131, name: 'SINGLE|ANYONECANPAY',
            inputSet: 'changeable', outputs: 'corresponding', correspondingOutputIndex: 0,
            fee: 'changeable' }],
          outputs: [
            { valueSats: '25000', address: 'Preview seller proceeds', ownership: 'wallet',
              role: 'recipient', commitment: 'fixed' },
            { valueSats: '1000', address: 'Changeable completion output', ownership: 'external',
              role: 'unknown', commitment: 'changeable' },
          ],
          assetMovements: [{ inscriptionId: `${'22'.repeat(32)}i0`, inputIndex: 0,
            outputIndex: 0, movement: 'sent', destinationAddress: 'Preview seller proceeds', guaranteed: true }],
        }), security: { psbtHash: '80'.repeat(32), psbtBytes: 5 },
        genericListing: { selectedInputIndexes: [0], commitment: {
          mode: 'single_anyonecanpay', committedOutputIndexes: [0], guaranteedProceedsSats: '25000',
          feeExposureSats: '0',
        } }, signingInputs: [{ index: 0, script: 'p2tr', sighash: 131 }] },
    ),
  },
  {
    id: 'mixed-sighash',
    label: 'Mixed sighashes',
    description: 'Three selected wallet inputs with different commitment rules.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000005', 'signPsbt', 'https://preview.example',
      psbtReview({
        authorization: 'partial', walletInputSats: '150000', walletOutputSats: '99400',
        externalOutputSats: '50000', netWalletDebitSats: '50600',
        outputs: [
          { index: 0, address: 'Changeable recipient', valueSats: '30000', ownership: 'external',
            role: 'recipient', committed: false },
          { index: 1, address: 'Changeable wallet return', valueSats: '99400', ownership: 'wallet',
            role: 'payment_change', committed: false },
          { index: 2, address: 'Guaranteed corresponding output', valueSats: '20000', ownership: 'external',
            role: 'recipient', committed: true },
        ],
      }),
      { fixture: APPROVAL_GALLERY_ISOLATION_MARKER, approvalModelVersion: 1,
        approvalExplanation: approvalExplanation({ intent: 'custom_transaction',
          walletInputSats: '150000', walletOutputSats: '99400',
          guaranteedWalletReturnSats: '0', maximumWalletDebitSats: '150000',
          sighashes: [
            { inputIndex: 0, raw: 1, name: 'ALL', inputSet: 'fixed', outputs: 'all', correspondingOutputIndex: null, fee: 'fixed' },
            { inputIndex: 1, raw: 129, name: 'ALL|ANYONECANPAY', inputSet: 'changeable', outputs: 'all', correspondingOutputIndex: null, fee: 'changeable' },
            { inputIndex: 2, raw: 3, name: 'SINGLE', inputSet: 'fixed', outputs: 'corresponding', correspondingOutputIndex: 2, fee: 'changeable' },
          ],
          outputs: [
            { valueSats: '30000', address: 'Changeable recipient', ownership: 'external', role: 'recipient', commitment: 'changeable' },
            { valueSats: '99400', address: 'Changeable wallet return', ownership: 'wallet', role: 'payment_change', commitment: 'changeable' },
            { valueSats: '20000', address: 'Guaranteed corresponding output', ownership: 'external', role: 'recipient', commitment: 'fixed' },
          ],
        }), security: { psbtHash: '90'.repeat(32), psbtBytes: 5 },
        signingInputs: [
          { index: 0, script: 'p2wpkh', sighash: 1 },
          { index: 1, script: 'p2tr', sighash: 129 },
          { index: 2, script: 'p2tr', sighash: 3 },
        ] },
    ),
  },
  {
    id: 'blocked-none',
    label: 'Blocked · NONE',
    description: 'Today the provider rejects this before opening an approval window.',
    providerError: 'SIGHASH_NONE does not commit to any destination, so Drey rejects it before approval.',
    snapshot: { type: 'drey:approval:snapshot', protocolVersion: 1, request: null },
  },
  {
    id: 'transaction-batch',
    label: 'Two-transaction batch',
    description: 'Two PSBTs reviewed together with aggregate wallet and fee exposure.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000006', 'signMultipleTransactions', 'https://preview.example',
      {
        kind: 'batch', network: 'signet', account: 0, walletName: 'Preview wallet',
        transactionCount: 2, walletInputSats: '200000', walletOutputSats: '159200',
        netWalletDebitSats: '40800', feeExposureSats: '800',
        transactions: [
          { index: 0, authorization: 'complete', feeSats: '420', walletInputSats: '100000',
            walletOutputSats: '74580', externalOutputSats: '25000', netWalletDebitSats: '25420',
            economicClaims: [], outputs: [
              { index: 0, address: 'Batch recipient 1', valueSats: '25000', ownership: 'external', role: 'recipient', committed: true },
              { index: 1, address: 'Batch change 1', valueSats: '74580', ownership: 'wallet', role: 'payment_change', committed: true },
            ] },
          { index: 1, authorization: 'complete', feeSats: '380', walletInputSats: '100000',
            walletOutputSats: '84620', externalOutputSats: '15000', netWalletDebitSats: '15380',
            economicClaims: [], outputs: [
              { index: 0, address: 'Batch recipient 2', valueSats: '15000', ownership: 'external', role: 'recipient', committed: true },
              { index: 1, address: 'Batch change 2', valueSats: '84620', ownership: 'wallet', role: 'payment_change', committed: true },
            ] },
        ],
      },
      { fixture: APPROVAL_GALLERY_ISOLATION_MARKER, approvalModelVersion: 1, transactions: [
        { approvalExplanation: approvalExplanation({ walletInputSats: '100000', walletOutputSats: '74580',
            guaranteedWalletReturnSats: '74580', maximumWalletDebitSats: '25420',
            sighashes: [{ inputIndex: 0, raw: 0, name: 'DEFAULT', inputSet: 'fixed', outputs: 'all', correspondingOutputIndex: null, fee: 'fixed' }],
            outputs: [
              { valueSats: '25000', address: 'Batch recipient 1', ownership: 'external', role: 'recipient', commitment: 'fixed' },
              { valueSats: '74580', address: 'Batch change 1', ownership: 'wallet', role: 'payment_change', commitment: 'fixed' },
            ] }), security: { psbtHash: 'a0'.repeat(32), psbtBytes: 6 }, signingInputs: [{ index: 0, sighash: 0 }] },
        { approvalExplanation: approvalExplanation({ walletInputSats: '100000', walletOutputSats: '84620',
            guaranteedWalletReturnSats: '84620', maximumWalletDebitSats: '15380',
            outputs: [
              { valueSats: '15000', address: 'Batch recipient 2', ownership: 'external', role: 'recipient', commitment: 'fixed' },
              { valueSats: '84620', address: 'Batch change 2', ownership: 'wallet', role: 'payment_change', commitment: 'fixed' },
            ] }), security: { psbtHash: 'b0'.repeat(32), psbtBytes: 6 }, signingInputs: [{ index: 0, sighash: 1 }] },
      ] },
    ),
  },
  {
    id: 'deferred-fee',
    label: 'Fee added later',
    description: 'A fully committed zero-fee transaction whose package fee must be added before broadcast.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000007', 'signPsbt', 'https://preview.example',
      {
        kind: 'transaction', ...identity, authorization: 'complete', feeSats: '0',
        walletInputSats: '100000', walletOutputSats: '75000', externalOutputSats: '25000',
        netWalletDebitSats: '25000', economicClaims: [],
        outputs: [
          { index: 0, address: 'Offer funding output', valueSats: '25000',
            ownership: 'external', role: 'recipient', committed: true },
          { index: 1, address: 'Preview wallet change', valueSats: '75000',
            ownership: 'wallet', role: 'payment_change', committed: true },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        approvalModelVersion: 1,
        deferredZeroFee: true,
        approvalExplanation: approvalExplanation({
          walletInputSats: '100000', walletOutputSats: '75000',
          guaranteedWalletReturnSats: '75000', maximumWalletDebitSats: '25000',
          sighashes: [{ inputIndex: 0, raw: 0, name: 'DEFAULT', inputSet: 'fixed',
            outputs: 'all', correspondingOutputIndex: null, fee: 'fixed' }],
          outputs: [
            { valueSats: '25000', address: 'Offer funding output', ownership: 'external',
              role: 'recipient', commitment: 'fixed' },
            { valueSats: '75000', address: 'Preview wallet change', ownership: 'wallet',
              role: 'payment_change', commitment: 'fixed' },
          ],
        }),
        security: { psbtHash: 'c0'.repeat(32), psbtBytes: 6 },
        signingInputs: [{ index: 0, sighash: 0 }],
      },
    ),
  },
  {
    id: 'foundry-presale-withdrawals',
    label: 'Foundry presale withdrawals',
    description:
      'Two verified withdrawals with recipient, unlock, fee, and input-status details.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000009', 'signMultipleTransactions', 'https://foundry.example',
      {
        kind: 'batch', network: 'mainnet', account: 0, walletName: 'Preview wallet',
        transactionCount: 2, walletInputSats: '1327', walletOutputSats: '666',
        netWalletDebitSats: '661', feeExposureSats: '661',
        transactions: [
          { index: 0, authorization: 'complete', feeSats: '330', walletInputSats: '663',
            walletOutputSats: '333', externalOutputSats: '0', netWalletDebitSats: '330',
            economicClaims: [], outputs: [
              { index: 0, address: 'bc1pfoundryrecipient0', valueSats: '333',
                ownership: 'wallet', role: 'ordinal_change', committed: true },
            ] },
          { index: 1, authorization: 'complete', feeSats: '331', walletInputSats: '664',
            walletOutputSats: '333', externalOutputSats: '0', netWalletDebitSats: '331',
            economicClaims: [], outputs: [
              { index: 0, address: 'bc1pfoundryrecipient1', valueSats: '333',
                ownership: 'wallet', role: 'ordinal_change', committed: true },
            ] },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        approvalModelVersion: 1,
        transactions: [
          {
            approvalExplanation: approvalExplanation({
              walletInputSats: '663',
              walletOutputSats: '333',
              guaranteedWalletReturnSats: '333',
              maximumWalletDebitSats: '330',
              sighashes: [{ inputIndex: 0, raw: 0, name: 'DEFAULT', inputSet: 'fixed',
                outputs: 'all', correspondingOutputIndex: null, fee: 'fixed' }],
              outputs: [{ valueSats: '333', address: 'bc1pfoundryrecipient0',
                ownership: 'wallet', role: 'ordinal_change', commitment: 'fixed' }],
            }),
            security: { psbtHash: '01'.repeat(32), psbtBytes: 6 },
            signingInputs: [{ index: 0, script: 'p2tr', sighash: 0 }],
            effectCount: 0,
            inscriptions: [],
            warnings: [],
            requiresPreviewAcknowledgement: false,
            ordnetFoundryPresale: {
              recipientAddress: 'bc1pfoundryrecipient0',
              unlockAt: 1_788_098_400,
              feeReserveSats: '330',
              inputStatus: 'future_delivery',
            },
          },
          {
            approvalExplanation: approvalExplanation({
              walletInputSats: '664',
              walletOutputSats: '333',
              guaranteedWalletReturnSats: '333',
              maximumWalletDebitSats: '331',
              sighashes: [{ inputIndex: 0, raw: 0, name: 'DEFAULT', inputSet: 'fixed',
                outputs: 'all', correspondingOutputIndex: null, fee: 'fixed' }],
              outputs: [{ valueSats: '333', address: 'bc1pfoundryrecipient1',
                ownership: 'wallet', role: 'ordinal_change', commitment: 'fixed' }],
            }),
            security: { psbtHash: '02'.repeat(32), psbtBytes: 6 },
            signingInputs: [{ index: 0, script: 'p2tr', sighash: 0 }],
            effectCount: 0,
            inscriptions: [],
            warnings: [],
            requiresPreviewAcknowledgement: false,
            ordnetFoundryPresale: {
              recipientAddress: 'bc1pfoundryrecipient1',
              unlockAt: 1_784_865_600,
              feeReserveSats: '331',
              inputStatus: 'classified',
            },
          },
        ],
      },
    ),
  },
  {
    id: 'linked-listing-group',
    label: 'OMB listing · linked',
    description:
      'One approval for the verified escrow, settlement, and recovery steps.',
    snapshot: request(
      '20000000-0000-4000-8000-000000000008', 'signMultipleTransactions', 'https://omb.example',
      {
        kind: 'batch', network: 'mainnet', account: 0, walletName: 'Preview wallet',
        transactionCount: 3, walletInputSats: '30000', walletOutputSats: '69500',
        netWalletDebitSats: '500', feeExposureSats: '500', linked: true,
        maximumWalletDebitSats: '500', maximumFeeExposureSats: '500',
        branchEconomicsExact: true,
        sharedFundingConflictCount: 1,
        alternativeOutcomeGroups: [{
          settlements: [{ nodeId: 'settlement', guaranteedWalletReturnSats: '50000',
            maximumWalletDebitSats: '0' }],
          recovery: { nodeId: 'recovery', guaranteedWalletReturnSats: '9500',
            maximumWalletDebitSats: '500' },
        }],
        transactions: [
          { index: 0, authorization: 'complete', feeSats: '0', walletInputSats: '10000',
            walletOutputSats: '10000', externalOutputSats: '0', netWalletDebitSats: '0',
            economicClaims: [], outputs: [
              { index: 0, address: 'Reserved sale output', valueSats: '10000',
                ownership: 'wallet', role: 'ordinal_change', committed: true },
            ] },
          { index: 1, authorization: 'partial', feeSats: '0', walletInputSats: '10000',
            walletOutputSats: '50000', externalOutputSats: '0', netWalletDebitSats: '-40000',
            economicClaims: [], outputs: [
              { index: 0, address: 'Seller payout', valueSats: '50000', ownership: 'wallet',
                role: 'payment_change', committed: true },
            ] },
          { index: 2, authorization: 'partial', feeSats: '500', walletInputSats: '10000',
            walletOutputSats: '9500', externalOutputSats: '0', netWalletDebitSats: '500',
            economicClaims: [], outputs: [
              { index: 0, address: 'Recovered inscription', valueSats: '9500', ownership: 'wallet',
                role: 'ordinal_change', committed: true },
            ] },
        ],
      },
      {
        fixture: APPROVAL_GALLERY_ISOLATION_MARKER,
        approvalModelVersion: 1,
        transactions: [
          {
            deferredZeroFee: true,
            effectCount: 0,
            approvalExplanation: approvalExplanation({
              walletInputSats: '10000', walletOutputSats: '10000',
              guaranteedWalletReturnSats: '10000', maximumWalletDebitSats: '0',
              sighashes: [{ inputIndex: 0, raw: 0, name: 'DEFAULT', inputSet: 'fixed',
                outputs: 'all', correspondingOutputIndex: null, fee: 'fixed' }],
              outputs: [{ valueSats: '10000', address: 'Reserved sale output', ownership: 'wallet',
                role: 'ordinal_change', commitment: 'fixed' }],
            }),
            security: { psbtHash: 'd0'.repeat(32), psbtBytes: 6 }, signingInputs: [{ index: 0, sighash: 0 }],
          },
          {
            effectCount: 0,
            approvalExplanation: approvalExplanation({
              intent: 'list_inscription', walletInputSats: '10000', walletOutputSats: '50000',
              guaranteedWalletReturnSats: '50000', maximumWalletDebitSats: '0',
              sighashes: [{ inputIndex: 0, raw: 131, name: 'SINGLE|ANYONECANPAY',
                inputSet: 'changeable', outputs: 'corresponding', correspondingOutputIndex: 0,
                fee: 'changeable' }],
              outputs: [{ valueSats: '50000', address: 'Seller payout', ownership: 'wallet',
                role: 'payment_change', commitment: 'fixed' }],
            }),
            security: { psbtHash: 'e0'.repeat(32), psbtBytes: 6 }, signingInputs: [{ index: 0, sighash: 131 }],
          },
          {
            effectCount: 0,
            approvalExplanation: approvalExplanation({
              intent: 'list_inscription', walletInputSats: '10000', walletOutputSats: '9500',
              guaranteedWalletReturnSats: '9500', maximumWalletDebitSats: '500',
              sighashes: [{ inputIndex: 0, raw: 1, name: 'ALL',
                inputSet: 'fixed', outputs: 'all', correspondingOutputIndex: null,
                fee: 'fixed' }],
              outputs: [{ valueSats: '9500', address: 'Recovered inscription', ownership: 'wallet',
                role: 'ordinal_change', commitment: 'fixed' }],
            }),
            security: { psbtHash: 'f0'.repeat(32), psbtBytes: 6 }, signingInputs: [{ index: 0, sighash: 1 }],
          },
        ],
        marketplace: {
          status: 'recognized',
          id: 'ordnet',
          name: 'OMB Wiki · ord.net',
          templateId: 'omb-wiki-ordnet-list-v1',
          templateVersion: 'omb-wiki-ordnet-list-v1',
          action: 'list',
          role: 'seller',
          assetKind: 'inscription',
          step: 1,
          stepCount: 3,
          groupedStepCount: 3,
          broadcaster: 'site',
          flexible: false,
        },
      },
    ),
  },
] as const;
