export const createId = (prefix: string): string => {
  const normalizedPrefix = prefix.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'id';

  if (globalThis.crypto?.randomUUID) {
    return `${normalizedPrefix}_${globalThis.crypto.randomUUID()}`;
  }

  const timestamp = Date.now().toString(36);
  const randomValue = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  const suffix = randomValue.toString(36).slice(0, 9);
  return `${normalizedPrefix}_${timestamp}_${suffix}`;
};
