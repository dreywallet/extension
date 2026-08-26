import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { SigHash, Transaction } from '@scure/btc-signer';
import type { Page } from '@playwright/test';

const gatewayRoot = path.resolve(import.meta.dirname, '../../../gateway');
const gatewayState = path.join(gatewayRoot, 'regtest/.state');
const regtestControllerPath = path.join(gatewayRoot, 'regtest/control.mjs');
const rpcAuthPath = path.join(gatewayState, 'secrets/core-rpc.auth');
const gatewayPublicKeyPath = path.join(gatewayState, 'response-signing.pub');
const regtestProject = process.env.DREY_REGTEST_PROJECT;
if (regtestProject !== undefined && !/^[a-z0-9][a-z0-9_-]{0,48}$/u.test(regtestProject)) {
  throw new Error('DREY_REGTEST_PROJECT must name a valid isolated project');
}
const regtestProjectArgs = regtestProject === undefined ? [] : ['--project', regtestProject];
const regtestConfirmation = regtestProject ?? 'drey-regtest';
const rpcOrigin = 'http://127.0.0.1:18443';
const gatewayOrigin = 'http://127.0.0.1:18480';
const ordinalRecipientWallet = 'drey-regtest-ordinal-recipient';
const cardinalFaucetWallet = 'drey-regtest-cardinal-faucet';
const rareSinkWallet = 'drey-regtest-rare-sink';
let rpcId = 0;
let cardinalFaucetReady: Promise<void> | null = null;
const encoder = new TextEncoder();

interface RegtestStatus {
  instanceId: string;
  network: 'regtest';
  protocolVersion: 2;
  requestNonce: string;
  timestamp: string;
  coreTip: { height: number; hash: string };
  indexTip: { height: number; hash: string };
  historyTip: { height: number; hash: string };
  ordTip: { height: number; hash: string };
  classificationRevision: string;
  capabilities: string[];
  readiness: { walletDataReady: boolean; spendingReady: boolean };
  signature: string;
}

export interface FundingOutpoint {
  txid: string;
  vout: number;
  sats: number;
}

export interface ProviderPsbtFixture {
  psbtBase64: string;
  unsignedTxid: string;
  funding: FundingOutpoint;
  walletAddress: string;
  destination: string;
  sendSats: number;
  changeSats: number;
  feeSats: number;
}

export interface FinalizedProviderTransaction {
  hex: string;
  txid: string;
}

export interface TransactionIntentResult {
  feeSats: number;
  feeRate: number;
  changeSats: number;
}

export interface SingleOutputTransactionResult {
  feeSats: number;
  feeRate: number;
  outputSats: number;
}

export interface OrdinalFixture {
  inscriptionId: string;
  number: number;
  outpoint: FundingOutpoint;
  satpoint: string;
}

export interface PopupWalletSummary {
  availableSats: string;
  collectiblesCount: number;
  protectedSats: string;
  unavailableCleanSats: string;
  awaitingClassificationSats: string;
  gating: string;
  scan: string;
  userFrozenSats: string;
  wrongLaneCount: number;
}

interface DecodedTransaction {
  txid?: unknown;
  vin?: Array<{ txid?: unknown; vout?: unknown; coinbase?: unknown }>;
  vout?: Array<{
    n?: unknown;
    value?: unknown;
    scriptPubKey?: { address?: unknown };
  }>;
}

function validTxid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function validRegtestAddress(value: unknown): value is string {
  return typeof value === 'string' && /^bcrt1[ac-hj-np-z02-9]{8,87}$/u.test(value);
}

function unsignedTransactionId(transaction: Transaction): string {
  const first = createHash('sha256').update(transaction.unsignedTx).digest();
  return Buffer.from(createHash('sha256').update(first).digest()).reverse().toString('hex');
}

function btcToSats(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} did not contain a finite BTC amount`);
  }
  const sats = Math.round(value * 100_000_000);
  if (!Number.isSafeInteger(sats) || Math.abs(value * 100_000_000 - sats) > 0.000_001) {
    throw new Error(`${label} did not contain an exact satoshi amount`);
  }
  return sats;
}

function u32be(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function framed(value: string): Uint8Array[] {
  const bytes = encoder.encode(value);
  return [u32be(bytes.byteLength), bytes];
}

function statusShape(value: unknown): value is RegtestStatus {
  if (typeof value !== 'object' || value === null) return false;
  const status = value as Partial<RegtestStatus>;
  const tip = (candidate: unknown): candidate is { height: number; hash: string } =>
    typeof candidate === 'object' && candidate !== null &&
    Number.isSafeInteger((candidate as { height?: unknown }).height) &&
    Number((candidate as { height: number }).height) >= 0 &&
    typeof (candidate as { hash?: unknown }).hash === 'string' &&
    /^[0-9a-f]{64}$/u.test((candidate as { hash: string }).hash);
  return typeof status.instanceId === 'string' && status.network === 'regtest' &&
    status.protocolVersion === 2 && typeof status.requestNonce === 'string' &&
    typeof status.timestamp === 'string' && tip(status.coreTip) && tip(status.indexTip) &&
    tip(status.historyTip) && tip(status.ordTip) && typeof status.classificationRevision === 'string' &&
    Array.isArray(status.capabilities) && status.capabilities.every((entry) => typeof entry === 'string') &&
    typeof status.readiness === 'object' && status.readiness !== null &&
    typeof status.readiness.walletDataReady === 'boolean' &&
    typeof status.readiness.spendingReady === 'boolean' &&
    typeof status.signature === 'string' && /^[0-9a-f]{128}$/u.test(status.signature);
}

function canonicalEnvelope(status: RegtestStatus): Uint8Array {
  const parts: Uint8Array[] = [
    ...framed(status.instanceId),
    ...framed(status.network),
    ...framed(String(status.protocolVersion)),
    ...framed(status.requestNonce),
    ...framed(status.timestamp),
    ...framed(String(status.coreTip.height)),
    ...framed(status.coreTip.hash),
    ...framed(String(status.indexTip.height)),
    ...framed(status.indexTip.hash),
    ...framed(status.classificationRevision),
    u32be(status.capabilities.length),
  ];
  for (const capability of status.capabilities) parts.push(...framed(capability));
  return concat(parts);
}

function verifyStatusBody(bytes: Uint8Array, status: RegtestStatus, publicKeyHex: string): boolean {
  const text = new TextDecoder().decode(bytes);
  const needle = `"signature":"${status.signature}"`;
  if (text.indexOf(needle) < 0 || text.indexOf(needle) !== text.lastIndexOf(needle)) return false;
  const blanked = encoder.encode(text.replace(needle, '"signature":""'));
  const bodyHash = createHash('sha256').update(blanked).digest();
  const input = concat([
    encoder.encode('squirrel-gateway-v1:'),
    canonicalEnvelope(status),
    bodyHash,
  ]);
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKeyHex, 'hex'),
  ]);
  return verify(
    null,
    input,
    createPublicKey({ key: spki, format: 'der', type: 'spki' }),
    Buffer.from(status.signature, 'hex'),
  );
}

async function fetchVerifiedStatus(publicKeyHex: string): Promise<RegtestStatus> {
  const nonce = randomBytes(16).toString('hex');
  const response = await fetch(`${gatewayOrigin}/v1/status`, {
    headers: { 'x-squirrel-request-nonce': nonce },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('regtest gateway status request failed');
  const bytes = new Uint8Array(await response.arrayBuffer());
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('regtest gateway status was not JSON');
  }
  const timestamp = statusShape(parsed) ? Date.parse(parsed.timestamp) : Number.NaN;
  if (!statusShape(parsed) || parsed.requestNonce !== nonce || !Number.isFinite(timestamp) ||
      Math.abs(Date.now() - timestamp) > 10 * 60_000 ||
      !verifyStatusBody(bytes, parsed, publicKeyHex)) {
    throw new Error('regtest gateway status signature or binding is invalid');
  }
  return parsed;
}

async function protectedFile(file: string, pattern: RegExp, label: string): Promise<string> {
  const metadata = await stat(file);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} permissions are broader than mode 0600`);
  const value = (await readFile(file, 'utf8')).trim();
  if (!pattern.test(value)) throw new Error(`${label} is malformed`);
  return value;
}

