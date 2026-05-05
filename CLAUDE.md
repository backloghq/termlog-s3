# termlog-s3

Amazon S3 storage backend for [@backloghq/termlog](https://github.com/backloghq/termlog). Enables termlog to store segment data (posting lists, manifests, tombstone logs) in S3-compatible object stores.

## What It Is

An implementation of termlog's `StorageBackend` interface backed by Amazon S3. Supports the full termlog I/O surface: `readBlob`, `writeBlob`, `listBlobs`, `deleteBlob`, and `createWriteStream` (via S3 multipart upload). Single-writer only — S3 provides no distributed lock.

## Architecture

```
s3://bucket/prefix/
  manifest.json            # Index manifest (generation, segments, tokenizer config)
  seg-<id>.seg             # Segment posting list (term dict + postings)
  seg-<id>.del             # Tombstone log for deleted docids
  docids.log               # Docid journal (append-only, falls back to read-modify-write)
```

### S3 Semantics Mapping

| termlog operation | S3 strategy |
|---|---|
| Manifest read/write | GetObject / PutObject |
| Segment write | Multipart upload via createWriteStream |
| Segment read | GetObject |
| List segments | ListObjectsV2 |
| Delete segment | DeleteObject |
| Docid journal append | Read-modify-write (no native append) |

### Single-writer constraint

S3 provides no distributed lock. You must ensure at most one writer per `(bucket, prefix)` combination. Multiple readers are safe.

### Multipart upload

`createWriteStream` uses S3 multipart upload. Parts are buffered at 5 MiB (S3 minimum). A zero-byte `end()` falls back to `PutObject` (S3 rejects `CompleteMultipartUpload` with empty Parts).

## Project Structure

```
src/
  types.ts          # S3BackendOpts interface
  s3-backend.ts     # S3Backend implementing StorageBackend
  index.ts          # Exports
tests/
  mock-s3.ts               # In-memory mock S3 client for testing
  s3-backend.test.ts       # S3Backend unit tests against mock
  s3-integration.test.ts   # Real S3 integration tests (gated: S3_INTEGRATION=1)
  termlog-integration.test.ts # Full TermLog + S3Backend round-trip (gated: S3_INTEGRATION=1)
```

## Dependencies

- **Runtime**: `@aws-sdk/client-s3` — AWS SDK v3 S3 client (hard dependency)
- **Peer**: `@backloghq/termlog` (>=0.1.0) — provides `StorageBackend` interface

## Commands

```bash
npm run build          # tsc
npm run lint           # eslint src/ tests/
npm test               # vitest run (mock S3, no AWS needed)
npm run test:coverage  # vitest coverage
npm run test:integration  # real S3 (requires S3_INTEGRATION=1 + AWS credentials)
```

## Coding Conventions

- Single runtime dependency (`@aws-sdk/client-s3`)
- All S3 errors handled via error `.name` checks (portable across environments)
- Tests use in-memory mock S3 — no AWS credentials needed for `npm test`
- Always use conventional commits: `type(scope): description`
- Always look up library/framework docs via Context7 before using APIs
- Lint before committing — all code must pass eslint
- **IMPORTANT: On every commit, update ALL docs** — README.md, CLAUDE.md, CHANGELOG.md

## Release Process

1. Update `CHANGELOG.md` with a new version entry
2. Bump version in `package.json`
3. Run `npm run build && npm run lint && npm test`
4. Commit, push, create PR
5. After merge: `npm publish --access public`
