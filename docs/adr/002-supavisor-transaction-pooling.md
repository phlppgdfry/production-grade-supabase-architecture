# ADR 002: Supavisor Transaction Pooling for Serverless Edge Workloads

## Status
Accepted

## Context
Supabase Edge Functions run as isolated Deno V8 isolates across edge regions. Under sudden traffic spikes (e.g. 1,000 concurrent VUs), each isolate opening a direct PostgreSQL connection would exceed `max_connections` (typically capped at 100-250) within seconds, triggering `FATAL: remaining connection slots are reserved for non-replication superuser connections`.

## Decision
We enforce connection routing through **Supavisor in Transaction Mode** on port `54329`. Backend database connections are capped at `default_pool_size = 20`, while accepting up to `max_client_conn = 1000` client connections.

## Consequences
### Positive:
- **Zero Connection Exhaustion**: Edge functions multiplex safely over a compact, warm pool of 20 server backends.
- **Microsecond Acquisition**: Clients avoid the high latency of establishing a new TLS + PostgreSQL authentication handshake on every invocation.

### Negative:
- Session-level state cannot be persisted across statements. Any user context setting must use `SET LOCAL` within transaction boundaries.