async function coreRpc<T>(method: string, params: readonly unknown[] = [], wallet?: string): Promise<T> {
  const auth = await protectedFile(rpcAuthPath, /^dreyregtest:[0-9a-f]{64}$/u, 'Core RPC identity');
  const target = wallet === undefined
    ? rpcOrigin
    : `${rpcOrigin}/wallet/${encodeURIComponent(wallet)}`;
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(auth).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { result?: T; error?: unknown };
  if (!response.ok || payload.error != null || !Object.hasOwn(payload, 'result')) {
    throw new Error(`Bitcoin Core RPC ${method} failed`);
  }
  return payload.result as T;
}

async function minerAddress(label: string, type: 'bech32' | 'bech32m' = 'bech32'): Promise<string> {
  const address = await coreRpc<string>('getnewaddress', [label, type], 'drey-regtest-miner');
  if (!validRegtestAddress(address)) throw new Error('Bitcoin Core returned a malformed regtest address');
  return address;
}

async function ensureCoreWallet(name: string): Promise<void> {
  const loaded = await coreRpc<string[]>('listwallets');
  if (loaded.includes(name)) return;
  const directory = await coreRpc<{ wallets?: Array<{ name?: unknown }> }>('listwalletdir');
  if (directory.wallets?.some((wallet) => wallet.name === name) === true) {
    await coreRpc<unknown>('loadwallet', [name]);
  } else {
    await coreRpc<unknown>('createwallet', [name]);
  }
}

async function ensureCardinalFaucet(): Promise<void> {
  if (cardinalFaucetReady !== null) return cardinalFaucetReady;
  cardinalFaucetReady = (async () => {
    await ensureCoreWallet(cardinalFaucetWallet);
    const existing = await coreRpc<number>('getbalance', ['*', 0], cardinalFaucetWallet);
    if (btcToSats(existing, 'cardinal faucet balance') >= 10_000_000) return;
    await ensureCoreWallet(rareSinkWallet);
    const candidates = await coreRpc<Array<{
      txid?: unknown;
      vout?: unknown;
      amount?: unknown;
    }>>('listunspent', [101, 9_999_999], 'drey-regtest-miner');
    let source: typeof candidates[number] | undefined;
    for (const candidate of candidates) {
      if (!validTxid(candidate.txid) || !Number.isSafeInteger(candidate.vout) ||
          typeof candidate.amount !== 'number' || candidate.amount <= 1.01) continue;
      const transaction = await coreRpc<DecodedTransaction>(
        'getrawtransaction',
        [candidate.txid, true],
      );
      if (typeof transaction.vin?.[0]?.coinbase === 'string') {
        source = candidate;
        break;
      }
    }
    if (source === undefined) throw new Error('regtest miner has no mature faucet source');
    const inputSats = btcToSats(source.amount, 'cardinal faucet source');
    const sinkSats = 100_000;
    const faucetSats = 100_000_000;
    const feeSats = 10_000;
    const changeSats = inputSats - sinkSats - faucetSats - feeSats;
    if (changeSats <= 0) throw new Error('regtest faucet source is too small');
    const [sinkAddress, faucetAddress, changeAddress] = await Promise.all([
      coreRpc<string>('getnewaddress', ['rare-sat-sink', 'bech32'], rareSinkWallet),
      coreRpc<string>('getnewaddress', ['cardinal-faucet', 'bech32'], cardinalFaucetWallet),
      minerAddress('cardinal-faucet-change'),
    ]);
    if (![sinkAddress, faucetAddress, changeAddress].every(validRegtestAddress)) {
      throw new Error('Bitcoin Core returned a malformed faucet address');
    }
    const raw = await coreRpc<string>('createrawtransaction', [
      [{ txid: source.txid, vout: source.vout }],
      [
        { [sinkAddress]: sinkSats / 100_000_000 },
        { [faucetAddress]: faucetSats / 100_000_000 },
        { [changeAddress]: changeSats / 100_000_000 },
      ],
    ]);
    const signed = await coreRpc<{ hex?: unknown; complete?: unknown }>(
      'signrawtransactionwithwallet',
      [raw],
      'drey-regtest-miner',
    );
    if (signed.complete !== true || typeof signed.hex !== 'string') {
      throw new Error('Bitcoin Core did not sign the cardinal faucet transaction');
    }
    const txid = await coreRpc<string>('sendrawtransaction', [signed.hex]);
    if (!validTxid(txid)) throw new Error('Bitcoin Core returned a malformed faucet transaction id');
    await mineAndWait();
    const received = await coreRpc<Array<{
      txid?: unknown;
      vout?: unknown;
      amount?: unknown;
      confirmations?: unknown;
    }>>('listunspent', [1, 9_999_999, [faucetAddress]], cardinalFaucetWallet);
    if (received.length !== 1 || received[0]?.txid !== txid || received[0].vout !== 1 ||
        btcToSats(received[0].amount, 'cardinal faucet output') !== faucetSats ||
        !Number.isSafeInteger(received[0].confirmations) || Number(received[0].confirmations) < 1) {
      throw new Error('cardinal faucet output did not preserve its exact ordered value');
    }
  })().catch((error) => {
    cardinalFaucetReady = null;
    throw error;
  });
  return cardinalFaucetReady;
}

export async function assertRegtestReady(): Promise<number> {
  const info = await coreRpc<{ chain?: unknown; blocks?: unknown }>('getblockchaininfo');
  if (info.chain !== 'regtest' || !Number.isSafeInteger(info.blocks) || Number(info.blocks) < 101) {
    throw new Error('local Bitcoin Core is not a mature regtest chain');
  }
  await waitForGatewayHeight(Number(info.blocks));
  return Number(info.blocks);
}

export async function popupWalletSummary(page: Page): Promise<PopupWalletSummary> {
  return page.evaluate(async () => {
    const session = (await chrome.storage.session.get('squirrel:session'))['squirrel:session'] as
      { vaultId?: unknown; sessionId?: unknown } | undefined;
    if (typeof session?.vaultId !== 'string' || typeof session.sessionId !== 'string') {
      throw new Error('active test session is unavailable');
    }
    const envelope = (op: string, payload: Record<string, unknown>) => ({
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      sender: 'popup',
      op,
      payload,
    });
    const expectation = {
      expectedVaultId: session.vaultId,
      expectedSessionId: session.sessionId,
    };
    const active = await chrome.runtime.sendMessage(envelope(
      'account.active.get',
      expectation,
    )) as { ok?: unknown; result?: { accountId?: unknown } };
    if (active.ok !== true || typeof active.result?.accountId !== 'string') {
      throw new Error('active test account is unavailable');
    }
    const response = await chrome.runtime.sendMessage(envelope('wallet.home', {
      ...expectation,
      accountId: active.result.accountId,
    })) as {
      ok?: unknown;
      result?: {
        balances?: Record<string, unknown>;
        collectiblesCount?: unknown;
        protectionBreakdown?: Record<string, unknown>;
        dataGating?: { state?: unknown };
        scan?: { kind?: unknown };
        wrongLaneCount?: unknown;
      };
    };
    const result = response.result;
    if (response.ok !== true || result === undefined) {
      throw new Error('wallet home diagnostic is unavailable');
    }
    const summary = {
      availableSats: result.balances?.['availableSats'],
      collectiblesCount: result.collectiblesCount,
      protectedSats: result.balances?.['protectedSats'],
      unavailableCleanSats: result.balances?.['unavailableCleanSats'],
      awaitingClassificationSats: result.protectionBreakdown?.['awaitingClassificationSats'],
      gating: result.dataGating?.state,
      scan: result.scan?.kind,
      userFrozenSats: result.protectionBreakdown?.['userFrozenSats'],
      wrongLaneCount: result.wrongLaneCount,
    };
    if ([summary.availableSats, summary.protectedSats, summary.unavailableCleanSats,
      summary.awaitingClassificationSats, summary.gating, summary.scan, summary.userFrozenSats]
      .some((value) => typeof value !== 'string') ||
      !Number.isSafeInteger(summary.collectiblesCount) ||
      !Number.isSafeInteger(summary.wrongLaneCount)) {
      throw new Error('wallet home diagnostic is malformed');
    }
    return summary as PopupWalletSummary;
  });
}

