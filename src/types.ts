import type { S3Client } from "@aws-sdk/client-s3";

export interface S3BackendOpts {
  /** S3Client instance (e.g. `new S3Client({ region: "us-east-1" })`). */
  client: S3Client;
  /** Bucket name. */
  bucket: string;
  /** Optional key prefix — all paths are scoped under `${prefix}${path}`. Default: `""`. */
  prefix?: string;
}
