// ==============================================================================
// Adapter: AWS S3 & Supabase Storage S3-Compatible Multipart Protocol
// Standard: AWS S3 REST API & S3 Multipart Specification
// ==============================================================================

import { computeSha256 } from '../utils/crypto-utils.js';

export interface S3PartDescriptor {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface S3MultipartOptions {
  s3Endpoint: string; // e.g. http://127.0.0.1:54321/storage/v1/s3
  bucketName: string;
  objectKey: string;
  bearerToken?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  partSizeBytes?: number; // default 5MB (S3 standard minimum)
  concurrency?: number;   // default 3 parallel chunk uploads
  maxRetries?: number;
  onProgress?: (uploadedParts: number, totalParts: number, uploadedBytes: number) => void;
  signal?: AbortSignal;
}

export class S3MultipartAdapter {
  private options: S3MultipartOptions;

  constructor(options: S3MultipartOptions) {
    this.options = {
      partSizeBytes: 5 * 1024 * 1024,
      concurrency: 3,
      maxRetries: 4,
      ...options,
    };
  }

  /**
   * Calculates S3 Multipart ETag according to AWS specification:
   * Hex MD5 of concatenated raw binary MD5 digests of each part + "-" + partCount.
   * NOTE: This is NEVER equal to the MD5 of the complete file!
   */
  public static calculateMultipartETag(partETags: string[]): string {
    const crypto = require('node:crypto');
    const md5Stream = crypto.createHash('md5');

    for (const etag of partETags) {
      // Strip optional surrounding quotes
      const cleanHex = etag.replace(/"/g, '').trim();
      md5Stream.update(Buffer.from(cleanHex, 'hex'));
    }

    return `"${md5Stream.digest('hex')}-${partETags.length}"`;
  }

  /**
   * Slices raw payload into 5MB S3 part buffers.
   */
  public prepareParts(buffer: Buffer): { partNumber: number; data: Buffer; sizeBytes: number; sha256: string }[] {
    const partSize = this.options.partSizeBytes!;
    const totalParts = Math.ceil(buffer.length / partSize);
    const parts = [];

    for (let i = 0; i < totalParts; i++) {
      const start = i * partSize;
      const end = Math.min((i + 1) * partSize, buffer.length);
      const slice = buffer.subarray(start, end);

      parts.push({
        partNumber: i + 1,
        data: slice,
        sizeBytes: slice.length,
        sha256: computeSha256(slice),
      });
    }

    return parts;
  }

  /**
   * Generates standard S3 XML CompleteMultipartUpload payload.
   */
  public formatCompletePayloadXml(parts: S3PartDescriptor[]): string {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const partsXml = sorted
      .map(
        (p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`
      )
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${partsXml}</CompleteMultipartUpload>`;
  }
}
