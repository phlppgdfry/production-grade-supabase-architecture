-- ==============================================================================
-- Test: 01_tenant_isolation.test.sql
-- Description: pgTAP verification of Multi-Tenant RLS isolation and Zero-Leakage
-- ==============================================================================

BEGIN;
SELECT plan(8);

-- 1. Verify RLS is enabled on core tables
SELECT row_level_security_active('public', 'organizations', 'organizations table has active RLS');
SELECT row_level_security_active('public', 'vault_objects', 'vault_objects table has active RLS');
SELECT row_level_security_active('public', 'object_multipart_uploads', 'multipart table has active RLS');

-- 2. Simulate Mallory (Apex AI Labs member)
-- Set session JWT claims for Mallory (d0000000-0000-0000-0000-000000000004)
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = 'd0000000-0000-0000-0000-000000000004';
SET LOCAL "request.jwt.claim.role" = 'authenticated';

-- Mallory must only see Apex AI Labs (1 org)
SELECT is(
    (SELECT count(*)::int FROM public.organizations),
    1,
    'Mallory can only see her own organization (Apex AI Labs)'
);

-- Mallory must NOT see Acme BioTech
SELECT is(
    (SELECT count(*)::int FROM public.organizations WHERE slug = 'acme-biotech'),
    0,
    'Mallory cannot see Acme BioTech (Zero-Leakage Guarantee)'
);

-- Mallory must see 0 vault objects belonging to Acme
SELECT is(
    (SELECT count(*)::int FROM public.vault_objects),
    0,
    'Mallory sees 0 vault objects from foreign organizations'
);

-- Mallory attempting an unauthorized INSERT into Acme's vault must be blocked
SELECT throws_ok(
    $$
    INSERT INTO public.vault_objects (
        org_id, vault_id, object_key, content_type, size_bytes
    ) VALUES (
        '10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000001',
        'infiltrate.exe',
        'application/octet-stream',
        1024
    );
    $$,
    '42501', -- insufficient_privilege / RLS violation
    NULL,
    'Mallory cannot inject objects into Acme BioTech vault'
);

-- 3. Simulate Alice (Acme BioTech Owner & HealthWave Admin)
SET LOCAL "request.jwt.claim.sub" = 'd0000000-0000-0000-0000-000000000001';

SELECT is(
    (SELECT count(*)::int FROM public.organizations),
    2,
    'Alice sees exactly the 2 organizations where she has active memberships'
);

SELECT * FROM finish();
ROLLBACK;
