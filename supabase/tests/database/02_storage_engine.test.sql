-- ==============================================================================
-- Test: 02_storage_engine.test.sql
-- Description: pgTAP tests for storage quota triggers and multipart integrity state machine
-- ==============================================================================

BEGIN;
SELECT plan(5);

-- 1. Test Quota Enforcement Trigger
-- Apex AI Labs has max_storage_bytes = 5368709120 (5 GiB)
-- Attempting to initiate a 10 GiB multipart upload must raise 54000 (program_limit_exceeded)
SELECT throws_ok(
    $$
    INSERT INTO public.object_multipart_uploads (
        org_id, vault_id, object_key, upload_id, expected_size_bytes, part_size_bytes, total_parts
    ) VALUES (
        '10000000-0000-0000-0000-000000000003',
        '20000000-0000-0000-0000-000000000004',
        'giant-model-weights.bin',
        'upl_apex_oversize_test',
        10737418240, -- 10 GiB requested, exceeds 5 GiB quota
        10485760,
        1024
    );
    $$,
    '54000',
    NULL,
    'Storage quota trigger blocks upload exceeding organization max_storage_bytes'
);

-- 2. Test Multipart Upload Assembly Transition
-- Acme's upload `upl_acme_multipart_987213` has total_parts = 4, parts 1 and 2 already uploaded.
-- Uploading part 3:
INSERT INTO public.object_parts (upload_id, part_number, size_bytes, checksum_sha256, etag)
VALUES ('upl_acme_multipart_987213', 3, 5242880, '3333333333333333333333333333333333333333333333333333333333333333', 'cccccccccccccccccccccccccccccccc');

SELECT is(
    (SELECT status FROM public.object_multipart_uploads WHERE upload_id = 'upl_acme_multipart_987213'),
    'in_progress',
    'Upload remains in_progress when partial chunks are uploaded'
);

-- Uploading part 4 (final chunk):
INSERT INTO public.object_parts (upload_id, part_number, size_bytes, checksum_sha256, etag)
VALUES ('upl_acme_multipart_987213', 4, 5242880, '4444444444444444444444444444444444444444444444444444444444444444', 'dddddddddddddddddddddddddddddddd');

SELECT is(
    (SELECT status FROM public.object_multipart_uploads WHERE upload_id = 'upl_acme_multipart_987213'),
    'assembling',
    'Upload automatically transitions to assembling when all chunks arrive'
);

-- 3. Test Storage Used Bytes Accounting
-- Verify organizations.storage_used_bytes reflects active objects
SELECT is(
    (SELECT storage_used_bytes FROM public.organizations WHERE id = '10000000-0000-0000-0000-000000000001'),
    178257920::bigint, -- 157286400 + 20971520 bytes from seed objects
    'Organization storage_used_bytes accurately aggregates active vault objects'
);

-- 4. Test Queue Worker Non-Blocking Dequeue (FOR UPDATE SKIP LOCKED)
SELECT is(
    (SELECT count(*)::int FROM internal.dequeue_jobs('storage.av_scan', 'worker-node-alpha-1', 5, 30)),
    1,
    'Queue worker successfully dequeues pending jobs with SKIP LOCKED lock isolation'
);

SELECT * FROM finish();
ROLLBACK;
