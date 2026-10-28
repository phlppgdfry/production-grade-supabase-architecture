-- ==============================================================================
-- Migration: 20261027000004_storage_engine_triggers.sql
-- Description: Storage quota enforcement, atomic byte accounting & upload state machine
-- Standards: Supabase Postgres Best Practices v1.1.0
--   - lock-short-transactions: fast atomic updates with minimal row locks
--   - security-privileges: SECURITY DEFINER with fixed search_path = public, pg_temp
-- ==============================================================================

-- 1. QUOTA CHECK TRIGGER (Before Multipart Upload Initiation)
CREATE OR REPLACE FUNCTION public.fn_check_storage_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_used_bytes bigint;
    v_max_bytes bigint;
    v_is_active boolean;
BEGIN
    SELECT storage_used_bytes, max_storage_bytes, is_active
    INTO v_used_bytes, v_max_bytes, v_is_active
    FROM public.organizations
    WHERE id = NEW.org_id
    FOR SHARE; -- Acquire lightweight shared lock on organization row

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Organization % does not exist', NEW.org_id;
    END IF;

    IF NOT v_is_active THEN
        RAISE EXCEPTION 'Organization % is currently suspended or inactive', NEW.org_id;
    END IF;

    IF (v_used_bytes + NEW.expected_size_bytes) > v_max_bytes THEN
        RAISE EXCEPTION 'Storage quota exceeded: Current usage % bytes + requested % bytes exceeds quota % bytes',
            v_used_bytes, NEW.expected_size_bytes, v_max_bytes
            USING ERRCODE = '54000'; -- program_limit_exceeded
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_check_storage_quota_multipart
    BEFORE INSERT ON public.object_multipart_uploads
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_check_storage_quota();

-- 2. ATOMIC QUOTA ACCOUNTING (On Vault Object Activation / Deletion)
CREATE OR REPLACE FUNCTION public.fn_sync_storage_quota_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF (TG_OP = 'INSERT' AND NEW.status = 'active') THEN
        UPDATE public.organizations
        SET storage_used_bytes = storage_used_bytes + NEW.size_bytes,
            updated_at = now()
        WHERE id = NEW.org_id;
    ELSIF (TG_OP = 'UPDATE') THEN
        IF (OLD.status != 'active' AND NEW.status = 'active') THEN
            UPDATE public.organizations
            SET storage_used_bytes = storage_used_bytes + NEW.size_bytes,
                updated_at = now()
            WHERE id = NEW.org_id;
        ELSIF (OLD.status = 'active' AND NEW.status = 'deleted') THEN
            UPDATE public.organizations
            SET storage_used_bytes = GREATEST(0, storage_used_bytes - OLD.size_bytes),
                updated_at = now()
            WHERE id = NEW.org_id;
        END IF;
    ELSIF (TG_OP = 'DELETE' AND OLD.status = 'active') THEN
        UPDATE public.organizations
        SET storage_used_bytes = GREATEST(0, storage_used_bytes - OLD.size_bytes),
            updated_at = now()
        WHERE id = OLD.org_id;
    END IF;

    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_sync_storage_quota_accounting
    AFTER INSERT OR UPDATE OR DELETE ON public.vault_objects
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_sync_storage_quota_accounting();

-- 3. MULTIPART PART VERIFICATION & AUTO-TRANSITION TRIGGER
CREATE OR REPLACE FUNCTION public.fn_verify_part_and_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_total_parts int;
    v_uploaded_parts int;
    v_expected_bytes bigint;
    v_actual_bytes bigint;
BEGIN
    SELECT total_parts, expected_size_bytes
    INTO v_total_parts, v_expected_bytes
    FROM public.object_multipart_uploads
    WHERE upload_id = NEW.upload_id;

    SELECT count(*), coalesce(sum(size_bytes), 0)
    INTO v_uploaded_parts, v_actual_bytes
    FROM public.object_parts
    WHERE upload_id = NEW.upload_id;

    -- If all parts uploaded, verify sizes and mark as assembling
    IF v_uploaded_parts = v_total_parts THEN
        IF v_actual_bytes != v_expected_bytes THEN
            RAISE EXCEPTION 'Chunk integrity mismatch: expected % bytes, accumulated % bytes across % parts',
                v_expected_bytes, v_actual_bytes, v_uploaded_parts
                USING ERRCODE = '22000'; -- data_exception
        END IF;

        UPDATE public.object_multipart_uploads
        SET status = 'assembling',
            updated_at = now()
        WHERE upload_id = NEW.upload_id;
    ELSE
        UPDATE public.object_multipart_uploads
        SET status = 'in_progress',
            updated_at = now()
        WHERE upload_id = NEW.upload_id
          AND status = 'initiated';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_verify_part_and_transition
    AFTER INSERT ON public.object_parts
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_verify_part_and_transition();
