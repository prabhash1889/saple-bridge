const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  // Rust command errors arrive as {code, message} objects once a surface migrates
  // to serializable error codes; show the human message, never the raw JSON.
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
};

export interface IpcErrorInfo {
  /** Stable snake_case machine code, or null when the rejection carries only text. */
  code: string | null;
  message: string;
}

/**
 * Parse a Tauri `invoke` rejection into its code and message. Rust surfaces migrated
 * to `CodedError` reject with `{code, message}` objects; surfaces still returning
 * plain strings (and ordinary JS `Error`s) carry no code. Callers branch on the code
 * when present instead of matching message text.
 */
export const parseIpcError = (error: unknown): IpcErrorInfo => {
  if (isRecord(error) && typeof error.code === 'string') {
    return {
      code: error.code,
      message: typeof error.message === 'string' ? error.message : toErrorMessage(error),
    };
  }
  return { code: null, message: toErrorMessage(error) };
};

/** True when the rejection carries the given stable machine code. */
export const hasIpcErrorCode = (error: unknown, code: string): boolean =>
  parseIpcError(error).code === code;
