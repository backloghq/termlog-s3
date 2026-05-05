/**
 * Full TermLog + S3Backend round-trip integration tests.
 * Skipped unless S3_INTEGRATION=1 is set.
 *
 * Usage:
 *   S3_INTEGRATION=1 \
 *   S3_TEST_BUCKET=my-test-bucket \
 *   S3_TEST_REGION=us-east-1 \
 *   npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { TermLog } from "@backloghq/termlog";
import { S3Backend } from "../src/s3-backend.js";

const integration = process.env.S3_INTEGRATION === "1";
const bucket = process.env.S3_TEST_BUCKET ?? "termlog-test";
const region = process.env.S3_TEST_REGION ?? "us-east-1";
const endpoint = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!integration)("TermLog + S3Backend (real S3)", () => {
  let client: S3Client;
  let basePrefix: string;

  function makeBackend(pfx: string) {
    return new S3Backend({ client, bucket, prefix: pfx });
  }

  async function makeIndex(pfx: string) {
    return TermLog.open({ dir: pfx, backend: makeBackend(pfx) });
  }

  beforeAll(() => {
    client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    basePrefix = `termlog-s3-integration-${Date.now()}/`;
  });

  afterAll(async () => {
    if (!client) return;
    let token: string | undefined;
    do {
      const list = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: basePrefix, ContinuationToken: token }),
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

  it("add, search, close, reopen — data persists across sessions", async () => {
    const pfx = `${basePrefix}persist-test/`;
    const idx1 = await makeIndex(pfx);
    await idx1.add("doc-1", "hello world");
    await idx1.add("doc-2", "hello termlog s3");
    await idx1.add("doc-3", "unrelated content");
    await idx1.close();

    const idx2 = await makeIndex(pfx);
    const results = await idx2.search("hello");
    expect(results.length).toBe(2);
    expect(results.map((r) => r.docId).sort()).toEqual(["doc-1", "doc-2"]);
    await idx2.close();
  });

  it("delete removes doc from search results across sessions", async () => {
    const pfx = `${basePrefix}delete-test/`;
    const idx1 = await makeIndex(pfx);
    await idx1.add("doc-1", "hello world");
    await idx1.add("doc-2", "hello termlog");
    await idx1.delete("doc-1");
    await idx1.close();

    const idx2 = await makeIndex(pfx);
    const results = await idx2.search("hello");
    expect(results).toHaveLength(1);
    expect(results[0].docId).toBe("doc-2");
    await idx2.close();
  });

  it("BM25 ranking — more relevant doc scores higher", async () => {
    const pfx = `${basePrefix}ranking-test/`;
    const idx = await makeIndex(pfx);
    await idx.add("doc-a", "the quick brown fox");
    await idx.add("doc-b", "fox fox fox");
    await idx.add("doc-c", "the lazy dog");
    await idx.close();

    const idx2 = await makeIndex(pfx);
    const results = await idx2.search("fox");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // doc-b has higher term frequency for "fox" → higher BM25 score
    expect(results[0].docId).toBe("doc-b");
    await idx2.close();
  });

  it("prefix isolation — two indexes in different prefixes do not interfere", async () => {
    const pfxA = `${basePrefix}isolated-A/`;
    const pfxB = `${basePrefix}isolated-B/`;

    const idxA = await makeIndex(pfxA);
    await idxA.add("doc-1", "only in A");
    await idxA.close();

    const idxB = await makeIndex(pfxB);
    const results = await idxB.search("only");
    expect(results).toHaveLength(0);
    await idxB.close();
  });

  it("compaction — segments merge and results remain correct", async () => {
    const pfx = `${basePrefix}compact-test/`;
    const idx = await makeIndex(pfx);

    // Add many documents to trigger segment creation.
    for (let i = 0; i < 20; i++) {
      await idx.add(`doc-${i}`, `document ${i} search keyword`);
    }

    const results = await idx.search("keyword");
    expect(results.length).toBe(20);
    await idx.close();

    // Reopen and verify results still correct after compaction on close.
    const idx2 = await makeIndex(pfx);
    const results2 = await idx2.search("keyword");
    expect(results2.length).toBe(20);
    await idx2.close();
  });
});
