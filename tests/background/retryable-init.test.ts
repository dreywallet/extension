import { describe, expect, it, vi } from 'vitest';
import { retryableInit } from '../../src/background/retryable-init';

describe('retryableInit', () => {
  it('shares an in-flight attempt and memoizes its success', async () => {
    let resolve!: (value: string) => void;
    const initialize = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const ready = retryableInit(initialize);

    const first = ready();
    const second = ready();
    expect(second).toBe(first);
    expect(initialize).toHaveBeenCalledTimes(1);

    resolve('ready');
    await expect(first).resolves.toBe('ready');
    await expect(ready()).resolves.toBe('ready');
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('forgets a rejected attempt so Retry can initialize again', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('transient storage failure'))
      .mockResolvedValueOnce('ready');
    const ready = retryableInit(initialize);

    await expect(ready()).rejects.toThrow('transient storage failure');
    await expect(ready()).resolves.toBe('ready');
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
