// ==============================================================================
// Database Types: Supabase Production-Grade Schema
// ==============================================================================

export type AppRole = 'owner' | 'admin' | 'member' | 'auditor' | 'readonly';
export type ObjectStatus = 'pending' | 'uploading' | 'verifying' | 'active' | 'archived' | 'deleted';
export type StorageTier = 'standard' | 'infrequent_access' | 'glacier';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface Organization {
  id: string;
  slug: string;
  name: string;
  plan_tier: 'starter' | 'pro' | 'enterprise';
  max_storage_bytes: number;
  storage_used_bytes: number;
  storage_reserved_bytes: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMember {
  id: string;
  org_id: string;
  user_id: string;
  role: AppRole;
  permissions: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Vault {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string | null;
  is_encrypted: boolean;
  kms_key_arn: string | null;
  retention_days: number;
  created_at: string;
  updated_at: string;
}

export interface VaultObject {
  id: string;
  org_id: string;
  vault_id: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string | null;
  etag: string | null;
  status: ObjectStatus;
  storage_tier: StorageTier;
  metadata: Record<string, unknown>;
  version_id: number;
  is_latest: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MultipartUpload {
  id: string;
  org_id: string;
  vault_id: string;
  object_key: string;
  upload_id: string;
  expected_size_bytes: number;
  part_size_bytes: number;
  total_parts: number;
  status: 'initiated' | 'in_progress' | 'assembling' | 'completed' | 'aborted';
  expires_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ObjectPart {
  id: string;
  upload_id: string;
  part_number: number;
  size_bytes: number;
  checksum_sha256: string;
  etag: string;
  uploaded_at: string;
}

export interface AuditEvent {
  id: string;
  org_id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface JobQueueItem {
  id: string;
  queue_name: string;
  org_id: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  retry_count: number;
  max_retries: number;
  scheduled_at: string;
  locked_until: string | null;
  locked_by: string | null;
  last_error: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
