import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_STATUS_KEY,
  loadCachedStatus,
  saveCachedStatus,
} from '../../src/adapters/gateway/status-cache';
import type { CachedGatewayStatus } from '@drey/core/domain/gateway/status-view';
import { makeFakeArea } from './fake-area';

const endpoint = 'http://127.0.0.1:8080';
const status = JSON.parse(
  readFileSync(
    join(coreFixturesDir, 'gateway', 'status.signed.json'),
    'utf8',
  ),
) as CachedGatewayStatus['status'];

describe('gateway status cache protocol policy', () => {
  it('retains a permitted v2 status', async () => {
    const area = makeFakeArea();
    await saveCachedStatus(area, { status, verifiedAtMs: 1, endpoint });

    await expect(loadCachedStatus(area, endpoint, [2])).resolves.toMatchObject({
      status: { protocolVersion: 2 },
    });
  });

  it('drops a status that the current build channel does not permit', async () => {
    const area = makeFakeArea();
    await saveCachedStatus(area, { status, verifiedAtMs: 1, endpoint });

    await expect(loadCachedStatus(area, endpoint, [1])).resolves.toBeNull();
    expect(area.store.has(GATEWAY_STATUS_KEY)).toBe(false);
  });
});
