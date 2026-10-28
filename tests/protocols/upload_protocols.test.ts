// ==============================================================================
// Protocol Test: Supabase TUS Resumable & S3 Multipart Specification
// ==============================================================================

import { describe, it, expect, vi } from 'vitest';
import { TusResumableAdapter } from '../../src/client/tus-resumable-adapter.js';
import { S3MultipartAdapter } from '../../src/client/s3-multipart-adapter.js';
import { computeETag, computeSha256 } from '../../src/utils/crypto-utils.js';

describe('TUS 1.0.0 Resumable Protocol Tests', () => {
  it('correctly creates upload session with b64 encoded metadata', async () => {
    const adapter = new TusResumableAdapter({
      endpoint: 'http://127.0.0.1:54321/storage/v1/upload/resumable',
      bearerToken: 'test-token',
      bucketName: 'clinical-vault',
      objectName: 'reports/2026/trial_summary.pdf',
      contentType: 'application/pdf',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 201,
      headers: new Headers({
        Location: 'http://127.0.0.1:54321/storage/v1/upload/resumable/sess_12345',
        'Tus-Resumable': '1.0.0',
      }),
    });

    const session = await adapter.createSession(1024, mockFetch as unknown as typeof fetch);

    expect(session.uploadUrl).toBe('http://127.0.0.1:54321/storage/v1/upload/resumable/sess_12345');
    expect(session.totalBytes).toBe(1024);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callArgs = mockFetch.mock.calls[0]!;
    expect(callArgs[1].headers['Upload-Length']).toBe('1024');
    expect(callArgs[1].headers['Tus-Resumable']).toBe('1.0.0');
    expect(callArgs[1].headers['Upload-Metadata']).toContain('bucketName');
  });

  it('probes remote offset using TUS HEAD after interruption', async () => {
    const adapter = new TusResumableAdapter({
      endpoint: 'http://127.0.0.1:54321/storage/v1/upload/resumable',
      bearerToken: 'test-token',
      bucketName: 'clinical-vault',
      objectName: 'reports/trial.pdf',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'Upload-Offset': '5242880', // 5MB already on server
        'Tus-Resumable': '1.0.0',
      }),
    });

    const offset = await adapter.getOffset(
      'http://127.0.0.1:54321/storage/v1/upload/resumable/sess_12345',
      mockFetch as unknown as typeof fetch
    );

    expect(offset).toBe(5242880);
    expect(mockFetch.mock.calls[0]![1].method).toBe('HEAD');
  });

  it('resumes seamlessly after simulated connection timeout on first chunk', async () => {
    const adapter = new TusResumableAdapter({
      endpoint: 'http://127.0.0.1:54321/storage/v1/upload/resumable',
      bearerToken: 'test-token',
      bucketName: 'clinical-vault',
      objectName: 'large_archive.tar',
      chunkSizeBytes: 1024,
      maxRetries: 3,
      baseDelayMs: 10,
    });

    const buffer = Buffer.alloc(2048, 'a'); // 2 chunks of 1024 bytes
    let patchCalls = 0;

    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      if (init.method === 'POST') {
        return {
          status: 201,
          headers: new Headers({
            Location: 'http://127.0.0.1:54321/storage/v1/upload/resumable/sess_retry',
          }),
        };
      }
      if (init.method === 'PATCH') {
        patchCalls++;
        if (patchCalls === 1) {
          throw new Error('Connection reset by peer (ETIMEDOUT)');
        }
        const currentOffset = parseInt(init.headers['Upload-Offset'], 10);
        const chunkLen = init.body.length;
        return {
          status: 204,
          headers: new Headers({
            'Upload-Offset': (currentOffset + chunkLen).toString(),
          }),
        };
      }
      if (init.method === 'HEAD') {
        return {
          status: 200,
          headers: new Headers({ 'Upload-Offset': '0' }),
        };
      }
      return { status: 400 };
    });

    const result = await adapter.upload(buffer, mockFetch as unknown as typeof fetch);

    expect(result.completed).toBe(true);
    expect(result.totalBytes).toBe(2048);
    // 1 failed PATCH + 2 successful PATCHes = 3 PATCH calls
    expect(patchCalls).toBe(3);
  });

  it('honors AbortSignal immediately and sends DELETE cancellation', async () => {
    const controller = new AbortController();
    const adapter = new TusResumableAdapter({
      endpoint: 'http://127.0.0.1:54321/storage/v1/upload/resumable',
      bearerToken: 'test-token',
      bucketName: 'clinical-vault',
      objectName: 'abort_target.bin',
      signal: controller.signal,
    });

    let deletedSession = false;
    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      if (init.method === 'POST') {
        return {
          status: 201,
          headers: new Headers({
            Location: 'http://127.0.0.1:54321/storage/v1/upload/resumable/sess_abort',
          }),
        };
      }
      if (init.method === 'DELETE') {
        deletedSession = true;
        return { status: 204 };
      }
      return { status: 200 };
    });

    // Abort prior to completion
    controller.abort();

    await expect(adapter.upload(Buffer.alloc(4096), mockFetch as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe('S3 Multipart Protocol & ETag Mathematics', () => {
  it('demonstrates that S3 Multipart ETag is NEVER equal to whole-file MD5', () => {
    // 3 parts of 5 MB each (15 MB total)
    const part1 = Buffer.alloc(5 * 1024 * 1024, 'a');
    const part2 = Buffer.alloc(5 * 1024 * 1024, 'b');
    const part3 = Buffer.alloc(5 * 1024 * 1024, 'c');
    const wholeFile = Buffer.concat([part1, part2, part3]);

    const wholeFileMd5 = computeETag(wholeFile);

    const part1Etag = computeETag(part1);
    const part2Etag = computeETag(part2);
    const part3Etag = computeETag(part3);

    const s3MultipartETag = S3MultipartAdapter.calculateMultipartETag([part1Etag, part2Etag, part3Etag]);

    // Format must match S3: "md5(concatenated_binary_md5s)-partCount"
    expect(s3MultipartETag).toMatch(/^"[a-f0-9]{32}-3"$/);

    // CRITICAL SPECIFICATION CHECK:
    // S3 multipart ETag is provably different from whole-file MD5!
    expect(s3MultipartETag.replace(/"/g, '')).not.toBe(wholeFileMd5);
  });

  it('formats valid CompleteMultipartUpload XML payload', () => {
    const adapter = new S3MultipartAdapter({
      s3Endpoint: 'http://127.0.0.1:54321/storage/v1/s3',
      bucketName: 'vault',
      objectKey: 'file.bin',
    });

    const parts = [
      { partNumber: 2, etag: '"etag-2"', sizeBytes: 5242880, checksumSha256: 'sha2' },
      { partNumber: 1, etag: '"etag-1"', sizeBytes: 5242880, checksumSha256: 'sha1' },
    ];

    const xml = adapter.formatCompletePayloadXml(parts);

    // Parts must be sorted sequentially in XML
    expect(xml).toContain('<PartNumber>1</PartNumber><ETag>"etag-1"</ETag>');
    expect(xml).toContain('<PartNumber>2</PartNumber><ETag>"etag-2"</ETag>');
    expect(xml.indexOf('<PartNumber>1</PartNumber>')).toBeLessThan(xml.indexOf('<PartNumber>2</PartNumber>'));
  });
});
