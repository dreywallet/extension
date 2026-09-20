import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function selectRegtestProject(args, environmentProject) {
  const remaining = [];
  let argumentProject;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--project' || argument.startsWith('--project=')) {
      if (argumentProject !== undefined) throw new Error('duplicate regtest project');
      argumentProject = argument === '--project' ? args[++index] : argument.slice('--project='.length);
      if (argumentProject === undefined) throw new Error('missing regtest project');
    } else if (argument !== '--') remaining.push(argument);
  }
  if (argumentProject !== undefined && environmentProject !== undefined && argumentProject !== environmentProject) throw new Error('regtest project argument disagrees with DREY_REGTEST_PROJECT');
  const project = argumentProject ?? environmentProject ?? 'drey-regtest';
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/u.test(project)) throw new Error('invalid regtest project');
  return { project, args: remaining };
}

export function parseRegtestProject(text, project, publicKey) {
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/u.test(project)) throw new Error('invalid regtest project');
  if (text.length > 65_536) throw new Error('regtest project configuration exceeds bound');
  const names = ['DREY_REGTEST_PROJECT', 'DREY_REGTEST_GATEWAY_PUBLIC_KEY_HEX', 'DREY_REGTEST_GATEWAY_PORT', 'DREY_REGTEST_CORE_RPC_PORT', 'DREY_REGTEST_ORD_PORT'];
  const values = new Map();
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    if (!names.includes(key)) continue;
    if (values.has(key)) throw new Error('duplicate regtest project setting');
    values.set(key, line.slice(index + 1));
  }
  if (values.get('DREY_REGTEST_PROJECT') !== project || !/^[0-9a-f]{64}$/u.test(publicKey) || values.get('DREY_REGTEST_GATEWAY_PUBLIC_KEY_HEX') !== publicKey) throw new Error('regtest project identity does not match its public binding');
  const port = (name) => {
    const value = values.get(name);
    if (typeof value !== 'string' || !/^[1-9][0-9]{3,4}$/u.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('regtest port must be an unprivileged local TCP port');
    return value;
  };
  const gatewayPort = port('DREY_REGTEST_GATEWAY_PORT');
  const rpcPort = port('DREY_REGTEST_CORE_RPC_PORT');
  const ordPort = port('DREY_REGTEST_ORD_PORT');
  if (new Set([gatewayPort, rpcPort, ordPort]).size !== 3) throw new Error('regtest service ports must differ');
  return { project, publicKey, gatewayPort, rpcPort, ordPort, gatewayOrigin: `http://127.0.0.1:${gatewayPort}`, rpcOrigin: `http://127.0.0.1:${rpcPort}`, ordOrigin: `http://127.0.0.1:${ordPort}` };
}

export function readRegtestProject(stateRoot, project) {
  // Validate before using the project as a path component.
  selectRegtestProject([], project);
  const file = join(stateRoot, 'projects', project, 'compose.env');
  if ((statSync(file).mode & 0o077) !== 0) throw new Error('regtest project configuration must be mode 0600');
  const publicKey = readFileSync(join(stateRoot, 'response-signing.pub'), 'utf8').trim();
  return parseRegtestProject(readFileSync(file, 'utf8'), project, publicKey);
}
