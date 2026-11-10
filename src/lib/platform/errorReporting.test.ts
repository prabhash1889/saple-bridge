import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { installGlobalErrorHandlers, reportError } from "./errorReporting";

describe("errorReporting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces several errors into one batched invoke", () => {
    reportError("first error");
    reportError("second error");
    expect(invokeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2500);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe("log_renderer_error");
    expect((args as { message: string }).message).toContain("first error");
    expect((args as { message: string }).message).toContain("second error");
  });

  it("flushes immediately once the batch cap is hit", () => {
    for (let i = 0; i < 20; i++) {
      reportError(`error ${i}`);
    }
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never throws when invoke rejects", () => {
    invokeMock.mockRejectedValue(new Error("ipc gone"));
    reportError("boom");
    expect(() => vi.advanceTimersByTime(2500)).not.toThrow();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized messages", () => {
    reportError("x".repeat(10_000));
    vi.advanceTimersByTime(2500);
    const message = (invokeMock.mock.calls[0][1] as { message: string }).message;
    expect(message.length).toBeLessThanOrEqual(4000);
  });

  it("global handlers forward errors and rejections through reportError", () => {
    // The vitest suite runs in a node environment, so stub a minimal window and drive the
    // registered listeners with plain event-shaped objects.
    const listeners = new Map<string, (event: never) => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, listener);
      },
    });
    try {
      installGlobalErrorHandlers();

      type ErrorLike = { message?: string; filename?: string; error?: unknown };
      const onError = listeners.get("error") as ((e: ErrorLike) => void) | undefined;
      expect(onError).toBeDefined();
      onError!({ message: "window blew up", filename: "App.tsx", error: undefined });

      type RejectionLike = { reason: unknown };
      const onRejection = listeners.get("unhandledrejection") as
        | ((e: RejectionLike) => void)
        | undefined;
      expect(onRejection).toBeDefined();
      onRejection!({ reason: "rejected!" });

      vi.advanceTimersByTime(2500);
      expect(invokeMock).toHaveBeenCalledTimes(1);
      const message = (invokeMock.mock.calls[0][1] as { message: string }).message;
      expect(message).toContain("window blew up");
      expect(message).toContain("(App.tsx)");
      expect(message).toContain("rejected!");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
