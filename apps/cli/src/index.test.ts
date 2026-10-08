import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { devlogChunksIndex, type DevlogIndexClient } from "@devlog/adapters";
import {
  IndexError,
  RetrievalError,
  type EvalReport,
  type IndexReport,
  type SearchHit,
} from "@devlog/core";
import { expect, test } from "vitest";
import {
  packageName,
  runCli,
  type CliIO,
  type EvalFlags,
  type EvalPaths,
  type IndexFlags,
  type QueryFlags,
} from "./index.js";

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

  const code = await runCli(["node", "main.ts", "serve"], {
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
  expect(output.errors.join("\n")).toContain("pnpm cli query");
  expect(output.errors.join("\n")).toContain("pnpm cli eval");
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

function searchHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    chunkId: "chunk-a",
    notePath: "devlog-agent/Architecture.md",
    noteTitle: "Architecture",
    headingPath: ["Background Processing", "Queue Worker"],
    content: "The queue worker retries failed batches.",
    score: 0.016,
    citation: "Architecture.md > Background Processing > Queue Worker",
    ...overrides,
  };
}

test("query prints citations, scores, and chunk text", async () => {
  const output = io();
  let opened = 0;
  let indexed = 0;

  const code = await runCli(["node", "main.ts", "query", "queue worker"], {
    env: indexerEnv(),
    io: output,
    openIndex: () => {
      opened += 1;
      return fakeIndex();
    },
    runIndex: async () => {
      indexed += 1;
      return indexReport();
    },
    runQuery: async () => [
      searchHit(),
      searchHit({
        chunkId: "chunk-d",
        notePath: "devlog-agent/Decisions.md",
        content: "Keep the notes in blob storage.",
        score: 1,
        citation: "Decisions.md > Storage",
      }),
    ],
  });

  expect(code).toBe(0);
  expect(opened).toBe(0);
  expect(indexed).toBe(0);
  expect(output.errors).toEqual([]);
  expect(output.logs).toEqual([
    "0.016  Architecture.md > Background Processing > Queue Worker",
    "The queue worker retries failed batches.",
    "",
    "1.000  Decisions.md > Storage",
    "Keep the notes in blob storage.",
  ]);
  expect(output.logs.join("\n")).not.toContain(searchKey);
});

test("query prints 0 hits when nothing matches", async () => {
  const output = io();

  const code = await runCli(["node", "main.ts", "query", "queue worker"], {
    env: indexerEnv(),
    io: output,
    runQuery: async () => [],
  });

  expect(code).toBe(0);
  expect(output.logs).toEqual(["0 hits"]);
});

test("query forwards --top, --tag, and --note in either order", async () => {
  const cases: Array<{ args: string[]; flags: QueryFlags }> = [
    {
      args: [
        "queue worker",
        "--top",
        "3",
        "--tag",
        "worker",
        "--note",
        "devlog-agent/Architecture.md",
      ],
      flags: {
        query: "queue worker",
        topK: 3,
        tags: ["worker"],
        notePath: "devlog-agent/Architecture.md",
      },
    },
    {
      args: [
        "--note",
        "devlog-agent/Architecture.md",
        "--tag",
        "worker",
        "--top",
        "3",
        "queue worker",
      ],
      flags: {
        query: "queue worker",
        topK: 3,
        tags: ["worker"],
        notePath: "devlog-agent/Architecture.md",
      },
    },
    {
      args: ["--tag", "a", "queue worker", "--tag", "b"],
      flags: {
        query: "queue worker",
        topK: 5,
        tags: ["a", "b"],
      },
    },
  ];

  for (const item of cases) {
    const output = io();
    let seen: QueryFlags | undefined;
    const code = await runCli(["node", "main.ts", "query", ...item.args], {
      env: indexerEnv(),
      io: output,
      runQuery: async (_config, flags) => {
        seen = flags;
        return [searchHit()];
      },
    });

    expect(code).toBe(0);
    expect(seen).toEqual(item.flags);
  }
});

test("an unknown query flag prints usage and does not search", async () => {
  const output = io();
  let called = 0;

  const code = await runCli(["node", "main.ts", "query", "--bogus"], {
    env: indexerEnv(),
    io: output,
    runQuery: async () => {
      called += 1;
      return [];
    },
  });

  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(output.logs).toEqual([]);
  expect(output.errors.join("\n")).toContain("pnpm cli query");
});

test("a missing query prints usage and does not search", async () => {
  const output = io();
  let called = 0;

  const code = await runCli(["node", "main.ts", "query"], {
    env: indexerEnv(),
    io: output,
    runQuery: async () => {
      called += 1;
      return [];
    },
  });

  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(output.errors.join("\n")).toContain("pnpm cli query");
});

test("a short query exits 1 and does not search", async () => {
  const output = io();
  let called = 0;

  const code = await runCli(["node", "main.ts", "query", "no"], {
    env: indexerEnv(),
    io: output,
    runQuery: async () => {
      called += 1;
      return [];
    },
  });

  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(output.logs).toEqual([]);
  expect(output.errors).toEqual(["Query must be at least 3 characters."]);
});

