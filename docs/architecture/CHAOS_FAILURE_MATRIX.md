# 🌪️ Storage Chaos & Failure Recovery Matrix

**Fault-Tolerance & Disaster Recovery Specification**  
**Role Scope:** Senior SRE & Distributed Systems Specialist  
**Author:** Philippe Godfroy  

---

## 1. Failure Scenarios & Self-Healing Behaviors

Distributed storage pipelines operate over unreliable physical networks and concurrent serverless workers. The following failure matrix defines system invariants across all fault classes:

| Fault Scenario | Trigger / Condition | Immediate Impact | Automated Self-Healing Mechanism | Verification Status |
| :--- | :--- | :--- | :--- | :--- |
| **Transient TCP Reset / Drop** | Network interface hiccup mid-chunk | HTTP stream terminates prematurely | Client executes full-jitter exponential backoff, queries `HEAD` for authoritative `Upload-Offset`, and resumes byte transfer | **VERIFIED** (`tests/protocols/`) |
| **HTTP 503 / 502 Gateway Error** | Temporary Edge gateway / S3 overload | Transient HTTP 5xx returned to client | Bounded retries (default: 4 attempts) with randomized backoff. If 4 retries fail, raises deterministic error without infinite loops | **VERIFIED** (`tests/failure/`) |
| **HTTP 404 Session Expiry** | Multipart upload inactive past 24 hours | Upload session purged by backend reaper | Immediate fail-fast: non-retryable 404 aborts client pipeline, preventing wasteful retransmission | **VERIFIED** (`tests/failure/`) |
| **Worker Node Crash** | Worker handling job crashes or OOMs | Job stuck in `status = 'processing'` | Lock lease expiration (`locked_until < now()`). Concurrent workers polling via `SKIP LOCKED` automatically reclaim the job | **VERIFIED** (`tests/failure/`) |
| **Concurrent Quota Race** | Multiple uploads launched on low quota | Headroom insufficient for all requests | Row-level atomic conditional `UPDATE` accepts only requests that fit; excess requests fail with `54000` | **VERIFIED** (`tests/concurrency/`) |
| **Corrupted Byte Payload** | In-transit bit flip / malicious tampering | Checksum digest mismatch | SHA-256 / MD5 digest verification rejects part with `22000 (data_exception)` before committing to storage | **VERIFIED** (`tests/protocols/`) |
| **Aborted Upload Quota Leak** | Client disconnects permanently | Reserved bytes orphaned in database | Background reaper function `reap_expired_multipart_uploads()` transitions status to `aborted` and returns bytes to tenant quota | **VERIFIED** (`supabase/migrations/`) |

---

## 2. Invariant Protections

1. **Zero Silent Bit Rot**: Every chunk is cryptographically hashed with SHA-256 prior to commit.
2. **Zero In-Flight Quota Leaks**: Unfinished uploads have a strict 24-hour lease enforced by the reaper function.
3. **No Unbounded Retries**: All client adapters enforce strict exponential backoff caps with ceiling timeouts.
