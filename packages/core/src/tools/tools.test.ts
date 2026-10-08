import { getEncoding } from "js-tiktoken";
import { expect, test } from "vitest";
import {
  InMemoryNoteStore,
  InMemorySearchIndex,
  type IndexedChunk,
  type NoteSummary,
  type SearchHit,
  type SearchIndex,
  type SearchQuery,
} from "../index.js";
import { DEFAULT_MIN_SCORE, retrieve } from "../retrieval/search.js";
import { listNotes } from "./list-notes.js";
import { readNote } from "./read-note.js";
import { searchArchitectureDocs } from "./search-architecture-docs.js";

function chunk(overrides: Partial<IndexedChunk> = {}): IndexedChunk {
  return {
    id: "chunk-a",
    notePath: "devlog-agent/Queue Worker.md",
    noteTitle: "Queue Worker",
    headingPath: ["Procedure Call"],
    ordinal: 0,
    content: "The worker calls sp_ProcessBatch.",
    embeddedText: "The worker calls sp_ProcessBatch.",
    tags: ["worker"],
    links: [],
    hasCode: false,
    hasMermaid: false,
    contentHash: "hash-worker",
    tokenCount: 8,
    embeddingModel: "fake-embedder",
    embeddingDimensions: 4,
    indexedAt: "2026-01-01T00:00:00.000Z",
    vector: [0, 0, 0, 1],
    ...overrides,
  };
}

class LowScoreIndex implements SearchIndex {
  readonly queries: SearchQuery[] = [];

  async hybridSearch(query: SearchQuery): Promise<SearchHit[]> {
    this.queries.push(query);
    return [
      {
        chunkId: "chunk-a",
        notePath: "devlog-agent/Queue Worker.md",
        noteTitle: "Queue Worker",
        headingPath: ["Procedure Call"],
        content: "The worker calls sp_ProcessBatch.",
        score: 0.01,
        citation: "Queue Worker.md > Procedure Call",
      },
    ];
  }

  async upsert(): Promise<void> {}

  async deleteByNotePath(): Promise<void> {}

  async listNoteHashes(): Promise<Map<string, string>> {
    return new Map();
  }

  async listNotes(): Promise<NoteSummary[]> {
    return [];
  }

  async readEmbeddingStamp() {
    return null;
  }
}

test("search_architecture_docs keeps a hit below DEFAULT_MIN_SCORE", async () => {
  const index = new LowScoreIndex();
  const notes = new InMemoryNoteStore();
  const parsed = searchArchitectureDocs.input.parse({
    query: "queue worker",
    tags: ["worker"],
  });

  const hits = await searchArchitectureDocs.handler({ index, notes })(parsed);
  const filtered = await retrieve(index, { query: "queue worker" });

  expect(parsed).toEqual({ query: "queue worker", topK: 5, tags: ["worker"] });
  expect(hits).toHaveLength(1);
  expect(hits[0]?.score).toBeLessThan(DEFAULT_MIN_SCORE);
  expect(index.queries[0]).toEqual({
    query: "queue worker",
    topK: 5,
    tags: ["worker"],
  });
  expect(filtered).toEqual([]);
  expect(
    searchArchitectureDocs.input.safeParse({ query: "no", topK: 11 }).success,
  ).toBe(false);
});

test("read_note returns the stored markdown for a hit path", async () => {
  const index = new InMemorySearchIndex();
  const notes = new InMemoryNoteStore();
  const notePath = "devlog-agent/Queue Worker.md";
  const markdown = "# Queue Worker\n\nThe worker calls sp_ProcessBatch.\n";
  await notes.put(notePath, markdown);

  const result = await readNote.handler({ index, notes })({ notePath });

  expect(result).toEqual({ notePath, content: markdown, truncated: false });
});

test("read_note reports a missing note", async () => {
  const result = await readNote.handler({
    index: new InMemorySearchIndex(),
    notes: new InMemoryNoteStore(),
  })({ notePath: "devlog-agent/Queue Worker.md" });

  expect(result).toEqual({
    error: "Note not found: devlog-agent/Queue Worker.md",
  });
});

test("read_note truncates at 8000 tokens", async () => {
  const encoder = getEncoding("cl100k_base");
  const markdown = "alpha ".repeat(8000);
  expect(encoder.encode(markdown).length).toBeGreaterThan(8000);
  const notes = new InMemoryNoteStore();
  const notePath = "devlog-agent/Queue Worker.md";
  await notes.put(notePath, markdown);

  const result = await readNote.handler({
    index: new InMemorySearchIndex(),
    notes,
  })({ notePath });

  const tokens = encoder.encode(markdown);
  expect(result).toEqual({
    notePath,
    content: encoder.decode(tokens.slice(0, 8000)),
    truncated: true,
  });
});

test("list_notes returns one row per note with title, tags, and indexedAt", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([
    chunk({
      id: "old",
      tags: ["stale"],
      indexedAt: "2026-01-01T00:00:00.000Z",
    }),
    chunk({
      id: "new",
      ordinal: 1,
      tags: ["worker", "retry"],
      indexedAt: "2026-06-01T00:00:00.000Z",
    }),
    chunk({
      id: "decisions",
      notePath: "devlog-agent/Decisions.md",
      noteTitle: "Decisions",
      headingPath: ["Storage"],
      tags: ["storage"],
      contentHash: "hash-decisions",
      indexedAt: "2026-03-01T00:00:00.000Z",
    }),
  ]);

  const notes = await listNotes.handler({
    index,
    notes: new InMemoryNoteStore(),
  })({});

  expect(notes).toEqual([
    {
      notePath: "devlog-agent/Decisions.md",
      noteTitle: "Decisions",
      tags: ["storage"],
      indexedAt: "2026-03-01T00:00:00.000Z",
    },
    {
      notePath: "devlog-agent/Queue Worker.md",
      noteTitle: "Queue Worker",
      tags: ["worker", "retry"],
      indexedAt: "2026-06-01T00:00:00.000Z",
    },
  ]);
});
