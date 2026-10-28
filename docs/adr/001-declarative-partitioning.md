# ADR 001: Declarative Range Partitioning for Audit Telemetry

## Status
Accepted

## Context
Enterprise compliance (SOC2, HIPAA, GDPR) requires immutable logging of every object creation, deletion, and permission mutation across tenants. At scale (millions of operations per month), storing all audit events in a single unpartitioned table causes severe index bloat, slows down vacuuming, and makes cold-data archival expensive.

## Decision
We adopt native PostgreSQL **declarative range partitioning** on `telemetry.audit_events` partitioned by `RANGE (created_at)` by quarterly boundaries, paired with a Block Range Index (BRIN) on `created_at`.

## Consequences
### Positive:
- **Instant Drop-Partition Archival**: Old quarters can be detached (`ALTER TABLE DETACH PARTITION`) and offloaded to S3 Parquet / DuckDB in $O(1)$ time without running slow `DELETE` queries that cause table bloat.
- **Partition Pruning**: Queries filtering on time ranges (e.g. `WHERE created_at >= '2026-10-01'`) scan only the relevant partition, eliminating 90%+ of I/O.
- **BRIN Index Efficiency**: Storage overhead is minimal (1/128th the size of a standard B-Tree).

### Negative:
- Foreign keys from external tables to partitioned tables require composite keys including `created_at`.
- Partitions must be provisioned ahead of time.
