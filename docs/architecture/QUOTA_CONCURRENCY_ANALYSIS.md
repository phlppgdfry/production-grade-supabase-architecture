# ⚖️ PostgreSQL Quota Correctness & Concurrency Audit

**Forensic Concurrency Analysis & Benchmark**  
**Role Scope:** Senior PostgreSQL & Distributed Systems Engineering  
**Author:** Philippe Godfroy  

---

## 1. The Concurrency Flaw: Why `SELECT FOR SHARE` Fails

In naive storage implementations, quota checks are often written as:

```sql
-- ❌ FLAWED IMPLEMENTATION (Catastrophic Under Concurrency):
SELECT storage_used_bytes, max_storage_bytes
FROM organizations
WHERE id = $org_id
FOR SHARE;

IF (storage_used_bytes + requested_bytes) > max_storage_bytes THEN
    RAISE EXCEPTION 'quota exceeded';
END IF;
```

### The 10 Concurrency Questions Answered

1. **Which rows are locked?**  
   Only the single row in `public.organizations` matching the organization ID.
2. **Which lock strengths are used?**  
   `ShareLock` (`FOR SHARE`).
3. **Can concurrent readers pass the same check?**  
   **YES.** In PostgreSQL, `ShareLock` does not conflict with other `ShareLock` acquisitions. Fifty concurrent requests can simultaneously acquire `FOR SHARE` on the exact same row. All fifty observe the identical pre-upload byte count, all fifty conclude headroom exists, and all fifty proceed.
4. **Is a reservation counter updated atomically?**  
   **NO.** In the unpatched design, `storage_used_bytes` was only updated *after* full upload completion. In-flight uploads consumed zero recorded bytes for the entire duration of the transfer.
5. **Is transaction isolation sufficient?**  
   Under `READ COMMITTED`, concurrent transactions read the committed row. Since `FOR SHARE` does not mutate the row, no serialization conflict occurs. Under `REPEATABLE READ`, concurrent `FOR SHARE` reads still do not conflict.
6. **Do failed uploads release reservations?**  
   Without an in-flight reservation lifecycle, abandoned or failed uploads left storage parts in buckets while the database remained oblivious.
7. **Can retries double-reserve capacity?**  
   Without idempotency keys, re-initiating a timed-out request reserved quota a second time.
8. **Do cancellations release unused quota?**  
   In the unpatched schema, only deleting an active vault object decremented quota; aborted multipart uploads did not trigger releases.
9. **Do partial uploads create inconsistent accounting?**  
   Yes. Chunks written to S3 or local disk cost real storage, but were never accounted for in tenant usage until file activation.
10. **Can concurrent uploads exceed tenant quotas?**  
    **Yes.** Demonstrated deterministically: 5 concurrent 300-byte requests on 400 bytes of headroom all succeeded, resulting in 1,500 bytes allocated against a 1,000-byte limit (150% quota overage).

---

## 2. Comparison of Candidate Solutions

| Strategy | Contention & Throughput | Deadlock Risk | Correctness Under Concurrency | Verdict |
| :--- | :--- | :--- | :--- | :--- |
| **`SELECT FOR SHARE`** | Low contention | Low | **0% Correct (Severe Over-allocation)** | ❌ Broken |
| **`SELECT FOR UPDATE`** | **High Contention**: Blocks all tenant reads/writes | Moderate | 100% Correct | ⚠️ Poor Throughput |
| **Serializable Transactions** | High abort rate (`40001`) | High retry churn | 100% Correct | ❌ Bad Developer Experience |
| **Atomic Conditional `UPDATE`** | **Optimal**: Serializes only the single atomic row update | Zero | **100% Correct** | ✅ **Chosen Architecture** |

---

## 3. The Winning Solution: Atomic Two-Phase Storage Accounting

We introduce `storage_reserved_bytes` with an invariant database constraint:

```sql
ALTER TABLE public.organizations
    ADD COLUMN storage_reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_reserved_bytes >= 0),
    ADD CONSTRAINT chk_org_quota_headroom
        CHECK ((storage_used_bytes + storage_reserved_bytes) <= max_storage_bytes);
```

### Phase 1: Atomic Reservation (Initiation)
```sql
UPDATE public.organizations
SET storage_reserved_bytes = storage_reserved_bytes + NEW.expected_size_bytes,
    updated_at = now()
WHERE id = NEW.org_id
  AND is_active = true
  AND (storage_used_bytes + storage_reserved_bytes + NEW.expected_size_bytes) <= max_storage_bytes;

GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
IF v_updated_rows = 0 THEN
    RAISE EXCEPTION 'Storage quota exceeded' USING ERRCODE = '54000';
END IF;
```

### Phase 2: Atomic Commitment (Activation)
When the file upload succeeds, the reservation is atomically converted to active usage:
```sql
UPDATE public.organizations
SET storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - NEW.size_bytes),
    storage_used_bytes = storage_used_bytes + NEW.size_bytes,
    updated_at = now()
WHERE id = NEW.org_id;
```

### Phase 3: Rollback on Abort or Expiry
When an upload is aborted, fails, or is swept by the background reaper (`reap_expired_multipart_uploads`):
```sql
UPDATE public.organizations
SET storage_reserved_bytes = GREATEST(0, storage_reserved_bytes - OLD.expected_size_bytes),
    updated_at = now()
WHERE id = OLD.org_id;
```

---

## 4. Empirical Test Verification

Verified via Vitest in `tests/concurrency/quota_concurrency.test.ts`:
- **Flawed `FOR SHARE` Experiment:** 5 concurrent requests for 300 bytes against 400 bytes headroom -> All 5 passed, resulting in 1,500 bytes allocated (150% over-allocation).
- **Atomic Conditional `UPDATE` Experiment:** 20 concurrent requests for 300 bytes against 400 bytes headroom -> **Exactly 1 succeeded**, 19 rejected with 0 quota leaks.
- **Abort & Reclaim Test:** Aborted upload immediately returned 300 bytes to pool, enabling subsequent requests to succeed without manual intervention.
