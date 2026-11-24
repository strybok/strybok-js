import { runtime } from './runtime.js';

/**
 * Random RFC 4122 version 4 UUID. It identifies one analytics event for de-duplication only, so
 * `Math.random` is an acceptable fallback where `crypto.getRandomValues` does not exist (React
 * Native without a polyfill).
 */
export function uuidV4(): string {
  const bytes = new Uint8Array(16);
  const crypto = runtime().crypto;
  let filled = false;
  if (crypto !== undefined && typeof crypto.getRandomValues === 'function') {
    try {
      crypto.getRandomValues(bytes);
      filled = true;
    } catch {
      // Some polyfills throw when their native half is missing; fall back.
    }
  }
  if (!filled) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] as number).toString(16).padStart(2, '0');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}
