// ==============================================================================
// Concurrency & Quota Test: Deterministic Verification of Race-Free Accounting
// ==============================================================================

import { describe, it, expect } from 'vitest';

/**
 * In-memory transactional row model simulating PostgreSQL row-level locks and isolation.
 */
class MockPostgresOrganization {
  public storage_used_bytes: number;
  public storage_reserved_bytes: number;
  public max_storage_bytes: number;
  public is_active: boolean;
  private rowLock: Promise<void> = Promise.resolve();

  constructor(maxBytes: number, usedBytes: number = 0, reservedBytes: number = 0) {
    this.max_storage_bytes = maxBytes;
    this.storage_used_bytes = usedBytes;
    this.storage_reserved_bytes = reservedBytes;
    this.is_active = true;
  }

  /**
   * Flawed Implementation: SELECT ... FOR SHARE followed by un-synchronized insert.
   * Multiple concurrent transactions read the shared state concurrently without serialization.
   */
  public async flawedCheckAndReserveForShare(requestedBytes: number, delayMs: number = 5): Promise<boolean> {
    // 1. SELECT ... FOR SHARE (Non-exclusive shared lock: multiple readers pass simultaneously)
    const currentUsed = this.storage_used_bytes;
    const currentReserved = this.storage_reserved_bytes;

    // Simulate async network/processing window
    await new Promise((r) => setTimeout(r, delayMs));

    if (currentUsed + currentReserved + requestedBytes <= this.max_storage_bytes) {
      // 2. Later update (or deferred update upon activation)
      this.storage_reserved_bytes += requestedBytes;
      return true;
    }
    return false;
  }

  /**
   * Correct Production-Grade Implementation: Atomic Conditional UPDATE.
   * Serializes strictly at the row level in PostgreSQL.
   */
  public async atomicConditionalUpdateReserve(requestedBytes: number): Promise<boolean> {
    // Acquire row-level serialization lock (PostgreSQL row update lock)
    let releaseLock: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const previousLock = this.rowLock;
    this.rowLock = previousLock.then(() => nextLock);
    await previousLock;

    try {
      // WHERE is_active = true AND (storage_used_bytes + storage_reserved_bytes + requested) <= max_storage_bytes
      if (
        this.is_active &&
        this.storage_used_bytes + this.storage_reserved_bytes + requestedBytes <= this.max_storage_bytes
      ) {
        this.storage_reserved_bytes += requestedBytes;
        return true;
      }
      return false; // 0 rows updated -> raises 54000
    } finally {
      releaseLock!();
    }
  }

  /**
   * Release reservation upon upload failure, abort, or expiration.
   */
  public releaseReservation(requestedBytes: number): void {
    this.storage_reserved_bytes = Math.max(0, this.storage_reserved_bytes - requestedBytes);
  }

  /**
   * Transition reservation to active storage upon upload completion.
   */
  public commitActive(requestedBytes: number, actualBytes: number): void {
    this.storage_reserved_bytes = Math.max(0, this.storage_reserved_bytes - requestedBytes);
    this.storage_used_bytes += actualBytes;
  }
}

describe('PostgreSQL Quota Correctness & Concurrency Audit', () => {
  it('demonstrates that flawed FOR SHARE allows catastrophic over-allocation under concurrency', async () => {
    // Tenant has 1000 bytes max, 600 used -> only 400 bytes headroom available
    const org = new MockPostgresOrganization(1000, 600, 0);

    // 5 concurrent requests each asking for 300 bytes (Total requested: 1500 bytes)
    const requests = Array.from({ length: 5 }, () => org.flawedCheckAndReserveForShare(300));
    const results = await Promise.all(requests);

    const successfulRequests = results.filter(Boolean).length;
    // With FOR SHARE, multiple requests evaluate the stale headroom and all succeed!
    expect(successfulRequests).toBeGreaterThan(1);
    expect(org.storage_used_bytes + org.storage_reserved_bytes).toBeGreaterThan(org.max_storage_bytes);
    // Over-allocated beyond max_storage_bytes!
  });

  it('guarantees atomic conditional UPDATE completely prevents over-allocation under high concurrency', async () => {
    // Tenant has 1000 bytes max, 600 used -> exactly 400 bytes available
    const org = new MockPostgresOrganization(1000, 600, 0);

    // 20 concurrent requests each asking for 300 bytes
    const requests = Array.from({ length: 20 }, () => org.atomicConditionalUpdateReserve(300));
    const results = await Promise.all(requests);

    const successfulRequests = results.filter(Boolean).length;
    const failedRequests = results.filter((s) => !s).length;

    // Exactly 1 request can fit into 400 bytes (300 bytes reserved, 100 bytes remaining)
    expect(successfulRequests).toBe(1);
    expect(failedRequests).toBe(19);

    // The invariant is strictly preserved
    expect(org.storage_used_bytes + org.storage_reserved_bytes).toBeLessThanOrEqual(org.max_storage_bytes);
    expect(org.storage_reserved_bytes).toBe(300);
  });

  it('correctly releases reservation on aborted or failed upload', async () => {
    const org = new MockPostgresOrganization(1000, 600, 0);

    // Reserve 300 bytes
    const reserved = await org.atomicConditionalUpdateReserve(300);
    expect(reserved).toBe(true);
    expect(org.storage_reserved_bytes).toBe(300);

    // Simulate client abort / network drop
    org.releaseReservation(300);
    expect(org.storage_reserved_bytes).toBe(0);

    // Now another 300 byte request can be reserved
    const secondReserved = await org.atomicConditionalUpdateReserve(300);
    expect(secondReserved).toBe(true);
  });

  it('atomically shifts bytes from reserved to used upon upload activation', async () => {
    const org = new MockPostgresOrganization(1000, 600, 0);

    await org.atomicConditionalUpdateReserve(300);
    expect(org.storage_reserved_bytes).toBe(300);
    expect(org.storage_used_bytes).toBe(600);

    // Commit active file
    org.commitActive(300, 300);
    expect(org.storage_reserved_bytes).toBe(0);
    expect(org.storage_used_bytes).toBe(900);
    expect(org.storage_used_bytes).toBeLessThanOrEqual(org.max_storage_bytes);
  });
});
