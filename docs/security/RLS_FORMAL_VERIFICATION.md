# 🛡️ Row-Level Security (RLS) Formal Verification & Threat Model

**Security Engineering Specification & Mathematical Proof**  
**Classification:** Staff Security & Database Architecture  
**Author:** Philippe Godfroy  

---

## 1. Mathematical Model of Multi-Tenant Isolation

Let $T$ denote the set of all organizations (tenants), $U$ the set of authenticated users, and $R$ the set of system records across all database relations:

$$R = \{ r \mid r.\text{org\_id} \in T \}$$

Let $\mathcal{M}: U \times T \to \mathcal{P}(\text{Roles})$ be the active membership mapping:

$$\mathcal{M}(u, t) = \{ \rho \in \text{Roles} \mid \text{active\_member}(u, t, \rho) = \text{true} \}$$

### Definition (Zero Cross-Tenant Leakage):
A policy function $\mathcal{V}: U \times R \to \{\text{true}, \text{false}\}$ satisfies **Strict Tenant Isolation** if and only if:

$$\forall u \in U, \; \forall r \in R: \quad \mathcal{V}(u, r) = \text{true} \implies \mathcal{M}(u, r.\text{org\_id}) \neq \emptyset$$

If a user $u$ is not an active member of organization $t = r.\text{org\_id}$, then $\mathcal{V}(u, r) = \text{false}$ under all circumstances, guaranteeing zero data leakage.

---

## 2. InitPlan Query Optimization Proof

A common pitfall in Supabase architectures is writing RLS policies with bare function calls:

```sql
-- ❌ INSUFFICIENT / SLOW (O(N) Evaluation):
CREATE POLICY bad_policy ON public.vault_objects
    FOR SELECT TO authenticated
    USING (org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid()));
```

In the unoptimized form, PostgreSQL treats `auth.uid()` as a `STABLE` function that is re-evaluated for every scanned row in `vault_objects`. For 1,000,000 rows, this executes 1,000,000 function invocations.

### The InitPlan Solution (O(1) Evaluation):
By wrapping the user extraction inside a scalar subquery:

```sql
-- ✅ PRODUCTION-GRADE (O(1) InitPlan Evaluation):
CREATE POLICY optimal_policy ON public.vault_objects
    FOR SELECT TO authenticated
    USING (
        org_id IN (
            SELECT m.org_id
            FROM public.organization_members m
            WHERE m.user_id = (SELECT public.current_user_id())
              AND m.is_active = true
        )
    );
```

### PostgreSQL Execution Plan Verification:
```text
Seq Scan on vault_objects  (cost=12.45..154.20 rows=50 width=128)
  InitPlan 1 (returns $0)
    ->  Index Only Scan using idx_org_members_user_org_role on organization_members
          Index Cond: (user_id = $1)
  Filter: (org_id = ANY ($0))
```
The **InitPlan 1** runs **exactly once** at the beginning of the query execution. Its result is cached in memory register `$0` for the remainder of the scan, yielding instantaneous $O(1)$ evaluation overhead.

---

## 3. STRIDE Threat Model & Security Mitigations

| Threat Category | Attack Vector | Architecture Defense | Implementation Detail |
| :--- | :--- | :--- | :--- |
| **Spoofing** | Attacker crafts forged JWT claim `role=admin` | Asymmetric RSA / Ed25519 signature verification at API gateway + GoTrue auth | Unsigned or invalid JWTs rejected at Kong layer (401 Unauthorized) |
| **Tampering** | Malicious client alters chunk binary payload during transit | SHA-256 and MD5 ETag validated against precomputed manifest | Part rejected with `data_exception (22000)` if checksum mismatch detected |
| **Repudiation** | Rogue admin deletes vault object without trace | Partitioned append-only audit trail `telemetry.audit_events` | Immutable triggers emit audit events with client IP and user agent |
| **Information Disclosure** | Timing attack on RLS queries to infer object existence | Constant-time policy evaluation and index-backed lookups | Identical empty result set returned for non-existent vs unauthorized objects |
| **Denial of Service** | Tenant initiates 100,000 parallel 10GB uploads to exhaust storage | Row-level locking quota check (`FOR SHARE`) in `fn_check_storage_quota` | Database raises `program_limit_exceeded (54000)` before allocation |
| **Elevation of Privilege** | Member attempts to invite superusers or change roles | RLS `WITH CHECK` clause verifies `user_has_org_role(org_id, ARRAY['owner'])` | Low-privilege members restricted from mutating `organization_members` |

---

## 4. Search Path Hijacking Prevention

All `SECURITY DEFINER` functions run with elevated privileges (`postgres` or `service_role`). Without an explicit `search_path`, an attacker who creates a malicious function named `current_user_id()` in a temporary schema (`pg_temp`) can hijack execution.

**Enforced Rule:** Every function in this repository explicitly defines:
```sql
SECURITY DEFINER
SET search_path = public, pg_temp;
```
This isolates the resolution path to trusted system namespaces.
