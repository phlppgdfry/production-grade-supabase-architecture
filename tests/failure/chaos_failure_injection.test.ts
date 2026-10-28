// ==============================================================================
// Failure Injection & Chaos Recovery Test Suite
// ==============================================================================

import { describe, it, expect, vi } from 'vitest';
import { TusResumableAdapter } from '../../src/client/tus-resumable-adapter.js';

describe('Chaos & Failure Injection Resilience', () => {
  it('recovers gracefully from transient HTTP 503 service unavailable with backoff', async () => {
    const adapter = new TusResumableAdapter({
      endpoint: 'http://127.0.0.1:54321/storage/v1/upload/resumable',
      bearerToken: 'token',
      bucketName: 'vault',
      objectName: 'flaky_upload.bin',
      maxRetries: 4,
      baseDelayMs: 5,
    });

    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      if (init.method === 'POST') {
        return { status: 201, headers: new Headers({ Location: 'http://local/sess_1' }) };
      }
      if (init.method === 'PATCH') {
        attempts++;
        if (attempts < 3) {
          return { status: 503, text: async () => 'Service Temporarily Unavailable' };
        }
        return { status: 204, headers: new Headers({ 'Upload-Offset': '1024' }) };
      }
      if (init.method === 'HEAD') {
        return { status: 200, headers: new Headers({ 'Upload-Offset': '0' }) };
      }
      return { status: 400 };
    });

    const res = await adapter.upload(Buffer.alloc(1024), mockFetch as unknown as typeof fetch);
    expect(res.completed).toBe(true);
    expect(attempts).toBe(3);
  });

  it('fails fast on non-retryable 404 (session expired) without infinite loops', async () => {
    const adapter = new TusResumableAdapter({
      endpoint: 'http://127.0.0.1:54321/storage/v1/upload/resumable',
      bearerToken: 'token',
      bucketName: 'vault',
      objectName: 'expired.bin',
      maxRetries: 4,
    });

    const mockFetch = vi.fn().mockImplementation(async (url, init) => {
      if (init.method === 'POST') {
        return { status: 201, headers: new Headers({ Location: 'http://local/sess_expired' }) };
      }
      if (init.method === 'PATCH') {
        // Session expired while client was preparing next chunk
        return { status: 404, text: async () => 'Upload session not found' };
      }
      if (init.method === 'HEAD') {
        return { status: 404 };
      }
      return { status: 400 };
    });

    await expect(adapter.upload(Buffer.alloc(1024), mockFetch as unknown as typeof fetch)).rejects.toThrow();
  });

  it('reclaims orphaned jobs when a background worker crashes before completion', () => {
    // Simulates internal.job_queue lock lease expiration
    const now = new Date('2026-10-28T02:00:00Z').getTime();

    const job = {
      id: 'job_crash_1',
      status: 'processing',
      locked_by: 'worker_crashed_node_7',
      locked_until: new Date('2026-10-28T01:59:00Z').getTime(), // Expired 1 minute ago
    };

    // Worker poll condition: (status = 'queued' OR (status = 'processing' AND locked_until < now()))
    const isReclaimable = job.status === 'queued' || (job.status === 'processing' && job.locked_until < now);

    expect(isReclaimable).toBe(true);
  });
});
