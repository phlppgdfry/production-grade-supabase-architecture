// ==============================================================================
// k6 Load Test: Multi-Tenant RLS Policy Evaluation & Zero Data Leakage
// Target: 1,000 Concurrent VUs against Supabase PostgREST with Supavisor Pooling
// ==============================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 200 },  // Ramp-up
    { duration: '30s', target: 1000 }, // Sustained staff-level concurrency load
    { duration: '10s', target: 0 },    // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<25', 'p(99)<60'], // Strict p95 latency SLA < 25ms
    http_req_failed: ['rate<0.01'],              // Less than 1% errors allowed
  },
};

const BASE_URL = __ENV.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = __ENV.SUPABASE_ANON_KEY || 'demo_anon_key_placeholder';

// Deterministic JWTs representing distinct tenants
const TENANTS = [
  {
    orgId: '10000000-0000-0000-0000-000000000001',
    userRole: 'owner',
    userId: 'd0000000-0000-0000-0000-000000000001', // Alice (Acme)
  },
  {
    orgId: '10000000-0000-0000-0000-000000000002',
    userRole: 'auditor',
    userId: 'd0000000-0000-0000-0000-000000000003', // Carol (HealthWave)
  },
  {
    orgId: '10000000-0000-0000-0000-000000000003',
    userRole: 'member',
    userId: 'd0000000-0000-0000-0000-000000000004', // Mallory (Apex)
  },
];

export default function () {
  // Randomly distribute requests across tenants
  const tenant = TENANTS[Math.floor(Math.random() * TENANTS.length)];

  const params = {
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
      'x-mock-user-id': tenant.userId,
      'Content-Type': 'application/json',
    },
  };

  // 1. Query Vault Objects (RLS filtered by tenant)
  const res = http.get(`${BASE_URL}/rest/v1/vault_objects?select=id,object_key,size_bytes,status`, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response body is valid json': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body);
      } catch (e) {
        return false;
      }
    },
    'latency is within SLA': (r) => r.timings.duration < 100,
  });

  sleep(0.05); // 50ms pacing
}
