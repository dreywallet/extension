/**
 * The ADR 0007 §8.1 disposable-mainnet Vault round trip.
 *
 * Deposit real bitcoin from a throwaway Spending wallet into a real 2-of-3
 * Vault, then withdraw it back — against the deployed mainnet gateway, with
 * real tips, real classification evidence, and two real broadcasts. It is the
 * one proof that cannot be simulated: no signet gateway anywhere serves the
 * Full Sat Safety capability set a Vault requires, so a signet Vault refuses at
 * the scan step and never reaches signing.
 *
 * **Deliberately not a test.** It is an operator script: no retries, no watch
 * mode, no assertion framework, and unreachable from `pnpm test`, `ci:*`, and
 * the E2E runner. A vitest file that spends real money would eventually be run
 * by something that runs vitest files.
 *
 * **What it proves and what it does not.** Roles B and C live in this same
 * process, on the same machine as role A. Three roots exist and the 2-of-3
 * script is real, so the code path is exercised end to end — but a single
 * compromised machine holds a quorum, and ADR 0007 §8.1 says outright that this
 * makes no independence claim. The §6 offline Recovery C ceremony is still owed.
 *
 * **Secrets.** Roles B and C are freshly generated and written to
 * `.env.pilot.local`, which `.gitignore` covers, at mode 0600. The Spending
 * wallet and role A live only in `.pilot-state/`, encrypted under the pilot
 * password, also gitignored. Nothing secret is printed, passed on a command
 * line, or written anywhere else — the pilot mnemonics are deliberately absent
 * from `audit:e2e-artifacts`'s allowlist, so a leak fails that audit loudly.
 *
 * This script chooses no network, gateway, or authority of its own. It uses the
 * reviewed production-mainnet capability while remaining confined to the
 * separately authorized disposable pilot wallet.
 */
import { createInterface } from 'node:readline/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { HDKey } from '@scure/bip32';

import { createLibsodiumCryptoProvider } from '../src/adapters/crypto/libsodium-provider';
import { setCryptoProvider } from '@drey/core/domain/vault/crypto-provider';
import { webCryptoDeps } from '@drey/core/domain/vault/vault';
import { calibrateArgon2id, makeKdfBenchmark } from '@drey/core/domain/vault/calibrate';
import { GatewayClient } from '@drey/core/gateway-client';
import { generateMnemonic, mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import { bip32Versions } from '@drey/core/domain/vault/multisig-contracts';
import {
  serializeVaultProofResult,
  serializeVaultSignerOrigin,
  parseCanonicalVaultPlan,
} from '@drey/core/domain/vault/multisig-encoding';
import type { VaultSignerOriginV1 } from '@drey/core/domain/vault/multisig-contracts';

import { resolveBuildChannel } from '../src/build/channel';
import { WalletService } from '../src/background/wallet-service';
import { MemoryWalletCache } from '../src/adapters/storage/wallet-cache-idb';
import {
  deriveVaultRoleOrigin,
  signVaultProofOfPossession,
} from '@drey/core/domain/vault/multisig-role';
import { composeVaultPolicyRecord } from '../src/background/vault-policy';
import { signVaultPlanAsRole } from '../src/background/vault-signing';
import { resolveVaultCoordinatorCapability } from '../src/background/vault-capability';
import { loadVaultApprovedPlans } from '../src/adapters/storage/vault-coordinator-store';
import type { StorageArea } from '../src/adapters/storage/area';
import type { SessionArea } from '../src/adapters/session/session-store';

const ROOT = new URL('..', import.meta.url).pathname;
const ENV_FILE = join(ROOT, '.env.pilot.local');
const STATE_DIR = join(ROOT, '.pilot-state');
const STATE_FILE = join(STATE_DIR, 'local.json');

/** Enough to pay two mainnet fees and still leave a visible amount moving. */
const FUNDING_TARGET_SATS = 50_000n;
/** Poll cadence while waiting on a human or on the chain. */
const POLL_MS = 15_000;

const line = (message = ''): void => {
  stdout.write(`${message}\n`);
};
const step = (message: string): void => line(`\n── ${message}`);

// ---------------------------------------------------------------------------
// Storage: a JSON file for `chrome.storage.local`, memory for `.session`.
//
// The local half must survive a run, because it holds the throwaway Spending
// wallet that ends the round trip holding the money. The session half must not:
// it holds a DEK, and a DEK on disk would be the one genuinely dangerous thing
// this script could leave behind.
// ---------------------------------------------------------------------------

function memoryArea(): SessionArea {
  const map = new Map<string, unknown>();
  return {
    get: (keys) => {
      const list = typeof keys === 'string' ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const key of list) if (map.has(key)) out[key] = map.get(key);
      return Promise.resolve(out);
    },
    set: (items) => {
      for (const [key, value] of Object.entries(items)) map.set(key, value);
      return Promise.resolve();
    },
    remove: (keys) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) map.delete(key);
      return Promise.resolve();
    },
    setAccessLevel: () => Promise.resolve(),
  };
}

