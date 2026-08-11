import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireCore = createRequire(import.meta.url);
const outputRoot = resolve(root, process.env.DREY_BUILD_OUTPUT_ROOT?.trim() || '.output');
const output = join(outputRoot, 'chrome-mv3');
const metadataPath = join(outputRoot, 'm8t-channel.json');
const requestedChannel = process.argv.includes('--channel')
  ? process.argv[process.argv.indexOf('--channel') + 1]
  : 'production';
const requireZip = process.argv.includes('--require-zip');
const fixturePreview = process.argv.includes('--fixture');
const pilotAudit = requestedChannel === 'pilot';
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };
const sorted = (values) => [...values].sort();
const same = (actual, expected) => JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function extensionId(publicKeyBase64) {
  try {
    const der = Buffer.from(publicKeyBase64, 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa') return null;
    return [...createHash('sha256').update(der).digest().subarray(0, 16)]
      .flatMap((byte) => [byte >> 4, byte & 0x0f])
      .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
      .join('');
  } catch {
    return null;
  }
}

// WXT's ZIP command can return while its temporary build-output swap is still
// settling. Keep the standalone audit command deterministic without masking a
// genuinely missing build.
const outputManifest = join(output, 'manifest.json');
const waitDeadline = Date.now() + 5_000;
while (!existsSync(outputManifest) && Date.now() < waitDeadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
}

assert(
  ['production', 'preview', 'pilot', 'test'].includes(requestedChannel),
  'audit channel must be production, preview, pilot, or test',
);

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to audit symlink: ${path}`);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }).sort();
}

function treeDigest(directory) {
  const hash = createHash('sha256');
  for (const file of filesBelow(directory)) {
    hash.update(relative(directory, file).replaceAll('\\', '/')).update('\0');
    hash.update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

const manifest = JSON.parse(readFileSync(outputManifest, 'utf8'));
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
assert(metadata.schemaVersion === 2, 'channel metadata schema mismatch');
assert(metadata.channel === requestedChannel, `expected ${requestedChannel} channel metadata`);
// Production and pilot intentionally carry reviewed mainnet Vault authority;
// preview remains excluded and test carries signet authority.
//
// This asserts the build *configuration* — what the provenance record binds,
// and what the worker's injected capability is derived from. It deliberately
// does not assert that coordinator code is absent from the bundle. Like the
// passkey surface before it, the coordinator's modules are statically imported
// by the wallet service and survive tree-shaking in every channel; what a
// disabled channel lacks is the capability, because `vaultCoordinatorNetwork`
// is never injected and every op refuses without it. A bundle-absence
// assertion here would be vacuous: verified 2026-08-02 that the pilot build,
// whose passkey enrollment is off, still ships the whole passkey settings
// surface for exactly the same reason.
const vaultCoordinatorExpected = requestedChannel === 'test' || requestedChannel === 'pilot' || requestedChannel === 'production';
assert(
  metadata.vaultCoordinatorEnabled === vaultCoordinatorExpected,
  `${requestedChannel} channel must ${vaultCoordinatorExpected ? 'enable' : 'not enable'} the Vault coordinator`,
);
// Test `full` authority is signet-only. Mainnet authority is explicitly named
// `production-mainnet`; no runtime value can promote another channel into it.
assert(
  metadata.vaultCoordinatorMovement !== 'full' || metadata.network === 'signet',
  'an unbounded Vault coordinator must be signet',
);
assert(
  metadata.vaultCoordinatorMovement !== 'production-mainnet' ||
    (metadata.network === 'mainnet' && (requestedChannel === 'pilot' || requestedChannel === 'production')),
  'production Vault authority is restricted to reviewed mainnet channels',
);
assert(
  metadata.vaultCoordinatorEnabled === (metadata.vaultCoordinatorMovement !== null),
  'a Vault coordinator and a Vault movement must exist together',
);
assert(manifest.manifest_version === 3, 'manifest must remain MV3');
assert(
  same(manifest.permissions ?? [], ['storage', 'alarms', 'idle', 'sidePanel']),
  'unexpected extension permissions',
);
assert(!manifest.optional_permissions, 'optional permissions are prohibited');
assert(manifest.minimum_chrome_version === '116', 'side panel requires Chrome 116 or newer');
assert(
  manifest.side_panel?.default_path === 'sidepanel.html',
  'side panel entrypoint mismatch',
);
assert(manifest.action?.default_popup === 'popup.html', 'toolbar popup must remain the default action');
assert(
  same(manifest.sandbox?.pages ?? [], ['inscription-preview.html', 'inscription-media.html']),
  'inscription sandbox pages mismatch',
);
assert(
  manifest.content_security_policy?.sandbox ===
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; connect-src 'none'; media-src blob:; object-src 'none'; frame-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts;",
  'inscription sandbox CSP mismatch',
);
assert(manifest.content_security_policy?.extension_pages?.includes("object-src 'none'"), 'extension pages must prohibit objects');
assert(manifest.content_security_policy?.extension_pages?.includes("base-uri 'none'"), 'extension pages must prohibit base URLs');
assert(!/\b(?:data|blob):/u.test(manifest.content_security_policy?.extension_pages ?? ''), 'extension pages must not permit data: or blob: sources');
assert(manifest.content_scripts?.length === 2, 'expected exactly two provider content scripts');
for (const script of manifest.content_scripts ?? []) {
  assert(
    same(script.matches ?? [], ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']),
    'content script scope must be HTTPS plus explicit development loopback only',
  );
  assert(script.all_frames === true, 'provider scripts must run in all frames');
  assert(script.run_at === 'document_start', 'provider scripts must run at document_start');
}
assert(same((manifest.content_scripts ?? []).map((script) => script.world), ['MAIN', 'ISOLATED']), 'provider worlds must be MAIN and ISOLATED');

const files = filesBelow(output);
assert(files.every((file) => !file.endsWith('.map')), 'source maps must not ship');
assert(files.every((file) => !/(?:^|[/\\])(?:private|secret|entropy|dek)[-_ .]/iu.test(file)), 'private-key material filename found');
for (const file of files.filter((path) => /\.(?:js|html|json|css|txt|pem|key)$/u.test(path))) {
  const contents = readFileSync(file, 'utf8');
  const name = relative(output, file);
  assert(!/sourceMappingURL/u.test(contents), `${name} embeds a source map reference`);
  assert(!/\beval\s*\(/u.test(contents), `${name} contains eval`);
  assert(!/\bnew\s+Function\s*\(/u.test(contents), `${name} contains the Function constructor`);
  assert(!/<script[^>]+src=["']https?:\/\//iu.test(contents), `${name} loads a remote script`);
  assert(!/import\s*\(\s*["']https?:\/\//u.test(contents), `${name} dynamically imports remote code`);
  assert(!/\b(?:ws|wss):\/\//iu.test(contents), `${name} contains a remote/HMR websocket URL`);
  assert(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(contents), `${name} contains a PEM private key`);
  assert(!/\b(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]{20,}\b|\b[KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/u.test(contents), `${name} contains an extended/WIF private key`);
  assert(!/["']?(?:mnemonic|seed(?:_?phrase)?|private_?key|secret_?key|entropy|dek|data_?encryption_?key)["']?\s*[:=]\s*["'][^"'\r\n]{1,4096}["']/iu.test(contents), `${name} contains a sensitive key/value field`);
  // The application legitimately ships BIP39's complete public English
  // wordlist. Remove only that exact ordered corpus before looking for an
  // embedded recovery phrase elsewhere in the artifact.
  const mnemonicSearchText = contents.toLowerCase()
    .replaceAll(english.join(' '), '')
    .replaceAll(english.join('\n'), '');
  let mnemonicFound = false;
  for (const run of mnemonicSearchText.match(/[a-z]+(?:\s+[a-z]+){11,23}/gu) ?? []) {
    const tokens = run.split(/\s+/u);
    for (let start = 0; start < tokens.length && !mnemonicFound; start += 1) {
      for (const count of [24, 21, 18, 15, 12]) {
        const words = tokens.slice(start, start + count);
        if (words.length === count && validateMnemonic(words.join(' '), english)) {
          mnemonicFound = true;
          break;
        }
      }
    }
  }
  assert(!mnemonicFound, `${name} contains a BIP39 recovery phrase`);
}

const approvalHtml = readFileSync(join(output, 'approval.html'), 'utf8');
assert(approvalHtml.includes("default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'"), 'approval page CSP is not isolated');
for (const sandboxPage of ['inscription-preview.html', 'inscription-media.html']) {
  const sandboxHtml = readFileSync(join(output, sandboxPage), 'utf8');
  const sandboxScript = /<script[^>]+src=["']\/?([^"']+)["']/u.exec(sandboxHtml)?.[1];
  assert(typeof sandboxScript === 'string', `${sandboxPage} sandbox script missing`);
  if (sandboxScript) {
    const sandboxJavaScript = readFileSync(join(output, sandboxScript), 'utf8');
    for (const forbidden of [
      'chrome.runtime', 'chrome.storage', 'browser.runtime', 'browser.storage',
      'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage',
      'indexedDB', 'window.opener',
    ]) {
      assert(!sandboxJavaScript.includes(forbidden), `${sandboxPage} contains forbidden capability: ${forbidden}`);
    }
  }
}

// ADR 0007 §6: the Role A recovery page must retain the stable extension
// WebAuthn RP, so it cannot be a sandboxed opaque origin. A page-local CSP is
// therefore the hard network boundary and is deliberately stricter than the
// extension-wide policy. The entry chunk must not acquire an RPC/network
// adapter later; WebAuthn and local file parsing are its only capabilities.
const roleARecoveryHtml = readFileSync(join(output, 'vault-recovery.html'), 'utf8');
assert(
  roleARecoveryHtml.includes("connect-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'"),
  'offline Role A recovery page must prohibit every network/resource channel',
);
const roleARecoveryScript = /<script[^>]+src=["']\/?([^"']*vault-recovery[^"']*\.js)["']/u
  .exec(roleARecoveryHtml)?.[1];
assert(typeof roleARecoveryScript === 'string', 'offline Role A recovery entry script missing');
if (roleARecoveryScript) {
  const recoveryJavaScript = readFileSync(join(output, roleARecoveryScript), 'utf8');
  for (const forbidden of [
    'chrome.runtime.sendMessage', 'chrome.storage', 'browser.runtime', 'browser.storage',
    'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage',
    'indexedDB', 'window.opener',
  ]) {
    assert(!recoveryJavaScript.includes(forbidden), `offline Role A recovery contains forbidden capability: ${forbidden}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const allowedRuntimeDependencies = [
  '@ngraveio/bc-ur', '@noble/curves', '@scure/bip32', '@scure/bip39', '@scure/btc-signer',
  '@drey/core', 'jsqr', 'libsodium-wrappers-sumo', 'qr', 'react', 'react-dom', 'zod',
];
assert(same(Object.keys(packageJson.dependencies ?? {}), allowedRuntimeDependencies), 'unexpected runtime dependency');
for (const prohibited of ['bitcoinjs-lib', '@bitcoinerlab/secp256k1', 'ledger', '@ledgerhq/hw-app-btc']) {
  assert(!(prohibited in (packageJson.dependencies ?? {})), `prohibited Bitcoin stack present: ${prohibited}`);
}

// The provider registry lives in @drey/core (ADR 0005); audit the exact core
// this build resolves.
const registry = readFileSync(
  join(requireCore.resolve('@drey/core/package.json'), '..', 'src', 'provider', 'registry.ts'),
  'utf8',
);
const registryBody = registry.match(/export const PROVIDER_OPERATIONS = \{([\s\S]*?)\n\} satisfies/u)?.[1] ?? '';
const methods = [...registryBody.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*): op\(/gmu)].map((match) => match[1]);
const expectedMethods = [
  'getInfo', 'wallet_connect', 'wallet_disconnect', 'wallet_renouncePermissions',
  'wallet_getCurrentPermissions', 'wallet_requestPermissions', 'wallet_getAccount',
  'wallet_getNetwork', 'getAddresses', 'getAccounts', 'getBalance', 'signMessage',
  'signPsbt', 'sendTransfer', 'ord_getInscriptions', 'ord_sendInscriptions',
];
assert(same(methods, expectedMethods), `provider surface mismatch: ${methods.join(', ')}`);
const shippedJavaScript = files
  .filter((path) => path.endsWith('.js'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
assert(!shippedJavaScript.includes('jsxDEV'), 'development JSX runtime shipped in packaged build');
assert(!shippedJavaScript.includes('react-refresh'), 'React refresh/HMR code shipped in packaged build');
assert(!shippedJavaScript.includes('/src/ui/UiRoot.tsx'), 'absolute development source path shipped');
const scannerGraphMarker = 'DREY_PRODUCTION_VAULT_SCANNER_v1';
assert(
  shippedJavaScript.includes(scannerGraphMarker) ===
    (requestedChannel === 'test' || requestedChannel === 'production'),
  `${requestedChannel} channel scanner graph confinement mismatch`,
);
for (const method of expectedMethods) {
  assert(shippedJavaScript.includes(method), `provider method missing from bundle: ${method}`);
}
// Competitor-style methods this wallet deliberately does not implement. The
// registry check is the precise one; the bundle scan is the belt-and-braces
// half, catching a name that reached the build by some path other than the
// registry — an alias map in the injected provider, say.
const undocumentedProviderMethods = ['pushTx', 'sendBitcoin', 'signTransaction', 'signMultipleTransactions'];

// One class of match is provably not a provider surface: an i18n message key.
// `approval.action.signTransaction` names a button label, and no page can call
// a message key. Rather than loosen the substring scan — which would also stop
// catching `provider.signTransaction = …` — redact the exact key strings and
// leave the scan at full strength everywhere else.
//
// The redaction is deliberately narrow. Only keys that CONTAIN an undocumented
// name are removed, and a key equal to one cannot redact itself, so an i18n
// entry can never be used to hide a real occurrence: the string disappears
// where it appears as that key and nowhere else, and any other occurrence in
// the bundle still fails the assertion below.
const messageCatalogSource = ['en', 'es', 'passkey-en', 'passkey-es', 'vault-en', 'vault-es']
  .map((catalog) => readFileSync(new URL(`../src/ui/i18n/${catalog}.ts`, import.meta.url), 'utf8'))
  .join('\n');
const redactableMessageKeys = [
  ...new Set([...messageCatalogSource.matchAll(/^\s*'([A-Za-z0-9_.]+)':/gmu)].map((match) => match[1])),
].filter((key) =>
  undocumentedProviderMethods.some((method) => key !== method && key.includes(method)),
);
const scannableJavaScript = redactableMessageKeys.reduce(
  (text, key) => text.split(key).join(''),
  shippedJavaScript,
);

for (const undocumented of undocumentedProviderMethods) {
  assert(!methods.includes(undocumented), `undocumented provider method present: ${undocumented}`);
  assert(
    !scannableJavaScript.includes(undocumented),
    `undocumented provider method shipped: ${undocumented}`,
  );
}

if (requestedChannel === 'production' || requestedChannel === 'pilot') {
  assert(manifest.name === (pilotAudit ? 'Drey PILOT' : 'Drey'), 'production identity changed');
  assert(manifest.description === (pilotAudit
    ? 'DISPOSABLE MAINNET VALIDATION — MANUAL TEST WALLET ONLY'
    : 'Non-custodial Bitcoin and Ordinals wallet'),
  `${requestedChannel} description changed`);
  if (pilotAudit) {
    assert(!manifest.key, 'pilot manifest identity key changed');
  } else {
    assert(typeof manifest.key === 'string', 'production manifest public key is missing');
    assert(manifest.key === metadata.manifestPublicKey, 'production manifest public key does not match channel metadata');
    const derivedExtensionId = typeof manifest.key === 'string' ? extensionId(manifest.key) : null;
    assert(derivedExtensionId !== null, 'production manifest public key is not a valid RSA SPKI key');
    assert(/^[a-p]{32}$/u.test(metadata.storeItemId ?? ''), 'production Store item ID is missing or malformed');
    assert(derivedExtensionId === metadata.storeItemId, 'production Store item ID does not match the manifest public key');
    assert(metadata.productionPackagingEnabled === true, 'production packaging gate is not enabled in reviewed source');
  }
  assert(same(Object.values(manifest.icons ?? {}), ['/icon/16.png', '/icon/32.png', '/icon/48.png', '/icon/128.png']), 'production icons changed');
  assert(same(manifest.host_permissions ?? [], ['https://wallet-api.squirrelsystems.net/*']), 'unexpected production host permissions');
  assert(metadata.network === 'mainnet', 'production network must remain mainnet');
  assert(metadata.liveGatewayEnabled === true, 'production gateway wiring changed');
  assert(metadata.gatewayOrigin === 'https://wallet-api.squirrelsystems.net', 'production gateway origin changed');
  assert(/^[0-9a-f]{64}$/u.test(metadata.gatewayPublicKeyHex), 'production gateway public key is empty or malformed');
  assert(metadata.gatewayPublicKeyHex !== '0aa651b5015967c85f088bdbf82b210daf3bd1f5fc0ae35bafc523b029e96ca3', 'production reused the public fixture key');
  if (!pilotAudit) {
    assert(metadata.gatewayPublicKeyHex !== 'eac4a676a0440c4da3909190dcd93f5a42d6291279bb8db9f0841891dec0cb7c', 'production reused the pilot public key');
  }
  assert(sha256(metadata.gatewayPublicKeyHex) !== 'eb74952253d9ec6f81d8863b482ddef5b3625f5033b3cf08f556149e3dc74c35', 'production reused the development key fingerprint');
  assert(JSON.stringify(metadata.gatewayProtocolVersions) === '[2]', 'production must accept gateway protocol v2 only');
  assert(metadata.disposableMainnetPilot === pilotAudit, 'pilot build marker mismatch');

  const productionZip = join(outputRoot, `${packageJson.name}-${packageJson.version}-chrome.zip`);
  let productionZipExists = false;
  try {
    productionZipExists = statSync(productionZip).isFile();
  } catch {
    // Report through the audit accumulator below.
  }
  if (!pilotAudit) assert(productionZipExists, `expected production ZIP ${basename(productionZip)}`);
  if (!pilotAudit && productionZipExists) {
    assert(statSync(productionZip).size > 0, 'production ZIP is empty');
    const listing = execFileSync('unzip', ['-Z1', productionZip], { encoding: 'utf8' }).trim().split('\n');
    const fileListing = listing.filter((name) => !name.endsWith('/'));
    assert(fileListing.length === listing.length, 'production ZIP contains directory entries');
    assert(listing.every((name) => !name.endsWith('.map')), 'production ZIP contains source maps');
    assert(listing.includes('manifest.json'), 'production ZIP has no manifest');
    assert(JSON.stringify(listing) === JSON.stringify(sorted(listing)), 'production ZIP entries are not sorted');
    const expectedListing = files.map((file) => relative(output, file).replaceAll('\\', '/')).sort();
    assert(JSON.stringify(listing) === JSON.stringify(expectedListing), 'production ZIP entries differ from audited output');
    for (const name of fileListing) {
      const archived = execFileSync('unzip', ['-p', productionZip, name], { maxBuffer: 32 * 1024 * 1024 });
      const builtPath = join(output, name);
      assert(existsSync(builtPath), `production ZIP contains unexpected entry ${name}`);
      if (existsSync(builtPath)) {
        assert(archived.equals(readFileSync(builtPath)), `production ZIP bytes differ for ${name}`);
      }
    }
    const verboseListing = execFileSync('unzip', ['-Z', '-v', productionZip], { encoding: 'utf8' });
    const normalizedTimes = verboseListing.match(/file last modified on \(DOS date\/time\):\s+1980 Jan 1 00:00:00/gu) ?? [];
    assert(normalizedTimes.length === listing.length, 'production ZIP timestamps are not normalized to 1980-01-01 UTC');

    const provenancePath = `${productionZip}.provenance.json`;
    assert(existsSync(provenancePath), 'production provenance sidecar is missing');
    if (existsSync(provenancePath)) {
      const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
      assert(provenance.schemaVersion === 1 && provenance.channel === 'production', 'production provenance schema/channel mismatch');
      assert(provenance.artifact.file === basename(productionZip), 'production provenance artifact name mismatch');
      assert(provenance.artifact.sha256 === sha256(readFileSync(productionZip)), 'production provenance ZIP digest mismatch');
      assert(provenance.artifact.contentDigest === treeDigest(output), 'production provenance content digest mismatch');
      assert(provenance.manifest.sha256 === sha256(readFileSync(join(output, 'manifest.json'))), 'production provenance manifest digest mismatch');
      assert(provenance.manifest.extensionId === metadata.storeItemId, 'production provenance Store identity mismatch');
      assert(JSON.stringify(provenance.manifest.value) === JSON.stringify(manifest), 'production provenance manifest value mismatch');
      assert(JSON.stringify(provenance.channelConfiguration) === JSON.stringify(metadata), 'production provenance channel configuration mismatch');
      assert(provenance.workspace.revision === metadata.sourceBinding.workspaceRevision, 'production provenance workspace revision mismatch');
      assert(provenance.workspace.contentDigest === metadata.sourceBinding.workspaceContentDigest, 'production provenance workspace digest mismatch');
      assert(provenance.extension.revision === metadata.sourceBinding.extensionRevision, 'production provenance extension revision mismatch');
      assert(provenance.extension.contentDigest === metadata.sourceBinding.extensionContentDigest, 'production provenance extension digest mismatch');
      assert(provenance.extension.buildOutputContentDigest === metadata.sourceBinding.buildOutputContentDigest, 'production provenance output digest mismatch');
      assert(provenance.gateway.revision === metadata.sourceBinding.gatewayRevision, 'production provenance gateway revision mismatch');
      assert(provenance.gateway.contentDigest === metadata.sourceBinding.gatewayContentDigest, 'production provenance gateway digest mismatch');
      assert(provenance.lockfile.sha256 === metadata.sourceBinding.lockfileSha256, 'production provenance lockfile mismatch');
      for (const repository of ['workspace', 'extension', 'gateway']) {
        assert(typeof provenance[repository]?.tag === 'string' && provenance[repository].tag.length > 0,
          `production provenance ${repository} release tag is missing`);
      }
    }
  }
}

if (requestedChannel === 'test') {
  assert(manifest.name === 'Drey Test', 'test identity is missing');
  assert(metadata.network === 'signet', 'test build must be signet');
  assert(metadata.liveGatewayEnabled === true, 'test fixture gateway must be enabled');
  assert(metadata.gatewayOrigin === 'http://127.0.0.1:18080', 'test gateway must use the dedicated loopback fixture');
  assert(typeof manifest.key === 'string' && manifest.key.length >= 128, 'test manifest needs a stable public key');
  assert(same(manifest.host_permissions ?? [], ['http://127.0.0.1:18080/*']), 'unexpected test host permissions');
}

if (requestedChannel === 'preview') {
  assert(metadata.syntheticPreviewAudit === fixturePreview, 'preview fixture/audit mode mismatch');
  if (!fixturePreview) {
    assert(metadata.previewPackagingEnabled === true, 'real preview packaging gate is not enabled in reviewed source');
  }
  assert(manifest.name.endsWith('BETA'), 'preview beta identity is missing');
  assert(manifest.description?.includes('THIS EXTENSION IS FOR BETA TESTING'), 'preview description is missing');
  assert(metadata.network === 'signet', 'preview build must be signet');
  assert(metadata.liveGatewayEnabled === false, 'preview live gateway must be compile-time disabled');
  assert(/^https:\/\/[^/]+$/u.test(metadata.gatewayOrigin), 'preview gateway must be one HTTPS origin');
  assert(metadata.gatewayOrigin !== 'https://wallet-api.squirrelsystems.net', 'preview gateway reused production');
  assert(/^[0-9a-f]{64}$/u.test(metadata.gatewayPublicKeyHex), 'preview Ed25519 public key is invalid');
  assert(typeof manifest.key === 'string' && manifest.key.length >= 128, 'preview Store manifest public key is missing');
  assert(manifest.key === metadata.manifestPublicKey, 'preview manifest identity does not match channel metadata');
  assert(same(manifest.host_permissions ?? [], [`${metadata.gatewayOrigin}/*`]), 'preview must have exactly one gateway origin');
  assert(same(Object.values(manifest.icons ?? {}), ['/icon-beta/16.png', '/icon-beta/32.png', '/icon-beta/48.png', '/icon-beta/128.png']), 'preview beta icons are missing');
  assert(files.every((file) => !relative(output, file).replaceAll('\\', '/').startsWith('icon/')), 'preview ships production icon fallback assets');
  for (const size of ['16', '32', '48', '128']) {
    assert(
      sha256(readFileSync(join(output, manifest.icons[size]))) !== sha256(readFileSync(join(root, 'public', 'icon', `${size}.png`))),
      `preview ${size}px icon is not distinct`,
    );
  }
  assert(shippedJavaScript.includes('BETA — SIGNET ONLY · NO REAL FUNDS'), 'preview beta banner is missing');
  assert(!shippedJavaScript.includes('https://wallet-api.squirrelsystems.net'), 'production gateway fallback shipped in preview');
  assert(!shippedJavaScript.includes('http://127.0.0.1:'), 'loopback fallback shipped in preview');

  const previewPattern = fixturePreview
    ? /^drey-preview-fixture-.*-chrome\.zip$/u
    : /^drey-preview-(?!fixture-).*-chrome\.zip$/u;
  const previewZips = readdirSync(outputRoot).filter((name) => previewPattern.test(name));
  assert(!requireZip || previewZips.length === 1, 'expected exactly one deterministic preview ZIP');
  if (previewZips.length === 1) {
    const zipPath = join(outputRoot, previewZips[0]);
    const provenancePath = `${zipPath}.provenance.json`;
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    assert(provenance.schemaVersion === 2, 'provenance schema mismatch');
    assert(provenance.syntheticFixture === fixturePreview, 'provenance fixture marker mismatch');
    assert(provenance.artifact.file === basename(zipPath), 'provenance artifact name mismatch');
    assert(provenance.artifact.sha256 === sha256(readFileSync(zipPath)), 'provenance ZIP digest mismatch');
    assert(provenance.artifact.contentDigest === treeDigest(output), 'provenance output content digest mismatch');
    assert(provenance.lockfile.sha256 === sha256(readFileSync(join(root, 'pnpm-lock.yaml'))), 'provenance lockfile digest mismatch');
    assert(provenance.manifest.sha256 === sha256(readFileSync(join(output, 'manifest.json'))), 'provenance manifest digest mismatch');
    assert(JSON.stringify(provenance.manifest.value) === JSON.stringify(manifest), 'provenance manifest value mismatch');
    assert(JSON.stringify(provenance.channelConfiguration) === JSON.stringify(metadata), 'provenance channel configuration mismatch');
    assert(provenance.workspace.revision === metadata.sourceBinding.workspaceRevision, 'provenance workspace revision is not build-bound');
    assert(provenance.workspace.contentDigest === metadata.sourceBinding.workspaceContentDigest, 'provenance workspace digest is not build-bound');
    assert(provenance.extension.revision === metadata.sourceBinding.extensionRevision, 'provenance extension revision is not build-bound');
    assert(provenance.extension.contentDigest === metadata.sourceBinding.extensionContentDigest, 'provenance extension digest is not build-bound');
    assert(provenance.extension.buildOutputContentDigest === metadata.sourceBinding.buildOutputContentDigest, 'provenance build-output digest is not build-bound');
    assert(provenance.fixture.revision === metadata.sourceBinding.gatewayRevision, 'provenance gateway revision is not build-bound');
    assert(provenance.fixture.contentDigest === metadata.sourceBinding.gatewayContentDigest, 'provenance gateway digest is not build-bound');
    assert(provenance.lockfile.sha256 === metadata.sourceBinding.lockfileSha256, 'provenance lockfile is not build-bound');
    const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
    assert(JSON.stringify(listing) === JSON.stringify(sorted(listing)), 'preview ZIP entries are not sorted');
    const expectedListing = files.map((file) => relative(output, file).replaceAll('\\', '/')).sort();
    assert(JSON.stringify(listing) === JSON.stringify(expectedListing), 'preview ZIP entries differ from audited output');
    for (const name of listing) {
      const archived = execFileSync('unzip', ['-p', zipPath, name], { maxBuffer: 32 * 1024 * 1024 });
      assert(archived.equals(readFileSync(join(output, name))), `preview ZIP bytes differ for ${name}`);
    }
    const verboseListing = execFileSync('unzip', ['-Z', '-v', zipPath], { encoding: 'utf8' });
    const normalizedTimes = verboseListing.match(/file last modified on \(DOS date\/time\):\s+1980 Jan 1 00:00:00/gu) ?? [];
    assert(normalizedTimes.length === listing.length, 'preview ZIP timestamps are not normalized to 1980-01-01 UTC');
    assert(listing.every((name) => !name.endsWith('.map')), 'preview ZIP contains source maps');
    assert(listing.includes('manifest.json'), 'preview ZIP has no manifest');
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`${requestedChannel} audit passed: ${files.length} files, ${methods.length} provider methods.`);
}