export async function fundWithoutConfirmation(
  address: string,
  sats: number,
): Promise<FundingOutpoint> {
  if (!validRegtestAddress(address)) throw new Error('extension returned a malformed regtest address');
  if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('funding amount must be positive integer sats');
  await ensureCardinalFaucet();
  const txid = await coreRpc<string>(
    'sendtoaddress',
    [address, sats / 100_000_000],
    cardinalFaucetWallet,
  );
  if (!validTxid(txid)) throw new Error('Bitcoin Core returned a malformed funding transaction id');
  const transaction = await coreRpc<DecodedTransaction>('getrawtransaction', [txid, true]);
  if (!Array.isArray(transaction.vout)) {
    throw new Error('Bitcoin Core did not decode the funding transaction outputs');
  }
  const matches = transaction.vout.filter((output) =>
    output.scriptPubKey?.address === address &&
    btcToSats(output.value, 'funding output') === sats,
  );
  const [match] = matches;
  if (matches.length !== 1 || match === undefined || !Number.isSafeInteger(match.n)) {
    throw new Error('funding transaction did not contain the exact extension output');
  }
  return { txid, vout: Number(match.n), sats };
}

export async function fundAndConfirm(address: string, sats: number): Promise<FundingOutpoint> {
  const funding = await fundWithoutConfirmation(address, sats);
  await confirmTransaction(funding.txid);
  return funding;
}

export async function freshExternalAddress(): Promise<string> {
  return minerAddress('extension-regtest-e2e-destination');
}

export async function freshExternalOrdinalAddress(): Promise<string> {
  await ensureCoreWallet(ordinalRecipientWallet);
  const address = await coreRpc<string>(
    'getnewaddress',
    ['extension-regtest-e2e-ordinal-destination', 'bech32m'],
    ordinalRecipientWallet,
  );
  if (!/^bcrt1p[ac-hj-np-z02-9]{8,87}$/u.test(address)) {
    throw new Error('Bitcoin Core did not return a regtest Taproot destination');
  }
  return address;
}

export async function createProviderPsbtFixture(input: {
  funding: FundingOutpoint;
  walletAddress: string;
  destination: string;
  sendSats: number;
  feeSats?: number;
}): Promise<ProviderPsbtFixture> {
  const feeSats = input.feeSats ?? 500;
  if (!validTxid(input.funding.txid) || !Number.isSafeInteger(input.funding.vout) ||
      input.funding.vout < 0 || !Number.isSafeInteger(input.funding.sats) ||
      input.funding.sats <= 0 || !validRegtestAddress(input.walletAddress) ||
      !validRegtestAddress(input.destination) || !Number.isSafeInteger(input.sendSats) ||
      input.sendSats <= 0 || !Number.isSafeInteger(feeSats) || feeSats <= 0) {
    throw new Error('provider PSBT fixture received malformed intent');
  }
  const changeSats = input.funding.sats - input.sendSats - feeSats;
  if (changeSats <= 546) throw new Error('provider PSBT fixture requires non-dust change');
  const bare = await coreRpc<string>('createpsbt', [
    [{ txid: input.funding.txid, vout: input.funding.vout, sequence: 0xfffffffd }],
    [
      { [input.destination]: input.sendSats / 100_000_000 },
      { [input.walletAddress]: changeSats / 100_000_000 },
    ],
    0,
    true,
  ]);
  const enrichedBase64 = await coreRpc<string>('utxoupdatepsbt', [bare]);
  const enriched = Transaction.fromPSBT(Buffer.from(enrichedBase64, 'base64'));
  const sourceInput = enriched.getInput(0);
  if (!sourceInput.txid || sourceInput.index === undefined || !sourceInput.witnessUtxo) {
    throw new Error('Bitcoin Core did not populate the provider PSBT witness UTXO');
  }
  const normalized = new Transaction({
    lowR: true,
    version: enriched.version,
    lockTime: enriched.lockTime,
  });
  normalized.addInput({
    txid: sourceInput.txid,
    index: sourceInput.index,
    ...(sourceInput.sequence === undefined ? {} : { sequence: sourceInput.sequence }),
    witnessUtxo: sourceInput.witnessUtxo,
    sighashType: SigHash.ALL,
  });
  for (let index = 0; index < enriched.outputsLength; index += 1) {
    const output = enriched.getOutput(index);
    if (!output.script || output.amount === undefined) {
      throw new Error('Bitcoin Core returned a malformed provider PSBT output');
    }
    normalized.addOutput({ script: output.script, amount: output.amount });
  }
  const psbtBase64 = Buffer.from(normalized.toPSBT()).toString('base64');
  const decoded = await coreRpc<{
    tx?: DecodedTransaction;
    inputs?: Array<{
      witness_utxo?: { amount?: unknown; scriptPubKey?: { address?: unknown } };
    }>;
    fee?: unknown;
  }>('decodepsbt', [psbtBase64]);
  const source = decoded.inputs?.[0]?.witness_utxo;
  const outputs = decoded.tx?.vout ?? [];
  if (!validTxid(decoded.tx?.txid) || decoded.tx?.vin?.length !== 1 ||
      decoded.tx.vin[0]?.txid !== input.funding.txid ||
      decoded.tx.vin[0]?.vout !== input.funding.vout || decoded.inputs?.length !== 1 ||
      source?.scriptPubKey?.address !== input.walletAddress ||
      btcToSats(source.amount, 'provider PSBT source') !== input.funding.sats ||
      outputs.length !== 2 || outputs[0]?.scriptPubKey?.address !== input.destination ||
      btcToSats(outputs[0]?.value, 'provider PSBT destination') !== input.sendSats ||
      outputs[1]?.scriptPubKey?.address !== input.walletAddress ||
      btcToSats(outputs[1]?.value, 'provider PSBT change') !== changeSats ||
      btcToSats(decoded.fee, 'provider PSBT fee') !== feeSats) {
    throw new Error('Bitcoin Core did not construct the exact provider PSBT fixture');
  }
  // Parse independently from Core as well. This catches malformed PSBT bytes
  // before a browser ever receives the fixture.
  const parsed = Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'));
  if (unsignedTransactionId(parsed) !== decoded.tx.txid ||
      parsed.inputsLength !== 1 || parsed.outputsLength !== 2) {
    throw new Error('provider PSBT fixture did not round-trip through the wallet signer parser');
  }
  return {
    psbtBase64,
    unsignedTxid: decoded.tx.txid,
    funding: input.funding,
    walletAddress: input.walletAddress,
    destination: input.destination,
    sendSats: input.sendSats,
    changeSats,
    feeSats,
  };
}

