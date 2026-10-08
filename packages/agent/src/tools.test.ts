import {
  InMemoryNoteStore,
  InMemorySearchIndex,
  type IndexedChunk,
} from "@devlog/core";
import { searchArchitectureDocs } from "@devlog/core/tools";
import { expect, test } from "vitest";
import { toLangChainTool } from "./tools.js";

function chunk(overrides: Partial<IndexedChunk> = {}): IndexedChunk {
  return {
    id: "chunk-a",
    notePath: "devlog-agent/Queue Worker.md",
    noteTitle: "Queue Worker",
    headingPath: ["Procedure Call"],
    ordinal: 0,
    content: "The queue worker calls sp_ProcessBatch.",
    embeddedText: "The queue worker calls sp_ProcessBatch.",
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

test("toLangChainTool returns the handler result as JSON", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([chunk()]);
  const wrapped = toLangChainTool(searchArchitectureDocs, {
    index,
    notes: new InMemoryNoteStore(),
  });

  const raw = await wrapped.invoke({ query: "queue worker" });
  const hits = JSON.parse(String(raw)) as { notePath: string; score: number }[];

  expect(wrapped.name).toBe("search_architecture_docs");
  expect(wrapped.description).toBe(searchArchitectureDocs.description);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    notePath: "devlog-agent/Queue Worker.md",
    score: 1,
  });
});
