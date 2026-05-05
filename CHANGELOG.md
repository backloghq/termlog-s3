# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-05-05

### Added

- **S3Backend** — `StorageBackend` implementation for Amazon S3 and S3-compatible stores (MinIO, Cloudflare R2, LocalStack)
  - `readBlob` / `writeBlob` / `listBlobs` / `deleteBlob` via GetObject / PutObject / ListObjectsV2 / DeleteObject
  - `createWriteStream` via S3 multipart upload (5 MiB part buffer, zero-byte fallback to PutObject)
  - Auto-abort multipart upload on `CompleteMultipartUpload` failure
  - `appendBlob` intentionally not implemented — docids.log falls back to read-modify-write automatically
  - Configurable key prefix for multi-tenant bucket usage
- **In-memory mock S3 client** for testing without AWS credentials
- Unit tests covering multipart upload, pagination, prefix handling, ENOENT mapping, and error paths
- Integration test suites gated behind `S3_INTEGRATION=1` env var (real S3 + full TermLog round-trip)
