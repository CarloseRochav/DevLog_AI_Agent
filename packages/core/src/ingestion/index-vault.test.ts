import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  InMemoryEmbedder,
  InMemoryNoteStore,
  InMemorySearchIndex,
  type Embedder,
  type IndexedChunk,
  type SearchIndex,
} from "../index.js";
import { IndexError, indexVault, type IndexOptions } from "./index-vault.js";
import type { VaultNote } from "./walk.js";

function hash(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

function note(notePath: string, markdown: string): VaultNote {
  return { notePath, markdown, contentHash: hash(markdown) };
}

const architecture = note(
  "devlog-agent/Architecture.md",
  `---
title: Architecture
tags:
  - worker
---

# Architecture

The queue worker retries failed batches.
`,
);

const decisions = note(
  "devlog-agent/Decisions.md",
  `# Decisions

Keep the notes in blob storage.
`,
);

function options(overrides: Partial<IndexOptions> = {}): IndexOptions {
  return {
    full: false,
    dryRun: false,
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
    maxTokens: 700,
    overlapTokens: 80,
    now: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function harness(): {
  embedder: Embedder;
  index: SearchIndex;
  store: InMemoryNoteStore;
  texts: string[][];
  deleted: string[];
  upserts: IndexedChunk[][];
} {
  const inner = new InMemoryEmbedder({
    model: "text-embedding-3-small",
    dimensions: 4,
  });
  const texts: string[][] = [];
  const embedder: Embedder = {
    model: inner.model,
    dimensions: inner.dimensions,
    async embed(input) {
      texts.push(input);
      return inner.embed(input);
    },
  };
  const search = new InMemorySearchIndex();
  const deleted: string[] = [];
  const upserts: IndexedChunk[][] = [];
  const index: SearchIndex = {
    upsert: async (chunks) => {
      upserts.push(chunks);
      await search.upsert(chunks);
    },
    deleteByNotePath: async (notePath) => {
      deleted.push(notePath);
      await search.deleteByNotePath(notePath);
    },
    hybridSearch: (query) => search.hybridSearch(query),
    listNoteHashes: () => search.listNoteHashes(),
    readEmbeddingStamp: () => search.readEmbeddingStamp(),
  };
  return {
    embedder,
    index,
    store: new InMemoryNoteStore(),
    texts,
    deleted,
    upserts,
  };
}

test("indexes every note, then reports zero changed", async () => {
  const deps = harness();
  const notes = [architecture, decisions];

  const first = await indexVault(notes, deps, options());

  expect(first.changed).toBe(2);
  expect(first.unchanged).toBe(0);
  expect(first.summary).toContain("2 changed");
  expect(first.summary).toContain("chunks upserted");
  expect(deps.texts).toHaveLength(1);
  expect(deps.upserts[0]?.[0]).toMatchObject({
    notePath: architecture.notePath,
    contentHash: architecture.contentHash,
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
    indexedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(await deps.store.get(architecture.notePath)).toBe(
    architecture.markdown,
  );
  expect(await deps.store.get(decisions.notePath)).toBe(decisions.markdown);

  const second = await indexVault(notes, deps, options());

  expect(second.changed).toBe(0);
  expect(second.unchanged).toBe(2);
  expect(second.summary).toContain("0 changed");
  expect(deps.texts).toHaveLength(1);
  expect(deps.upserts).toHaveLength(2);
});

test("editing one note reindexes only that note", async () => {
  const deps = harness();
  const notes = [architecture, decisions];
  await indexVault(notes, deps, options());
  deps.deleted.length = 0;
  deps.upserts.length = 0;

  const edited = note(
    architecture.notePath,
    `${architecture.markdown}\nEdited.\n`,
  );
  const report = await indexVault([edited, decisions], deps, options());

  expect(report.changed).toBe(1);
  expect(report.unchanged).toBe(1);
  expect(deps.deleted).toEqual([architecture.notePath]);
  expect(deps.upserts).toHaveLength(1);
  expect(
    deps.upserts[0]?.every((chunk) => chunk.notePath === edited.notePath),
  ).toBe(true);
  expect(deps.texts.at(-1)?.join("\n")).toContain("Edited.");
  expect(deps.texts.at(-1)?.join("\n")).not.toContain(
    "Keep the notes in blob storage.",
  );
  expect(await deps.store.get(decisions.notePath)).toBe(decisions.markdown);
  expect(await deps.store.get(edited.notePath)).toBe(edited.markdown);
});

test("deleting one note removes its chunks and blob", async () => {
  const deps = harness();
  await indexVault([architecture, decisions], deps, options());

  const report = await indexVault([decisions], deps, options());

  expect(report.deleted).toBe(1);
  expect(report.changed).toBe(0);
  expect(await deps.store.get(architecture.notePath)).toBeNull();
  expect((await deps.index.listNoteHashes()).has(architecture.notePath)).toBe(
    false,
  );
  expect(await deps.store.get(decisions.notePath)).toBe(decisions.markdown);
});

test("prune false leaves notes that are outside this run", async () => {
  const deps = harness();
  await indexVault([architecture, decisions], deps, options());
  deps.deleted.length = 0;

  const report = await indexVault([decisions], deps, options({ prune: false }));
  const dryRun = await indexVault(
    [decisions],
    deps,
    options({ prune: false, dryRun: true }),
  );

  expect(report.deleted).toBe(0);
  expect(report.changed).toBe(0);
  expect(deps.deleted).toEqual([]);
  expect(await deps.store.get(architecture.notePath)).toBe(
    architecture.markdown,
  );
  expect((await deps.index.listNoteHashes()).has(architecture.notePath)).toBe(
    true,
  );
  expect(dryRun.deleted).toBe(0);
  expect(dryRun.lines.join("\n")).not.toContain("delete ");
});

test("dry-run prints chunks and writes nothing", async () => {
  const deps = harness();
  await indexVault([architecture], deps, options());
  deps.texts.length = 0;
  deps.deleted.length = 0;
  deps.upserts.length = 0;

  const report = await indexVault([decisions], deps, options({ dryRun: true }));

  expect(report.summary.startsWith("dry-run ·")).toBe(true);
  expect(report.lines.join("\n")).toContain("Keep the notes in blob storage.");
  expect(report.lines.join("\n")).toContain(`delete ${architecture.notePath}`);
  expect(deps.texts).toEqual([]);
  expect(deps.deleted).toEqual([]);
  expect(deps.upserts).toEqual([]);
  expect(await deps.store.get(architecture.notePath)).toBe(
    architecture.markdown,
  );
  expect(await deps.store.get(decisions.notePath)).toBeNull();
});

test("a dimension mismatch refuses to run without --full", async () => {
  const deps = harness();
  await indexVault([architecture], deps, options());
  const writes = deps.upserts.length;
  const embeds = deps.texts.length;

  await expect(
    indexVault([architecture], deps, options({ embeddingDimensions: 8 })),
  ).rejects.toThrow(IndexError);
  await expect(
    indexVault([architecture], deps, options({ embeddingDimensions: 8 })),
  ).rejects.toThrow(/dimensions are 4 in the index and 8 in config/);

  expect(deps.upserts).toHaveLength(writes);
  expect(deps.texts).toHaveLength(embeds);
  await expect(
    indexVault(
      [architecture],
      deps,
      options({ embeddingModel: "other-model", embeddingDimensions: 8 }),
    ),
  ).rejects.toThrow(
    "Embedding model is text-embedding-3-small in the index and other-model in config. Embedding dimensions are 4 in the index and 8 in config. Re-run with --full.",
  );
  expect(deps.upserts).toHaveLength(writes);
  expect(deps.texts).toHaveLength(embeds);
  expect(await deps.index.readEmbeddingStamp()).toEqual({
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
  });

  const preview = await indexVault(
    [architecture],
    deps,
    options({ embeddingDimensions: 8, full: true, dryRun: true }),
  );
  expect(preview.changed).toBe(1);
  expect(preview.summary.startsWith("dry-run ·")).toBe(true);
  expect(deps.upserts).toHaveLength(writes);
  expect(deps.texts).toHaveLength(embeds);

  const rebuilt = await indexVault(
    [architecture],
    deps,
    options({ embeddingDimensions: 8, full: true }),
  );

  expect(rebuilt.changed).toBe(1);
  expect(deps.upserts.at(-1)?.[0]?.embeddingDimensions).toBe(8);
  expect(await deps.index.readEmbeddingStamp()).toEqual({
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 8,
  });
});