async function fileArea(): Promise<StorageArea> {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8')) as Record<string, unknown>;
  } catch {
    state = {};
  }
  const flush = (): Promise<void> =>
    writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return {
    get: (keys) => {
      const list = typeof keys === 'string' ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const key of list) if (key in state) out[key] = state[key];
      return Promise.resolve(out);
    },
    set: async (items) => {
      Object.assign(state, items);
      await flush();
    },
    remove: async (keys) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key];
      await flush();
    },
  };
}

// ---------------------------------------------------------------------------
// The gitignored operator secrets.
// ---------------------------------------------------------------------------

interface PilotSecrets {
  password: string;
  roleB: string;
  roleC: string;
  /** Present only if the operator kept role A's words to restore from (R1). */
  roleA: string | undefined;
}

/**
 * Read `.env.pilot.local`, generating whatever is missing.
 *
 * Roles B and C are generated here and only here. Reusing the committed fixture
 * roots would be the worst possible shortcut: their mnemonics are public, so
 * anyone with repository access would hold two of three keys and could spend
 * the Vault outright.
 */
async function loadSecrets(): Promise<PilotSecrets> {
  let existing: Record<string, string> = {};
  try {
    existing = Object.fromEntries(
      (await readFile(ENV_FILE, 'utf8'))
        .split('\n')
        .filter((row) => row.trim() !== '' && !row.trimStart().startsWith('#'))
        .map((row) => {
          const at = row.indexOf('=');
          return [row.slice(0, at).trim(), row.slice(at + 1).trim()] as const;
        }),
    );
  } catch {
    existing = {};
  }
  const random = webCryptoDeps().random;
  const fresh = (): string => generateMnemonic(random).mnemonic;
  const secrets: PilotSecrets = {
    password: existing['DREY_PILOT_PASSWORD'] ?? bytesToHex(random(24)),
    roleB: existing['DREY_PILOT_ROLE_B_MNEMONIC'] ?? fresh(),
    roleC: existing['DREY_PILOT_ROLE_C_MNEMONIC'] ?? fresh(),
    roleA: existing['DREY_PILOT_ROLE_A_MNEMONIC'],
  };
  await writeFile(
    ENV_FILE,
    [
      '# ADR 0007 §8.1 disposable-mainnet Vault pilot — GITIGNORED, NEVER COMMIT.',
      '# Freshly generated mainnet roots for Vault roles B and C. They are',
      '# disposable and hold no value of their own, but together they are a',
      '# 2-of-3 quorum over whatever the pilot Vault holds.',
      '#',
      '# DREY_PILOT_ROLE_A_MNEMONIC is optional. Role A is created by the',
      '# coordinator and lives encrypted in .pilot-state/; set this only if you',
      '# want the R1 restore path to rebuild it after that state is lost.',
      `DREY_PILOT_PASSWORD=${secrets.password}`,
      `DREY_PILOT_ROLE_B_MNEMONIC=${secrets.roleB}`,
      `DREY_PILOT_ROLE_C_MNEMONIC=${secrets.roleC}`,
      ...(secrets.roleA === undefined ? [] : [`DREY_PILOT_ROLE_A_MNEMONIC=${secrets.roleA}`]),
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return secrets;
}

// ---------------------------------------------------------------------------
// The two human gates.
// ---------------------------------------------------------------------------

const rl = createInterface({ input: stdin, output: stdout });

/**
 * The typed confirmation the root instructions require before a mainnet
 * broadcast. Everything else in this script is automated; this is not, and the
 * exact word is demanded rather than a y/n so a reflex keypress cannot spend.
 */
async function confirmBroadcast(what: string, facts: Record<string, string>): Promise<void> {
  line();
  line(`!! ABOUT TO BROADCAST ON MAINNET: ${what}`);
  for (const [key, value] of Object.entries(facts)) line(`   ${key.padEnd(14)} ${value}`);
  const answer = await rl.question('   Type BROADCAST to send, anything else to abort: ');
  if (answer.trim() !== 'BROADCAST') {
    line('   Aborted. Nothing was sent.');
    process.exit(1);
  }
}

async function waitUntil(what: string, ready: () => Promise<boolean>): Promise<void> {
  for (;;) {
    if (await ready()) return;
    line(`   waiting for ${what}…`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Every compile-time fact comes from the reviewed channel table. This script
  // picks no network, no gateway, no key, and no movement of its own, so it
  // cannot run anywhere the `pilot` build could not.
  const channel = resolveBuildChannel('pilot');
  const capability = resolveVaultCoordinatorCapability(
    channel.network === 'mainnet' ? 'mainnet' : 'signet',
    channel.vaultCoordinatorMovement ?? 'unsigned-only',
  );
  if (
    channel.network !== 'mainnet' ||
    channel.vaultCoordinatorMovement !== 'production-mainnet' ||
    !channel.liveGatewayEnabled ||
    capability === undefined ||
    capability.movement !== 'production-mainnet'
  ) {
    throw new Error('the pilot channel is not the reviewed production-mainnet coordinator');
  }
  line('Drey — disposable-mainnet Vault round trip');
  line(`  gateway   ${channel.gatewayOrigin}`);
  line('  This pilot proves the code path. It makes NO independence claim:');
  line('  all three roles are held by this one process on this one machine.');

  setCryptoProvider(await createLibsodiumCryptoProvider());
  const secrets = await loadSecrets();
  const local = await fileArea();
  const service = new WalletService({
    local,
    session: memoryArea(),
    vaultDeps: webCryptoDeps(),
    calibrateKdf: () => calibrateArgon2id({ benchmark: makeKdfBenchmark() }),
    newVaultId: () => globalThis.crypto.randomUUID(),
    newSessionId: () => globalThis.crypto.randomUUID(),
    network: channel.network,
    vaultCoordinatorCapability: capability,
    walletCache: new MemoryWalletCache(),
    gateway: new GatewayClient({
      fetchFn: globalThis.fetch.bind(globalThis),
      baseUrl: channel.gatewayOrigin,
      publicKeyHex: channel.gatewayPublicKeyHex,
      expectedNetwork: channel.network,
      allowedProtocolVersions: channel.gatewayProtocolVersions,
      randomNonce: () => bytesToHex(webCryptoDeps().random(16)),
      retryJitterMs: () => 250,
      now: () => Date.now(),
    }),
  });
  await service.init();

  // ---- 1. the throwaway Spending wallet ------------------------------------
  step('Spending wallet');
  const vaults = await service.list();
  const vaultId =
    vaults.vaults[0]?.vaultId ??
    (
      await service.create({
        name: 'Pilot Spending',
        password: secrets.password,
        operationId: globalThis.crypto.randomUUID(),
      })
    ).vaultId;
  const { sessionId } = await service.unlock({ vaultId, password: secrets.password });
  const accountId = (await service.sessionSnapshot()).activeAccountId;
  if (accountId === null) throw new Error('missing active Spending account identity');
  const expectation = { expectedVaultId: vaultId, expectedSessionId: sessionId, accountId };
  if (!(await service.backupStatus({ ...expectation })).backupVerified) {
    // The wallet refuses to hand out a receive address until the backup is
    // confirmed. This one is disposable and its words never leave the process.
    const revealed = await service.revealMnemonic({ password: secrets.password, ...expectation });
    const words = revealed.mnemonic.split(' ');
    await service.verifyBackup({
      words: [0, 5, 11].map((index) => ({ index, word: words[index]! })),
      ...expectation,
    });
  }
  const receive = await service.receiveAddress({ kind: 'payment', ...expectation });
  line(`  Spending receive address: ${receive.address}`);

  // The rate this listing prices eligibility at, not the rate anything pays.
  // Kept nominal so a hot mempool cannot make a balance read refuse; the fee
  // actually paid is quoted, capped, and refused separately below.
  const LISTING_FEE_RATE_SAT_PER_KVB = 1000;
  const spendable = async (): Promise<bigint> => {
    const feeRateSatPerKvB = LISTING_FEE_RATE_SAT_PER_KVB;
    await service.startScan({ mode: 'refresh', ...expectation });
    await waitUntil('the Spending scan', async () => {
      const status = await service.scanStatus({ ...expectation });
      return status.kind !== 'running';
    });
    const utxos = await service.listUtxos({ feeRateSatPerKvB, ...expectation });
    return utxos.utxos
      .filter((utxo) => utxo.eligible && utxo.classification === 'cardinal_clean')
      .reduce((total, utxo) => total + BigInt(utxo.valueSats), 0n);
  };

  // Deliberately not waited on here. Once a deposit has been made the Spending
  // wallet legitimately holds less than the funding target, and a resumed run
  // must not sit waiting for money it already moved into the Vault. The funding
  // gate belongs to the deposit step, which is the only thing that needs it.
  line(`  Spendable: ${await spendable()} sats`);

  // ---- 2. the Vault: role A, both peers, the policy ------------------------
  step('Vault policy');
  const status = await service.vaultCoordinatorStatus({ ...expectation });
  if (status.role === 'absent') {
    // R1's restore path when the operator kept the words, generation otherwise.
    if (secrets.roleA === undefined) {
      await service.vaultCoordinatorCreateRole({
        password: secrets.password,
        label: 'Pilot Desktop A',
        ...expectation,
      });
    } else {
      await service.vaultCoordinatorRestoreRole({
        password: secrets.password,
        label: 'Pilot Desktop A',
        mnemonic: secrets.roleA,
        ...expectation,
      });
    }
  }
  const roleA = (await service.vaultCoordinatorRoleOrigin({ ...expectation })).role!;

  /** A peer signer, exactly as a separate device would present itself. */
  const peer = (mnemonic: string, role: 'mobile-b' | 'recovery-c') => {
    const seed = mnemonicToSeed(mnemonic);
    return {
      origin: deriveVaultRoleOrigin(seed, role, 'mainnet') as VaultSignerOriginV1,
      root: HDKey.fromMasterSeed(seed, bip32Versions('mainnet')),
      seed,
    };
  };
  const peerB = peer(secrets.roleB, 'mobile-b');
  const peerC = peer(secrets.roleC, 'recovery-c');

  if ((await service.vaultCoordinatorStatus({ ...expectation })).policy !== 'present') {
    const challenge = await service.vaultCoordinatorBeginImport({ ...expectation });
    for (const [role, held] of [
      ['mobile-b', peerB],
      ['recovery-c', peerC],
    ] as const) {
      const proof = signVaultProofOfPossession(held.seed, {
        version: 1,
        origin: held.origin,
        sessionIdHex: challenge.sessionIdHex,
        challengeNonceHex: challenge.challengeNonceHex,
        transcriptHashHex: challenge.transcriptHashHex,
        expiresAtMs: challenge.expiresAtMs,
      });
      await service.vaultCoordinatorImportSigner({
        role,
        originHex: bytesToHex(serializeVaultSignerOrigin(held.origin)),
        proofResultHex: bytesToHex(serializeVaultProofResult(proof)),
        ...expectation,
      });
    }
    await service.vaultCoordinatorCreatePolicy({
      password: secrets.password,
      vaultLabel: 'Pilot Vault',
      signerLabels: ['Desktop A', 'Peer B', 'Peer C'],
      birthdayHeight: null,
      ...expectation,
    });
  }
  const policy = (await service.vaultCoordinatorPolicy({ ...expectation })).policy!;
  line(`  policyId  ${policy.policyId}`);
  // Recomposed from the same three origins the coordinator holds, so role B can
  // run the B3-safe signer over the identity rather than over a summary of it.
  const identity = composeVaultPolicyRecord(
    'mainnet',
    [roleA.origin as VaultSignerOriginV1, peerB.origin, peerC.origin],
    {
      createdAtMs: String(policy.createdAt),
      birthdayHeight: policy.birthdayHeight,
      vaultLabel: policy.vaultLabel,
      signerLabels: policy.signers.map((signer) => signer.label) as [string, string, string],
    },
  ).identity;
  if (identity.policyId !== policy.policyId) {
    throw new Error('recomposed policy does not reproduce the coordinator policyId');
  }

  // ---- 3. the fee rate this run may pay ------------------------------------
  const quote = await service.feeQuote({ ...expectation });
  // Round up to whole sat/vB, which is what the Spending planner takes.
  const satPerVb = Math.ceil(quote.standardSatPerKvB / 1000);
  const satPerKvB = BigInt(satPerVb) * 1000n;
  line(`  fee rate  ${satPerVb} sat/vB`);

  // ---- 4. deposit: an ordinary Spending send to a proved Vault address -----
  //
  // Not a Vault plan, and it never could be: every VaultPlanInputV1 needs a
  // witness script and is proved Vault-owned, and a deposit spends S's inputs.
  // All the Vault contributes is an address it regenerates from its own policy.
  step('Deposit (Spending → Vault)');
  const vaultScan = () => service.vaultCoordinatorScan({ ...expectation });
  let vaultState = await vaultScan();
  if (vaultState.refusal !== null) throw new Error(`Vault is read-only: ${vaultState.refusal}`);

  if (BigInt(vaultState.balance?.movableSats ?? '0') === 0n) {
    // Only now does the Spending balance matter, so only now is it a gate.
    let balance = await spendable();
    if (balance < FUNDING_TARGET_SATS) {
      line(`  Fund ${receive.address} with about ${FUNDING_TARGET_SATS} sats. Have: ${balance}.`);
      await waitUntil('funding to confirm', async () => {
        balance = await spendable();
        return balance >= FUNDING_TARGET_SATS;
      });
    }
    const deposit = await service.vaultCoordinatorDepositAddress({ index: 0, ...expectation });
    const amount = balance / 2n;
    const planned = await service.createTransactionPlan({
      kind: 'native_send',
      account: 0,
      recipient: deposit.address,
      amountSats: amount.toString(),
      sendMax: false,
      fee: { type: 'custom', rateSatPerVb: String(satPerVb) },
      ...expectation,
    });
    await confirmBroadcast('deposit into the Vault', {
      destination: deposit.address,
      amount: `${amount} sats`,
      fee: `${planned.review.feeSats} sats`,
      'fee rate': `${satPerVb} sat/vB`,
      vsize: planned.review.vsize,
    });
    const sent = await service.approveTransaction({
      planId: planned.planId,
      planHash: planned.planHash,
      password: secrets.password,
      ...expectation,
    });
    line(`  broadcast ${sent.status} — ${sent.txid ?? '(no txid)'}`);
    await waitUntil('the deposit to confirm in the Vault', async () => {
      vaultState = await vaultScan();
      return (
        vaultState.refusal === null && BigInt(vaultState.balance?.movableSats ?? '0') > 0n
      );
    });
  }
  line(`  Vault movable: ${vaultState.balance?.movableSats ?? '0'} sats`);

  // ---- 5. withdraw: build, sign A, sign B, combine, finalize, send ---------
  step('Withdrawal (Vault → Spending)');
  const movable = BigInt(vaultState.balance!.movableSats);
  // Leave the fee behind rather than sweeping: the planner solves the exact fee
  // and refuses if the remainder cannot cover it, and a headroom that is too
  // small simply fails loudly before anything is signed.
  const withdrawSats = movable - (satPerKvB * 400n) / 1000n;
  if (withdrawSats <= 0n) throw new Error('Vault balance cannot cover a withdrawal fee');

  const built = await service.vaultCoordinatorBuildPlan({
    amountSats: withdrawSats.toString(),
    feeRateSatPerKvB: satPerKvB.toString(),
    ...expectation,
  });
  const signedA = await service.vaultCoordinatorSignPlan({
    password: secrets.password,
    ...expectation,
  });

  // Role B signs as a paired device would: the same B3-safe wrapper, over the
  // same plan and evidence, with its own root. It is handed the plan and the
  // evidence directly rather than over a transport, because there is no second
  // process here to be the other end of one — the transport itself is proven by
  // `combinePlan`, which takes PSBT hex and nothing else.
  const record = (await loadVaultApprovedPlans(local)).find(
    (entry) => entry.planId === built.plan.planId,
  )!;
  const signedB = signVaultPlanAsRole({
    capability,
    policy: identity,
    plan: parseCanonicalVaultPlan(hexToBytes(record.canonicalPlanHex)),
    evidence: record.evidence,
    nowMs: String(Date.now()),
    role: 'mobile-b',
    signerRoot: peerB.root,
    psbtHex: built.psbtHex,
  });

  const combined = await service.vaultCoordinatorCombinePlan({
    psbtHexes: [signedA.signedPsbtHex, signedB.signedPsbtHex],
    ...expectation,
  });
  const finalized = await service.vaultCoordinatorFinalizePlan({
    psbtHex: combined.psbtHex,
    ...expectation,
  });
  await confirmBroadcast('withdrawal out of the Vault', {
    destination: built.plan.destinationAddress,
    amount: `${built.plan.amountSats} sats`,
    fee: `${built.plan.feeSats} sats`,
    'fee rate': `${built.plan.feeRateSatPerKvB} sat/kvB`,
    vsize: String(finalized.vsize),
  });
  const outcome = await service.vaultCoordinatorBroadcastPlan({
    transactionHex: finalized.transactionHex,
    ...expectation,
  });
  line(`  broadcast ${outcome.status} — ${outcome.txid}`);
  if (outcome.status === 'indeterminate') {
    line('  The outcome is NOT known. The exact bytes are kept in .pilot-state/;');
    line('  establish what is on chain before anything else touches this plan.');
    process.exitCode = 2;
    return;
  }
  // Only these three mean the network took it. `rejected` and `conflicted` are
  // failures, and reporting either as a completed round trip would be the worst
  // kind of wrong answer — the money is still in the Vault and the operator
  // would have been told otherwise.
  if (!['accepted', 'already_known', 'confirmed'].includes(outcome.status)) {
    line(`  The network refused it: ${outcome.detail ?? '(no detail)'}`);
    line('  Nothing moved. The plan is spent as far as this coordinator is');
    line('  concerned; discard it and build a new one from a fresh scan.');
    process.exitCode = 1;
    return;
  }

  step('Round trip complete');
  line(`  withdrawal  ${combined.roles.join(' + ')} quorum, ${finalized.txid}`);
  line('  Run `pnpm audit:e2e-artifacts` now. The pilot mnemonics are absent');
  line('  from its allowlist on purpose: a leak must fail it loudly.');

  peerB.seed.fill(0);
  peerC.seed.fill(0);
  peerB.root.wipePrivateData();
  peerC.root.wipePrivateData();
}

try {
  await main();
} finally {
  rl.close();
}
