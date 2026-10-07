import {
  SearchHitSchema,
  type IndexedChunk,
  type SearchHit,
} from "@devlog/core";
import { describe, expect, test } from "vitest";
import { AzureEmbedder } from "./embedder.js";
import { AzureNoteStore, createNoteBlob } from "./blob.js";
import {
  AzureSearchIndex,
  createAzureSearchIndex,
  createSearchIndexClient,
  ensureDevlogIndex,
} from "./search.js";

const azureEnabled =
  process.env.AZURE_INTEGRATION === "1" ||
  process.env.npm_lifecycle_event === "test:azure";

const NOTE_PATH = "devlog-agent/__adapter_smoke__.md";
const MARKER = "adapter smoke marker";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function safeMessage(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : "request failed";
  for (const secret of secrets) {
    if (secret !== "") {
      message = message.split(secret).join("***");
    }
  }
  return message;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe.skipIf(!azureEnabled)("Azure adapters", () => {
  test("embeds, indexes, and stores one note", async () => {
    const apiKey = required("AZURE_OPENAI_API_KEY");
    const searchKey = required("AZURE_SEARCH_API_KEY");
    const connectionString = required("AZURE_STORAGE_CONNECTION_STRING");
    const secrets = [apiKey, searchKey, connectionString];
    const endpoint = required("AZURE_OPENAI_ENDPOINT");
    const deployment = required("AZURE_OPENAI_EMBEDDING_DEPLOYMENT");
    const searchEndpoint = required("AZURE_SEARCH_ENDPOINT");
    const dimensions = Number(required("EMBEDDING_DIMENSIONS"));
    if (dimensions !== 1536) {
      throw new Error("EMBEDDING_DIMENSIONS must be 1536");
    }
    const indexName = process.env.AZURE_SEARCH_INDEX || "devlog-chunks";
    const container = process.env.AZURE_STORAGE_CONTAINER || "devlog-notes";

    const embedder = new AzureEmbedder({
      endpoint,
      apiKey,
      deployment,
      dimensions,
    });
    let search: AzureSearchIndex | undefined;
    let store: AzureNoteStore | undefined;
    let failure: unknown;

    try {
      await ensureDevlogIndex(
        createSearchIndexClient(searchEndpoint, searchKey),
        indexName,
        dimensions,
      );
      search = createAzureSearchIndex({
        endpoint: searchEndpoint,
        apiKey: searchKey,
        indexName,
        embedder,
      });
      store = new AzureNoteStore(createNoteBlob(connectionString, container));

      await search.deleteByNotePath(NOTE_PATH);
      await store.delete(NOTE_PATH);

      const content = `${MARKER} for the Azure adapter test.`;
      const embedded = await embedder.embed([content]);
      const vector = embedded[0];
      if (vector === undefined || vector.length !== 1536) {
        throw new Error(
          `Expected one embedding of length 1536, got ${vector?.length ?? 0}`,
        );
      }

      const chunk: IndexedChunk = {
        id: "adapter-smoke-chunk",
        notePath: NOTE_PATH,
        noteTitle: "Adapter Smoke",
        headingPath: ["Smoke"],
        ordinal: 0,
        content,
        embeddedText: content,
        tags: ["smoke"],
        links: [],
        hasCode: false,
        hasMermaid: false,
        contentHash: "adapter-smoke-hash",
        tokenCount: 8,
        embeddingModel: deployment,
        embeddingDimensions: 1536,
        indexedAt: new Date().toISOString(),
        vector,
      };

      await search.upsert([chunk]);
      await store.put(NOTE_PATH, content);
      await expect(store.get(NOTE_PATH)).resolves.toBe(content);

      const deadline = Date.now() + 20_000;
      let hit: SearchHit | undefined;
      let hash: string | undefined;
      while (Date.now() < deadline) {
        const hits = await search.hybridSearch({
          query: MARKER,
          topK: 5,
          tags: ["smoke"],
          notePath: NOTE_PATH,
        });
        hit = hits.find((item) => item.chunkId === chunk.id);
        hash = (await search.listNoteHashes()).get(NOTE_PATH);
        if (hit !== undefined && hash === chunk.contentHash) {
          break;
        }
        await delay(1000);
      }

      expect(hash).toBe(chunk.contentHash);
      expect(SearchHitSchema.parse(hit)).toMatchObject({
        chunkId: chunk.id,
        notePath: NOTE_PATH,
        noteTitle: "Adapter Smoke",
        headingPath: ["Smoke"],
        content,
        citation: "__adapter_smoke__.md > Smoke",
      });
    } catch (error) {
      failure = error;
    }

    const cleanup: string[] = [];
    if (search !== undefined) {
      try {
        await search.deleteByNotePath(NOTE_PATH);
      } catch (error) {
        cleanup.push(safeMessage(error, secrets));
      }
    }
    if (store !== undefined) {
      try {
        await store.delete(NOTE_PATH);
      } catch (error) {
        cleanup.push(safeMessage(error, secrets));
      }
    }

    if (failure !== undefined) {
      throw new Error(safeMessage(failure, secrets), { cause: failure });
    }
    if (cleanup.length > 0) {
      throw new Error(cleanup.join("; "));
    }
  }, 120_000);
});