export async function verifySignedProviderBatch(
  signedPsbts: readonly string[],
  fixtures: readonly ProviderPsbtFixture[],
): Promise<FinalizedProviderTransaction[]> {
  if (signedPsbts.length !== fixtures.length || signedPsbts.length === 0) {
    throw new Error('signed provider batch result count changed');
  }
  const finalized: FinalizedProviderTransaction[] = [];
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index]!;
    const psbtBase64 = signedPsbts[index]!;
    const decoded = await coreRpc<{
      tx?: DecodedTransaction;
      inputs?: Array<{ partial_signatures?: Record<string, unknown> }>;
    }>('decodepsbt', [psbtBase64]);
    const signatures = decoded.inputs?.[0]?.partial_signatures;
    if (decoded.tx?.txid !== fixture.unsignedTxid || signatures === undefined ||
        Object.keys(signatures).length !== 1) {
      throw new Error('signed provider batch result changed order or signature scope');
    }
    const result = await coreRpc<{ hex?: unknown; complete?: unknown }>('finalizepsbt', [psbtBase64, true]);
    if (result.complete !== true || typeof result.hex !== 'string' ||
        !/^[0-9a-f]+$/u.test(result.hex)) {
      throw new Error('Bitcoin Core could not finalize a signed provider batch result');
    }
    const raw = await coreRpc<DecodedTransaction>('decoderawtransaction', [result.hex]);
    if (raw.txid !== fixture.unsignedTxid) {
      throw new Error('finalized provider transaction identity changed');
    }
    finalized.push({ hex: result.hex, txid: fixture.unsignedTxid });
  }
  const acceptance = await coreRpc<Array<{ txid?: unknown; allowed?: unknown }>>(
    'testmempoolaccept',
    [finalized.map((item) => item.hex)],
  );
  if (acceptance.length !== finalized.length || acceptance.some((item, index) =>
    item.allowed !== true || item.txid !== finalized[index]?.txid)) {
    throw new Error('Bitcoin Core rejected a finalized provider batch result');
  }
  return finalized;
}

export async function broadcastFinalizedProviderBatch(
  transactions: readonly FinalizedProviderTransaction[],
): Promise<string[]> {
  const txids: string[] = [];
  for (const transaction of transactions) {
    const txid = await coreRpc<string>('sendrawtransaction', [transaction.hex]);
    if (txid !== transaction.txid) throw new Error('Bitcoin Core returned a changed provider txid');
    txids.push(txid);
  }
  return txids;
}

interface OrdInscriptionRecord {
  address?: unknown;
  content_length?: unknown;
  content_type?: unknown;
  id?: unknown;
  number?: unknown;
  output?: unknown;
  satpoint?: unknown;
  value?: unknown;
}

