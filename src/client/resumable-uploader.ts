// ==============================================================================
// Resumable Chunked Storage Uploader
// Description: S3 & TUS-compatible multipart pipeline with verification & retries
// ==============================================================================

import { computeSha256, computeETag } from '../utils/crypto-utils.js';

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  partNumber: number;
  totalParts: number;
}

export interface UploaderOptions {
  chunkSizeBytes?: number; // default 5MB
  concurrency?: number;    // default 3 parallel chunk uploads
  maxRetries?: number;     // default 4 attempts per chunk
  baseRetryDelayMs?: number; // default 500ms
  onProgress?: (progress: UploadProgress) => void;
}

export interface ChunkDescriptor {
  partNumber: number;
  data: Buffer;
  sizeBytes: number;
  sha256: string;
  etag: string;
  uploaded: boolean;
}

export class ResumableChunkUploader {
  private chunkSizeBytes: number;
  private concurrency: number;
  private maxRetries: number;
  private baseRetryDelayMs: number;
  private onProgress?: (progress: UploadProgress) => void;

  constructor(options: UploaderOptions = {}) {
    this.chunkSizeBytes = options.chunkSizeBytes ?? 5 * 1024 * 1024;
    this.concurrency = options.concurrency ?? 3;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
    this.onProgress = options.onProgress;
  }

  /**
   * Slices raw payload into typed ChunkDescriptors with precomputed checksums.
   */
  public prepareChunks(buffer: Buffer): ChunkDescriptor[] {
    const totalBytes = buffer.length;
    const totalParts = Math.ceil(totalBytes / this.chunkSizeBytes);
    const chunks: ChunkDescriptor[] = [];

    for (let i = 0; i < totalParts; i++) {
      const start = i * this.chunkSizeBytes;
      const end = Math.min((i + 1) * this.chunkSizeBytes, totalBytes);
      const chunkData = buffer.subarray(start, end);

      chunks.push({
        partNumber: i + 1,
        data: chunkData,
        sizeBytes: chunkData.length,
        sha256: computeSha256(chunkData),
        etag: computeETag(chunkData),
        uploaded: false,
      });
    }

    return chunks;
  }

  /**
   * Uploads chunks with concurrency control, retries, and automatic resumption.
   */
  public async upload(
    uploadId: string,
    chunks: ChunkDescriptor[],
    uploadChunkFn: (chunk: ChunkDescriptor) => Promise<{ success: boolean; etag: string }>
  ): Promise<{ uploadId: string; totalParts: number; totalBytes: number }> {
    const totalBytes = chunks.reduce((acc, c) => acc + c.sizeBytes, 0);
    let uploadedBytes = chunks.filter((c) => c.uploaded).reduce((acc, c) => acc + c.sizeBytes, 0);

    const pendingChunks = chunks.filter((c) => !c.uploaded);
    const queue = [...pendingChunks];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const chunk = queue.shift();
        if (!chunk) break;

        await this.uploadChunkWithRetry(chunk, uploadChunkFn);

        chunk.uploaded = true;
        uploadedBytes += chunk.sizeBytes;

        if (this.onProgress) {
          this.onProgress({
            uploadedBytes,
            totalBytes,
            percent: Math.round((uploadedBytes / totalBytes) * 100),
            partNumber: chunk.partNumber,
            totalParts: chunks.length,
          });
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.concurrency, queue.length) },
      () => worker()
    );

    await Promise.all(workers);

    return {
      uploadId,
      totalParts: chunks.length,
      totalBytes,
    };
  }

  /**
   * Executes chunk dispatch with exponential backoff and jitter.
   */
  private async uploadChunkWithRetry(
    chunk: ChunkDescriptor,
    uploadChunkFn: (chunk: ChunkDescriptor) => Promise<{ success: boolean; etag: string }>
  ): Promise<void> {
    let attempt = 0;
    while (attempt < this.maxRetries) {
      try {
        const res = await uploadChunkFn(chunk);
        if (res.success) return;
        throw new Error(`Upload returned non-success for part ${chunk.partNumber}`);
      } catch (err: unknown) {
        attempt++;
        if (attempt >= this.maxRetries) {
          throw new Error(
            `Failed to upload part ${chunk.partNumber} after ${this.maxRetries} attempts: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        // Exponential backoff with full jitter
        const delay = Math.floor(
          Math.random() * (this.baseRetryDelayMs * Math.pow(2, attempt))
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
