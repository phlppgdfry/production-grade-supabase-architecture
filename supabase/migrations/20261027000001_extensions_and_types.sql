-- ==============================================================================
-- Migration: 20261027000001_extensions_and_types.sql
-- Description: Core extensions, schemas, custom ENUMs, and domain types
-- Standards: Supabase Postgres Best Practices v1.1.0 (schema-lowercase-identifiers)
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA extensions;

-- 2. CUSTOM SCHEMAS
-- We isolate internal engine operations from public REST/GraphQL exposure
CREATE SCHEMA IF NOT EXISTS internal;
CREATE SCHEMA IF NOT EXISTS telemetry;

GRANT USAGE ON SCHEMA internal TO postgres, service_role;
GRANT USAGE ON SCHEMA telemetry TO postgres, service_role, authenticated;

-- 3. CUSTOM ENUMS & DOMAIN TYPES
DO $$ BEGIN
    CREATE TYPE app_role AS ENUM ('owner', 'admin', 'member', 'auditor', 'readonly');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE object_status AS ENUM ('pending', 'uploading', 'verifying', 'active', 'archived', 'deleted');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE storage_tier AS ENUM ('standard', 'infrequent_access', 'glacier');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'completed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Domain type: ETag format (hex string with optional quotes)
CREATE DOMAIN etag_type AS text
    CHECK (VALUE ~* '^"?([a-f0-9]{32}(-[0-9]+)?)"?$');

-- Domain type: SHA-256 Hex string
CREATE DOMAIN sha256_type AS text
    CHECK (VALUE ~* '^[a-f0-9]{64}$');
