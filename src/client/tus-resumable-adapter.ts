// ==============================================================================
// Adapter: Supabase TUS 1.0.0 Resumable Upload Engine
// Standard: Official TUS 1.0.0 Specification & Supabase Storage Endpoint
// ==============================================================================

export interface TusUploadOptions {
  endpoint: string; // e.g. http://127.0.0.1:54321/storage/v1/upload/resumable
  bearerToken: string;
  bucketName: string;
  objectName: string;
  contentType?: string;
  chunkSizeBytes?: number; // default 5MB
  maxRetries?: number;     // default 4
  baseDelayMs?: number;    // default 300ms
  maxDelayMs?: number;     // default 5000ms
  onProgress?: (bytesUploaded: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

export interface TusUploadSession {
  uploadUrl: string;
  totalBytes: number;
  offset: number;
}

export class TusResumableAdapter {
  private options: TusUploadOptions;

  constructor(options: TusUploadOptions) {
    this.options = {
      chunkSizeBytes: 5 * 1024 * 1024,
      maxRetries: 4,
      baseDelayMs: 300,
      maxDelayMs: 5000,
      ...options,
    };
  }

  /**
   * Encodes metadata string according to TUS specification (comma-separated key base64(value)).
   */
  public encodeMetadata(metadata: Record<string, string>): string {
    return Object.entries(metadata)
      .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
      .join(',');
  }

  /**
   * Initiates a new TUS upload session (POST creation).
   */
  public async createSession(
    totalBytes: number,
    fetchFn: typeof fetch = fetch
  ): Promise<TusUploadSession> {
    if (this.options.signal?.aborted) {
      throw new Error('Upload aborted prior to session creation');
    }

    const metadata = this.encodeMetadata({
      bucketName: this.options.bucketName,
      objectName: this.options.objectName,
      contentType: this.options.contentType || 'application/octet-stream',
    });

    const res = await fetchFn(this.options.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.options.bearerToken}`,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': totalBytes.toString(),
        'Upload-Metadata': metadata,
      },
      signal: this.options.signal,
    });

    if (res.status === 413) {
      throw new Error('Storage quota exceeded or file exceeds maximum allowed bucket size (HTTP 413)');
    }

    if (res.status !== 201) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to create TUS upload session: HTTP ${res.status} - ${text}`);
    }

    const location = res.headers.get('Location');
    if (!location) {
      throw new Error('TUS server did not return Location header in creation response');
    }

    return {
      uploadUrl: location,
      totalBytes,
      offset: 0,
    };
  }

  /**
   * Probes current byte offset on server via TUS HEAD request.
   */
  public async getOffset(
    uploadUrl: string,
    fetchFn: typeof fetch = fetch
  ): Promise<number> {
    const res = await fetchFn(uploadUrl, {
      method: 'HEAD',
      headers: {
        'Authorization': `Bearer ${this.options.bearerToken}`,
        'Tus-Resumable': '1.0.0',
      },
      signal: this.options.signal,
    });

    if (res.status === 404) {
      throw new Error('Upload session expired or does not exist (HTTP 404)');
    }

    if (res.status !== 200) {
      throw new Error(`Failed to probe TUS offset: HTTP ${res.status}`);
    }

    const offsetHeader = res.headers.get('Upload-Offset');
    if (offsetHeader === null) {
      throw new Error('TUS server omitted Upload-Offset header in HEAD response');
    }

    return parseInt(offsetHeader, 10);
  }

  /**
   * Uploads binary buffer slice via TUS PATCH.
   */
  public async sendPatch(
    uploadUrl: string,
    chunk: Buffer | Uint8Array,
    currentOffset: number,
    fetchFn: typeof fetch = fetch
  ): Promise<number> {
    const res = await fetchFn(uploadUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.options.bearerToken}`,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': currentOffset.toString(),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: chunk as unknown as BodyInit,
      signal: this.options.signal,
    });

    if (res.status === 409) {
      // Offset mismatch: client and server disagree on byte boundary
      throw new Error('TUS 409 Conflict: Upload offset mismatch');
    }

    if (res.status !== 204 && res.status !== 200) {
      const err = await res.text().catch(() => '');
      throw new Error(`TUS PATCH failed with HTTP ${res.status}: ${err}`);
    }

    const newOffset = res.headers.get('Upload-Offset');
    if (!newOffset) {
      return currentOffset + chunk.length;
    }
    return parseInt(newOffset, 10);
  }

  /**
   * Aborts/cancels the TUS upload session via DELETE request.
   */
  public async abortSession(
    uploadUrl: string,
    fetchFn: typeof fetch = fetch
  ): Promise<void> {
    const res = await fetchFn(uploadUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.options.bearerToken}`,
        'Tus-Resumable': '1.0.0',
      },
    });

    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new Error(`Failed to terminate TUS session: HTTP ${res.status}`);
    }
  }

  /**
   * Uploads an entire stream/buffer with bounded retries, auto-offset recovery, and cancellation.
   */
  public async upload(
    data: Buffer,
    fetchFn: typeof fetch = fetch
  ): Promise<{ uploadUrl: string; totalBytes: number; completed: boolean }> {
    const session = await this.createSession(data.length, fetchFn);
    let offset = session.offset;

    const chunkSize = this.options.chunkSizeBytes!;

    while (offset < data.length) {
      if (this.options.signal?.aborted) {
        await this.abortSession(session.uploadUrl, fetchFn).catch(() => {});
        throw new Error('Upload aborted by client signal');
      }

      const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
      let success = false;
      let attempt = 0;

      while (!success && attempt < this.options.maxRetries!) {
        try {
          offset = await this.sendPatch(session.uploadUrl, chunk, offset, fetchFn);
          success = true;

          if (this.options.onProgress) {
            this.options.onProgress(offset, data.length);
          }
        } catch (err: unknown) {
          attempt++;
          if (attempt >= this.options.maxRetries!) {
            throw err;
          }

          // In case of error (e.g. timeout or 409), query HEAD to re-sync authoritative offset
          try {
            offset = await this.getOffset(session.uploadUrl, fetchFn);
          } catch (_e) {
            // Keep existing offset if HEAD fails
          }

          // Full-jitter exponential backoff
          const delay = Math.min(
            this.options.maxDelayMs!,
            this.options.baseDelayMs! * Math.pow(2, attempt)
          ) * (0.5 + Math.random() * 0.5);

          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    return {
      uploadUrl: session.uploadUrl,
      totalBytes: data.length,
      completed: true,
    };
  }
}
