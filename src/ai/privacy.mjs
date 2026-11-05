import { createHmac, randomBytes } from 'node:crypto';
import { redact } from '../core/privacy.mjs';

export const AI_PRIVACY = Object.freeze({ personal_data: 'HMAC-SHA256', scope: 'client_lifetime', credentials: 'redacted' });

/** Stable pseudonyms for one AI client. The random key is never persisted or sent. */
export function createAiPrivacy() {
  const key = randomBytes(32);
  let closed = false;
  function hash(value) {
    if (value == null || value === '' || typeof value === 'string' && /^(?:\[REDACTED\]|\[PII:[a-f0-9]{64}\])$/.test(value)) return value;
    if (Array.isArray(value)) return value.map(hash);
    let encoded;
    try { encoded = typeof value === 'string' ? value : JSON.stringify(value); } catch { return '[REDACTED]'; }
    return `[PII:${createHmac('sha256', key).update(`${typeof value}:${encoded}`).digest('hex')}]`;
  }
  return {
    sanitize(value) {
      if (closed) throw new Error('AI privacy context is closed.');
      return redact(value, new WeakSet(), hash);
    },
    close() { closed = true; key.fill(0); },
  };
}
