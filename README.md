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

## License

MIT
