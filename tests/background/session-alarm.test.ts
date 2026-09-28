import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSessionSweep } from '../../src/background/session-alarm';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session alarm wiring', () => {
  it('registers synchronously and distinguishes an overdue resume alarm', async () => {
    let listener: ((alarm: chrome.alarms.Alarm) => void) | undefined;
    const create = vi.fn();
    vi.stubGlobal('chrome', {
      alarms: {
        create,
        get: vi.fn(async () => undefined),
        onAlarm: {
          addListener: vi.fn((next: (alarm: chrome.alarms.Alarm) => void) => {
            listener = next;
          }),
        },
      },
    });
    const onSweep = vi.fn();

    registerSessionSweep(onSweep, () => 120_001);
    expect(listener).toBeDefined();
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledWith('squirrel:session-sweep', { periodInMinutes: 1 }));

    listener?.({
      name: 'squirrel:session-sweep',
      scheduledTime: 60_000,
      periodInMinutes: 1,
      persistAcrossSessions: true,
    });
    expect(onSweep).toHaveBeenLastCalledWith(true);

    listener?.({
      name: 'squirrel:session-sweep',
      scheduledTime: 60_001,
      periodInMinutes: 1,
      persistAcrossSessions: true,
    });
    expect(onSweep).toHaveBeenLastCalledWith(false);
  });

  it('keeps a pending alarm so a missed firing still signals resume', async () => {
    const create = vi.fn();
    const get = vi.fn(async () => ({
      name: 'squirrel:session-sweep', scheduledTime: 60_000, periodInMinutes: 1,
    }));
    vi.stubGlobal('chrome', {
      alarms: { create, get, onAlarm: { addListener: vi.fn() } },
    });

    registerSessionSweep(vi.fn());
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith('squirrel:session-sweep'));
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
  });

  it('still creates the alarm when it cannot be read', async () => {
    const create = vi.fn();
    vi.stubGlobal('chrome', {
      alarms: {
        create,
        get: vi.fn(async () => { throw new Error('unavailable'); }),
        onAlarm: { addListener: vi.fn() },
      },
    });

    registerSessionSweep(vi.fn());
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledWith('squirrel:session-sweep', { periodInMinutes: 1 }));
  });
});
