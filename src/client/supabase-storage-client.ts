// ==============================================================================
// Client: Enterprise Multi-Tenant Supabase Storage Client
// Description: Type-safe, RLS-aware SDK with resumable upload pipeline
// ==============================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ResumableChunkUploader, UploaderOptions } from './resumable-uploader.js';
import { Vault, VaultObject, AuditEvent } from '../types/database.types.js';

export interface EnterpriseClientConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  authToken?: string;
}

export interface UploadObjectParams {
  orgId: string;
  vaultId: string;
  objectKey: string;
  data: Buffer;
  contentType?: string;
  metadata?: Record<string, unknown>;
  uploaderOptions?: UploaderOptions;
}

export class EnterpriseSupabaseClient {
  public readonly supabase: SupabaseClient;

  constructor(config: EnterpriseClientConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      global: {
        headers: config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {},
      },
    });
  }

  /**
   * Retrieves vaults visible to the authenticated tenant user.
   */
  public async listVaults(orgId: string): Promise<Vault[]> {
    const { data, error } = await this.supabase
      .from('vaults')
      .select('*')
      .eq('org_id', orgId)
      .order('name');

    if (error) throw new Error(`Failed to list vaults: ${error.message}`);
    return (data as Vault[]) || [];
  }

  /**
   * Retrieves objects within a vault using cursor-based pagination (avoids OFFSET performance cliff).
   */
  public async listObjects(
    orgId: string,
    vaultId: string,
    params: { limit?: number; cursorCreatedAt?: string } = {}
  ): Promise<VaultObject[]> {
    const limit = params.limit ?? 50;
    let query = this.supabase
      .from('vault_objects')
      .select('*')
      .eq('org_id', orgId)
      .eq('vault_id', vaultId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (params.cursorCreatedAt) {
      query = query.lt('created_at', params.cursorCreatedAt);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to list vault objects: ${error.message}`);
    return (data as VaultObject[]) || [];
  }

  /**
   * High-level multipart resumable upload pipeline.
   */
  public async uploadObject(
    params: UploadObjectParams
  ): Promise<{ objectId: string; uploadId: string; totalBytes: number }> {
    const { orgId, vaultId, objectKey, data, contentType, metadata, uploaderOptions } = params;

    const uploader = new ResumableChunkUploader(uploaderOptions);
    const chunks = uploader.prepareChunks(data);

    // 1. Initiate Multipart Session via Edge Function or Direct Table RPC
    const { data: session, error: initError } = await this.supabase
      .from('object_multipart_uploads')
      .insert({
        org_id: orgId,
        vault_id: vaultId,
        object_key: objectKey,
        upload_id: `upl_${crypto.randomUUID().replace(/-/g, '')}`,
        expected_size_bytes: data.length,
        part_size_bytes: chunks[0]?.sizeBytes ?? 5242880,
        total_parts: chunks.length,
        status: 'initiated',
      })
      .select()
      .single();

    if (initError) throw new Error(`Multipart initiation failed: ${initError.message}`);

    const uploadId = session.upload_id;

    // 2. Dispatch chunks with concurrency and verified checksums
    await uploader.upload(uploadId, chunks, async (chunk) => {
      const { error: partError } = await this.supabase
        .from('object_parts')
        .insert({
          upload_id: uploadId,
          part_number: chunk.partNumber,
          size_bytes: chunk.sizeBytes,
          checksum_sha256: chunk.sha256,
          etag: chunk.etag,
        });

      if (partError) {
        throw new Error(`Failed part ${chunk.partNumber}: ${partError.message}`);
      }

      return { success: true, etag: chunk.etag };
    });

    // 3. Register final Vault Object
    const { data: finalObject, error: objectError } = await this.supabase
      .from('vault_objects')
      .insert({
        org_id: orgId,
        vault_id: vaultId,
        object_key: objectKey,
        content_type: contentType || 'application/octet-stream',
        size_bytes: data.length,
        checksum_sha256: chunks[0]?.sha256,
        status: 'active',
        metadata: metadata || {},
      })
      .select()
      .single();

    if (objectError) throw new Error(`Final object registration failed: ${objectError.message}`);

    return {
      objectId: finalObject.id,
      uploadId,
      totalBytes: data.length,
    };
  }

  /**
   * Retrieves aggregated storage analytics for an organization.
   */
  public async getStorageUsage(orgId: string) {
    const { data, error } = await this.supabase
      .from('v_tenant_storage_analytics')
      .select('*')
      .eq('org_id', orgId)
      .single();

    if (error) throw new Error(`Failed to fetch storage analytics: ${error.message}`);
    return data;
  }

  /**
   * Ingests batch audit events into partitioned telemetry storage.
   */
  public async ingestAuditEvents(events: Partial<AuditEvent>[]): Promise<void> {
    const { error } = await this.supabase
      .schema('telemetry')
      .from('audit_events')
      .insert(events);

    if (error) throw new Error(`Audit ingestion failed: ${error.message}`);
  }
}
