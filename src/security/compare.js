import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison with NO length side-channel.
 *
 * Both inputs are hashed to a fixed-width 32-byte SHA-256 digest first, so the
 * comparison always runs over equal-length buffers and never returns early on a
 * length mismatch (which would leak the secret's length — CWE-208). Hashing a
 * non-secret alongside the secret reveals nothing about either: SHA-256 is
 * preimage-resistant, and we only compare digests.
 */
export function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
