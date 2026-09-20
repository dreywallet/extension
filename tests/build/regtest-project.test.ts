import { describe, expect, it } from 'vitest';
import { parseRegtestProject, selectRegtestProject } from '../../scripts/lib/regtest-project.mjs';
import { resolveBuildChannel } from '../../src/build/channel';

const publicKey = '17'.repeat(32);
const project = 'drey-runes-task';
const source = `DREY_REGTEST_PROJECT=${project}\nDREY_REGTEST_GATEWAY_PUBLIC_KEY_HEX=${publicKey}\nDREY_REGTEST_GATEWAY_PORT=19480\nDREY_REGTEST_CORE_RPC_PORT=19443\nDREY_REGTEST_ORD_PORT=19481\n`;

describe('compile-time isolated regtest binding', () => {
  it('selects one named project consistently and prevents path or argument ambiguity', () => {
    expect(selectRegtestProject(['build', '--', '--project', project], undefined)).toEqual({ project, args: ['build'] });
    expect(selectRegtestProject([], undefined).project).toBe('drey-regtest');
    expect(() => selectRegtestProject(['--project', project], 'different')).toThrow();
    expect(() => selectRegtestProject(['--project'], undefined)).toThrow();
    expect(() => selectRegtestProject([], '../../production')).toThrow();
    expect(() => selectRegtestProject(['--project', project, '--project', project], undefined)).toThrow();
  });

  it('pins only local service ports and checks project public identity', () => {
    expect(parseRegtestProject(source, project, publicKey)).toMatchObject({
      gatewayOrigin: 'http://127.0.0.1:19480', rpcOrigin: 'http://127.0.0.1:19443', ordOrigin: 'http://127.0.0.1:19481',
    });
    for (const port of ['80', '65536', '019480', '19480/attack', 'https://example.com', '19443']) {
      expect(() => parseRegtestProject(source.replace('=19480', `=${port}`), project, publicKey)).toThrow();
    }
    expect(() => parseRegtestProject(`${source}DREY_REGTEST_GATEWAY_PORT=19482\n`, project, publicKey)).toThrow();
    expect(() => parseRegtestProject(source, project, '18'.repeat(32))).toThrow();
    expect(() => parseRegtestProject(source, 'another-project', publicKey)).toThrow();
  });

  it('keeps alternate local origins confined to development builds', () => {
    const environment = { DREY_REGTEST_GATEWAY_PUBLIC_KEY_HEX: publicKey, DREY_REGTEST_GATEWAY_PORT: '19480', DREY_REGTEST_ORD_PORT: '19481' };
    expect(resolveBuildChannel('development', environment)).toMatchObject({ gatewayOrigin: 'http://127.0.0.1:19480', regtestExplorerOrigin: 'http://127.0.0.1:19481', network: 'regtest', vaultCoordinatorEnabled: false });
    expect(resolveBuildChannel('test', environment).gatewayOrigin).toBe('http://127.0.0.1:18080');
    expect(resolveBuildChannel('production', environment).gatewayOrigin).toBe('https://wallet-api.squirrelsystems.net');
    expect(() => resolveBuildChannel('development', { ...environment, DREY_REGTEST_GATEWAY_PORT: '19480@host' })).toThrow();
  });
});
