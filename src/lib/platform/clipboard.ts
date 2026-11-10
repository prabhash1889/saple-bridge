import { writeText } from '@tauri-apps/plugin-clipboard-manager';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ClipboardRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// The Windows clipboard is an exclusively-locked shared resource: Clipboard History
// (Win+V), OneDrive, clipboard sync, and RDP all briefly hold that lock, and a write that
// collides with a holder fails with CLIPBRD_E_CANT_OPEN. The lock is held for
// milliseconds, so a couple of retries with a short growing backoff absorbs virtually all
// of that contention. Throws the last error once the attempts are exhausted.
export const writeClipboardTextWithRetry = async (
  write: (text: string) => Promise<void>,
  text: string,
  { attempts = 3, baseDelayMs = 50, sleep = defaultSleep }: ClipboardRetryOptions = {},
): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await write(text);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(baseDelayMs * attempt);
      }
    }
  }
  throw lastError;
};

// Clipboard writes go through the Tauri plugin, not navigator.clipboard: WebView2 never
// auto-grants clipboard permission to config-defined windows (see lib.rs), so the web API
// intermittently rejects or hangs on a permission prompt. It stays as a fallback only.
// Rejects when both paths fail - callers must react (keep the selection, tell the user)
// instead of losing the copy silently.
export const writeTextToClipboard = async (text: string): Promise<void> => {
  try {
    await writeClipboardTextWithRetry((value) => writeText(value), text);
    return;
  } catch (error) {
    console.warn('Plugin clipboard copy failed, falling back to navigator.clipboard:', error);
  }

  await navigator.clipboard.writeText(text);
};
