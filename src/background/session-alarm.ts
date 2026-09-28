/**
 * Proactive session expiry via chrome.alarms (spec §7.4). A periodic alarm
 * wakes the (possibly terminated) MV3 worker so an idle-expired unlock session
 * is cleared even when no RPC is arriving to trigger the lazy check. The actual
 * expiry decision lives in WalletService.sweepExpired (unit-tested). A late
 * alarm also signals device sleep/resume, which is an unconditional lock path.
 */
const SWEEP_ALARM = 'squirrel:session-sweep';
const SWEEP_PERIOD_MINUTES = 1;
const SWEEP_PERIOD_MS = SWEEP_PERIOD_MINUTES * 60_000;

export function registerSessionSweep(
  onSweep: (lockForResume: boolean) => void | Promise<void>,
  now: () => number = Date.now,
): void {
  // Keep an existing alarm: create() replaces it, so a worker woken by some
  // other event after device resume would erase the missed alarm whose late
  // firing is the sleep/resume signal below.
  const ensureAlarm = () => chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MINUTES });
  void Promise.resolve()
    .then(() => chrome.alarms.get(SWEEP_ALARM))
    .then((existing) => {
      if (existing?.periodInMinutes !== SWEEP_PERIOD_MINUTES) return ensureAlarm();
      return undefined;
    })
    .catch(() => ensureAlarm());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SWEEP_ALARM) return;
    // Chrome fires a missed alarm once the device wakes. Being more than one
    // full sweep period late is a conservative sleep/resume signal; lock even
    // if the ordinary idle deadline has not elapsed (§7.4).
    const lockForResume = now() - alarm.scheduledTime > SWEEP_PERIOD_MS;
    try {
      void Promise.resolve(onSweep(lockForResume)).catch(() => undefined);
    } catch {
      // Storage remains authoritative; a later RPC/startup re-checks expiry.
    }
  });
}
