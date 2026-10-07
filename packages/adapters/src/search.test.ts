import type { Embedder, IndexedChunk, SearchQuery } from "@devlog/core";
import { ZodError } from "zod";
import { expect, test } from "vitest";
import {
  AzureSearchIndex,
  devlogChunksIndex,
  ensureDevlogIndex,
  type DevlogDocument,
  type DocumentClient,
  type DocumentHit,
  type DocumentSearchRequest,
  type IndexingOutcome,
} from "./search.js";

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
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
    indexedAt: "2026-01-01T00:00:00.000Z",
    vector: [0, 0, 0, 1],
    ...overrides,
  };
}

class FakeEmbedder implements Embedder {
  readonly model = "text-embedding-3-small";
  readonly dimensions = 4;
  readonly texts: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.texts.push(texts);
    return texts.map((_, index) => [index, 1, 2, 3]);
  }
}

class FakeDocuments implements DocumentClient {
  readonly searches: DocumentSearchRequest[] = [];
  readonly uploaded: DevlogDocument[][] = [];
  readonly deleted: string[][] = [];
  uploadResult: IndexingOutcome[] | undefined;
  deleteResult: IndexingOutcome[] | undefined;
  searchHandler: (request: DocumentSearchRequest) => DocumentHit[] = () => [];

  async mergeOrUpload(documents: DevlogDocument[]): Promise<IndexingOutcome[]> {
    this.uploaded.push(documents);
    if (this.uploadResult !== undefined) {
      return this.uploadResult;
    }
    return documents.map((document) => ({
      key: document.id,
      succeeded: true,
      statusCode: 200,
    }));
  }

  async deleteByIds(ids: string[]): Promise<IndexingOutcome[]> {
    this.deleted.push(ids);
    if (this.deleteResult !== undefined) {
      return this.deleteResult;
    }
    return ids.map((id) => ({ key: id, succeeded: true, statusCode: 200 }));
  }

  async search(request: DocumentSearchRequest): Promise<DocumentHit[]> {
    this.searches.push(request);
    return this.searchHandler(request);
  }
}

function indexWith(): {
  index: AzureSearchIndex;
  documents: FakeDocuments;
  embedder: FakeEmbedder;
} {
  const documents = new FakeDocuments();
  const embedder = new FakeEmbedder();
  return {
    index: new AzureSearchIndex(documents, embedder),
    documents,
    embedder,
  };
}

test("devlogChunksIndex matches the section 7.1 fields", () => {
  const definition = devlogChunksIndex("devlog-chunks", 1536);

  expect(definition.name).toBe("devlog-chunks");
  expect(definition.vectorSearch?.algorithms?.[0]).toEqual({
    name: "devlog-hnsw-algo",
    kind: "hnsw",
    parameters: { metric: "cosine" },
  });
  expect(definition.vectorSearch?.profiles?.[0]).toEqual({
    name: "devlog-hnsw",
    algorithmConfigurationName: "devlog-hnsw-algo",
  });

  const fields = new Map(definition.fields.map((field) => [field.name, field]));
  expect(fields.get("id")).toMatchObject({
    type: "Edm.String",
    key: true,
  });
  expect(fields.get("id")).not.toHaveProperty("hidden");
  expect(fields.get("notePath")).toMatchObject({
    filterable: true,
    facetable: true,
    searchable: false,
  });
  expect(fields.get("noteTitle")).toMatchObject({ searchable: true });
  expect(fields.get("headingPath")).toMatchObject({ searchable: true });
  expect(fields.get("content")).toMatchObject({
    searchable: true,
    analyzerName: "en.microsoft",
  });
  expect(fields.get("tags")).toMatchObject({
    type: "Collection(Edm.String)",
    filterable: true,
    facetable: true,
  });
  expect(fields.get("links")).toMatchObject({
    type: "Collection(Edm.String)",
    filterable: true,
  });
  expect(fields.get("ordinal")).toMatchObject({
    type: "Edm.Int32",
    sortable: true,
  });
  expect(fields.get("contentHash")).toMatchObject({ filterable: true });
  expect(fields.get("embeddingModel")).toMatchObject({ filterable: true });
  expect(fields.get("embeddingDimensions")).toMatchObject({
    type: "Edm.Int32",
    filterable: true,
  });
  expect(fields.get("indexedAt")).toMatchObject({
    type: "Edm.DateTimeOffset",
    sortable: true,
  });
  expect(fields.get("contentVector")).toMatchObject({
    type: "Collection(Edm.Single)",
    searchable: true,
    vectorSearchDimensions: 1536,
    vectorSearchProfileName: "devlog-hnsw",
  });
  expect(fields.get("contentVector")).not.toHaveProperty("hidden");
});

test("ensureDevlogIndex creates or updates the named index", async () => {
  const calls: string[] = [];
  await ensureDevlogIndex(
    {
      async createOrUpdateIndex(definition) {
        const vector = definition.fields.find(
          (field) => field.name === "contentVector",
        );
        const dimensions =
          vector !== undefined && "vectorSearchDimensions" in vector
            ? vector.vectorSearchDimensions
            : undefined;
        calls.push(`${definition.name}:${String(dimensions)}`);
        return definition;
      },
    },
    "devlog-chunks",
    32,
  );

  expect(calls).toEqual(["devlog-chunks:32"]);
});

