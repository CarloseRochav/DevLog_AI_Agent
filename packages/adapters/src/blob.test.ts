import { expect, test } from "vitest";
import {
  AzureNoteStore,
  isMissingBlob,
  readBlob,
  type NoteBlob,
} from "./blob.js";

function memoryBlobs(): NoteBlob & {
  saved: Map<string, { body: Uint8Array; contentType: string }>;
} {
  const saved = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    saved,
    async upload(name, body, contentType) {
      saved.set(name, { body, contentType });
    },
    async download(name) {
      return saved.get(name)?.body ?? null;
    },
    async delete(name) {
      saved.delete(name);
    },
  };
}

test("stores markdown bytes and reads them back", async () => {
  const blobs = memoryBlobs();
  const store = new AzureNoteStore(blobs);
  const markdown = "héllo";

  await store.put("devlog-agent/Note.md", markdown);

  const saved = blobs.saved.get("devlog-agent/Note.md");
  expect(saved?.contentType).toBe("text/markdown; charset=utf-8");
  expect(markdown.length).toBe(5);
  expect(saved?.body.byteLength).toBe(6);
  await expect(store.get("devlog-agent/Note.md")).resolves.toBe(markdown);

  await store.delete("devlog-agent/Note.md");
  await expect(store.get("devlog-agent/Note.md")).resolves.toBeNull();
});

test("get returns null when the blob download is missing", async () => {
  const store = new AzureNoteStore({
    async upload() {
      throw new Error("unused");
    },
    async download() {
      return null;
    },
    async delete() {
      throw new Error("unused");
    },
  });

  await expect(store.get("missing.md")).resolves.toBeNull();
});

test("treats blob status 404 as missing and rethrows other errors", async () => {
  expect(isMissingBlob({ statusCode: 404 })).toBe(true);
  expect(isMissingBlob({ statusCode: 500 })).toBe(false);
  expect(isMissingBlob(new Error("no"))).toBe(false);

  await expect(
    readBlob(async () => {
      throw { statusCode: 404 };
    }),
  ).resolves.toBeNull();

  await expect(
    readBlob(async () => {
      throw { statusCode: 500 };
    }),
  ).rejects.toEqual({ statusCode: 500 });
});
