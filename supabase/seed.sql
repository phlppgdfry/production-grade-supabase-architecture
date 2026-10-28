-- ==============================================================================
-- Seed: supabase/seed.sql
-- Description: Deterministic enterprise multi-tenant seed data for tests & benchmarks
-- ==============================================================================

DO $$
DECLARE
    v_acme_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
    v_health_id uuid := '10000000-0000-0000-0000-000000000002'::uuid;
    v_apex_id uuid := '10000000-0000-0000-0000-000000000003'::uuid;

    v_user_alice uuid := 'd0000000-0000-0000-0000-000000000001'::uuid;
    v_user_bob uuid := 'd0000000-0000-0000-0000-000000000002'::uuid;
    v_user_carol uuid := 'd0000000-0000-0000-0000-000000000003'::uuid;
    v_user_mallory uuid := 'd0000000-0000-0000-0000-000000000004'::uuid;

    v_vault_acme_prod uuid := '20000000-0000-0000-0000-000000000001'::uuid;
    v_vault_acme_audit uuid := '20000000-0000-0000-0000-000000000002'::uuid;
    v_vault_health_clinical uuid := '20000000-0000-0000-0000-000000000003'::uuid;
    v_vault_apex_models uuid := '20000000-0000-0000-0000-000000000004'::uuid;

    v_obj_1 uuid := '30000000-0000-0000-0000-000000000001'::uuid;
    v_obj_2 uuid := '30000000-0000-0000-0000-000000000002'::uuid;
BEGIN
    -- 1. SEED ORGANIZATIONS
    INSERT INTO public.organizations (id, slug, name, plan_tier, max_storage_bytes, storage_used_bytes, storage_reserved_bytes, is_active)
    VALUES
        (v_acme_id, 'acme-biotech', 'Acme BioTech Inc.', 'enterprise', 53687091200, 0, 0, true), -- 50 GiB
        (v_health_id, 'healthwave-medtech', 'HealthWave MedTech', 'pro', 21474836480, 0, 0, true),  -- 20 GiB
        (v_apex_id, 'apex-ai-labs', 'Apex AI Labs', 'starter', 5368709120, 0, 0, true)             -- 5 GiB
    ON CONFLICT (id) DO NOTHING;

    -- 2. SEED MEMBERSHIPS
    INSERT INTO public.organization_members (org_id, user_id, role, is_active)
    VALUES
        (v_acme_id, v_user_alice, 'owner', true),
        (v_acme_id, v_user_bob, 'member', true),
        (v_health_id, v_user_alice, 'admin', true),
        (v_health_id, v_user_carol, 'auditor', true),
        (v_apex_id, v_user_mallory, 'member', true)
    ON CONFLICT (org_id, user_id) DO NOTHING;

    -- 3. SEED VAULTS
    INSERT INTO public.vaults (id, org_id, slug, name, description, is_encrypted)
    VALUES
        (v_vault_acme_prod, v_acme_id, 'prod-genomics', 'Genomics Data Lake', 'Confidential DNA sequence datasets', true),
        (v_vault_acme_audit, v_acme_id, 'compliance-audit', 'FDA Compliance Archive', 'Immutable regulatory submissions', true),
        (v_vault_health_clinical, v_health_id, 'clinical-trials', 'Phase 3 Clinical Trial Assets', 'Encrypted patient metrics', true),
        (v_vault_apex_models, v_apex_id, 'neural-checkpoints', 'PyTorch Model Weights', 'LLM parameter weights', true)
    ON CONFLICT (id) DO NOTHING;

    -- 4. SEED VAULT OBJECTS
    INSERT INTO public.vault_objects (
        id, org_id, vault_id, object_key, content_type, size_bytes,
        checksum_sha256, etag, status, storage_tier, metadata, created_by
    )
    VALUES
        (
            v_obj_1, v_acme_id, v_vault_acme_prod,
            'datasets/2026/chromosome_21_highres.bam',
            'application/octet-stream',
            157286400, -- 150 MiB
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            'd41d8cd98f00b204e9800998ecf8427e',
            'active',
            'standard',
            '{"department": "R&D", "patient_cohort": "Cohort-B", "classification": "restricted"}'::jsonb,
            v_user_alice
        ),
        (
            v_obj_2, v_acme_id, v_vault_acme_prod,
            'reports/q3_clinical_efficacy_summary.pdf',
            'application/pdf',
            20971520, -- 20 MiB
            'ca978112ca1bbdcafac231b39a23dc4da786081441606713e439227274291100',
            '7d793037a0760186574b0282f2f435e7',
            'active',
            'standard',
            '{"type": "clinical_report", "status": "approved", "tags": ["fda", "q3", "summary"]}'::jsonb,
            v_user_bob
        )
    ON CONFLICT (id) DO NOTHING;

    -- 5. SEED MULTIPART UPLOAD IN PROGRESS
    INSERT INTO public.object_multipart_uploads (
        id, org_id, vault_id, object_key, upload_id, expected_size_bytes, part_size_bytes, total_parts, status, created_by
    )
    VALUES (
        '40000000-0000-0000-0000-000000000001'::uuid,
        v_acme_id,
        v_vault_acme_prod,
        'datasets/large_scale_sequencing_v2.tar.gz',
        'upl_acme_multipart_987213',
        20971520, -- 20 MB expected
        5242880,  -- 5 MB parts
        4,        -- 4 parts total
        'in_progress',
        v_user_bob
    )
    ON CONFLICT (id) DO NOTHING;

    -- Parts 1 and 2 uploaded
    INSERT INTO public.object_parts (upload_id, part_number, size_bytes, checksum_sha256, etag)
    VALUES
        ('upl_acme_multipart_987213', 1, 5242880, '1111111111111111111111111111111111111111111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        ('upl_acme_multipart_987213', 2, 5242880, '2222222222222222222222222222222222222222222222222222222222222222', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    ON CONFLICT (upload_id, part_number) DO NOTHING;

    -- 6. SEED AUDIT LOG
    INSERT INTO telemetry.audit_events (org_id, actor_id, action, resource_type, resource_id, metadata, created_at)
    VALUES
        (v_acme_id, v_user_alice, 'vault.object.create', 'vault_object', v_obj_1::text, '{"key": "datasets/2026/chromosome_21_highres.bam"}'::jsonb, now() - interval '2 days'),
        (v_acme_id, v_user_bob, 'vault.object.create', 'vault_object', v_obj_2::text, '{"key": "reports/q3_clinical_efficacy_summary.pdf"}'::jsonb, now() - interval '1 day'),
        (v_health_id, v_user_carol, 'vault.audit.export', 'vault', v_vault_health_clinical::text, '{"exported_rows": 128}'::jsonb, now() - interval '4 hours');

    -- 7. SEED BACKGROUND QUEUE
    INSERT INTO internal.job_queue (queue_name, org_id, payload, priority)
    VALUES
        ('storage.av_scan', v_acme_id, jsonb_build_object('object_id', v_obj_1, 'engine', 'clamav'), 10),
        ('storage.vector_index', v_acme_id, jsonb_build_object('object_id', v_obj_2, 'chunk_tokens', 512), 20);

END $$;