test("upsert stores a joined heading path and skips an empty batch", async () => {
  const { index, documents } = indexWith();

  await index.upsert([]);
  await index.upsert([chunk()]);

  expect(documents.uploaded).toHaveLength(1);
  expect(documents.uploaded[0]?.[0]).toMatchObject({
    id: "chunk-a",
    headingPath: "Background Processing > Queue Worker",
    contentVector: [0, 0, 0, 1],
    indexedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

test("upsert throws when a document fails", async () => {
  const { index, documents } = indexWith();
  documents.uploadResult = [
    {
      key: "chunk-a",
      succeeded: false,
      statusCode: 400,
      errorMessage: "bad document",
    },
  ];

  await expect(index.upsert([chunk()])).rejects.toThrow(
    /upsert failed: chunk-a \(400 bad document\)/,
  );
});

test("hybrid search embeds the query and maps a filename citation", async () => {
  const { index, documents, embedder } = indexWith();
  documents.searchHandler = () => [
    {
      score: 0.01,
      document: {
        id: "chunk-a",
        notePath: "ProjectX/Architecture.md",
        noteTitle: "Architecture",
        headingPath: "Background Processing > Queue Worker",
        content: "The queue worker retries failed batches.",
      },
    },
  ];

  const hits = await index.hybridSearch({
    query: "queue worker",
    topK: 3,
  });

  expect(embedder.texts).toEqual([["queue worker"]]);
  expect(documents.searches[0]).toMatchObject({
    searchText: "queue worker",
    top: 3,
    select: ["id", "notePath", "noteTitle", "headingPath", "content"],
    vector: {
      vector: [0, 1, 2, 3],
      kNearestNeighborsCount: 20,
      fields: ["contentVector"],
    },
  });
  expect(hits).toEqual([
    {
      chunkId: "chunk-a",
      notePath: "ProjectX/Architecture.md",
      noteTitle: "Architecture",
      headingPath: ["Background Processing", "Queue Worker"],
      content: "The queue worker retries failed batches.",
      score: 0.01,
      citation: "Architecture.md > Background Processing > Queue Worker",
    },
  ]);
});

test("citation uses the file name for a windows path and an empty heading", async () => {
  const { index, documents } = indexWith();
  documents.searchHandler = () => [
    {
      score: 1,
      document: {
        id: "chunk-b",
        notePath: "ProjectX\\Decisions.md",
        noteTitle: "Decisions",
        headingPath: "",
        content: "Keep the queue worker.",
      },
    },
  ];

  const hits = await index.hybridSearch({
    query: "queue worker",
    topK: 1,
  });

  expect(hits[0]?.citation).toBe("Decisions.md");
  expect(hits[0]?.headingPath).toEqual([]);
});

test("builds an OData filter and defaults topK to 5", async () => {
  const { index, documents } = indexWith();

  await index.hybridSearch({
    query: "queue worker",
    notePath: "a'b",
    tags: ["x", "y's"],
  } as SearchQuery);

  expect(documents.searches[0]?.top).toBe(5);
  expect(documents.searches[0]?.filter).toBe(
    "notePath eq 'a''b' and tags/any(t: t eq 'x') and tags/any(t: t eq 'y''s')",
  );
});

test("rejects a search hit that fails SearchHitSchema", async () => {
  const { index, documents } = indexWith();
  documents.searchHandler = () => [
    {
      score: "high",
      document: { id: "chunk-a" },
    },
  ];

  await expect(
    index.hybridSearch({ query: "queue worker", topK: 1 }),
  ).rejects.toBeInstanceOf(ZodError);
});

test("rejects a query shorter than 3 characters before embedding", async () => {
  const { index, embedder } = indexWith();

  await expect(
    index.hybridSearch({ query: "no", topK: 1 }),
  ).rejects.toBeInstanceOf(ZodError);
  expect(embedder.texts).toEqual([]);
});

test("deleteByNotePath pages ids and skips a delete when none match", async () => {
  const { index, documents } = indexWith();
  documents.searchHandler = (request) => {
    if ((request.skip ?? 0) === 0) {
      return Array.from({ length: 1000 }, (_, item) => ({
        document: { id: `id-${item}` },
      }));
    }
    return [{ document: { id: "id-last" } }];
  };

  await index.deleteByNotePath("a'b");

  expect(documents.searches.map((request) => request.skip)).toEqual([0, 1000]);
  expect(documents.searches[0]?.filter).toBe("notePath eq 'a''b'");
  expect(documents.searches[0]?.select).toEqual(["id"]);
  expect(documents.deleted[0]).toHaveLength(1000);
  expect(documents.deleted[1]).toEqual(["id-last"]);

  documents.searches.length = 0;
  documents.deleted.length = 0;
  documents.searchHandler = () => [];
  await index.deleteByNotePath("missing.md");
  expect(documents.deleted).toEqual([]);
});

test("listNoteHashes keeps the first hash for each note", async () => {
  const { index, documents } = indexWith();
  documents.searchHandler = (request) => {
    if ((request.skip ?? 0) === 0) {
      return Array.from({ length: 1000 }, (_, item) => ({
        document: {
          notePath: "ProjectX/Architecture.md",
          contentHash: item === 0 ? "first" : "later",
        },
      }));
    }
    return [
      {
        document: {
          notePath: "ProjectX/Architecture.md",
          contentHash: "second-page",
        },
      },
      {
        document: {
          notePath: "ProjectX/Decisions.md",
          contentHash: "other",
        },
      },
      { document: { notePath: "ProjectX/Missing.md" } },
    ];
  };

  const hashes = await index.listNoteHashes();

  expect(documents.searches[0]).toMatchObject({
    searchText: "*",
    top: 1000,
    skip: 0,
    select: ["notePath", "contentHash"],
  });
  expect(documents.searches[1]?.skip).toBe(1000);
  expect(hashes.get("ProjectX/Architecture.md")).toBe("first");
  expect(hashes.get("ProjectX/Decisions.md")).toBe("other");
  expect(hashes.has("ProjectX/Missing.md")).toBe(false);
});
