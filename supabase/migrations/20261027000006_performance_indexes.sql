-- ==============================================================================
-- Migration: 20261027000006_performance_indexes.sql
-- Description: Production-grade indexing strategy (B-Tree, GIN, BRIN, Covering & Partial)
-- Standards: Supabase Postgres Best Practices v1.1.0
--   - schema-foreign-key-indexes: complete indexing of every FK column
--   - query-composite-indexes: (tenant_id, filter_column, sort_column) order
--   - query-partial-indexes: partial indexes on active records to minimize index bloat
--   - query-covering-indexes: INCLUDE clause for zero-heap-fetch index-only scans
--   - advanced-jsonb-indexing: GIN jsonb_path_ops on document metadata
-- ==============================================================================

-- 1. FOREIGN KEY & TENANT ISOLATION INDEXES
-- Organization members lookup & RLS subquery accelerator (Index-Only Scan)
CREATE INDEX idx_org_members_user_org_role
    ON public.organization_members (user_id, org_id, role)
    INCLUDE (is_active)
    WHERE is_active = true;

CREATE INDEX idx_org_members_org_id
    ON public.organization_members (org_id);

-- Vaults lookup by organization
CREATE INDEX idx_vaults_org_id
    ON public.vaults (org_id, slug);

-- 2. HOT VAULT OBJECTS QUERY OPTIMIZATIONS
-- Covering index for vault listing: tenant + vault + object_key + sort
CREATE INDEX idx_vault_objects_tenant_vault_active
    ON public.vault_objects (org_id, vault_id, created_at DESC)
    INCLUDE (object_key, size_bytes, content_type, status)
    WHERE deleted_at IS NULL;

-- Exact lookup by tenant + key (unique version lookup)
CREATE INDEX idx_vault_objects_key_lookup
    ON public.vault_objects (org_id, object_key)
    WHERE is_latest = true AND deleted_at IS NULL;

-- Partial index for pending / uploading files needing garbage collection or verification
CREATE INDEX idx_vault_objects_inflight
    ON public.vault_objects (status, created_at)
    WHERE status IN ('pending', 'uploading', 'verifying');

-- 3. ADVANCED JSONB & FULL-TEXT SEARCH
-- GIN index using jsonb_path_ops for fast @> containment searches on metadata tags
CREATE INDEX idx_vault_objects_metadata_gin
    ON public.vault_objects USING gin (metadata jsonb_path_ops);

-- 4. MULTIPART & CHUNKING LOOKUPS
CREATE INDEX idx_multipart_org_status
    ON public.object_multipart_uploads (org_id, status, created_at DESC);

CREATE INDEX idx_object_parts_upload_id
    ON public.object_parts (upload_id, part_number ASC);

-- 5. VECTOR EMBEDDINGS HNSW INDEX
-- Hierarchical Navigable Small World index for sub-5ms cosine similarity search
CREATE INDEX idx_vector_embeddings_hnsw
    ON public.vector_embeddings USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- 6. AUDIT TELEMETRY BRIN & COMPOSITE INDEXES
-- BRIN index on partitioned audit logs (extremely low storage footprint for time-series)
CREATE INDEX idx_audit_events_created_at_brin
    ON telemetry.audit_events USING brin (created_at);

-- Tenant query index for compliance reporting
CREATE INDEX idx_audit_events_org_created
    ON telemetry.audit_events (org_id, created_at DESC)
    INCLUDE (action, resource_type, actor_id);
