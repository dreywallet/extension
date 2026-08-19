import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { UR, URDecoder, UREncoder } from '@ngraveio/bc-ur';
import encodeQr from 'qr';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.resolve(scriptDirectory, '..');
const workspaceDirectory = path.resolve(extensionDirectory, '..');
const vectorPath = path.join(workspaceDirectory, 'core', 'vectors', 'vault-recovery-plan-v1.json');
const outputPath = process.argv[2] ?? '/private/tmp/drey-jade-public-psbt-probe.html';
const maxFragmentLength = Number(process.argv[3] ?? '60');
if (!Number.isSafeInteger(maxFragmentLength) || maxFragmentLength < 10 || maxFragmentLength > 200) {
  throw new RangeError('fragment length must be an integer from 10 through 200 bytes');
}

const vectors = JSON.parse(await readFile(vectorPath, 'utf8'));
const probe = vectors.records.signet.cases.sweep;
const psbt = Buffer.from(probe.unsignedPsbtHex, 'hex');
const cbor = UR.fromBuffer(psbt).cbor;
const encoder = new UREncoder(new UR(cbor, 'crypto-psbt'), maxFragmentLength, 0, 10);
const frames = encoder.encodeWhole();

const decoder = new URDecoder();
for (const frame of frames) decoder.receivePart(frame);
if (!decoder.isComplete() || !decoder.isSuccess()) {
  throw new Error(`generated UR sequence did not decode: ${decoder.resultError()}`);
}
const decoded = decoder.resultUR();
if (decoded.type !== 'crypto-psbt' || !decoded.decodeCBOR().equals(psbt)) {
  throw new Error('generated UR sequence did not reproduce the source PSBT');
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function qrSvg(value, index) {
  const matrix = encodeQr(value, 'raw', { ecc: 'medium', border: 4 });
  const pathParts = [];
  for (let y = 0; y < matrix.length; y += 1) {
    const row = matrix[y];
    for (let x = 0; x < row.length;) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (row[x]) x += 1;
      pathParts.push(`M${start} ${y}h${x - start}v1H${start}z`);
    }
  }
  const pixelSize = matrix.length * 10;
  return `<svg class="frame${index === 0 ? ' current' : ''}" data-frame="${index}" role="img" ` +
    `aria-label="PSBT QR frame ${index + 1} of ${frames.length}" viewBox="0 0 ${matrix.length} ${matrix.length}" ` +
    `width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges">` +
    `<rect width="${matrix.length}" height="${matrix.length}" fill="#fff"/>` +
    `<path d="${pathParts.join('')}" fill="#000"/></svg>`;
}

const destination = probe.plan.destination.address;
const psbtDigest = createHash('sha256').update(psbt).digest('hex');
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Drey Jade public PSBT probe</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0b0f16; color: #edf2f7; }
    main { min-height: 100vh; display: grid; grid-template-columns: minmax(420px, 58vh) minmax(320px, 1fr); gap: 28px; align-items: center; max-width: 1180px; margin: auto; padding: 28px; box-sizing: border-box; }
    .qr { width: 100%; aspect-ratio: 1; background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 0 0 2px #f5a65b; }
    .frame { display: none; width: 100%; height: 100%; }
    .frame.current { display: block; }
    h1 { margin-top: 0; font-size: 28px; }
    .warning { color: #ffbd73; font-weight: 700; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 14px; }
    dt { color: #aab5c3; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-size: 12px; }
    .controls { display: flex; gap: 10px; margin-top: 20px; }
    button { border: 1px solid #657286; border-radius: 8px; background: #1d2735; color: #fff; padding: 10px 16px; font: inherit; cursor: pointer; }
    #counter { font-variant-numeric: tabular-nums; }
    @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="qr">${frames.map(qrSvg).join('')}</div>
    <section>
      <h1>Drey Jade PSBT compatibility probe</h1>
      <p class="warning">PUBLIC SIGNET FIXTURE · NONEXISTENT INPUTS · CANNOT MOVE FUNDS</p>
      <p>On the device, scan this from <strong>Scan QR</strong>. Review the values before approving.</p>
      <dl>
        <dt>Network</dt><dd>Signet / testnet</dd>
        <dt>Inputs</dt><dd>${probe.plan.inputs.length} nonexistent fixture outpoints</dd>
        <dt>Destination</dt><dd><code>${escapeHtml(destination)}</code></dd>
        <dt>Amount</dt><dd>${escapeHtml(probe.plan.amountSats)} sats</dd>
        <dt>Fee</dt><dd>${escapeHtml(probe.plan.feeSats)} sats</dd>
        <dt>UR type</dt><dd><code>crypto-psbt</code></dd>
        <dt>PSBT SHA-256</dt><dd><code>${psbtDigest}</code></dd>
        <dt>Frame</dt><dd id="counter">1 / ${frames.length}</dd>
      </dl>
      <div class="controls">
        <button id="previous" type="button">Previous</button>
        <button id="toggle" type="button">Pause</button>
        <button id="next" type="button">Next</button>
      </div>
    </section>
  </main>
  <script>
    const nodes = [...document.querySelectorAll('.frame')];
    const counter = document.querySelector('#counter');
    const toggle = document.querySelector('#toggle');
    let index = 0;
    let running = true;
    function show(next) {
      nodes[index].classList.remove('current');
      index = (next + nodes.length) % nodes.length;
      nodes[index].classList.add('current');
      counter.textContent = (index + 1) + ' / ' + nodes.length;
    }
    const timer = setInterval(() => { if (running) show(index + 1); }, 1500);
    document.querySelector('#previous').addEventListener('click', () => show(index - 1));
    document.querySelector('#next').addEventListener('click', () => show(index + 1));
    toggle.addEventListener('click', () => {
      running = !running;
      toggle.textContent = running ? 'Pause' : 'Play';
    });
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  </script>
</body>
</html>`;

await writeFile(outputPath, html, { encoding: 'utf8', mode: 0o600 });
const framePaths = [];
for (let index = 0; index < frames.length; index += 1) {
  const frameNumber = String(index + 1).padStart(3, '0');
  const framePath = `/private/tmp/drey-jade-public-psbt-low-frame-${frameNumber}.svg`;
  await writeFile(framePath, qrSvg(frames[index], index), { encoding: 'utf8', mode: 0o600 });
  framePaths.push(framePath);
}
console.log(JSON.stringify({
  outputPath,
  framePaths,
  network: probe.plan.network,
  frameCount: frames.length,
  maxFragmentLength,
  psbtBytes: psbt.length,
  psbtSha256: psbtDigest,
  destination,
  amountSats: probe.plan.amountSats,
  feeSats: probe.plan.feeSats,
}, null, 2));