async function ordInscription(inscriptionId: string): Promise<OrdInscriptionRecord> {
  if (!/^[0-9a-f]{64}i[0-9]+$/u.test(inscriptionId)) {
    throw new Error('inscription fixture returned a malformed identifier');
  }
  const response = await fetch(
    `http://127.0.0.1:18481/r/inscription/${encodeURIComponent(inscriptionId)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error('local ord did not return the inscription fixture');
  return await response.json() as OrdInscriptionRecord;
}

export async function createOrdinalFixture(
  destination: string,
  destinationLane: 'ordinals' | 'payment' = 'ordinals',
): Promise<OrdinalFixture> {
  const destinationPattern = destinationLane === 'ordinals'
    ? /^bcrt1p[ac-hj-np-z02-9]{8,87}$/u
    : /^bcrt1q[ac-hj-np-z02-9]{8,87}$/u;
  if (!destinationPattern.test(destination)) {
    throw new Error(`inscription fixture destination must be a regtest ${destinationLane} address`);
  }
  const result = spawnSync(process.execPath, [
    regtestControllerPath,
    'inscribe',
    '--destination', destination,
    '--destination-lane', destinationLane,
    '--confirm', regtestConfirmation,
    ...regtestProjectArgs,
  ], {
    cwd: gatewayRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('local ord fixture creation failed; inspect the regtest stack directly');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error('local ord fixture controller returned malformed JSON');
  }
  const inscriptionId = (payload as { inscriptionId?: unknown }).inscriptionId;
  const height = (payload as { height?: unknown }).height;
  if (typeof inscriptionId !== 'string' || !/^[0-9a-f]{64}i[0-9]+$/u.test(inscriptionId) ||
      !Number.isSafeInteger(height)) {
    throw new Error('local ord fixture controller returned malformed fields');
  }
  await waitForGatewayHeight(Number(height));

  const record = await ordInscription(inscriptionId);
  const revealTxid = inscriptionId.slice(0, 64);
  const satpoint = typeof record.satpoint === 'string' ? record.satpoint : '';
  const satpointMatch = satpoint !== ''
    ? /^([0-9a-f]{64}):([0-9]+):([0-9]+)$/u.exec(satpoint)
    : null;
  if (record.id !== inscriptionId || !satpointMatch || satpointMatch[1] !== revealTxid ||
      satpointMatch[3] !== '0' || record.output !== `${satpointMatch[1]}:${satpointMatch[2]}` ||
      record.address !== destination || record.value !== 10_000 ||
      record.content_type !== 'text/plain;charset=utf-8' || record.content_length !== 40 ||
      !Number.isSafeInteger(record.number)) {
    throw new Error('local ord fixture metadata did not match its exact intended content and location');
  }
  const transaction = await coreRpc<DecodedTransaction>('getrawtransaction', [revealTxid, true]);
  const vout = Number(satpointMatch[2]);
  const output = transaction.vout?.find((candidate) => candidate.n === vout);
  if (transaction.txid !== revealTxid || output?.scriptPubKey?.address !== destination ||
      btcToSats(output.value, 'inscription fixture output') !== 10_000) {
    throw new Error('inscription reveal transaction did not pay the exact extension Ordinals address');
  }
  return {
    inscriptionId,
    number: Number(record.number),
    outpoint: { txid: revealTxid, vout, sats: 10_000 },
    satpoint,
  };
}

export async function assertOrdinalTransferTransaction(
  txid: string,
  fixture: OrdinalFixture,
  feeFunding: FundingOutpoint,
  destination: string,
): Promise<{ feeSats: number; feeRate: number; destinationVout: number }> {
  if (!validTxid(txid) || !/^bcrt1p[ac-hj-np-z02-9]{8,87}$/u.test(destination)) {
    throw new Error('ordinal transfer assertion received malformed intent');
  }
  const [transaction, mempool, destinationInfo] = await Promise.all([
    coreRpc<DecodedTransaction>('getrawtransaction', [txid, true]),
    coreRpc<{ vsize?: unknown; fees?: { base?: unknown } }>('getmempoolentry', [txid]),
    coreRpc<{ ismine?: unknown }>('getaddressinfo', [destination], ordinalRecipientWallet),
  ]);
  const expectedInputs = new Set([
    `${fixture.outpoint.txid}:${fixture.outpoint.vout}`,
    `${feeFunding.txid}:${feeFunding.vout}`,
  ]);
  const actualInputs = transaction.vin?.map((input) =>
    `${String(input.txid)}:${String(input.vout)}`) ?? [];
  if (transaction.txid !== txid || actualInputs.length !== 2 ||
      actualInputs.some((input) => !expectedInputs.has(input)) ||
      new Set(actualInputs).size !== 2 || destinationInfo.ismine !== true) {
    throw new Error('ordinal transfer did not spend exactly the protected and clean fee inputs');
  }
  const outputs = transaction.vout?.map((output) => ({
    address: output.scriptPubKey?.address,
    sats: btcToSats(output.value, 'ordinal transfer output'),
    vout: output.n,
  })) ?? [];
  const destinationOutputs = outputs.filter((output) =>
    output.address === destination && output.sats === 10_000 && Number.isSafeInteger(output.vout));
  if (outputs.length !== 2 || destinationOutputs.length !== 1 ||
      outputs.some((output) => !validRegtestAddress(output.address) || output.sats <= 0)) {
    throw new Error('ordinal transfer did not contain exact postage and clean change outputs');
  }
  const feeSats = fixture.outpoint.sats + feeFunding.sats -
    outputs.reduce((sum, output) => sum + output.sats, 0);
  const reportedFeeSats = btcToSats(mempool.fees?.base, 'ordinal transfer mempool fee');
  if (feeSats <= 0 || feeSats !== reportedFeeSats || !Number.isSafeInteger(mempool.vsize) ||
      Number(mempool.vsize) <= 0) {
    throw new Error('ordinal transfer did not conserve value and fee exactly');
  }
  const feeRate = feeSats / Number(mempool.vsize);
  if (feeRate < 1 || feeRate > 1.05) {
    throw new Error('ordinal transfer did not honor the selected one sat/vB rate');
  }
  return { feeSats, feeRate, destinationVout: Number(destinationOutputs[0]!.vout) };
}

export async function assertOrdinalBatchTransferTransaction(
  txid: string,
  fixtures: readonly OrdinalFixture[],
  feeFunding: FundingOutpoint,
  destination: string,
): Promise<{ feeSats: number; feeRate: number; destinationVouts: Map<string, number> }> {
  if (!validTxid(txid) || fixtures.length < 2 || fixtures.length > 16 ||
      !/^bcrt1p[ac-hj-np-z02-9]{8,87}$/u.test(destination)) {
    throw new Error('ordinal batch assertion received malformed intent');
  }
  const protectedByOutpoint = new Map(fixtures.map((fixture) => [
    `${fixture.outpoint.txid}:${fixture.outpoint.vout}`,
    fixture,
  ]));
  if (protectedByOutpoint.size !== fixtures.length) {
    throw new Error('ordinal batch fixtures did not name unique source outputs');
  }
  const [transaction, mempool, destinationInfo] = await Promise.all([
    coreRpc<DecodedTransaction>('getrawtransaction', [txid, true]),
    coreRpc<{ vsize?: unknown; fees?: { base?: unknown } }>('getmempoolentry', [txid]),
    coreRpc<{ ismine?: unknown }>('getaddressinfo', [destination], ordinalRecipientWallet),
  ]);
  const actualInputs = transaction.vin?.map((input) =>
    `${String(input.txid)}:${String(input.vout)}`) ?? [];
  const protectedInputs = actualInputs.slice(0, fixtures.length);
  const feeInput = `${feeFunding.txid}:${feeFunding.vout}`;
  if (transaction.txid !== txid || destinationInfo.ismine !== true ||
      actualInputs.length !== fixtures.length + 1 || actualInputs.at(-1) !== feeInput ||
      new Set(protectedInputs).size !== fixtures.length ||
      protectedInputs.some((input) => !protectedByOutpoint.has(input))) {
    throw new Error('ordinal batch did not keep every protected input ahead of clean fee funding');
  }
  const outputs = transaction.vout?.map((output) => ({
    address: output.scriptPubKey?.address,
    sats: btcToSats(output.value, 'ordinal batch output'),
    vout: output.n,
  })) ?? [];
  const postageOutputs = outputs.slice(0, fixtures.length);
  const paymentChange = outputs.at(-1);
  if (outputs.length !== fixtures.length + 1 || postageOutputs.some((output, index) =>
    output.vout !== index || output.address !== destination || output.sats !== 10_000) ||
      paymentChange?.vout !== fixtures.length ||
      !/^bcrt1q[ac-hj-np-z02-9]{8,87}$/u.test(String(paymentChange.address)) ||
      !Number.isSafeInteger(paymentChange.sats) || paymentChange.sats <= 0) {
    throw new Error('ordinal batch did not preserve one exact postage output per source');
  }
  const inputSats = fixtures.reduce((sum, fixture) => sum + fixture.outpoint.sats, 0) +
    feeFunding.sats;
  const feeSats = inputSats - outputs.reduce((sum, output) => sum + output.sats, 0);
  const reportedFeeSats = btcToSats(mempool.fees?.base, 'ordinal batch mempool fee');
  if (feeSats <= 0 || feeSats !== reportedFeeSats ||
      paymentChange.sats !== feeFunding.sats - feeSats ||
      !Number.isSafeInteger(mempool.vsize) || Number(mempool.vsize) <= 0) {
    throw new Error('ordinal batch did not conserve protected value, fee funding, and change');
  }
  const feeRate = feeSats / Number(mempool.vsize);
  if (feeRate < 1 || feeRate > 1.05) {
    throw new Error('ordinal batch did not honor the selected one sat/vB rate');
  }
  return {
    feeSats,
    feeRate,
    destinationVouts: new Map(protectedInputs.map((outpoint, index) => [outpoint, index])),
  };
}

export async function assertOrdinalMoved(
  fixture: OrdinalFixture,
  txid: string,
  destination: string,
  destinationVout: number,
  postageSats = fixture.outpoint.sats,
): Promise<void> {
  const record = await ordInscription(fixture.inscriptionId);
  const expectedOutpoint = `${txid}:${destinationVout}`;
  if (record.id !== fixture.inscriptionId || record.number !== fixture.number ||
      record.output !== expectedOutpoint || record.satpoint !== `${expectedOutpoint}:0` ||
      record.address !== destination || record.value !== postageSats) {
    throw new Error('ord did not index the inscription at the exact confirmed transfer output');
  }
}

interface WalletOrdinalMutationResult {
  destinationVout: number;
  feeSats: number;
  feeRate: number;
  paymentChange: FundingOutpoint;
}

async function assertWalletOrdinalMutation(
  txid: string,
  fixture: OrdinalFixture,
  feeFunding: FundingOutpoint,
  destination: string,
  postageSats: number,
  returnedPostageSats: number,
): Promise<WalletOrdinalMutationResult> {
  if (!validTxid(txid) || !/^bcrt1p[ac-hj-np-z02-9]{8,87}$/u.test(destination) ||
      !Number.isSafeInteger(postageSats) || postageSats <= 0 ||
      !Number.isSafeInteger(returnedPostageSats) || returnedPostageSats < 0 ||
      postageSats + returnedPostageSats !== fixture.outpoint.sats) {
    throw new Error('wallet ordinal mutation assertion received malformed intent');
  }
  const [transaction, mempool] = await Promise.all([
    coreRpc<DecodedTransaction>('getrawtransaction', [txid, true]),
    coreRpc<{ vsize?: unknown; fees?: { base?: unknown } }>('getmempoolentry', [txid]),
  ]);
  const actualInputs = transaction.vin?.map((input) =>
    `${String(input.txid)}:${String(input.vout)}`) ?? [];
  const expectedInputs = [
    `${fixture.outpoint.txid}:${fixture.outpoint.vout}`,
    `${feeFunding.txid}:${feeFunding.vout}`,
  ];
  if (transaction.txid !== txid || actualInputs.length !== 2 ||
      actualInputs.some((input, index) => input !== expectedInputs[index])) {
    throw new Error('wallet ordinal mutation did not preserve protected-first input ordering');
  }
  const outputs = transaction.vout?.map((output) => ({
    address: output.scriptPubKey?.address,
    sats: btcToSats(output.value, 'wallet ordinal mutation output'),
    vout: output.n,
  })) ?? [];
  const expectedOutputCount = returnedPostageSats > 0 ? 3 : 2;
  const protectedOutput = outputs[0];
  if (outputs.length !== expectedOutputCount || protectedOutput?.vout !== 0 ||
      protectedOutput.address !== destination || protectedOutput.sats !== postageSats ||
      outputs.some((output) => !validRegtestAddress(output.address) || output.sats <= 0)) {
    throw new Error('wallet ordinal mutation did not keep exact postage at output zero');
  }
  const paymentOutputs = outputs.slice(1);
  if (paymentOutputs.some((output) => !/^bcrt1q[ac-hj-np-z02-9]{8,87}$/u.test(
    String(output.address),
  ))) {
    throw new Error('wallet ordinal mutation returned bitcoin outside the payment lane');
  }
  const feeSats = fixture.outpoint.sats + feeFunding.sats -
    outputs.reduce((sum, output) => sum + output.sats, 0);
  const reportedFeeSats = btcToSats(mempool.fees?.base, 'wallet ordinal mutation mempool fee');
  if (feeSats <= 0 || feeSats !== reportedFeeSats || !Number.isSafeInteger(mempool.vsize) ||
      Number(mempool.vsize) <= 0) {
    throw new Error('wallet ordinal mutation did not conserve value and fee exactly');
  }
  const feeRate = feeSats / Number(mempool.vsize);
  if (feeRate < 1 || feeRate > 1.05) {
    throw new Error('wallet ordinal mutation did not honor the selected one sat/vB rate');
  }
  const returnedOutputs = returnedPostageSats === 0
    ? []
    : paymentOutputs.filter((output) => output.sats === returnedPostageSats);
  const expectedChangeSats = feeFunding.sats - feeSats;
  const changeOutputs = paymentOutputs.filter((output) => output.sats === expectedChangeSats);
  if (returnedOutputs.length !== (returnedPostageSats > 0 ? 1 : 0) ||
      changeOutputs.length !== 1 || returnedPostageSats > 0 && returnedOutputs[0] === changeOutputs[0]) {
    throw new Error('wallet ordinal mutation did not return exact postage excess and fee change');
  }
  const paymentChange = changeOutputs[0]!;
  if (!Number.isSafeInteger(paymentChange.vout)) {
    throw new Error('wallet ordinal mutation returned malformed payment change');
  }
  return {
    destinationVout: 0,
    feeSats,
    feeRate,
    paymentChange: { txid, vout: Number(paymentChange.vout), sats: expectedChangeSats },
  };
}

export async function assertOrdinalRescueTransaction(
  txid: string,
  fixture: OrdinalFixture,
  feeFunding: FundingOutpoint,
  destination: string,
): Promise<WalletOrdinalMutationResult> {
  return assertWalletOrdinalMutation(
    txid, fixture, feeFunding, destination, fixture.outpoint.sats, 0,
  );
}

export async function assertOrdinalPostageTransaction(
  txid: string,
  fixture: OrdinalFixture,
  feeFunding: FundingOutpoint,
  destination: string,
  postageSats: number,
): Promise<WalletOrdinalMutationResult> {
  return assertWalletOrdinalMutation(
    txid, fixture, feeFunding, destination, postageSats, fixture.outpoint.sats - postageSats,
  );
}

export async function assertOrdinalSweepTransaction(
  txid: string,
  source: FundingOutpoint,
): Promise<{
  feeSats: number;
  feeRate: number;
  ordinalChange: FundingOutpoint & { address: string };
  paymentChange: FundingOutpoint & { address: string };
}> {
  if (!validTxid(txid) || !validTxid(source.txid) || !Number.isSafeInteger(source.vout) ||
      source.vout < 0 || !Number.isSafeInteger(source.sats) || source.sats <= 10_000) {
    throw new Error('ordinal sweep assertion received malformed intent');
  }
  const [transaction, mempool] = await Promise.all([
    coreRpc<DecodedTransaction>('getrawtransaction', [txid, true]),
    coreRpc<{ vsize?: unknown; fees?: { base?: unknown } }>('getmempoolentry', [txid]),
  ]);
  const actualInputs = transaction.vin?.map((input) =>
    `${String(input.txid)}:${String(input.vout)}`) ?? [];
  if (transaction.txid !== txid || actualInputs.length !== 1 ||
      actualInputs[0] !== `${source.txid}:${source.vout}`) {
    throw new Error('ordinal sweep did not spend only the selected Ordinals-lane bitcoin');
  }
  const outputs = transaction.vout?.map((output) => ({
    address: output.scriptPubKey?.address,
    sats: btcToSats(output.value, 'ordinal sweep output'),
    vout: output.n,
  })) ?? [];
  const ordinalChange = outputs[0];
  const paymentChange = outputs[1];
  if (outputs.length !== 2 || ordinalChange?.vout !== 0 || ordinalChange.sats !== 10_000 ||
      !/^bcrt1p[ac-hj-np-z02-9]{8,87}$/u.test(String(ordinalChange.address)) ||
      paymentChange?.vout !== 1 || paymentChange.sats <= 0 ||
      !/^bcrt1q[ac-hj-np-z02-9]{8,87}$/u.test(String(paymentChange.address))) {
    throw new Error('ordinal sweep did not reserve postage and return excess to separate lanes');
  }
  const feeSats = source.sats - ordinalChange.sats - paymentChange.sats;
  const reportedFeeSats = btcToSats(mempool.fees?.base, 'ordinal sweep mempool fee');
  if (feeSats <= 0 || feeSats !== reportedFeeSats ||
      !Number.isSafeInteger(mempool.vsize) || Number(mempool.vsize) <= 0) {
    throw new Error('ordinal sweep did not conserve its source and fee exactly');
  }
  const feeRate = feeSats / Number(mempool.vsize);
  if (feeRate < 1 || feeRate > 1.05) {
    throw new Error('ordinal sweep did not honor the selected one sat/vB rate');
  }
  return {
    feeSats,
    feeRate,
    ordinalChange: {
      txid,
      vout: Number(ordinalChange.vout),
      sats: ordinalChange.sats,
      address: String(ordinalChange.address),
    },
    paymentChange: {
      txid,
      vout: Number(paymentChange.vout),
      sats: paymentChange.sats,
      address: String(paymentChange.address),
    },
  };
}

export async function transactionInMempool(txid: string): Promise<void> {
  if (!validTxid(txid)) throw new Error('extension returned a malformed transaction id');
  const mempool = await coreRpc<unknown[]>('getrawmempool');
  if (!Array.isArray(mempool) || !mempool.includes(txid)) {
    throw new Error('the signed extension transaction did not reach the local mempool');
  }
}

export async function transactionNotInMempool(txid: string): Promise<void> {
  if (!validTxid(txid)) throw new Error('extension returned a malformed transaction id');
  const mempool = await coreRpc<unknown[]>('getrawmempool');
  if (!Array.isArray(mempool) || mempool.includes(txid)) {
    throw new Error('replaced transaction remained in the local mempool');
  }
}

export async function mempoolTransactionIds(): Promise<string[]> {
  const mempool = await coreRpc<unknown[]>('getrawmempool');
  if (!Array.isArray(mempool) || !mempool.every(validTxid)) {
    throw new Error('Bitcoin Core returned a malformed mempool transaction list');
  }
  return [...mempool].sort();
}

async function assertSingleOutputSpend(
  txid: string,
  funding: FundingOutpoint | readonly FundingOutpoint[],
  expectedFeeRate: { min: number; max?: number },
): Promise<SingleOutputTransactionResult & { outputAddress: string }> {
  const fundings = Array.isArray(funding) ? funding : [funding];
  if (!validTxid(txid) || fundings.length === 0 || fundings.some((entry) =>
    !validTxid(entry.txid) || !Number.isSafeInteger(entry.vout) || entry.vout < 0 ||
    !Number.isSafeInteger(entry.sats) || entry.sats <= 0) ||
      !Number.isFinite(expectedFeeRate.min) || expectedFeeRate.min <= 0 ||
      (expectedFeeRate.max !== undefined &&
        (!Number.isFinite(expectedFeeRate.max) || expectedFeeRate.max < expectedFeeRate.min))) {
    throw new Error('single-output transaction assertion received invalid inputs');
  }
  const fundingSats = fundings.reduce((sum, entry) => sum + entry.sats, 0);
  const [transaction, mempool] = await Promise.all([
    coreRpc<DecodedTransaction>('getrawtransaction', [txid, true]),
    coreRpc<{ vsize?: unknown; fees?: { base?: unknown } }>('getmempoolentry', [txid]),
  ]);
  const expectedInputs = new Set(fundings.map((entry) => `${entry.txid}:${entry.vout}`));
  const actualInputs = Array.isArray(transaction.vin)
    ? transaction.vin.map((input) => `${String(input.txid)}:${String(input.vout)}`)
    : [];
  if (transaction.txid !== txid || actualInputs.length !== expectedInputs.size ||
      new Set(actualInputs).size !== actualInputs.length ||
      actualInputs.some((input) => !expectedInputs.has(input))) {
    throw new Error('single-output transaction did not spend the exact expected outpoints');
  }
  const output = transaction.vout?.[0];
  const outputAddress = output?.scriptPubKey?.address;
  if (transaction.vout?.length !== 1 || output === undefined ||
      !validRegtestAddress(outputAddress)) {
    throw new Error('single-output transaction did not contain one valid regtest output');
  }
  const outputSats = btcToSats(output.value, 'single transaction output');
  const feeSats = fundingSats - outputSats;
  const reportedFeeSats = btcToSats(mempool.fees?.base, 'mempool fee');
  if (!Number.isSafeInteger(mempool.vsize) || Number(mempool.vsize) <= 0 ||
      feeSats !== reportedFeeSats || feeSats <= 0 || outputSats <= 0) {
    throw new Error('single-output transaction did not conserve value and fee exactly');
  }
  const feeRate = feeSats / Number(mempool.vsize);
  if (feeRate < expectedFeeRate.min ||
      (expectedFeeRate.max !== undefined && feeRate > expectedFeeRate.max)) {
    throw new Error('single-output transaction did not honor the requested fee-rate range');
  }
  return { feeSats, feeRate, outputSats, outputAddress };
}

export async function assertSendMaxTransaction(
  txid: string,
  funding: FundingOutpoint | readonly FundingOutpoint[],
  destination: string,
  expectedFeeRate: { min: number; max?: number } = { min: 1, max: 1.05 },
): Promise<SingleOutputTransactionResult> {
  if (!validRegtestAddress(destination)) {
    throw new Error('Send Max destination is not a valid regtest address');
  }
  const result = await assertSingleOutputSpend(txid, funding, expectedFeeRate);
  const destinationInfo = await coreRpc<{ ismine?: unknown }>(
    'getaddressinfo',
    [destination],
    'drey-regtest-miner',
  );
  if (result.outputAddress !== destination || destinationInfo.ismine !== true) {
    throw new Error('Send Max transaction did not pay its exact miner-controlled destination');
  }
  return { feeSats: result.feeSats, feeRate: result.feeRate, outputSats: result.outputSats };
}

export async function assertConsolidationTransaction(
  txid: string,
  funding: readonly FundingOutpoint[],
  expectedFeeRate: { min: number; max?: number } = { min: 1, max: 1.05 },
): Promise<SingleOutputTransactionResult> {
  if (funding.length < 2) throw new Error('consolidation must spend at least two expected inputs');
  const result = await assertSingleOutputSpend(txid, funding, expectedFeeRate);
  const minerInfo = await coreRpc<{ ismine?: unknown }>(
    'getaddressinfo',
    [result.outputAddress],
    'drey-regtest-miner',
  );
  if (minerInfo.ismine === true) {
    throw new Error('consolidation output unexpectedly paid the disposable miner');
  }
  return { feeSats: result.feeSats, feeRate: result.feeRate, outputSats: result.outputSats };
}

export async function assertTransactionIntent(
  txid: string,
  funding: FundingOutpoint | readonly FundingOutpoint[],
  destination: string,
  sendSats: number,
  expectedFeeRate: { min: number; max?: number } = { min: 1, max: 1.05 },
): Promise<TransactionIntentResult> {
  const fundings = Array.isArray(funding) ? funding : [funding];
  if (!validTxid(txid) || fundings.length === 0 || fundings.some((entry) =>
    !validTxid(entry.txid) || !Number.isSafeInteger(entry.vout) || entry.vout < 0 ||
    !Number.isSafeInteger(entry.sats) || entry.sats <= 0) ||
      !validRegtestAddress(destination) ||
      !Number.isSafeInteger(sendSats) || sendSats <= 0 ||
      !Number.isFinite(expectedFeeRate.min) || expectedFeeRate.min <= 0 ||
      (expectedFeeRate.max !== undefined &&
        (!Number.isFinite(expectedFeeRate.max) || expectedFeeRate.max < expectedFeeRate.min))) {
    throw new Error('transaction intent assertion received invalid inputs');
  }
  const fundingSats = fundings.reduce((sum, entry) => sum + entry.sats, 0);
  if (!Number.isSafeInteger(fundingSats) || sendSats >= fundingSats) {
    throw new Error('transaction intent funding did not safely cover the intended send');
  }

  const [transaction, mempool, destinationInfo] = await Promise.all([
    coreRpc<DecodedTransaction>('getrawtransaction', [txid, true]),
    coreRpc<{ vsize?: unknown; fees?: { base?: unknown } }>('getmempoolentry', [txid]),
    coreRpc<{ ismine?: unknown }>('getaddressinfo', [destination], 'drey-regtest-miner'),
  ]);
  const expectedInputs = new Set(fundings.map((entry) => `${entry.txid}:${entry.vout}`));
  const actualInputs = Array.isArray(transaction.vin)
    ? transaction.vin.map((input) => `${String(input.txid)}:${String(input.vout)}`)
    : [];
  if (transaction.txid !== txid || actualInputs.length !== expectedInputs.size ||
      new Set(actualInputs).size !== actualInputs.length ||
      actualInputs.some((input) => !expectedInputs.has(input))) {
    throw new Error('broadcast transaction did not spend the exact funded extension outpoints');
  }
  if (destinationInfo.ismine !== true) {
    throw new Error('broadcast destination is not controlled by the disposable regtest miner');
  }
  if (!Array.isArray(transaction.vout) || transaction.vout.length !== 2) {
    throw new Error('broadcast transaction did not contain exactly recipient and change outputs');
  }

  const outputs = transaction.vout.map((output) => ({
    address: output.scriptPubKey?.address,
    sats: btcToSats(output.value, 'broadcast output'),
  }));
  if (outputs.some((output) => !validRegtestAddress(output.address))) {
    throw new Error('broadcast transaction contained a non-regtest or non-address output');
  }
  const recipients = outputs.filter((output) =>
    output.address === destination && output.sats === sendSats,
  );
  if (recipients.length !== 1) {
    throw new Error('broadcast transaction did not pay the exact intended recipient amount');
  }
  const change = outputs.find((output) => output !== recipients[0]);
  if (change === undefined || change.address === destination || change.sats <= 0) {
    throw new Error('broadcast transaction did not contain a distinct positive change output');
  }

  const feeSats = fundingSats - outputs.reduce((sum, output) => sum + output.sats, 0);
  const reportedFeeSats = btcToSats(mempool.fees?.base, 'mempool fee');
  if (!Number.isSafeInteger(mempool.vsize) || Number(mempool.vsize) <= 0 ||
      feeSats !== reportedFeeSats || feeSats <= 0) {
    throw new Error('broadcast transaction fee did not match the independently decoded value');
  }
  const feeRate = feeSats / Number(mempool.vsize);
  if (feeRate < expectedFeeRate.min ||
      (expectedFeeRate.max !== undefined && feeRate > expectedFeeRate.max)) {
    throw new Error('broadcast transaction did not honor the requested fee-rate range');
  }
  if (change.sats !== fundingSats - sendSats - feeSats) {
    throw new Error('broadcast change did not conserve the funded satoshi value');
  }
  return { feeSats, feeRate, changeSats: change.sats };
}

export async function assertBatchTransactionIntent(
  txid: string,
  funding: FundingOutpoint | readonly FundingOutpoint[],
  recipients: readonly { destination: string; sats: number }[],
  expectedFeeRate: { min: number; max?: number },
): Promise<TransactionIntentResult> {
  const fundings = Array.isArray(funding) ? funding : [funding];
  if (!validTxid(txid) || fundings.length === 0 || recipients.length < 2 ||
      recipients.length > 20 || fundings.some((entry) =>
        !validTxid(entry.txid) || !Number.isSafeInteger(entry.vout) || entry.vout < 0 ||
        !Number.isSafeInteger(entry.sats) || entry.sats <= 0) ||
      recipients.some((entry) => !validRegtestAddress(entry.destination) ||
        !Number.isSafeInteger(entry.sats) || entry.sats <= 0) ||
      new Set(recipients.map((entry) => entry.destination)).size !== recipients.length ||
      !Number.isFinite(expectedFeeRate.min) || expectedFeeRate.min <= 0 ||
      (expectedFeeRate.max !== undefined &&
        (!Number.isFinite(expectedFeeRate.max) || expectedFeeRate.max < expectedFeeRate.min))) {
    throw new Error('batch transaction intent assertion received invalid inputs');
  }
  const fundingSats = fundings.reduce((sum, entry) => sum + entry.sats, 0);
  const sendSats = recipients.reduce((sum, entry) => sum + entry.sats, 0);
  if (!Number.isSafeInteger(fundingSats) || !Number.isSafeInteger(sendSats) ||
      sendSats >= fundingSats) {
    throw new Error('batch transaction funding did not safely cover the intended send');
  }

  const [transaction, mempool, destinationInfo] = await Promise.all([
    coreRpc<DecodedTransaction>('getrawtransaction', [txid, true]),
    coreRpc<{ vsize?: unknown; fees?: { base?: unknown } }>('getmempoolentry', [txid]),
    Promise.all(recipients.map((entry) => coreRpc<{ ismine?: unknown }>(
      'getaddressinfo', [entry.destination], 'drey-regtest-miner',
    ))),
  ]);
  const expectedInputs = new Set(fundings.map((entry) => `${entry.txid}:${entry.vout}`));
  const actualInputs = Array.isArray(transaction.vin)
    ? transaction.vin.map((input) => `${String(input.txid)}:${String(input.vout)}`)
    : [];
  if (transaction.txid !== txid || actualInputs.length !== expectedInputs.size ||
      new Set(actualInputs).size !== actualInputs.length ||
      actualInputs.some((input) => !expectedInputs.has(input))) {
    throw new Error('batch transaction did not spend the exact funded extension outpoints');
  }
  if (destinationInfo.some((info) => info.ismine !== true)) {
    throw new Error('a batch destination is not controlled by the disposable regtest miner');
  }
  if (!Array.isArray(transaction.vout) || transaction.vout.length !== recipients.length + 1) {
    throw new Error('batch transaction did not contain every recipient plus one change output');
  }

  const outputs = transaction.vout.map((output) => ({
    address: output.scriptPubKey?.address,
    sats: btcToSats(output.value, 'batch broadcast output'),
  }));
  if (outputs.some((output) => !validRegtestAddress(output.address))) {
    throw new Error('batch transaction contained a non-regtest or non-address output');
  }
  for (const recipient of recipients) {
    if (outputs.filter((output) => output.address === recipient.destination &&
      output.sats === recipient.sats).length !== 1) {
      throw new Error('batch transaction did not pay an exact intended recipient amount');
    }
  }
  const recipientAddresses = new Set(recipients.map((entry) => entry.destination));
  const changeOutputs = outputs.filter((output) =>
    typeof output.address === 'string' && !recipientAddresses.has(output.address));
  if (changeOutputs.length !== 1 || changeOutputs[0]!.sats <= 0) {
    throw new Error('batch transaction did not contain one distinct positive change output');
  }

  const feeSats = fundingSats - outputs.reduce((sum, output) => sum + output.sats, 0);
  const reportedFeeSats = btcToSats(mempool.fees?.base, 'batch mempool fee');
  if (!Number.isSafeInteger(mempool.vsize) || Number(mempool.vsize) <= 0 ||
      feeSats !== reportedFeeSats || feeSats <= 0) {
    throw new Error('batch transaction fee did not match the independently decoded value');
  }
  const feeRate = feeSats / Number(mempool.vsize);
  if (feeRate < expectedFeeRate.min ||
      (expectedFeeRate.max !== undefined && feeRate > expectedFeeRate.max)) {
    throw new Error('batch transaction did not honor the requested fee-rate range');
  }
  const changeSats = changeOutputs[0]!.sats;
  if (changeSats !== fundingSats - sendSats - feeSats) {
    throw new Error('batch transaction change did not conserve the funded satoshi value');
  }
  return { feeSats, feeRate, changeSats };
}

export async function confirmTransaction(txid: string): Promise<number> {
  if (!validTxid(txid)) throw new Error('extension returned a malformed transaction id');
  const height = await mineAndWait();
  const transaction = await coreRpc<{ confirmations?: unknown }>('getrawtransaction', [txid, true]);
  if (!Number.isSafeInteger(transaction.confirmations) || Number(transaction.confirmations) < 1) {
    throw new Error('the extension transaction was not confirmed by the local chain');
  }
  return height;
}

export async function mineBlock(): Promise<number> {
  return mineAndWait();
}

export async function reorgLatestTransactionToMempool(txid: string): Promise<string> {
  if (!validTxid(txid)) throw new Error('extension returned a malformed transaction id');
  const transaction = await coreRpc<{ blockhash?: unknown; confirmations?: unknown }>(
    'getrawtransaction',
    [txid, true],
  );
  const bestBlockHash = await coreRpc<string>('getbestblockhash');
  const beforeHeight = await coreRpc<number>('getblockcount');
  if (!validTxid(transaction.blockhash) || transaction.blockhash !== bestBlockHash ||
      !Number.isSafeInteger(transaction.confirmations) || Number(transaction.confirmations) < 1 ||
      !Number.isSafeInteger(beforeHeight) || beforeHeight <= 101) {
    throw new Error('reorg test transaction was not confirmed in the current chain tip');
  }
  await coreRpc<null>('invalidateblock', [transaction.blockhash]);
  const afterHeight = await coreRpc<number>('getblockcount');
  if (afterHeight !== beforeHeight - 1) {
    throw new Error('regtest invalidation did not remove exactly the latest block');
  }
  await waitForGatewayFailClosed(afterHeight);
  await transactionInMempool(txid);
  return transaction.blockhash;
}

export async function assertTransactionReconfirmed(
  txid: string,
  displacedBlockHash: string,
): Promise<number> {
  if (!validTxid(displacedBlockHash)) throw new Error('displaced regtest block hash is malformed');
  await generateOneBlock();
  const height = await generateOneBlock();
  await waitForGatewayHeight(height);
  const transaction = await coreRpc<{ blockhash?: unknown; confirmations?: unknown }>(
    'getrawtransaction',
    [txid, true],
  );
  if (!validTxid(transaction.blockhash) || transaction.blockhash === displacedBlockHash ||
      !Number.isSafeInteger(transaction.confirmations) || Number(transaction.confirmations) < 2) {
    throw new Error('reorged transaction was not confirmed in a distinct replacement block');
  }
  return height;
}

async function generateOneBlock(): Promise<number> {
  const address = await minerAddress('extension-regtest-e2e-mining');
  const blocks = await coreRpc<unknown[]>('generatetoaddress', [1, address]);
  if (!Array.isArray(blocks) || blocks.length !== 1 || !validTxid(blocks[0])) {
    throw new Error('Bitcoin Core did not mine exactly one regtest block');
  }
  const height = await coreRpc<number>('getblockcount');
  if (!Number.isSafeInteger(height)) throw new Error('Bitcoin Core returned an invalid height');
  return height;
}

async function mineAndWait(): Promise<number> {
  const height = await generateOneBlock();
  await waitForGatewayHeight(height);
  return height;
}

async function waitForGatewayFailClosed(height: number): Promise<void> {
  const publicKey = await protectedFile(
    gatewayPublicKeyPath,
    /^[0-9a-f]{64}$/u,
    'regtest gateway public key',
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await fetchVerifiedStatus(publicKey);
    if (status.coreTip.height === height && !status.readiness.walletDataReady &&
        !status.readiness.spendingReady) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('signed regtest gateway did not fail closed during the displaced tip');
}

async function waitForGatewayHeight(height: number): Promise<void> {
  const publicKey = await protectedFile(
    gatewayPublicKeyPath,
    /^[0-9a-f]{64}$/u,
    'regtest gateway public key',
  );
  const deadline = Date.now() + 60_000;
  let stableRevision: string | null = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const status = await fetchVerifiedStatus(publicKey);
    const converged = status.coreTip.height === height && status.indexTip.height === height &&
        status.historyTip.height === height && status.ordTip.height === height &&
        status.indexTip.hash === status.coreTip.hash &&
        status.historyTip.hash === status.coreTip.hash && status.ordTip.hash === status.coreTip.hash &&
        status.readiness.walletDataReady &&
        status.readiness.spendingReady;
    if (converged && status.classificationRevision === stableRevision) {
      stableSamples += 1;
      if (stableSamples >= 3) return;
    } else if (converged) {
      stableRevision = status.classificationRevision;
      stableSamples = 1;
    } else {
      stableRevision = null;
      stableSamples = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('signed regtest gateway status did not settle on the mined block');
}
