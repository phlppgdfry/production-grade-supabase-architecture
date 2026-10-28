// ==============================================================================
// Utility: Cryptographic Hashing & ETag Computation
// ==============================================================================

import { createHash } from 'node:crypto';

/**
 * Computes SHA-256 hex string for a given Buffer or Uint8Array.
 */
export function computeSha256(data: Uint8Array | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Computes MD5 hex string (S3 chunk ETag format).
 */
export function computeETag(data: Uint8Array | Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

/**
 * Computes S3 multipart final ETag:
 * MD5 of concatenated part MD5s + '-' + partCount
 */
export function computeMultipartETag(partETags: string[]): string {
  const md5Stream = createHash('md5');
  for (const etag of partETags) {
    const rawEtag = etag.replace(/"/g, '');
    md5Stream.update(Buffer.from(rawEtag, 'hex'));
  }
  return `"${md5Stream.digest('hex')}-${partETags.length}"`;
}
