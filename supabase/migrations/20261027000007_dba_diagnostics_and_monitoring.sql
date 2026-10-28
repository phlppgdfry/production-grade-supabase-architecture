-- ==============================================================================
-- Migration: 20261027000007_dba_diagnostics_and_monitoring.sql
-- Description: SRE & DBA diagnostic views for pg_stat_statements, index efficiency & pooler
-- Standards: Supabase Postgres Best Practices v1.1.0
--   - monitor-pg-stat-statements: mean_exec_time, calls, buffer hit ratio
--   - monitor-vacuum-analyze: table bloat and dead tuple diagnostics
--   - conn-limits: connection pool saturation monitoring
-- ==============================================================================

-- 1. SLOW QUERY DIAGNOSTICS (pg_stat_statements wrapper)
CREATE OR REPLACE VIEW internal.v_slow_queries AS
SELECT
    pss.queryid,
    pss.calls,
    round(pss.total_exec_time::numeric, 2) AS total_time_ms,
    round(pss.mean_exec_time::numeric, 2) AS mean_time_ms,
    round(pss.min_exec_time::numeric, 2) AS min_time_ms,
    round(pss.max_exec_time::numeric, 2) AS max_time_ms,
    pss.rows,
    round((pss.rows::numeric / nullif(pss.calls, 0)), 1) AS rows_per_call,
    round(
        100.0 * (pss.shared_blks_hit::numeric / nullif(pss.shared_blks_hit + pss.shared_blks_read, 0)),
        2
    ) AS buffer_hit_pct,
    left(pss.query, 160) AS query_preview
FROM extensions.pg_stat_statements pss
JOIN pg_database db ON db.oid = pss.dbid
WHERE db.datname = current_database()
  AND pss.calls > 5
ORDER BY pss.mean_exec_time DESC
LIMIT 50;

-- 2. INDEX USAGE & MISSING INDEX DETECTOR
CREATE OR REPLACE VIEW internal.v_index_efficiency AS
SELECT
    schemaname,
    relname AS table_name,
    indexrelname AS index_name,
    idx_scan AS number_of_scans,
    idx_tup_read AS tuples_read,
    idx_tup_fetch AS tuples_fetched,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
    CASE
        WHEN idx_scan = 0 THEN 'UNUSED - Consider dropping if not primary/foreign key'
        WHEN idx_scan < 50 THEN 'LOW USAGE'
        ELSE 'ACTIVE'
    END AS status
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;

-- 3. BUFFER CACHE HIT RATIO (Target: >= 99%)
CREATE OR REPLACE VIEW internal.v_cache_hit_ratios AS
SELECT
    schemaname,
    relname AS table_name,
    heap_blks_read AS disk_reads,
    heap_blks_hit AS cache_hits,
    round(
        100.0 * (heap_blks_hit::numeric / nullif(heap_blks_hit + heap_blks_read, 0)),
        2
    ) AS cache_hit_pct,
    n_dead_tup AS dead_tuples,
    n_live_tup AS live_tuples,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
ORDER BY (heap_blks_hit + heap_blks_read) DESC;

-- 4. TENANT STORAGE CONSUMPTION & QUOTA UTILIZATION
CREATE OR REPLACE VIEW public.v_tenant_storage_analytics AS
SELECT
    o.id AS org_id,
    o.name AS organization_name,
    o.slug,
    o.plan_tier,
    o.storage_used_bytes,
    o.storage_reserved_bytes,
    o.max_storage_bytes,
    round(100.0 * ((o.storage_used_bytes + o.storage_reserved_bytes)::numeric / nullif(o.max_storage_bytes, 0)), 2) AS quota_utilization_pct,
    count(vo.id) FILTER (WHERE vo.deleted_at IS NULL) AS active_objects_count,
    coalesce(sum(vo.size_bytes) FILTER (WHERE vo.deleted_at IS NULL), 0) AS calculated_active_bytes,
    count(mu.id) FILTER (WHERE mu.status IN ('initiated', 'in_progress', 'assembling')) AS inflight_multipart_uploads
FROM public.organizations o
LEFT JOIN public.vault_objects vo ON vo.org_id = o.id
LEFT JOIN public.object_multipart_uploads mu ON mu.org_id = o.id
GROUP BY o.id, o.name, o.slug, o.plan_tier, o.storage_used_bytes, o.storage_reserved_bytes, o.max_storage_bytes;

-- Security grant for views
GRANT SELECT ON public.v_tenant_storage_analytics TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA internal TO postgres, service_role;
