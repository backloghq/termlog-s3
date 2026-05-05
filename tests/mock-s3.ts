/**
 * In-memory mock S3 client for testing.
 * Supports: GetObject, PutObject, DeleteObject, ListObjectsV2,
 * CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload.
 */
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

interface StoredObject {
  body: Buffer;
  contentType?: string;
  etag: string;
}

interface PendingUpload {
  key: string;
  parts: Map<number, Buffer>;
}

export interface MockS3Store {
  objects: Map<string, StoredObject>;
  uploads: Map<string, PendingUpload>;
}

function makeError(name: string, message: string, statusCode: number): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, { $metadata: { httpStatusCode: statusCode } });
  return err;
}

let uploadIdCounter = 0;
let etagCounter = 0;

export function createMockS3(): { client: S3Client; store: MockS3Store } {
  const store: MockS3Store = { objects: new Map(), uploads: new Map() };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = async (command: any): Promise<any> => {
    if (command instanceof GetObjectCommand) {
      const { Key } = command.input;
      const obj = store.objects.get(Key!);
      if (!obj) throw makeError("NoSuchKey", "The specified key does not exist.", 404);
      return {
        Body: {
          transformToByteArray: async () => obj.body,
        },
        ETag: obj.etag,
        ContentType: obj.contentType,
      };
    }

    if (command instanceof PutObjectCommand) {
      const { Key, Body, ContentType } = command.input;
      if (!Key) throw new Error("PutObject: Key required");
      const body = Body instanceof Buffer ? Body : Buffer.from(Body ?? "");
      const etag = `"etag-${++etagCounter}"`;
      store.objects.set(Key, { body, contentType: ContentType, etag });
      return { ETag: etag };
    }

    if (command instanceof DeleteObjectCommand) {
      const { Key } = command.input;
      store.objects.delete(Key!);
      return {};
    }

    if (command instanceof ListObjectsV2Command) {
      const { Prefix, ContinuationToken, MaxKeys } = command.input;
      const prefix = Prefix ?? "";
      const maxKeys = MaxKeys ?? 1000;
      const allKeys = Array.from(store.objects.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();

      const startIdx = ContinuationToken ? parseInt(ContinuationToken, 10) : 0;
      const slice = allKeys.slice(startIdx, startIdx + maxKeys);
      const isTruncated = startIdx + maxKeys < allKeys.length;

      return {
        Contents: slice.length > 0 ? slice.map((k) => ({ Key: k })) : undefined,
        IsTruncated: isTruncated,
        NextContinuationToken: isTruncated ? String(startIdx + maxKeys) : undefined,
        KeyCount: slice.length,
      };
    }

    if (command instanceof CreateMultipartUploadCommand) {
      const { Key } = command.input;
      const uploadId = `upload-${++uploadIdCounter}`;
      store.uploads.set(uploadId, { key: Key!, parts: new Map() });
      return { UploadId: uploadId };
    }

    if (command instanceof UploadPartCommand) {
      const { UploadId, PartNumber, Body } = command.input;
      const upload = store.uploads.get(UploadId!);
      if (!upload) throw makeError("NoSuchUpload", "The specified upload does not exist.", 404);
      const body = Body instanceof Buffer ? Body : Buffer.from(Body ?? "");
      upload.parts.set(PartNumber!, body);
      const etag = `"part-etag-${++etagCounter}"`;
      return { ETag: etag };
    }

    if (command instanceof CompleteMultipartUploadCommand) {
      const { UploadId, Key, MultipartUpload } = command.input;
      const upload = store.uploads.get(UploadId!);
      if (!upload) throw makeError("NoSuchUpload", "The specified upload does not exist.", 404);
      const partNums = (MultipartUpload?.Parts ?? [])
        .map((p) => p.PartNumber!)
        .sort((a, b) => a - b);
      const chunks = partNums.map((n) => {
        const chunk = upload.parts.get(n);
        if (!chunk) throw new Error(`Part ${n} not found`);
        return chunk;
      });
      const body = Buffer.concat(chunks);
      const etag = `"etag-${++etagCounter}"`;
      store.objects.set(Key!, { body, etag });
      store.uploads.delete(UploadId!);
      return { ETag: etag };
    }

    if (command instanceof AbortMultipartUploadCommand) {
      const { UploadId } = command.input;
      store.uploads.delete(UploadId!);
      return {};
    }

    throw new Error(`Unmocked S3 command: ${command.constructor.name}`);
  };

  const client = { send, destroy: () => {} } as unknown as S3Client;
  return { client, store };
}
