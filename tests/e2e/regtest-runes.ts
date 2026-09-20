import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { p2tr, p2wpkh, TEST_NETWORK } from '@scure/btc-signer';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { RuneListResult, RuneReview } from '../../src/messaging/rune-ops';
import { coreRpc } from './regtest';

const controller = path.resolve(import.meta.dirname, '../../../gateway/regtest/control.mjs');
const project = process.env.DREY_REGTEST_PROJECT ?? 'drey-regtest';
export interface RuneFixture { runeId: string; name: string; atomic: string; divisibility: number; txid: string; outpoint: string; height: number }
export interface RuneInspection {
  reference: string;
  transaction: { txid: string; hex: string; vin: { txid: string; vout: number }[]; vout: { n: number; value: number; scriptPubKey: { hex: string; address?: string } }[] };
  referenceDecode: { runestone: { Runestone?: { edicts: { id: string; amount: string; output: string }[]; etching: unknown; mint: unknown }; Cenotaph?: { flaw: string } } };
  outputs: { outpoint: string; ord: { address: string | null; value: string; indexed: boolean; inscriptions: string[]; runes: Record<string, { amount: string }> } }[];
}

export function runeController<T>(command: string, args: string[]): T {
  const result = spawnSync(process.execPath, [controller, command, '--project', project, ...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 });
  if (result.error || result.status !== 0) throw new Error(`local Rune ${command} failed; reconcile the isolated stack before retrying`);
  try { return JSON.parse(result.stdout.trim()) as T; } catch { throw new Error('local Rune helper returned malformed evidence'); }
}

export function createRuneFixture(destination: string, sendAmount = '1000.00'): RuneFixture {
  const name = `DREYREGTEST${Array.from(randomBytes(12), (byte) => String.fromCharCode(65 + byte % 26)).join('')}`;
  return runeController<RuneFixture>('rune', ['--confirm', project, '--name', name, '--destination', destination, '--amount', '1000.00', '--divisibility', '2', '--send-amount', sendAmount]);
}

export function sendMoreRuneFixture(fixture: RuneFixture, destination: string, amount: string): RuneFixture {
  return { ...fixture, ...runeController<Omit<RuneFixture, 'runeId'>>('rune-send', ['--confirm', project, '--name', fixture.name, '--destination', destination, '--amount', amount, '--divisibility', '2']) };
}

export function inspectRuneTransaction(txid: string): RuneInspection {
  return runeController<RuneInspection>('rune-inspect', ['--txid', txid]);
}

export async function runeMessage<T>(page: Page, op: string, payload: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: T; code?: string }> {
  try {
    await page.waitForFunction(async () => Boolean((await chrome.storage.session.get('squirrel:session'))['squirrel:session']), undefined, { timeout: 15_000 });
  } catch {
    const diagnostic = await page.evaluate(async () => {
      const safe = window as unknown as { runeSessionEvents?: { present: boolean; priorPresent: boolean; deadlineRemainingMs: number | null }[] };
      const session = (await chrome.storage.session.get('squirrel:session'))['squirrel:session'] as { deadline?: number } | undefined;
      return { idle: await chrome.idle.queryState(15), present: Boolean(session), deadlineRemainingMs: typeof session?.deadline === 'number' ? session.deadline - Date.now() : null, events: safe.runeSessionEvents ?? [] };
    });
    throw new Error(`disposable session did not become available: ${JSON.stringify(diagnostic)}`);
  }
  return page.evaluate(async ({ op, payload }) => {
    const session = (await chrome.storage.session.get('squirrel:session'))['squirrel:session'] as { vaultId: string; sessionId: string };
    if (!session) {
      const safe = window as unknown as { runeSessionEvents?: { present: boolean; priorPresent: boolean }[] };
      throw new Error(`disposable session absent: ${JSON.stringify({ idle: await chrome.idle.queryState(15), present: false, events: safe.runeSessionEvents ?? [] })}`);
    }
    const envelope = (operation: string, body: Record<string, unknown>) => ({ protocolVersion: 1, requestId: crypto.randomUUID(), sender: 'popup', op: operation, payload: body });
    const binding = { expectedVaultId: session.vaultId, expectedSessionId: session.sessionId };
    const active = await chrome.runtime.sendMessage(envelope('account.active.get', binding)) as { ok: boolean; result: { accountId: string } };
    if (!active.ok) throw new Error('active disposable account unavailable');
    const account = ['account.add', 'account.list', 'account.active.get'].includes(op) ? {} : { accountId: active.result.accountId };
    return chrome.runtime.sendMessage(envelope(op, { ...binding, ...account, ...payload }));
  }, { op, payload });
}

export async function runeState(page: Page): Promise<RuneListResult> {
  const result = await runeMessage<RuneListResult>(page, 'runes.list');
  if (!result.ok || !result.result) throw new Error(`Rune state unavailable: ${result.code ?? 'missing-result'}`);
  return result.result;
}

export async function waitForRune(page: Page, fixture: RuneFixture, atomic: string): Promise<void> {
  let diagnostic: unknown;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = await runeState(page);
    const holding = state.holdings.find((item) => item.id === fixture.runeId);
    diagnostic = { status: state.status, canSign: state.canSign, count: state.holdings.length, found: Boolean(holding), available: holding?.available, total: holding?.total, constraints: holding?.constrained.map((item) => item.reason) };
    if (state.status === 'ready' && holding?.available === atomic) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(`real Rune holdings did not converge: ${JSON.stringify(diagnostic)}`);
}