test("a retrieval error exits 1 and hides the search key", async () => {
  const output = io();

  const code = await runCli(["node", "main.ts", "query", "queue worker"], {
    env: indexerEnv(),
    io: output,
    runQuery: async () => {
      throw new RetrievalError("Invalid search query.");
    },
  });

  expect(code).toBe(1);
  expect(output.logs).toEqual([]);
  expect(output.errors).toEqual(["Invalid search query."]);
  expect(output.errors.join("\n")).not.toContain(searchKey);
});

test("query rethrows errors that are not a retrieval error", async () => {
  await expect(
    runCli(["node", "main.ts", "query", "queue worker"], {
      env: indexerEnv(),
      io: io(),
      runQuery: async () => {
        throw new Error("boom");
      },
    }),
  ).rejects.toThrow("boom");
});

test("query names a missing vault path and does not search", async () => {
  const output = io();
  const env = indexerEnv();
  delete env.VAULT_PATH;
  let called = 0;

  const code = await runCli(["node", "main.ts", "query", "queue worker"], {
    env,
    io: output,
    runQuery: async () => {
      called += 1;
      return [];
    },
  });

  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(output.logs).toEqual([]);
  expect(output.errors.join("\n")).toContain("VAULT_PATH");
  expect(output.errors.join("\n")).not.toContain(searchKey);
});

function evalReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    timestamp: "2026-10-07T00:00:00.000Z",
    threshold: 0,
    hitAt5: 1,
    mrr: 1,
    negativePrecision: 1,
    passed: true,
    lines: [
      "id  type  hit  rank  question",
      "q01  exact-name  yes  1  How does the worker retry failed batches?",
    ],
    summary:
      "hit@5 1.000 (1/1) · MRR 1.000 · negative precision 1.000 (1/1) · threshold 0",
    questions: [
      {
        id: "q01",
        type: "exact-name",
        question: "How does the worker retry failed batches?",
        hit: true,
        rank: 1,
        hits: [
          {
            notePath: "devlog-agent/Architecture.md",
            headingPath: ["Queue Worker"],
            score: 0.02,
            citation: "Architecture.md > Queue Worker",
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function evalDir(): Promise<{ dir: string; paths: EvalPaths }> {
  const dir = await mkdtemp(path.join(tmpdir(), "devlog-eval-"));
  return {
    dir,
    paths: {
      vaultDir: dir,
      goldenPath: path.join(dir, "golden.jsonl"),
      resultsDir: dir,
      now: "2026-10-07T00:00:00.000Z",
    },
  };
}

test("eval prints the table and writes the report", async () => {
  const output = io();
  const { dir, paths } = await evalDir();
  let seen: EvalFlags | undefined;
  const report = evalReport();

  try {
    const code = await runCli(["node", "main.ts", "eval", "--threshold", "0"], {
      env: indexerEnv(),
      io: output,
      evalPaths: paths,
      runEval: async (_config, flags) => {
        seen = flags;
        return report;
      },
    });
    const written = JSON.parse(
      await readFile(path.join(dir, "2026-10-07T00-00-00.000Z.json"), "utf8"),
    ) as {
      hitAt5: number;
      questions: EvalReport["questions"];
    };

    expect(code).toBe(0);
    expect(seen).toEqual({ threshold: 0 });
    expect(output.logs).toEqual([...report.lines, report.summary]);
    expect(output.errors).toEqual([]);
    expect(output.logs.join("\n")).not.toContain(searchKey);
    expect(written.hitAt5).toBe(1);
    expect(written.questions).toEqual(report.questions);
    expect(written).not.toHaveProperty("lines");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eval exits 1 when the targets are missed and still writes the report", async () => {
  const output = io();
  const { dir, paths } = await evalDir();

  try {
    const code = await runCli(["node", "main.ts", "eval"], {
      env: indexerEnv(),
      io: output,
      evalPaths: paths,
      runEval: async () => evalReport({ passed: false, hitAt5: 0.5 }),
    });

    expect(code).toBe(1);
    expect(output.logs.at(-1)).toBe(
      "hit@5 1.000 (1/1) · MRR 1.000 · negative precision 1.000 (1/1) · threshold 0",
    );
    const written = JSON.parse(
      await readFile(path.join(dir, "2026-10-07T00-00-00.000Z.json"), "utf8"),
    ) as { passed: boolean };
    expect(written.passed).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown eval flag prints usage and does not evaluate", async () => {
  const output = io();
  let called = 0;

  const code = await runCli(["node", "main.ts", "eval", "--bogus"], {
    env: indexerEnv(),
    io: output,
    runEval: async () => {
      called += 1;
      return evalReport();
    },
  });

  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(output.logs).toEqual([]);
  expect(output.errors.join("\n")).toContain("pnpm cli eval");
});

test("eval names a missing vault path and does not evaluate", async () => {
  const output = io();
  const env = indexerEnv();
  delete env.VAULT_PATH;
  let called = 0;

  const code = await runCli(["node", "main.ts", "eval"], {
    env,
    io: output,
    runEval: async () => {
      called += 1;
      return evalReport();
    },
  });

  expect(code).toBe(1);
  expect(called).toBe(0);
  expect(output.errors.join("\n")).toContain("VAULT_PATH");
  expect(output.errors.join("\n")).not.toContain(searchKey);
});

test("eval rethrows errors that are not an eval failure", async () => {
  await expect(
    runCli(["node", "main.ts", "eval"], {
      env: indexerEnv(),
      io: io(),
      runEval: async () => {
        throw new Error("boom");
      },
    }),
  ).rejects.toThrow("boom");
});
