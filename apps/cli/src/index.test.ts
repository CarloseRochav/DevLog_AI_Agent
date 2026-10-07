import { devlogChunksIndex, type DevlogIndexClient } from "@devlog/adapters";
import { IndexError, type IndexReport } from "@devlog/core";
import { expect, test } from "vitest";
import { packageName, runCli, type CliIO, type IndexFlags } from "./index.js";

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

function indexReport(overrides: Partial<IndexReport> = {}): IndexReport {
  return {
    notes: 2,
    changed: 0,
    unchanged: 2,
    deleted: 0,
    chunksUpserted: 0,
    dryRun: false,
    elapsedMs: 100,
    lines: [],
    summary:
      "2 notes · 0 changed · 2 unchanged · 0 deleted · 0 chunks upserted · 0.1 s",
    ...overrides,
  };
}

test("index runs changed notes and prints the summary", async () => {
  const output = io();
  let opened = 0;
  let seen: IndexFlags | undefined;

  const code = await runCli(["node", "main.ts", "index"], {
    env: indexerEnv(),
    io: output,
    openIndex: () => {
      opened += 1;
      return fakeIndex();
    },
    runIndex: async (_config, flags) => {
      seen = flags;
      return indexReport();
    },
  });

  expect(code).toBe(0);
  expect(opened).toBe(0);
  expect(seen).toEqual({ dryRun: false, full: false });
  expect(output.logs).toEqual([
    "2 notes · 0 changed · 2 unchanged · 0 deleted · 0 chunks upserted · 0.1 s",
  ]);
  expect(output.errors).toEqual([]);
  expect(output.logs.join("\n")).not.toContain(searchKey);
});

test("index accepts --dry-run and --full in either order", async () => {
  const cases: Array<{ args: string[]; flags: IndexFlags; line: string }> = [
    {
      args: ["--dry-run"],
      flags: { dryRun: true, full: false },
      line: "devlog-agent/Architecture.md\nThe queue worker retries failed batches.",
    },
    {
      args: ["--full"],
      flags: { dryRun: false, full: true },
      line: "",
    },
    {
      args: ["--dry-run", "--full"],
      flags: { dryRun: true, full: true },
      line: "delete devlog-agent/Old.md",
    },
    {
      args: ["--full", "--dry-run"],
      flags: { dryRun: true, full: true },
      line: "delete devlog-agent/Old.md",
    },
  ];

  for (const item of cases) {
    const output = io();
    let seen: IndexFlags | undefined;
    const code = await runCli(["node", "main.ts", "index", ...item.args], {
      env: indexerEnv(),
      io: output,
      runIndex: async (_config, flags) => {
        seen = flags;
        return indexReport({
          dryRun: flags.dryRun,
          lines: item.line === "" ? [] : [item.line],
          summary: flags.dryRun ? "dry-run · 1 chunks" : "1 chunks upserted",
        });
      },
    });

    expect(code).toBe(0);
    expect(seen).toEqual(item.flags);
    expect(output.logs.at(-1)).toBe(
      item.flags.dryRun ? "dry-run · 1 chunks" : "1 chunks upserted",
    );
    if (item.line !== "") {
      expect(output.logs[0]).toBe(item.line);
    }
  }
});

test("an unknown index flag prints usage and does not run the index", async () => {
  const output = io();
  let called = 0;

  const code = await runCli(["node", "main.ts", "index", "--bogus"], {
    env: indexerEnv(),
    io: output,
    runIndex: async () => {
      called += 1;
      return indexReport();
    },
  });

  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(output.logs).toEqual([]);
  expect(output.errors.join("\n")).toContain("index:setup");
  expect(output.errors.join("\n")).toContain("pnpm cli index");
});

test("an index stamp mismatch exits 1 and hides the search key", async () => {
  const output = io();
  const message =
    "Embedding dimensions are 1536 in the index and 3072 in config. Re-run with --full.";

  const code = await runCli(["node", "main.ts", "index"], {
    env: indexerEnv(),
    io: output,
    runIndex: async () => {
      throw new IndexError(message);
    },
  });

  expect(code).toBe(1);
  expect(output.logs).toEqual([]);
  expect(output.errors.join("\n")).toContain("--full");
  expect(output.errors.join("\n")).not.toContain(searchKey);
});

test("index rethrows errors that are not an index refusal", async () => {
  await expect(
    runCli(["node", "main.ts", "index"], {
      env: indexerEnv(),
      io: io(),
      runIndex: async () => {
        throw new Error("boom");
      },
    }),
  ).rejects.toThrow("boom");
});

test("index:setup does not run the indexer", async () => {
  const output = io();

  const code = await runCli(["node", "main.ts", "index:setup"], {
    env: indexerEnv(),
    io: output,
    openIndex: () => fakeIndex(),
    runIndex: async () => {
      throw new Error("should not index");
    },
  });

  expect(code).toBe(0);
  expect(output.logs).toEqual(["created index devlog-chunks"]);
});

test("index names a missing vault path and does not run", async () => {
  const output = io();
  const env = indexerEnv();
  delete env.VAULT_PATH;
  let called = 0;

  const code = await runCli(["node", "main.ts", "index"], {
    env,
    io: output,
    runIndex: async () => {
      called += 1;
      return indexReport();
    },
  });

  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(output.logs).toEqual([]);
  expect(output.errors.join("\n")).toContain("VAULT_PATH");
  expect(output.errors.join("\n")).not.toContain(searchKey);
});
