import { expect, test } from "vitest";
import {
  InMemoryEmbedder,
  InMemoryNoteStore,
  InMemorySearchIndex,
  type IndexedChunk,
} from "./index.js";

function chunk(overrides: Partial<IndexedChunk> = {}): IndexedChunk {
  return {
    id: "chunk-a",
    notePath: "ProjectX/Architecture.md",
    noteTitle: "Architecture",
    headingPath: ["Background Processing", "Queue Worker"],
    ordinal: 0,
    content: "The queue worker retries failed batches.",
    embeddedText: "The queue worker retries failed batches.",
    tags: ["worker"],
    links: [],
    hasCode: false,
    hasMermaid: false,
    contentHash: "hash-architecture",
    tokenCount: 8,
    embeddingModel: "fake-embedder",
    embeddingDimensions: 4,
    indexedAt: "2026-01-01T00:00:00.000Z",
    vector: [0, 0, 0, 1],
    ...overrides,
  };
}

test("embed returns one stable vector per text", async () => {
  const embedder = new InMemoryEmbedder({ model: "fake", dimensions: 4 });

  expect(embedder.model).toBe("fake");
  expect(embedder.dimensions).toBe(4);

  const first = await embedder.embed(["alpha", "beta"]);
  const second = await embedder.embed(["alpha"]);

  expect(first).toHaveLength(2);
  expect(first[0]).toHaveLength(4);
  expect(first[1]).toHaveLength(4);
  expect(first[0]).toEqual(second[0]);
  expect(first[0]).not.toEqual(first[1]);
  expect(await embedder.embed([])).toEqual([]);
});

test("upsert lists one hash per note and delete removes it", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([
    chunk({ id: "a", ordinal: 0 }),
    chunk({
      id: "b",
      ordinal: 1,
      content: "Another paragraph about the queue.",
    }),
  ]);

  const hashes = await index.listNoteHashes();
  expect(hashes.size).toBe(1);
  expect(hashes.get("ProjectX/Architecture.md")).toBe("hash-architecture");

  await index.deleteByNotePath("ProjectX/Architecture.md");
  expect((await index.listNoteHashes()).size).toBe(0);
});

test("readEmbeddingStamp is empty until a chunk is stored", async () => {
  const index = new InMemorySearchIndex();

  expect(await index.readEmbeddingStamp()).toBeNull();
  await index.upsert([
    chunk({
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    }),
  ]);

  expect(await index.readEmbeddingStamp()).toEqual({
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
  });
});

test("hybridSearch matches content and honors topK, notePath, and tags", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([
    chunk({ id: "a", ordinal: 0, content: "queue worker retries" }),
    chunk({ id: "b", ordinal: 1, content: "queue worker logs" }),
    chunk({
      id: "c",
      ordinal: 2,
      content: "queue worker metrics",
      tags: ["other"],
    }),
    chunk({
      id: "d",
      ordinal: 5,
      notePath: "ProjectX/Decisions.md",
      noteTitle: "Decisions",
      headingPath: ["Storage"],
      content: "queue worker choice",
      contentHash: "hash-decisions",
      tags: ["worker"],
    }),
  ]);

  const hits = await index.hybridSearch({ query: "QUEUE", topK: 2 });
  expect(hits.map((hit) => hit.chunkId)).toEqual(["a", "b"]);
  expect(hits[0]?.score).toBe(1);
  expect(hits[0]?.citation).toBe(
    "Architecture > Background Processing > Queue Worker",
  );

  const byNote = await index.hybridSearch({
    query: "queue",
    topK: 10,
    notePath: "ProjectX/Decisions.md",
  });
  expect(byNote.map((hit) => hit.chunkId)).toEqual(["d"]);
  expect(byNote[0]?.citation).toBe("Decisions > Storage");

  const byTag = await index.hybridSearch({
    query: "queue",
    topK: 10,
    tags: ["worker"],
  });
  expect(byTag.map((hit) => hit.chunkId)).toEqual(["a", "b", "d"]);
});

test("InMemorySearchIndex listNotes dedupes by notePath", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([
    chunk({
      id: "new",
      tags: ["worker"],
      indexedAt: "2026-06-01T00:00:00.000Z",
    }),
    chunk({
      id: "old",
      ordinal: 1,
      tags: ["stale"],
      indexedAt: "2026-01-01T00:00:00.000Z",
    }),
    chunk({
      id: "decisions",
      notePath: "ProjectX/Decisions.md",
      noteTitle: "Decisions",
      headingPath: ["Storage"],
      tags: ["storage"],
      contentHash: "hash-decisions",
      indexedAt: "2026-02-01T00:00:00.000Z",
    }),
  ]);

  expect(await index.listNotes()).toEqual([
    {
      notePath: "ProjectX/Architecture.md",
      noteTitle: "Architecture",
      tags: ["worker"],
      indexedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      notePath: "ProjectX/Decisions.md",
      noteTitle: "Decisions",
      tags: ["storage"],
      indexedAt: "2026-02-01T00:00:00.000Z",
    },
  ]);
});

test("put, get, and delete notes", async () => {
  const store = new InMemoryNoteStore();

  expect(await store.get("a.md")).toBeNull();
  await store.put("a.md", "# A");
  expect(await store.get("a.md")).toBe("# A");
  await store.delete("a.md");
  expect(await store.get("a.md")).toBeNull();
  await store.delete("missing.md");
});
