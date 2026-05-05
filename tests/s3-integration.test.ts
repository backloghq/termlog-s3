/**
 * Real S3 integration tests.
 * Skipped unless S3_INTEGRATION=1 is set.
 *
 * Usage:
 *   S3_INTEGRATION=1 \
 *   S3_TEST_BUCKET=my-test-bucket \
 *   S3_TEST_REGION=us-east-1 \
 *   AWS_PROFILE=my-profile \
 *   npm run test:integration
 *
 * MinIO / LocalStack:
 *   S3_INTEGRATION=1 \
 *   S3_TEST_BUCKET=termlog-test \
 *   S3_TEST_ENDPOINT=http://localhost:9000 \
 *   npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { S3Backend } from "../src/s3-backend.js";

const integration = process.env.S3_INTEGRATION === "1";
const bucket = process.env.S3_TEST_BUCKET ?? "termlog-test";
const region = process.env.S3_TEST_REGION ?? "us-east-1";
const endpoint = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!integration)("S3Backend (real S3)", () => {
  let client: S3Client;
  let prefix: string;

  function makeBackend(pfx?: string) {
    return new S3Backend({ client, bucket, prefix: pfx ?? prefix });
  }

  beforeAll(() => {
    client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    prefix = `termlog-test-${Date.now()}/`;
  });

  afterAll(async () => {
    if (!client) return;
    let token: string | undefined;
    do {
      const list = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      ) as { Contents?: Array<{ Key: string }>; IsTruncated?: boolean; NextContinuationToken?: string };
      if (list.Contents && list.Contents.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key })) },
          }),
        );
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    client.destroy();
  });

  it("writeBlob + readBlob round-trip", async () => {
    const backend = makeBackend();
    const data = Buffer.from("hello real s3");
    await backend.writeBlob("test.txt", data);
    const result = await backend.readBlob("test.txt");
    expect(result).toEqual(data);
  });

  it("readBlob returns ENOENT for missing key", async () => {
    const backend = makeBackend();
    const err = await backend.readBlob("nonexistent.seg").catch((e) => e) as NodeJS.ErrnoException;
    expect(err.code).toBe("ENOENT");
  });

  it("listBlobs returns only matching prefix", async () => {
    const pfx = `${prefix}list-test/`;
    const backend = makeBackend(pfx);
    await backend.writeBlob("seg-000001.seg", Buffer.from("a"));
    await backend.writeBlob("seg-000002.seg", Buffer.from("b"));
    await backend.writeBlob("manifest.json", Buffer.from("{}"));

    const segs = await backend.listBlobs("seg-");
    expect(segs.sort()).toEqual(["seg-000001.seg", "seg-000002.seg"]);
  });

  it("deleteBlob is idempotent", async () => {
    const backend = makeBackend();
    await expect(backend.deleteBlob("nonexistent.seg")).resolves.toBeUndefined();
  });

  it("createWriteStream — small write committed atomically", async () => {
    const pfx = `${prefix}stream-test/`;
    const backend = makeBackend(pfx);
    const data = Buffer.from("streaming content");
    const stream = await backend.createWriteStream("seg-000001.seg");
    await stream.write(data);
    await stream.end();

    const result = await backend.readBlob("seg-000001.seg");
    expect(result).toEqual(data);
  });

  it("createWriteStream — abort leaves nothing at path", async () => {
    const pfx = `${prefix}abort-test/`;
    const backend = makeBackend(pfx);
    const stream = await backend.createWriteStream("aborted.seg");
    await stream.write(Buffer.from("partial data"));
    await stream.abort();

    const err = await backend.readBlob("aborted.seg").catch((e) => e) as NodeJS.ErrnoException;
    expect(err.code).toBe("ENOENT");
  });

  it("createWriteStream — zero-byte end() produces empty object", async () => {
    const pfx = `${prefix}zero-test/`;
    const backend = makeBackend(pfx);
    const stream = await backend.createWriteStream("empty.seg");
    await stream.end();

    const result = await backend.readBlob("empty.seg");
    expect(result.length).toBe(0);
  });
});
