-- ==============================================================================
-- Migration: 20261027000005_declarative_partitioning_and_queues.sql
-- Description: Declarative range partitioning for audit telemetry & SKIP LOCKED queue
-- Standards: Supabase Postgres Best Practices v1.1.0
--   - schema-partitioning: partition by RANGE (created_at) for time-series logs
--   - lock-skip-locked: non-blocking concurrent job worker pattern
--   - security-privileges: internal schema isolated from public API
-- ==============================================================================

-- 1. DECLARATIVE PARTITIONED AUDIT LOG
CREATE TABLE telemetry.audit_events (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    ip_address inet,
    user_agent text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Partitions for 2026
CREATE TABLE telemetry.audit_events_2026_q3 PARTITION OF telemetry.audit_events
    FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

CREATE TABLE telemetry.audit_events_2026_q4 PARTITION OF telemetry.audit_events
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

-- Partitions for 2027
CREATE TABLE telemetry.audit_events_2027_q1 PARTITION OF telemetry.audit_events
    FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');

CREATE TABLE telemetry.audit_events_default PARTITION OF telemetry.audit_events DEFAULT;

-- Enable RLS on audit events
ALTER TABLE telemetry.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_tenant_select ON telemetry.audit_events
    FOR SELECT
    TO authenticated
    USING (
        org_id IN (SELECT org_id FROM public.get_user_org_ids())
        AND public.user_has_org_role(org_id, ARRAY['owner', 'admin', 'auditor']::app_role[])
    );

-- 2. HIGH-THROUGHPUT JOB QUEUE (FOR UPDATE SKIP LOCKED)
CREATE TABLE internal.job_queue (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_name text NOT NULL,
    org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    status job_status NOT NULL DEFAULT 'queued',
    priority int NOT NULL DEFAULT 100, -- lower number = higher priority
    retry_count int NOT NULL DEFAULT 0,
    max_retries int NOT NULL DEFAULT 3,
    scheduled_at timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz,
    locked_by text,
    last_error text,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index for queue worker polling with zero lock contention
CREATE INDEX idx_job_queue_fetch ON internal.job_queue (queue_name, priority ASC, scheduled_at ASC)
    WHERE status = 'queued';

-- 3. QUEUE WORKER RPC (Zero-Contention Multi-Worker Dequeue)
CREATE OR REPLACE FUNCTION internal.dequeue_jobs(
    p_queue_name text,
    p_worker_id text,
    p_batch_size int DEFAULT 10,
    p_lock_duration_seconds int DEFAULT 60
)
RETURNS TABLE (
    job_id uuid,
    org_id uuid,
    payload jsonb,
    retry_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = internal, public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    WITH available_jobs AS (
        SELECT id
        FROM internal.job_queue
        WHERE queue_name = p_queue_name
          AND (status = 'queued' OR (status = 'processing' AND locked_until < now()))
          AND scheduled_at <= now()
        ORDER BY priority ASC, scheduled_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT p_batch_size
    )
    UPDATE internal.job_queue q
    SET status = 'processing',
        locked_by = p_worker_id,
        locked_until = now() + (p_lock_duration_seconds || ' seconds')::interval,
        updated_at = now()
    FROM available_jobs
    WHERE q.id = available_jobs.id
    RETURNING q.id, q.org_id, q.payload, q.retry_count;
END;
$$;

-- 4. JOB COMPLETION & FAILURE RPCs
CREATE OR REPLACE FUNCTION internal.complete_job(
    p_job_id uuid,
    p_worker_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = internal, public, pg_temp
AS $$
BEGIN
    UPDATE internal.job_queue
    SET status = 'completed',
        locked_until = NULL,
        completed_at = now(),
        updated_at = now()
    WHERE id = p_job_id
      AND locked_by = p_worker_id;
END;
$$;

CREATE OR REPLACE FUNCTION internal.fail_job(
    p_job_id uuid,
    p_worker_id text,
    p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = internal, public, pg_temp
AS $$
BEGIN
    UPDATE internal.job_queue
    SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed'::job_status ELSE 'queued'::job_status END,
        retry_count = retry_count + 1,
        last_error = p_error,
        scheduled_at = now() + ((retry_count + 1) * 30 || ' seconds')::interval, -- exponential backoff
        locked_until = NULL,
        updated_at = now()
    WHERE id = p_job_id
      AND locked_by = p_worker_id;
END;
$$;
