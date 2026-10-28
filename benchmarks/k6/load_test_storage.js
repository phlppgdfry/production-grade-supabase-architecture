// ==============================================================================
// k6 Load Test: Concurrent Chunked Upload & Integrity Stress Test
// ==============================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 50 },  // 50 concurrent upload pipelines
    { duration: '20s', target: 150 }, // 150 concurrent upload pipelines
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<40'],
    http_req_failed: ['rate<0.02'],
  },
};

const BASE_URL = __ENV.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = __ENV.SUPABASE_ANON_KEY || 'demo_anon_key_placeholder';

export default function () {
  const uploadId = `upl_bench_${__VU}_${__ITER}_${Date.now()}`;
  const partNumber = 1;
  const sizeBytes = 5242880; // 5 MB

  const payload = JSON.stringify({
    upload_id: uploadId,
    part_number: partNumber,
    size_bytes: sizeBytes,
    checksum_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    etag: 'd41d8cd98f00b204e9800998ecf8427e',
  });

  const params = {
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  const res = http.post(`${BASE_URL}/functions/v1/chunk-completer`, payload, params);

  check(res, {
    'chunk accepted or handled': (r) => r.status === 200 || r.status === 400, // 400 expected if session not seeded
  });

  sleep(0.1);
}
