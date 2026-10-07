import type { NoteStore } from "@devlog/core";
import { BlobServiceClient } from "@azure/storage-blob";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export interface NoteBlob {
  upload(name: string, body: Uint8Array, contentType: string): Promise<void>;
  download(name: string): Promise<Uint8Array | null>;
  delete(name: string): Promise<void>;
}

export function isMissingBlob(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return false;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return statusCode === 404;
}

export async function readBlob(
  download: () => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  try {
    return await download();
  } catch (error) {
    if (isMissingBlob(error)) {
      return null;
    }
    throw error;
  }
}

export class AzureNoteStore implements NoteStore {
  constructor(private readonly blobs: NoteBlob) {}

  async put(notePath: string, markdown: string): Promise<void> {
    const body = Buffer.from(markdown, "utf8");
    await this.blobs.upload(notePath, body, MARKDOWN_CONTENT_TYPE);
  }

  async get(notePath: string): Promise<string | null> {
    const body = await this.blobs.download(notePath);
    if (body === null) {
      return null;
    }
    return Buffer.from(body).toString("utf8");
  }

  async delete(notePath: string): Promise<void> {
    await this.blobs.delete(notePath);
  }
}

export function createNoteBlob(
  connectionString: string,
  containerName: string,
): NoteBlob {
  const container =
    BlobServiceClient.fromConnectionString(connectionString).getContainerClient(
      containerName,
    );

  return {
    async upload(name, body, contentType) {
      await container.getBlockBlobClient(name).upload(body, body.byteLength, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    },
    async download(name) {
      return readBlob(() =>
        container.getBlockBlobClient(name).downloadToBuffer(),
      );
    },
    async delete(name) {
      await container.getBlockBlobClient(name).deleteIfExists();
    },
  };
}
