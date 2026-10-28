# 🚀 Upstream Open-Source Contribution: Supabase Storage PR #1616

**Target Repository:** [`supabase/storage`](https://github.com/supabase/storage)  
**Pull Request:** [#1616: fix(file): honor upload cancellation signals](https://github.com/supabase/storage/pull/1616)  
**Author / Contributor:** Philippe Godfroy (`phlppgdfry`)  
**Scope:** Core Storage Engine Filesystem Backend (`FileBackend`)  
**Status:** Open Upstream Pull Request  

---

## 1. Context & Problem Discovery

While investigating upload resilience, interruption recovery, and AbortSignal handling across storage backends in the official Supabase Storage repository, an inconsistency was identified in `FileBackend.uploadObject`:

- The shared `StorageBackendAdapter` interface accepts an optional `signal?: AbortSignal`.
- The higher-level `Uploader.upload` pipeline passes an `AbortSignal` through from client request bodies.
- While the **S3 storage backend** (`S3Backend`) properly checked `signal?.aborted` and bound stream cancellations to the AWS SDK I/O pipeline, the **Filesystem backend** (`FileBackend`) accepted the `signal` argument but **completely ignored it**.

### Observable Defects:
1. **Pre-Aborted Signal Ignored:** Calling `uploadObject` with an already-aborted signal (`controller.abort()`) proceeded to stage the file, write bytes, and return success (`200 OK`).
2. **Active Cancellation Ignored:** If a client disconnected or cancelled an in-flight upload, the underlying Node.js stream pipeline continued streaming, leaving the source socket alive and publishing the file.
3. **Orphaned File Staging:** In edge cancellation scenarios, temporary staging files (`.${randomUUID()}.tmp`) could be orphaned without deterministic cleanup.

---

## 2. Root Cause Analysis

In `src/storage/backend/file.ts`, `pipeline()` from Node's `stream/promises` was invoked without the options object containing `{ signal }`:

```typescript
// ❌ UNPATCHED UPSTREAM (supabase/storage v1.84.32):
await ensureFile(stagedFile)
await pipeline(body, fs.createWriteStream(stagedFile)) // <-- Missing { signal }!
```

Because `{ signal }` was omitted:
- Node's stream pipeline never listened to abort events on the controller.
- The write stream never received abort signals.
- The `catch` block never mapped `AbortError` to Supabase Storage's standard error codes (`ERRORS.Aborted` or `ERRORS.AbortedTerminate`).

---

## 3. The Minimal, Surgical Fix

The patch consists of **8 insertions and 1 deletion** with zero breaking changes to public APIs, database schemas, or S3 behavior:

```typescript
// ✅ PROPOSED FIX (supabase/storage PR #1616):
if (signal?.aborted) {
  throw ERRORS.Aborted('Upload was aborted')
}

const file = this.resolveSecurePath(withOptionalVersion(`${bucketName}/${key}`, version))
const stagedFile = path.join(path.dirname(file), `.${randomUUID()}.tmp`)
try {
  await ensureFile(stagedFile)
  await pipeline(body, fs.createWriteStream(stagedFile), { signal }) // Bound signal!

  await this.setFileMetadata(stagedFile, { ... })
  ...
} catch (err: unknown) {
  await fsp.unlink(stagedFile).catch(() => {})
  if (err instanceof Error && err.name === 'AbortError') {
    throw ERRORS.AbortedTerminate('Upload was aborted', err)
  }
  if (err instanceof StorageBackendError) {
    throw err
  }
  throw ERRORS.InternalError('Database error occurred', err)
}
```

---

## 4. Upstream Regression Test Suite

Five comprehensive test cases were added to `src/storage/backend/file.test.ts`:

1. **Pre-Aborted Rejection:** Validates that an already-aborted upload rejects immediately with `ErrorCode.Aborted` without creating an object or temporary file.
2. **Active Stream Cancellation:** Validates that cancelling an active transfer destroys the readable source, removes the temporary file, preserves any existing destination version, and rejects with `ErrorCode.AbortedTerminate`.
3. **Signal Listener Cleanup:** Validates that `controller.signal` has 0 leftover event listeners after successful upload completion (preventing memory leaks).
4. **Late Cancellation Safety:** Validates that cancellation arriving *after* the stream completes still finishes atomic renaming and metadata synchronization (preserving upload completion invariants).
5. **Source Error Propagation:** Validates that errors originating from the readable stream are preserved and temporary files are unlinked cleanly.

---

## 5. Verification Evidence

- **Baseline:** On upstream commit `4134dbba1b94757f400d5d7c09f9382935efd726`, the 5 regression tests produce **2 failures and 3 passes**.
- **With Patch:** All **5 tests pass** with 0 regressions.
- **Native Check:** Verified on real filesystem extended attributes (`xattrs`) on macOS arm64 without dependency mocks.
- **Upstream PR:** [supabase/storage#1616](https://github.com/supabase/storage/pull/1616).
