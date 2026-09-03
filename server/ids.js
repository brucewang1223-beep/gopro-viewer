import { createHash } from 'node:crypto';

/** Stable 16-hex-char id derived from its parts (file paths never leave the server). */
export function shortId(...parts) {
  return createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 16);
}
