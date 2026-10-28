# ADR 003: End-to-End Cryptographic Chunk Hashing and Atomic Assembly

## Status
Accepted

## Context
High-reliability storage engines must protect against network data corruption, incomplete transfers, and race conditions where clients report a file completed before all chunks have landed in durable storage.

## Decision
1. Chunks are validated using both MD5 (S3 compatibility) and SHA-256 (cryptographic integrity).
2. The database trigger `trg_verify_part_and_transition` in `public.object_parts` automatically tallies uploaded parts against `total_parts`.
3. When the count matches, the trigger verifies cumulative byte size matches `expected_size_bytes` and atomically transitions upload state to `assembling`.

## Consequences
### Positive:
- Impossible for an incomplete or corrupt multipart upload to transition to `active`.
- The database enforces byte consistency; the application layer cannot accidentally commit truncated files.
