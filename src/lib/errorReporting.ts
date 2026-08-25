// Renderer -> durable log forwarding (Phase 4 observability).
//
// Installs global `error` and `unhandledrejection` handlers and ships every renderer crash
// through the `log_renderer_error` Tauri command into the Rust-side durable app log, where it is
// secret-redacted before hitting disk (the frontend cannot be trusted to redact - it only
// forwards raw text). Events are batched and debounced so an error storm cannot flood IPC.
//
// Failure-silent by contract: if the invoke itself throws (window closing during shutdown, IPC
// gone), the failure is swallowed. Logging must never crash the app.

import { invoke } from "@tauri-apps/api/core";

interface PendingError {
  message: string;
  source?: string;
}

const MAX_MESSAGE_CHARS = 4000;
const MAX_BATCH = 20;
const FLUSH_DEBOUNCE_MS = 2000;

let queue: PendingError[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Queue one renderer error for the durable log. Never throws. */
export function reportError(message: string, source?: string): void {
  try {
    const cleaned = String(message ?? "").slice(0, MAX_MESSAGE_CHARS);
    if (!cleaned) return;
    queue.push({ message: cleaned, source });
    if (queue.length >= MAX_BATCH) {
      flushNow();
      return;
    }
    if (flushTimer === null) {
      flushTimer = setTimeout(flushNow, FLUSH_DEBOUNCE_MS);
    }
  } catch {
    // Never let reporting break the caller.
  }
}

function formatError(message: string, source?: string): string {
  return source ? `${message} (${source})` : message;
}

function flushNow(): void {
  try {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    const payload = batch.map((e) => formatError(e.message, e.source)).join("\n");
    void Promise.resolve(invoke("log_renderer_error", { message: payload })).catch(() => {
      // The Rust side may be unavailable; dropping diagnostics beats crashing.
    });
  } catch {
    // Swallow everything: this runs inside error handlers.
  }
}

/** Install the global handlers. Call once at startup, before rendering. */
export function installGlobalErrorHandlers(): void {
  try {
    window.addEventListener("error", (event) => {
      const detail =
        event.error instanceof Error && event.error.stack
          ? event.error.stack
          : event.message || "Unknown error event";
      reportError(detail, event.filename || undefined);
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const detail =
        reason instanceof Error
          ? reason.stack || reason.message
          : typeof reason === "string"
            ? reason
            : safeSerialize(reason);
      reportError(`Unhandled rejection: ${detail}`);
    });
  } catch {
    // A hostile environment must not stop startup.
  }
}

function safeSerialize(reason: unknown): string {
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}
