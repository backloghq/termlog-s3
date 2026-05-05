import { describe, it, expect, beforeEach } from "vitest";
import { S3Backend } from "../src/s3-backend.js";
import { createMockS3, type MockS3Store } from "./mock-s3.js";
import type { StorageBackend } from "@backloghq/termlog";

describe("S3Backend — basic blob operations", () => {
  let backend: S3Backend;
  let store: MockS3Store;

  beforeEach(() => {
    const mock = createMockS3();
    store = mock.store;
    backend = new S3Backend({ client: mock.client, bucket: "test-bucket", prefix: "idx/" });
  });

  it("writeBlob + readBlob round-trip", async () => {
    const data = Buffer.from("hello s3");
    await backend.writeBlob("seg-000001.seg", data);
    const result = await backend.readBlob("seg-000001.seg");
    expect(result).toEqual(data);
  });

  it("readBlob throws ENOENT-shaped error for missing key", async () => {
    const err = await backend.readBlob("missing.seg").catch((e) => e) as NodeJS.ErrnoException;
    expect(err.code).toBe("ENOENT");
  });

  it("writeBlob scopes key under prefix", async () => {
    await backend.writeBlob("manifest.json", Buffer.from("{}"));
    expect(store.objects.has("idx/manifest.json")).toBe(true);
    expect(store.objects.has("manifest.json")).toBe(false);
  });

  it("listBlobs returns paths relative to prefix", async () => {
    store.objects.set("idx/seg-000001.seg", { body: Buffer.from("a"), etag: '"e1"' });
    store.objects.set("idx/seg-000002.seg", { body: Buffer.from("b"), etag: '"e2"' });
    store.objects.set("idx/manifest.json", { body: Buffer.from("{}"), etag: '"e3"' });
    store.objects.set("other/seg-000003.seg", { body: Buffer.from("c"), etag: '"e4"' });

    const segs = await backend.listBlobs("seg-");
    expect(segs.sort()).toEqual(["seg-000001.seg", "seg-000002.seg"]);
  });

  it("listBlobs returns empty array when no keys match", async () => {
    const result = await backend.listBlobs("seg-");
    expect(result).toEqual([]);
  });

  it("deleteBlob removes the object", async () => {
    store.objects.set("idx/todelete.seg", { body: Buffer.from("x"), etag: '"e"' });
    await backend.deleteBlob("todelete.seg");
    expect(store.objects.has("idx/todelete.seg")).toBe(false);
  });

  it("deleteBlob is idempotent — does not throw for missing key", async () => {
    await expect(backend.deleteBlob("nonexistent.seg")).resolves.toBeUndefined();
  });

  it("appendBlob is undefined — falls back to snapshot mode in saveDocIds", () => {
    expect(backend.appendBlob).toBeUndefined();
  });

  it("satisfies StorageBackend interface", () => {
    const b: StorageBackend = backend;
    expect(typeof b.readBlob).toBe("function");
    expect(typeof b.writeBlob).toBe("function");
    expect(typeof b.listBlobs).toBe("function");
    expect(typeof b.deleteBlob).toBe("function");
    expect(typeof b.createWriteStream).toBe("function");
  });
});

describe("S3Backend — no prefix", () => {
  it("keys are written without prefix when prefix is omitted", async () => {
    const { client, store } = createMockS3();
    const backend = new S3Backend({ client, bucket: "b" });
    await backend.writeBlob("manifest.json", Buffer.from("{}"));
    expect(store.objects.has("manifest.json")).toBe(true);
  });
});

describe("S3Backend — pagination", () => {
  it("listBlobs follows IsTruncated / NextContinuationToken across pages", async () => {
    const { client, store } = createMockS3();
    const backend = new S3Backend({ client, bucket: "b", prefix: "idx/" });

    // Insert 1500 keys.
    const allKeys: string[] = [];
    for (let i = 0; i < 1500; i++) {
      const name = `seg-${String(i).padStart(6, "0")}.seg`;
      store.objects.set(`idx/${name}`, { body: Buffer.from("x"), etag: `"e${i}"` });
      allKeys.push(name);
    }

    const result = await backend.listBlobs("seg-");
    expect(result).toHaveLength(1500);
    expect(result.sort()).toEqual(allKeys.sort());
  });
});

describe("S3Backend — error propagation", () => {
  it("readBlob propagates non-NoSuchKey errors unchanged", async () => {
    const { client: mockClient } = createMockS3();
    const accessDenied = Object.assign(new Error("Access Denied"), { name: "AccessDenied" });

    const brokenClient = {
      send: async () => { throw accessDenied; },
      destroy: () => {},
    };

    const backend = new S3Backend({ client: brokenClient as never, bucket: "b", prefix: "idx/" });
    const err = await backend.readBlob("some.seg").catch((e) => e) as Error;
    expect(err.name).toBe("AccessDenied");
    expect((err as NodeJS.ErrnoException).code).not.toBe("ENOENT");
    void mockClient;
  });
});

