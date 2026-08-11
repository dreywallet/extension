import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSessionSweep } from '../../src/background/session-alarm';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session alarm wiring', () => {
  it('registers synchronously and distinguishes an overdue resume alarm', () => {
    let listener: ((alarm: chrome.alarms.Alarm) => void) | undefined;
    const create = vi.fn();
    vi.stubGlobal('chrome', {
      alarms: {
        create,
        onAlarm: {
          addListener: vi.fn((next: (alarm: chrome.alarms.Alarm) => void) => {
            listener = next;
          }),
        },
      },
    });
    const onSweep = vi.fn();

    registerSessionSweep(onSweep, () => 120_001);
    expect(create).toHaveBeenCalledWith('squirrel:session-sweep', { periodInMinutes: 1 });

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
});
