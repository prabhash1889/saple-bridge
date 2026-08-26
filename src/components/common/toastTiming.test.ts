import { describe, it, expect, vi, afterEach } from 'vitest';
import { autoDismissDelay, createDismissScheduler } from './toastTiming';

afterEach(() => {
  vi.useRealTimers();
});

describe('autoDismissDelay', () => {
  it('uses the explicit duration when provided', () => {
    expect(autoDismissDelay({ duration: 6000 })).toBe(6000);
  });

  it('falls back to the default duration', () => {
    expect(autoDismissDelay({})).toBe(4000);
  });

  it('keeps persistent toasts on screen', () => {
    expect(autoDismissDelay({ persistent: true })).toBeNull();
  });

  it('keeps actionable toasts on screen so the action stays reachable', () => {
    expect(
      autoDismissDelay({ action: { label: 'Retry', onClick: () => {} }, duration: 4000 }),
    ).toBeNull();
  });
});

describe('createDismissScheduler', () => {
  it('fires once after the delay', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const scheduler = createDismissScheduler(onExpire);

    scheduler.start(1000);
    expect(scheduler.status).toBe('running');
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(scheduler.status).toBe('idle');
  });

  it('pausing stops the countdown and resumes with the remaining time', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const scheduler = createDismissScheduler(onExpire);

    scheduler.start(1000);
    vi.advanceTimersByTime(400);
    scheduler.pause();
    expect(scheduler.status).toBe('paused');

    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();

    scheduler.resume();
    expect(scheduler.status).toBe('running');
    // Only the remaining 600ms should elapse before firing.
    vi.advanceTimersByTime(599);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('cancel prevents a pending expiry', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const scheduler = createDismissScheduler(onExpire);

    scheduler.start(500);
    scheduler.cancel();
    vi.advanceTimersByTime(10000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(scheduler.status).toBe('idle');
  });

  it('pause without a running countdown is a no-op', () => {
    const onExpire = vi.fn();
    const scheduler = createDismissScheduler(onExpire);
    scheduler.pause();
    expect(scheduler.status).toBe('idle');
    scheduler.resume();
    expect(onExpire).not.toHaveBeenCalled();
  });
});