describe("S3Backend — createWriteStream multipart", () => {
  const MIN_PART = 5 * 1024 * 1024; // 5 MiB

  it("sub-5MiB write → 1 UploadPart then Complete", async () => {
    const { client, store } = createMockS3();
    const backend = new S3Backend({ client, bucket: "b", prefix: "p/" });

    const stream = await backend.createWriteStream("obj.seg");
    const payload = Buffer.alloc(1024, 0x41);
    await stream.write(payload);
    await stream.end();

    expect(store.objects.has("p/obj.seg")).toBe(true);
    expect(store.objects.get("p/obj.seg")!.body).toEqual(payload);
    expect(store.uploads.size).toBe(0); // completed uploads are removed from pending map
  });

  it(">5MiB total → multiple parts assembled in order", { timeout: 15000 }, async () => {
    const { client, store } = createMockS3();
    const backend = new S3Backend({ client, bucket: "b", prefix: "p/" });

    const stream = await backend.createWriteStream("obj.seg");
    const chunk1 = Buffer.alloc(MIN_PART + 1, 0x41);
    await stream.write(chunk1);
    const chunk2 = Buffer.alloc(1024, 0x42);
    await stream.write(chunk2);
    await stream.end();

    const expected = Buffer.concat([chunk1, chunk2]);
    expect(store.objects.get("p/obj.seg")!.body).toEqual(expected);
  });

  it("zero-byte end() falls back to PutObject with empty body", async () => {
    const { client, store } = createMockS3();
    const backend = new S3Backend({ client, bucket: "b", prefix: "p/" });

    const stream = await backend.createWriteStream("obj.seg");
    await stream.end();

    expect(store.objects.has("p/obj.seg")).toBe(true);
    expect(store.objects.get("p/obj.seg")!.body).toEqual(Buffer.alloc(0));
    expect(store.uploads.size).toBe(0); // upload was aborted
  });

  it("abort() sends AbortMultipartUpload and leaves nothing at path", async () => {
    const { client, store } = createMockS3();
    const backend = new S3Backend({ client, bucket: "b", prefix: "p/" });

    const stream = await backend.createWriteStream("obj.seg");
    await stream.write(Buffer.alloc(512, 0x41));
    await stream.abort();

    expect(store.objects.has("p/obj.seg")).toBe(false);
    expect(store.uploads.size).toBe(0);
  });

  it("end() is idempotent — calling twice does not throw", async () => {
    const { client } = createMockS3();
    const backend = new S3Backend({ client, bucket: "b", prefix: "p/" });

    const stream = await backend.createWriteStream("obj.seg");
    await stream.write(Buffer.alloc(512, 0x41));
    await stream.end();
    await expect(stream.end()).resolves.toBeUndefined();
  });

  it("abort() is idempotent — calling twice does not throw", async () => {
    const { client } = createMockS3();
    const backend = new S3Backend({ client, bucket: "b", prefix: "p/" });

    const stream = await backend.createWriteStream("obj.seg");
    await stream.abort();
    await expect(stream.abort()).resolves.toBeUndefined();
  });

  it("CompleteMultipartUpload failure triggers auto-abort before re-throwing", async () => {
    const { client: mockClient, store } = createMockS3();
    let abortCalled = false;
    let completeAttempted = false;

    const interceptClient = {
      send: async (cmd: object) => {
        const name = (cmd as { constructor: { name: string } }).constructor.name;
        if (name === "CompleteMultipartUploadCommand") {
          completeAttempted = true;
          throw new Error("Complete network failure");
        }
        if (name === "AbortMultipartUploadCommand") {
          abortCalled = true;
        }
        return mockClient.send(cmd);
      },
      destroy: () => {},
    };

    const backend = new S3Backend({ client: interceptClient as never, bucket: "b", prefix: "p/" });
    const stream = await backend.createWriteStream("obj.seg");
    await stream.write(Buffer.alloc(512, 0x41));
    const err = await stream.end().catch((e) => e) as Error;

    expect(err.message).toMatch(/Complete network failure/);
    expect(completeAttempted).toBe(true);
    expect(abortCalled).toBe(true);
    expect(store.objects.has("p/obj.seg")).toBe(false);
  });

  it("UploadPart mid-stream failure — caller must call abort(), adapter does NOT auto-abort", async () => {
    const { client: mockClient, store } = createMockS3();
    let uploadPartCallCount = 0;
    let abortCallCount = 0;

    const interceptClient = {
      send: async (cmd: object) => {
        const name = (cmd as { constructor: { name: string } }).constructor.name;
        if (name === "UploadPartCommand") {
          uploadPartCallCount++;
          if (uploadPartCallCount === 2) throw new Error("UploadPart network failure");
        }
        if (name === "AbortMultipartUploadCommand") {
          abortCallCount++;
        }
        return mockClient.send(cmd);
      },
      destroy: () => {},
    };

    const backend = new S3Backend({ client: interceptClient as never, bucket: "b", prefix: "p/" });
    const stream = await backend.createWriteStream("obj.seg");

    // First write > 5 MiB triggers first UploadPart — succeeds.
    await stream.write(Buffer.alloc(MIN_PART + 1, 0x41));
    // Second write > 5 MiB triggers second UploadPart — throws.
    const writeErr = await stream.write(Buffer.alloc(MIN_PART + 1, 0x42)).catch((e) => e) as Error;
    expect(writeErr.message).toMatch(/UploadPart network failure/);

    // Adapter does NOT auto-abort on write-time failure — caller must.
    expect(abortCallCount).toBe(0);

    // Caller explicitly aborts.
    await stream.abort();
    expect(abortCallCount).toBe(1);

    // Object must not appear in the store.
    expect(store.objects.has("p/obj.seg")).toBe(false);
  });
});
