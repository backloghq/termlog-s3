# termlog-s3

Amazon S3 storage backend for [@backloghq/termlog](https://github.com/backloghq/termlog). Store termlog segment data in S3-compatible object stores (AWS S3, MinIO, Cloudflare R2, LocalStack).

## Install

```bash
npm install @backloghq/termlog @backloghq/termlog-s3
```

## Usage

```typescript
import { TermLog } from "@backloghq/termlog";
import { S3Backend } from "@backloghq/termlog-s3";
import { S3Client } from "@aws-sdk/client-s3";

const backend = new S3Backend({
  client: new S3Client({ region: "us-east-1" }),
  bucket: "my-bucket",
  prefix: "my-index/",
});

const index = await TermLog.open({ dir: "my-index", backend });
await index.add("doc-1", "hello world");
await index.add("doc-2", "hello termlog");

const results = await index.search("hello");
await index.close();
```

### MinIO / LocalStack

```typescript
const backend = new S3Backend({
  client: new S3Client({
    region: "us-east-1",
    endpoint: "http://localhost:9000",
    forcePathStyle: true,
  }),
  bucket: "my-bucket",
  prefix: "my-index/",
});
```

## Options

```typescript
new S3Backend({
  client: myS3Client,   // S3Client instance (required)
  bucket: "my-bucket",  // S3 bucket name (required)
  prefix: "my-index/",  // Key prefix — scope all objects under this prefix (optional)
});
```

## Single-writer constraint

S3 provides no distributed lock. You must ensure **at most one writer** per `(bucket, prefix)` combination at any given time. Multiple concurrent readers are safe.

## Multipart upload

`createWriteStream` uses S3 multipart upload (required for streaming segment writes). Parts are buffered at 5 MiB (S3 minimum part size). If the stream completes with zero bytes, the adapter falls back to a `PutObject` call (S3 rejects `CompleteMultipartUpload` with empty Parts).

**Required IAM permissions** for the multipart path: `s3:CreateMultipartUpload`, `s3:UploadPart`, `s3:CompleteMultipartUpload`, `s3:AbortMultipartUpload`.

## IAM Permissions

Minimum required permissions:

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:GetObject",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:ListBucket",
    "s3:CreateMultipartUpload",
    "s3:UploadPart",
    "s3:CompleteMultipartUpload",
    "s3:AbortMultipartUpload"
  ],
  "Resource": [
    "arn:aws:s3:::my-bucket",
    "arn:aws:s3:::my-bucket/my-index/*"
  ]
}
```

## S3 lifecycle rules (recommended)

Add a lifecycle rule to abort incomplete multipart uploads after 1 day to avoid storage charges from crashed writers:

```json
{
  "Rules": [{
    "ID": "abort-incomplete-multipart",
    "Status": "Enabled",
    "Filter": { "Prefix": "my-index/" },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
  }]
}
```

## Development

```bash
npm run build          # Compile TypeScript
npm run lint           # ESLint
npm test               # Run tests (in-memory mock S3, no AWS needed)
npm run test:coverage  # Tests with coverage
npm run test:integration  # Real S3 tests (requires S3_INTEGRATION=1 + credentials)
```

### Integration tests in CI

The CI `integration` job runs the full integration suite (including the 1500-object pagination stress test) against a MinIO container on every push — no AWS credentials, no cost. It runs after the unit-test matrix passes (`needs: test`).

### Local integration testing

To run against MinIO locally:

```bash
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data

AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
  aws --endpoint-url http://localhost:9000 s3 mb s3://termlog-test

S3_INTEGRATION=1 S3_INTEGRATION_SLOW=1 \
  S3_TEST_BUCKET=termlog-test S3_TEST_ENDPOINT=http://localhost:9000 \
  npm run test:integration
```

To run against real AWS S3 (opt-in, costs money):

```bash
S3_INTEGRATION=1 S3_TEST_BUCKET=my-bucket S3_TEST_REGION=us-east-1 \
  AWS_PROFILE=my-profile npm run test:integration
```

### Integration test env vars

| Var | Required | Description |
|---|---|---|
| `S3_INTEGRATION=1` | yes | Enables real-S3 tests (otherwise all skipped) |
| `S3_TEST_BUCKET` | yes | Bucket name |
| `S3_TEST_REGION` | no | AWS region (default: `us-east-1`) |
| `S3_TEST_ENDPOINT` | no | Custom endpoint for MinIO / LocalStack |
| `AWS_PROFILE` | no | AWS credential profile |
| `S3_INTEGRATION_SLOW=1` | no | Enables pagination stress test (1500 PutObject + 1500 DeleteObject — ~5 s on MinIO, ~60 s + cost on real AWS S3) |

## License

MIT
