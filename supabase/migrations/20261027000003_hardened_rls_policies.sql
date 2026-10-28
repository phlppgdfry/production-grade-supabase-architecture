-- ==============================================================================
-- Migration: 20261027000003_hardened_rls_policies.sql
-- Description: Zero-leakage Row Level Security (RLS) policies with initPlan optimization
-- Standards: Supabase Postgres Best Practices v1.1.0
--   - security-rls-performance: (SELECT auth.uid()) wrapped in subqueries to force initPlan
--   - security-privileges: SECURITY DEFINER with fixed search_path = public, pg_temp
--   - lock-advisory: no recursive locks or self-referential RLS loops
-- ==============================================================================

-- 1. SECURITY DEFINER HELPER FUNCTIONS
-- Explicit search_path prevents search_path hijacking attacks

CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
        auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.user_has_org_role(
    target_org_id uuid,
    required_roles app_role[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_members m
        WHERE m.org_id = target_org_id
          AND m.user_id = (SELECT public.current_user_id())
          AND m.is_active = true
          AND m.role = ANY(required_roles)
    );
$$;

CREATE OR REPLACE FUNCTION public.get_user_org_ids()
RETURNS TABLE (org_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT m.org_id
    FROM public.organization_members m
    WHERE m.user_id = (SELECT public.current_user_id())
      AND m.is_active = true;
$$;

-- 2. ENABLE ROW LEVEL SECURITY ON ALL TABLES
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members FORCE ROW LEVEL SECURITY;

ALTER TABLE public.vaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vaults FORCE ROW LEVEL SECURITY;

ALTER TABLE public.vault_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vault_objects FORCE ROW LEVEL SECURITY;

ALTER TABLE public.object_multipart_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_multipart_uploads FORCE ROW LEVEL SECURITY;

ALTER TABLE public.object_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_parts FORCE ROW LEVEL SECURITY;

ALTER TABLE public.vector_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vector_embeddings FORCE ROW LEVEL SECURITY;

-- 3. POLICIES: ORGANIZATIONS
-- Users can only view organizations they are active members of
CREATE POLICY org_select_policy ON public.organizations
    FOR SELECT
    TO authenticated
    USING (
        id IN (SELECT org_id FROM public.get_user_org_ids())
    );

-- Only owners and admins can update organization profile
CREATE POLICY org_update_policy ON public.organizations
    FOR UPDATE
    TO authenticated
    USING (
        public.user_has_org_role(id, ARRAY['owner', 'admin']::app_role[])
    )
    WITH CHECK (
        public.user_has_org_role(id, ARRAY['owner', 'admin']::app_role[])
    );

-- 4. POLICIES: ORGANIZATION MEMBERS
-- Members can view their peers within the same organization
CREATE POLICY org_members_select_policy ON public.organization_members
    FOR SELECT
    TO authenticated
    USING (
        org_id IN (SELECT org_id FROM public.get_user_org_ids())
    );

-- Only owners and admins can invite or modify memberships
CREATE POLICY org_members_write_policy ON public.organization_members
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin']::app_role[])
    );

CREATE POLICY org_members_update_policy ON public.organization_members
    FOR UPDATE
    TO authenticated
    USING (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin']::app_role[])
    )
    WITH CHECK (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin']::app_role[])
    );

CREATE POLICY org_members_delete_policy ON public.organization_members
    FOR DELETE
    TO authenticated
    USING (
        public.user_has_org_role(org_id, ARRAY['owner']::app_role[])
    );

-- 5. POLICIES: VAULTS
CREATE POLICY vaults_select_policy ON public.vaults
    FOR SELECT
    TO authenticated
    USING (
        org_id IN (SELECT org_id FROM public.get_user_org_ids())
    );

CREATE POLICY vaults_insert_policy ON public.vaults
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin', 'member']::app_role[])
    );

CREATE POLICY vaults_modify_policy ON public.vaults
    FOR UPDATE
    TO authenticated
    USING (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin']::app_role[])
    )
    WITH CHECK (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin']::app_role[])
    );

-- 6. POLICIES: VAULT OBJECTS
-- Read: Active members of the organization
CREATE POLICY vault_objects_select_policy ON public.vault_objects
    FOR SELECT
    TO authenticated
    USING (
        org_id IN (SELECT org_id FROM public.get_user_org_ids())
        AND (deleted_at IS NULL OR public.user_has_org_role(org_id, ARRAY['owner', 'admin', 'auditor']::app_role[]))
    );

-- Insert: Write allowed for owner, admin, member (excludes auditor, readonly)
-- Strictly enforces created_by attribution matching current_user_id (no null bypass)
CREATE POLICY vault_objects_insert_policy ON public.vault_objects
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin', 'member']::app_role[])
        AND created_by = (SELECT public.current_user_id())
    );

-- Update: Modification restricted to non-readonly roles
CREATE POLICY vault_objects_update_policy ON public.vault_objects
    FOR UPDATE
    TO authenticated
    USING (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin', 'member']::app_role[])
    )
    WITH CHECK (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin', 'member']::app_role[])
    );

-- Delete: Soft-delete or hard delete restricted to owner / admin
CREATE POLICY vault_objects_delete_policy ON public.vault_objects
    FOR DELETE
    TO authenticated
    USING (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin']::app_role[])
    );

-- 7. POLICIES: MULTIPART UPLOADS & PARTS
CREATE POLICY multipart_select_policy ON public.object_multipart_uploads
    FOR SELECT
    TO authenticated
    USING (
        org_id IN (SELECT org_id FROM public.get_user_org_ids())
    );

CREATE POLICY multipart_insert_policy ON public.object_multipart_uploads
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.user_has_org_role(org_id, ARRAY['owner', 'admin', 'member']::app_role[])
        AND created_by = (SELECT public.current_user_id())
    );

CREATE POLICY parts_select_policy ON public.object_parts
    FOR SELECT
    TO authenticated
    USING (
        upload_id IN (
            SELECT upload_id FROM public.object_multipart_uploads
            WHERE org_id IN (SELECT org_id FROM public.get_user_org_ids())
        )
    );

CREATE POLICY parts_insert_policy ON public.object_parts
    FOR INSERT
    TO authenticated
    WITH CHECK (
        upload_id IN (
            SELECT upload_id FROM public.object_multipart_uploads
            WHERE org_id IN (SELECT org_id FROM public.get_user_org_ids())
              AND public.user_has_org_role(org_id, ARRAY['owner', 'admin', 'member']::app_role[])
        )
    );

-- 8. POLICIES: VECTOR EMBEDDINGS
CREATE POLICY vector_embeddings_select_policy ON public.vector_embeddings
    FOR SELECT
    TO authenticated
    USING (
        org_id IN (SELECT org_id FROM public.get_user_org_ids())
    );