export async function lastRuneTransfer(page: Page): Promise<string> {
  const state = await runeState(page);
  const txid = state.transfers.filter((transfer) => transfer.direction === 'sent').sort((left, right) => Number(right.createdAt) - Number(left.createdAt))[0]?.txid;
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/u.test(txid)) throw new Error('Rune transfer identifier absent');
  return txid;
}

export async function assertRuneTransfer(txid: string, fixture: RuneFixture, args: {
  destination: string; amount: string; retained: string; ownAssetAddresses: string[]; ownPaymentAddresses: string[]; sourceOutpoints: string[]; feeSats: string; postageSats: string;
}): Promise<void> {
  const inspection = inspectRuneTransaction(txid);
  const runestone = inspection.referenceDecode.runestone.Runestone;
  if (inspection.reference !== '0.27.1' || !runestone || runestone.etching !== null || runestone.mint !== null) throw new Error('pinned ord rejected native transfer runestone');
  const inputs = inspection.transaction.vin.map((input) => `${input.txid}:${input.vout}`);
  if (!args.sourceOutpoints.every((outpoint) => inputs.includes(outpoint))) throw new Error('transfer omitted an intended Rune input');
  let recipient = 0n;
  let retained = 0n;
  for (const output of inspection.outputs) {
    if (!output.ord.indexed || output.ord.inscriptions.length !== 0) throw new Error('transfer output lacks clean complete ord evidence');
    if (Object.keys(output.ord.runes).length === 0 && output.ord.value !== '0' && (output.ord.address === null || !args.ownPaymentAddresses.includes(output.ord.address))) throw new Error('Bitcoin change is not independently derived payment-role ownership');
    for (const [name, pile] of Object.entries(output.ord.runes)) {
      if (name !== fixture.name) throw new Error('transfer moved an unrelated Rune');
      if (output.ord.address === args.destination) {
        recipient += BigInt(pile.amount);
        if (output.ord.value !== args.postageSats) throw new Error('recipient postage disagrees with review');
      } else if (output.ord.address !== null && args.ownAssetAddresses.includes(output.ord.address)) retained += BigInt(pile.amount);
      else throw new Error('Rune allocated outside reviewed recipient and owned token change');
    }
  }
  if (recipient.toString() !== args.amount || retained.toString() !== args.retained) throw new Error('pinned ord allocation differs from exact review quantities');
  let inputSats = 0;
  for (const input of inspection.transaction.vin) {
    const previous = await coreRpc<{ vout: { value: number; scriptPubKey: { address?: string } }[] }>('getrawtransaction', [input.txid, true]);
    const origin = previous.vout[input.vout]!;
    if (!args.sourceOutpoints.includes(`${input.txid}:${input.vout}`) && (origin.scriptPubKey.address === undefined || !args.ownPaymentAddresses.includes(origin.scriptPubKey.address))) throw new Error('additional input is outside independently derived payment funding');
    inputSats += Math.round(origin.value * 100_000_000);
  }
  const outputSats = inspection.transaction.vout.reduce((sum, output) => sum + Math.round(output.value * 100_000_000), 0);
  if (String(inputSats - outputSats) !== args.feeSats) throw new Error('independent Bitcoin fee differs from review');
}

export function assertReferenceRuneAddressBalance(address: string, fixture: RuneFixture, atomic: string): void {
  const state = runeController<{ reference: string; atomic: string }>('rune-address', ['--address', address, '--name', fixture.name]);
  if (state.reference !== '0.27.1' || state.atomic !== atomic) throw new Error('aggregate recipient balance disagrees with pinned ord');
}

export async function prepareRune(page: Page, fixture: RuneFixture, recipient: string, amount: string): Promise<RuneReview> {
  const result = await runeMessage<RuneReview>(page, 'runes.prepare', { runeId: fixture.runeId, recipient, amount, feeRate: '1' });
  if (!result.ok || !result.result) throw new Error(`Rune test preparation rejected: ${result.code ?? 'missing-result'}`);
  return result.result;
}

export async function ownedRuneAddresses(page: Page, password: string): Promise<string[]> {
  return ownedAddresses(page, password, 'ordinals');
}
export async function ownedPaymentAddresses(page: Page, password: string): Promise<string[]> {
  return ownedAddresses(page, password, 'payment');
}
async function ownedAddresses(page: Page, password: string, role: 'payment' | 'ordinals'): Promise<string[]> {
  const exported = await runeMessage<{ definition: { network: string; lanes: Record<'payment' | 'ordinals', { origin: { accountXpub: string } }> } }>(page, 'account.public.export', { password });
  if (!exported.ok || exported.result?.definition.network !== 'regtest') throw new Error('public disposable regtest account export failed');
  const root = HDKey.fromExtendedKey(exported.result.definition.lanes[role].origin.accountXpub, { private: 0x04358394, public: 0x043587cf });
  const addresses: string[] = [];
  for (const branch of [0, 1]) for (let index = 0; index < 32; index += 1) {
    const key = root.deriveChild(branch).deriveChild(index).publicKey;
    if (!key) throw new Error('public Rune derivation failed');
    const address = role === 'ordinals' ? p2tr(key.slice(1), undefined, { ...TEST_NETWORK, bech32: 'bcrt' }).address : p2wpkh(key, { ...TEST_NETWORK, bech32: 'bcrt' }).address;
    if (!address) throw new Error('public Rune address encoding failed');
    addresses.push(address);
  }
  return addresses;
}
