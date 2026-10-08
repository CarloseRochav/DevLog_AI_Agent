import { expect, test } from "vitest";
import { InMemorySearchIndex, type IndexedChunk } from "../index.js";
import type { SearchHit, SearchQuery } from "../schemas.js";
import type { SearchIndex } from "../ports.js";
import { RetrievalError, retrieve } from "./search.js";

function chunk(overrides: Partial<IndexedChunk> = {}): IndexedChunk {
  return {
    id: "chunk-a",
    notePath: "devlog-agent/Architecture.md",
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

class RecordingIndex implements SearchIndex {
  readonly queries: SearchQuery[] = [];

  constructor(private readonly hits: SearchHit[]) {}

  async hybridSearch(query: SearchQuery): Promise<SearchHit[]> {
    this.queries.push(query);
    return this.hits;
  }

  async upsert(): Promise<void> {}

  async deleteByNotePath(): Promise<void> {}

  async listNoteHashes(): Promise<Map<string, string>> {
    return new Map();
  }

  async readEmbeddingStamp(): Promise<null> {
    return null;
  }
}

test("retrieve returns path, heading path, and score from one hybrid search", async () => {
  const hit: SearchHit = {
    chunkId: "chunk-a",
    notePath: "devlog-agent/Architecture.md",
    noteTitle: "Architecture",
    headingPath: ["Background Processing", "Queue Worker"],
    content: "The queue worker retries failed batches.",
    score: 0.016,
    citation: "Architecture.md > Background Processing > Queue Worker",
  };
  const index = new RecordingIndex([hit]);

  const hits = await retrieve(index, { query: "queue worker" });
  await retrieve(index, {
    query: "queue worker",
    topK: 3,
    tags: ["worker"],
    notePath: "devlog-agent/Architecture.md",
  });

  expect(hits).toEqual([hit]);
  expect(hits[0]).toMatchObject({
    notePath: "devlog-agent/Architecture.md",
    headingPath: ["Background Processing", "Queue Worker"],
    score: 0.016,
  });
  expect(index.queries).toHaveLength(2);
  expect(index.queries[0]).toMatchObject({ query: "queue worker", topK: 5 });
  expect(index.queries[0]?.tags).toBeUndefined();
  expect(index.queries[0]?.notePath).toBeUndefined();
  expect(index.queries[1]).toMatchObject({
    query: "queue worker",
    topK: 3,
    tags: ["worker"],
    notePath: "devlog-agent/Architecture.md",
  });
});

test("tag and note path filters narrow the hits", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([
    chunk({ id: "a", ordinal: 0, content: "queue worker retries" }),
    chunk({
      id: "b",
      ordinal: 1,
      content: "queue worker logs",
      tags: ["other"],
    }),
    chunk({
      id: "d",
      ordinal: 2,
      notePath: "devlog-agent/Decisions.md",
      noteTitle: "Decisions",
      headingPath: ["Storage"],
      content: "queue worker choice",
      contentHash: "hash-decisions",
      tags: ["worker"],
    }),
  ]);

  const all = await retrieve(index, { query: "queue", topK: 10 });
  const byTag = await retrieve(index, {
    query: "queue",
    topK: 10,
    tags: ["worker"],
  });
  const byNote = await retrieve(index, {
    query: "queue",
    topK: 10,
    notePath: "devlog-agent/Decisions.md",
  });

  expect(all.map((hit) => hit.chunkId)).toEqual(["a", "b", "d"]);
  expect(byTag.map((hit) => hit.chunkId)).toEqual(["a", "d"]);
  expect(byTag.length).toBeLessThan(all.length);
  expect(byNote.map((hit) => hit.chunkId)).toEqual(["d"]);
  expect(byNote[0]).toMatchObject({
    notePath: "devlog-agent/Decisions.md",
    headingPath: ["Storage"],
    score: 1,
  });
});

test("retrieve rejects an invalid query before searching", async () => {
  const index = new RecordingIndex([]);

  const short = await retrieve(index, { query: "no", topK: 50 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  const invalid = await retrieve(index, { query: "queue", topK: 0 }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(short).toBeInstanceOf(RetrievalError);
  expect(short).toMatchObject({
    message: "Query must be at least 3 characters.",
  });
  expect(invalid).toBeInstanceOf(RetrievalError);
  expect(invalid).toMatchObject({ message: "Invalid search query." });
  expect(index.queries).toEqual([]);
});
