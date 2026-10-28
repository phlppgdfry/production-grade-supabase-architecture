-- ==============================================================================
-- Migration: 20261027000004_storage_engine_triggers.sql
-- Description: Atomic Two-Phase Storage Quota Reservation, Accounting & Integrity State Machine
-- Standards: Supabase Postgres Best Practices v1.1.0
--   - lock-short-transactions: atomic conditional UPDATE eliminating over-allocation races
--   - security-privileges: SECURITY DEFINER with fixed search_path = public, pg_temp
-- ==============================================================================

-- 1. ATOMIC QUOTA RESERVATION (Before Multipart Upload Initiation)
-- Replaces flawed SELECT ... FOR SHARE with atomic conditional UPDATE
CREATE OR REPLACE FUNCTION public.fn_reserve_storage_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_updated_rows int;
BEGIN
    -- Atomic conditional reservation at row level:
    -- If (used + reserved + requested) > max, the WHERE predicate fails, updating 0 rows.
    UPDATE public.organizations
    SET storage_reserved_bytes = storage_reserved_bytes + NEW.expected_size_bytes,
        updated_at = now()
    WHERE id = NEW.org_id
      AND is_active = true
      AND (storage_used_bytes + storage_reserved_bytes + NEW.expected_size_bytes) <= max_storage_bytes;

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

    IF v_updated_rows = 0 THEN
        RAISE EXCEPTION 'Storage quota exceeded: insufficient headroom for % bytes reservation on organization %',
            NEW.expected_size_bytes, NEW.org_id
            USING ERRCODE = '54000'; -- program_limit_exceeded
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reserve_storage_quota_multipart
    BEFORE INSERT ON public.object_multipart_uploads
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_reserve_storage_quota();

-- 2. ATOMIC QUOTA RELEASE (On Multipart Upload Abort, Failure or Deletion)
CREATE OR REPLACE FUNCTION public.fn_release_storage_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF (TG_OP = 'UPDATE' AND OLD.status IN ('initiated', 'in_progress', 'assembling') AND NEW.status IN ('aborted', 'failed')) THEN
        UPDATE public.organizations
        SET storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - OLD.expected_size_bytes),
            updated_at = now()
        WHERE id = OLD.org_id;
    ELSIF (TG_OP = 'DELETE' AND OLD.status IN ('initiated', 'in_progress', 'assembling')) THEN
        UPDATE public.organizations
        SET storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - OLD.expected_size_bytes),
            updated_at = now()
        WHERE id = OLD.org_id;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_release_storage_reservation
    AFTER UPDATE OR DELETE ON public.object_multipart_uploads
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_release_storage_reservation();

-- 3. ATOMIC QUOTA ACCOUNTING (On Vault Object Activation / Deletion)
CREATE OR REPLACE FUNCTION public.fn_sync_storage_quota_accounting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF (TG_OP = 'INSERT' AND NEW.status = 'active') THEN
        -- Direct upload: increment used bytes
        UPDATE public.organizations
        SET storage_used_bytes = storage_used_bytes + NEW.size_bytes,
            updated_at = now()
        WHERE id = NEW.org_id;
    ELSIF (TG_OP = 'UPDATE') THEN
        IF (OLD.status != 'active' AND NEW.status = 'active') THEN
            -- Transition from reserved to active used bytes
            UPDATE public.organizations
            SET storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - NEW.size_bytes),
                storage_used_bytes = storage_used_bytes + NEW.size_bytes,
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

-- 4. MULTIPART PART VERIFICATION & AUTO-TRANSITION TRIGGER
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

-- 5. EXPIRED UPLOAD REAPER (Reclaims orphaned quota reservations & cleanups)
CREATE OR REPLACE FUNCTION public.reap_expired_multipart_uploads(
    p_batch_size int DEFAULT 50
)
RETURNS TABLE (
    reaped_count int,
    reclaimed_bytes bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reaped int := 0;
    v_bytes bigint := 0;
    r RECORD;
BEGIN
    FOR r IN
        SELECT id, upload_id, org_id, expected_size_bytes
        FROM public.object_multipart_uploads
        WHERE status IN ('initiated', 'in_progress')
          AND expires_at < now()
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE public.object_multipart_uploads
        SET status = 'aborted',
            updated_at = now()
        WHERE id = r.id;

        v_reaped := v_reaped + 1;
        v_bytes := v_bytes + r.expected_size_bytes;
    END LOOP;

    reaped_count := v_reaped;
    reclaimed_bytes := v_bytes;
    RETURN NEXT;
END;
$$;
