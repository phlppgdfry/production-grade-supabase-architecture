-- ==============================================================================
-- Migration: 20261027000002_core_multitenant_schema.sql
-- Description: Core tables for multi-tenant isolation, enterprise vaults, and storage multipart
-- Standards: Supabase Postgres Best Practices v1.1.0
--   - schema-data-types: timestamptz for temporal columns, bigint for storage byte counts
--   - schema-foreign-key-indexes: indexed in Migration 06
--   - schema-constraints: NOT NULL on business keys, CHECK constraints on size and status
-- ==============================================================================

-- 1. ORGANIZATIONS (TENANTS)
CREATE TABLE public.organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    plan_tier text NOT NULL DEFAULT 'starter' CHECK (plan_tier IN ('starter', 'pro', 'enterprise')),
    max_storage_bytes bigint NOT NULL DEFAULT 10737418240, -- 10 GiB default
    storage_used_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
    storage_reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_reserved_bytes >= 0),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_org_slug_format CHECK (slug ~* '^[a-z0-9-]+$'),
    CONSTRAINT chk_org_quota_headroom CHECK ((storage_used_bytes + storage_reserved_bytes) <= max_storage_bytes)
);

-- 2. ORGANIZATION MEMBERSHIPS (RBAC / ABAC)
CREATE TABLE public.organization_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL, -- references auth.users(id) in runtime
    role app_role NOT NULL DEFAULT 'member',
    permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_org_user UNIQUE (org_id, user_id)
);

-- 3. VAULTS (Logical Storage Containers per Organization)
CREATE TABLE public.vaults (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    is_encrypted boolean NOT NULL DEFAULT true,
    kms_key_arn text,
    retention_days int DEFAULT 365 CHECK (retention_days > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_org_vault_slug UNIQUE (org_id, slug)
);

-- 4. VAULT OBJECTS (Object Storage Metadata Registry)
CREATE TABLE public.vault_objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    vault_id uuid NOT NULL REFERENCES public.vaults(id) ON DELETE CASCADE,
    object_key text NOT NULL,
    content_type text NOT NULL DEFAULT 'application/octet-stream',
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    checksum_sha256 sha256_type,
    etag etag_type,
    status object_status NOT NULL DEFAULT 'pending',
    storage_tier storage_tier NOT NULL DEFAULT 'standard',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    version_id int NOT NULL DEFAULT 1 CHECK (version_id >= 1),
    is_latest boolean NOT NULL DEFAULT true,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CONSTRAINT uq_vault_object_version UNIQUE (org_id, vault_id, object_key, version_id),
    CONSTRAINT chk_object_key_not_empty CHECK (length(trim(object_key)) > 0)
);

-- 5. OBJECT MULTIPART UPLOADS (S3 / TUS Resumable Upload State Machine)
CREATE TABLE public.object_multipart_uploads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    vault_id uuid NOT NULL REFERENCES public.vaults(id) ON DELETE CASCADE,
    object_key text NOT NULL,
    upload_id text NOT NULL UNIQUE,
    expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes > 0),
    part_size_bytes bigint NOT NULL DEFAULT 5242880 CHECK (part_size_bytes >= 5242880), -- 5MB min S3 standard
    total_parts int NOT NULL CHECK (total_parts >= 1),
    status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'in_progress', 'assembling', 'completed', 'aborted')),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6. OBJECT PARTS (Individual verified chunks)
CREATE TABLE public.object_parts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id text NOT NULL REFERENCES public.object_multipart_uploads(upload_id) ON DELETE CASCADE,
    part_number int NOT NULL CHECK (part_number >= 1),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    checksum_sha256 sha256_type NOT NULL,
    etag etag_type NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_upload_part UNIQUE (upload_id, part_number)
);

-- 7. VECTOR EMBEDDINGS (pgvector semantic search index)
CREATE TABLE public.vector_embeddings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    object_id uuid NOT NULL REFERENCES public.vault_objects(id) ON DELETE CASCADE,
    chunk_index int NOT NULL DEFAULT 0,
    content_snippet text NOT NULL,
    embedding extensions.vector(1536),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_object_chunk_index UNIQUE (object_id, chunk_index)
);
