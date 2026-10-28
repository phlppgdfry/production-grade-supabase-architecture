# 🏛️ System Architecture Specification

**Production-Grade Supabase Enterprise Architecture**  
**Classification:** Staff-Level Reference Implementation  
**Author:** Philippe Godfroy  

---

## 1. High-Level Topology & Microservices Decomposition

The architecture isolates concerns across client entrypoints, stateless serverless edge runtimes, connection multiplexers, and PostgreSQL 17 compute nodes backed by S3-compatible distributed object storage.

```mermaid
flowchart TD
    subgraph Clients["Edge & Mobile Clients"]
        WebClient["Web UI (React/Next.js)"]
        MobileClient["Mobile SDK (iOS/Swift & Android)"]
        CLIClient["SupaForge CLI & k6 Runner"]
    end

    subgraph EdgeLayer["Edge & Ingress Tier (Cloudflare / Envoy)"]
        Kong["Kong API Gateway & Rate Limiter"]
        EdgeRuntime["Supabase Edge Functions (Deno)"]
    end

    subgraph ServiceLayer["Supabase Service Engines"]
        PostgREST["PostgREST (Auto-REST API)"]
        StorageEngine["Supabase Storage Engine (S3 / TUS)"]
        GoTrue["Auth Service (GoTrue JWT)"]
        Realtime["Realtime Engine (Elixir / Phoenix)"]
    end

    subgraph ConnectionPooler["Connection Pooling Tier"]
        Supavisor["Supavisor (Transaction Mode Pooler)"]
    end

    subgraph DatabaseEngine["PostgreSQL 17 Compute Cluster"]
        direction TB
        RLSEngine["Row-Level Security (RLS) Filter Engine"]
        CoreTables["Multi-Tenant Core Tables (Organizations, Vaults)"]
        PartitionedLogs["telemetry.audit_events (Range Partitioned)"]
        JobQueue["internal.job_queue (FOR UPDATE SKIP LOCKED)"]
        HNSW["pgvector HNSW Semantic Search Index"]
    end

    subgraph ObjectStorage["Distributed Object Storage Tier"]
        S3Bucket["AWS S3 / MinIO Compliant Bucket"]
        CDN["Global Edge CDN with Cache Invalidation"]
    end

    WebClient --> Kong
    MobileClient --> Kong
    CLIClient --> Kong

    Kong --> EdgeRuntime
    Kong --> PostgREST
    Kong --> StorageEngine
    Kong --> GoTrue
    Kong --> Realtime

    EdgeRuntime --> Supavisor
    PostgREST --> Supavisor
    StorageEngine --> Supavisor
    StorageEngine --> S3Bucket
    S3Bucket --> CDN

    Supavisor --> RLSEngine
    RLSEngine --> CoreTables
    RLSEngine --> PartitionedLogs
    RLSEngine --> JobQueue
    RLSEngine --> HNSW
```

---

## 2. Decoupled Storage-Compute Architecture

Modern enterprise architectures decouple compute and storage to achieve independent scaling, high durability, and cost efficiency:

1. **Metadata & State Machine (PostgreSQL Compute)**:
   All tenant boundaries, file manifests, multipart part descriptors, SHA-256 digests, and quota accounting reside in PostgreSQL.
2. **Binary Payloads (Distributed Object Storage / S3)**:
   Raw binary blobs bypass database transaction logs (WAL) completely. Blobs are chunked at the client, streamed via presigned URLs or Supabase Storage, and stored in S3-compatible buckets.
3. **Connection Multiplexing via Supavisor**:
   Serverless edge environments (Deno Edge Functions) initiate hundreds of concurrent short-lived connections. Direct connection to PostgreSQL would exhaust backend process limits (`max_connections`). Supavisor operates in **transaction mode**, recycling server connections immediately after each transaction commits.

---

## 3. Request Lifecycle & Authentication Flow

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client / SDK
    participant Gateway as Kong Gateway
    participant Edge as Edge Function (upload-initiator)
    participant Pooler as Supavisor
    participant Postgres as PostgreSQL 17 (RLS)
    participant Storage as S3 Storage Engine

    Client->>Gateway: POST /upload-initiator (JWT + Object Metadata)
    Gateway->>Edge: Route authorized request
    Edge->>Pooler: Begin Transaction
    Pooler->>Postgres: SET LOCAL request.jwt.claim.sub = 'user_uuid'
    Postgres->>Postgres: Execute fn_check_storage_quota (acquire SHARE lock on org)
    Postgres-->>Edge: Quota verified & multipart session registered
    Edge-->>Client: Return upload_id + parts manifest

    loop For each 5MB chunk
        Client->>Client: Compute SHA-256 & ETag
        Client->>Gateway: POST /chunk-completer (Part binary + Checksum)
        Gateway->>Postgres: INSERT INTO object_parts
        Postgres->>Postgres: trg_verify_part_and_transition()
        Postgres-->>Client: Part committed (200 OK)
    end

    Note over Postgres: Once final part arrives: status -> 'assembling'
    Postgres->>Postgres: Queue background worker job (SKIP LOCKED)
```

---

## 4. Architectural Invariants

- **Zero-Trust Multi-Tenancy**: Every database table with tenant association MUST have `ROW LEVEL SECURITY` enabled and forced (`FORCE ROW LEVEL SECURITY`).
- **No Volatile Functions in RLS Predicates**: Functions that query authentication state must be wrapped in scalar subqueries `(SELECT auth.uid())` to allow PostgreSQL to generate an **InitPlan** rather than executing row-by-row function calls.
- **Strict Byte-Accounting Consistency**: Storage quota calculations use database triggers with atomic updates, eliminating race conditions in parallel uploads.
