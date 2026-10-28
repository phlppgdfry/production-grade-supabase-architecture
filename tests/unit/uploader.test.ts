// ==============================================================================
// Unit Test: Resumable Chunked Storage Uploader
// ==============================================================================

import { describe, it, expect, vi } from 'vitest';
import { ResumableChunkUploader } from '../../src/client/resumable-uploader.js';
import { computeSha256, computeETag } from '../../src/utils/crypto-utils.js';

describe('ResumableChunkUploader', () => {
  it('correctly slices buffer into deterministic 5MB chunks', () => {
    const uploader = new ResumableChunkUploader({ chunkSizeBytes: 5 * 1024 * 1024 });
    const buffer = Buffer.alloc(12 * 1024 * 1024, 'a'); // 12 MB

    const chunks = uploader.prepareChunks(buffer);

    expect(chunks.length).toBe(3);
    expect(chunks[0]!.partNumber).toBe(1);
    expect(chunks[0]!.sizeBytes).toBe(5 * 1024 * 1024);
    expect(chunks[1]!.partNumber).toBe(2);
    expect(chunks[1]!.sizeBytes).toBe(5 * 1024 * 1024);
    expect(chunks[2]!.partNumber).toBe(3);
    expect(chunks[2]!.sizeBytes).toBe(2 * 1024 * 1024); // remaining 2MB

    // Checksums should match manual computation
    expect(chunks[0]!.sha256).toBe(computeSha256(chunks[0]!.data));
    expect(chunks[0]!.etag).toBe(computeETag(chunks[0]!.data));
  });

  it('dispatches chunks concurrently and reports progress accurately', async () => {
    const progressReports: number[] = [];
    const uploader = new ResumableChunkUploader({
      chunkSizeBytes: 1024,
      concurrency: 2,
      onProgress: (p) => progressReports.push(p.percent),
    });

    const buffer = Buffer.alloc(4096, 'x'); // 4 chunks of 1KB
    const chunks = uploader.prepareChunks(buffer);

    const mockUpload = vi.fn().mockImplementation(async (chunk) => {
      return { success: true, etag: chunk.etag };
    });

    const result = await uploader.upload('upl_test_session', chunks, mockUpload);

    expect(result.uploadId).toBe('upl_test_session');
    expect(result.totalParts).toBe(4);
    expect(result.totalBytes).toBe(4096);
    expect(mockUpload).toHaveBeenCalledTimes(4);
    expect(progressReports[progressReports.length - 1]).toBe(100);
  });

  it('retries on transient failure with exponential backoff and succeeds', async () => {
    const uploader = new ResumableChunkUploader({
      chunkSizeBytes: 1024,
      maxRetries: 3,
      baseRetryDelayMs: 10,
    });

    const buffer = Buffer.alloc(1024, 'z');
    const chunks = uploader.prepareChunks(buffer);

    let callCount = 0;
    const flakeyUpload = vi.fn().mockImplementation(async (chunk) => {
      callCount++;
      if (callCount < 2) {
        throw new Error('Transient 503 Service Unavailable');
      }
      return { success: true, etag: chunk.etag };
    });

    const result = await uploader.upload('upl_flakey_test', chunks, flakeyUpload);

    expect(result.uploadId).toBe('upl_flakey_test');
    expect(callCount).toBe(2);
    expect(chunks[0]!.uploaded).toBe(true);
  });
});
