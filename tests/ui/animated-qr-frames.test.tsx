import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnimatedQrFrames,
  VAULT_QR_FRAME_INTERVAL_MS,
} from '../../src/entrypoints/fullpage/vault/AnimatedQrFrames';

const FRAMES = ['frame one', 'frame two', 'frame three'] as const;
let visibility: DocumentVisibilityState;
let reducedMotion: boolean;
let motionListeners: Set<(event: MediaQueryListEvent) => void>;

function renderFrames(frames: readonly string[] = FRAMES) {
  return render(
    <AnimatedQrFrames
      frames={frames}
      alt="Approval QR"
      stepLabel="1. Scan the request"
      progressLabel={(current, total) => `QR part ${current} of ${total}`}
      pauseLabel="Pause QR"
      resumeLabel="Resume QR"
      previousLabel="Previous"
      nextLabel="Next"
    />,
  );
}

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  fireEvent(document, new Event('visibilitychange'));
}

function setReducedMotion(next: boolean): void {
  reducedMotion = next;
  const event = { matches: next } as MediaQueryListEvent;
  for (const listener of motionListeners) listener(event);
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  reducedMotion = false;
  motionListeners = new Set();
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: reducedMotion,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        motionListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        motionListeners.delete(listener);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('<AnimatedQrFrames />', () => {
  it('cycles through every frame at the signer-tested rate', () => {
    renderFrames();
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 1 of 3' })).toBeVisible();

    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 2 of 3' })).toBeVisible();

    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS * 2));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 1 of 3' })).toBeVisible();
  });

  it('supports pause, resume, and manual navigation', () => {
    renderFrames();
    fireEvent.click(screen.getByRole('button', { name: 'Pause QR' }));
    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS * 3));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 1 of 3' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 2 of 3' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 1 of 3' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Resume QR' }));
    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 2 of 3' })).toBeVisible();
  });

  it('pauses in the background and restarts from the first frame on return', () => {
    renderFrames();
    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 2 of 3' })).toBeVisible();

    setVisibility('hidden');
    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS * 3));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 2 of 3' })).toBeVisible();

    setVisibility('visible');
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 1 of 3' })).toBeVisible();
    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 2 of 3' })).toBeVisible();
  });

  it('disables animation for reduced motion but keeps manual controls', () => {
    reducedMotion = true;
    renderFrames();
    expect(screen.queryByRole('button', { name: 'Pause QR' })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS * 3));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 1 of 3' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 2 of 3' })).toBeVisible();

    act(() => setReducedMotion(false));
    expect(screen.getByRole('button', { name: 'Pause QR' })).toBeVisible();
    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 3 of 3' })).toBeVisible();
  });

  it('resets playback when a new frame set replaces the old one', () => {
    const view = renderFrames();
    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Pause QR' }));

    view.rerender(
      <AnimatedQrFrames
        frames={['replacement one', 'replacement two']}
        alt="Approval QR"
        stepLabel="1. Scan the request"
        progressLabel={(current, total) => `QR part ${current} of ${total}`}
        pauseLabel="Pause QR"
        resumeLabel="Resume QR"
        previousLabel="Previous"
        nextLabel="Next"
      />,
    );

    expect(screen.getByRole('img', { name: 'Approval QR. QR part 1 of 2' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause QR' })).toHaveAttribute('aria-pressed', 'false');
    act(() => vi.advanceTimersByTime(VAULT_QR_FRAME_INTERVAL_MS));
    expect(screen.getByRole('img', { name: 'Approval QR. QR part 2 of 2' })).toBeVisible();
  });
});
