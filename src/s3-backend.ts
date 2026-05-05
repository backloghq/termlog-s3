import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import type { StorageBackend, BlobWriteStream } from "@backloghq/termlog";
import type { S3BackendOpts } from "./types.js";

export class S3Backend implements StorageBackend {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3BackendOpts) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ?? "";
  }

  private key(path: string): string {
    return `${this.prefix}${path}`;
  }

  async readBlob(path: string): Promise<Buffer> {
    let output: { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    try {
      output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(path) }),
      ) as typeof output;
    } catch (err: unknown) {
      const name = (err as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") {
        const e = new Error(`ENOENT: no such file: ${path}`);
        (e as NodeJS.ErrnoException).code = "ENOENT";
        throw e;
      }
      throw err;
    }
    if (!output.Body) {
      const e = new Error(`ENOENT: empty body: ${path}`);
      (e as NodeJS.ErrnoException).code = "ENOENT";
      throw e;
    }
    return Buffer.from(await output.Body.transformToByteArray());
  }

  async writeBlob(path: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(path),
        Body: data,
        ContentType: "application/octet-stream",
      }),
    );
  }

  async listBlobs(prefix: string): Promise<string[]> {
    const results: string[] = [];
    let token: string | undefined;
    const keyPrefix = this.key(prefix);
    const stripLen = this.prefix.length;

    do {
      const output = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: keyPrefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      ) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string };

      for (const obj of output.Contents ?? []) {
        if (obj.Key) results.push(obj.Key.slice(stripLen));
      }
      token = output.IsTruncated ? output.NextContinuationToken : undefined;
    } while (token);

    return results;
  }

  async deleteBlob(path: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(path) }),
      );
    } catch (err: unknown) {
      const name = (err as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return;
      throw err;
    }
  }

  // appendBlob intentionally not implemented — S3 has no native append.
  // saveDocIds() falls back to read-modify-write automatically.

  async createWriteStream(path: string): Promise<BlobWriteStream> {
    const key = this.key(path);
    const { client, bucket } = this;
    const MIN_PART_SIZE = 5 * 1024 * 1024; // 5 MiB S3 multipart minimum

    const initOutput = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: "application/octet-stream",
      }),
    ) as { UploadId?: string };
    const uploadId = initOutput.UploadId!;

    const parts: Array<{ PartNumber: number; ETag: string }> = [];
    let partNumber = 1;
    let partBuffer: Buffer[] = [];
    let bufferedSize = 0;
    let done = false;

    const flush = async (force: boolean): Promise<void> => {
      if (bufferedSize === 0) return;
      if (!force && bufferedSize < MIN_PART_SIZE) return;
      const partData = Buffer.concat(partBuffer);
      partBuffer = [];
      bufferedSize = 0;
      const out = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: partData,
        }),
      ) as { ETag?: string };
      parts.push({ PartNumber: partNumber, ETag: out.ETag ?? "" });
      partNumber++;
    };

    return {
      async write(chunk: Buffer): Promise<void> {
        partBuffer.push(chunk);
        bufferedSize += chunk.length;
        await flush(false);
      },
      async end(): Promise<void> {
        if (done) return;
        if (parts.length === 0 && bufferedSize === 0) {
          // Zero-byte stream — S3 rejects CompleteMultipartUpload with empty Parts.
          // Abort and fall back to an empty PutObject.
          done = true;
          await client.send(
            new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
          ).catch(() => undefined);
          await client.send(
            new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.alloc(0), ContentType: "application/octet-stream" }),
          );
          return;
        }
        await flush(true);
        try {
          await client.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              MultipartUpload: { Parts: parts },
            }),
          );
          done = true;
        } catch (err) {
          try {
            await client.send(
              new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
            );
          } catch { /* best-effort */ }
          done = true;
          throw err;
        }
      },
      async abort(): Promise<void> {
        if (done) return;
        done = true;
        await client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
        ).catch(() => undefined);
      },
    };
  }
}
