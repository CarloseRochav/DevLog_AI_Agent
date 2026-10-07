import { devlogChunksIndex, type DevlogIndexClient } from "@devlog/adapters";
import { expect, test } from "vitest";
import { packageName, runCli, type CliIO } from "./index.js";

type IndexDefinition = ReturnType<typeof devlogChunksIndex>;

const searchKey = "search-secret-key";

function indexerEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
    AZURE_OPENAI_API_KEY: "openai-secret-key",
    EMBEDDING_DIMENSIONS: "1536",
    AZURE_SEARCH_ENDPOINT: "https://example.search.windows.net",
    AZURE_SEARCH_API_KEY: searchKey,
    AZURE_SEARCH_INDEX: "devlog-chunks",
    AZURE_STORAGE_CONNECTION_STRING: "AccountKey=storage-secret-value",
    VAULT_PATH: "C:/notes",
    ...overrides,
  };
}

function io(): CliIO & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log(message) {
      logs.push(message);
    },
    error(message) {
      errors.push(message);
    },
  };
}

function fakeIndex(existing?: IndexDefinition): DevlogIndexClient & {
  writes: IndexDefinition[];
} {
  const writes: IndexDefinition[] = [];
  return {
    writes,
    async getIndex() {
      if (existing === undefined) {
        throw { statusCode: 404 };
      }
      return existing;
    },
    async createOrUpdateIndex(index) {
      writes.push(index);
      return index;
    },
  };
}

test("@devlog/cli loads", () => {
  expect(packageName).toBe("@devlog/cli");
});

test("index:setup creates a missing index and prints the result", async () => {
  const output = io();
  const client = fakeIndex();
  let opened = 0;

  const code = await runCli(["node", "main.ts", "index:setup"], {
    env: indexerEnv(),
    io: output,
    openIndex: () => {
      opened += 1;
      return client;
    },
  });

  expect(code).toBe(0);
  expect(opened).toBe(1);
  expect(output.logs).toEqual(["created index devlog-chunks"]);
  expect(output.errors).toEqual([]);
  expect(client.writes).toEqual([devlogChunksIndex("devlog-chunks", 1536)]);
  expect(output.logs.join("\n")).not.toContain(searchKey);
});

test("index:setup reports an unchanged index without writing", async () => {
  const output = io();
  const client = fakeIndex(devlogChunksIndex("devlog-chunks", 1536));

  const code = await runCli(["node", "main.ts", "index:setup"], {
    env: indexerEnv(),
    io: output,
    openIndex: () => client,
  });

  expect(code).toBe(0);
  expect(output.logs).toEqual(["unchanged index devlog-chunks"]);
  expect(client.writes).toEqual([]);
});

test("an unknown command prints usage and does not open the index", async () => {
  const output = io();
  let opened = 0;

  const code = await runCli(["node", "main.ts", "query"], {
    env: indexerEnv(),
    io: output,
    openIndex: () => {
      opened += 1;
      return fakeIndex();
    },
  });

  expect(code).toBe(1);
  expect(opened).toBe(0);
  expect(output.errors.join("\n")).toContain("index:setup");
  expect(output.logs).toEqual([]);
});

test("a missing vault path names the variable and hides the search key", async () => {
  const output = io();
  const env = indexerEnv();
  delete env.VAULT_PATH;
  let opened = 0;

  const code = await runCli(["node", "main.ts", "index:setup"], {
    env,
    io: output,
    openIndex: () => {
      opened += 1;
      return fakeIndex();
    },
  });

  expect(code).toBe(1);
  expect(opened).toBe(0);
  expect(output.logs).toEqual([]);
  expect(output.errors.join("\n")).toContain("VAULT_PATH");
  expect(output.errors.join("\n")).not.toContain(searchKey);
});
