import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import {
  IndexerEnv,
  ServerEnv,
  loadIndexerEnv,
  loadServerEnv,
  parseIndexerEnv,
  parseServerEnv,
} from "./index.js";

const openaiKey = "openai-secret-key";
const searchKey = "search-secret-key";
const storageSecret = "AccountKey=storage-secret-value";
const agentKey = "a".repeat(32);

function serverSource(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  return {
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
    AZURE_OPENAI_API_KEY: openaiKey,
    EMBEDDING_DIMENSIONS: "1536",
    AZURE_SEARCH_ENDPOINT: "https://example.search.windows.net",
    AZURE_SEARCH_API_KEY: searchKey,
    AZURE_STORAGE_CONNECTION_STRING: storageSecret,
    AGENT_API_KEY: agentKey,
    ...overrides,
  };
}

function without(
  source: Record<string, string>,
  ...keys: string[]
): Record<string, string> {
  const copy = { ...source };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
}

function captureExit(run: () => void): { code: number; stderr: string } {
  const lines: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    lines.push(args.map(String).join(" "));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${String(code)}`);
  });

  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const match = /^exit:(\d+)$/.exec(message);
    if (match?.[1] === undefined) {
      throw error;
    }
    return { code: Number(match[1]), stderr: lines.join("\n") };
  } finally {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }

  throw new Error("load returned instead of exiting");
}

test("a missing key exits and names it", () => {
  const result = captureExit(() => {
    loadServerEnv(without(serverSource(), "AZURE_OPENAI_API_KEY"));
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("AZURE_OPENAI_API_KEY");
});

test("every invalid variable is listed", () => {
  const result = captureExit(() => {
    loadServerEnv(
      without(serverSource(), "AZURE_OPENAI_ENDPOINT", "AZURE_SEARCH_API_KEY"),
    );
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("AZURE_OPENAI_ENDPOINT");
  expect(result.stderr).toContain("AZURE_SEARCH_API_KEY");
});

test("validation errors do not echo secret values", () => {
  const secret = "short-agent-secret";
  const result = captureExit(() => {
    loadServerEnv(serverSource({ AGENT_API_KEY: secret }));
  });

  expect(result.stderr).toContain("AGENT_API_KEY");
  expect(result.stderr).not.toContain(secret);
});

test("the server does not require VAULT_PATH", () => {
  const config = parseServerEnv({
    ...serverSource(),
    VAULT_PATH: "C:/vault",
  });

  expect(config.PORT).toBe(3000);
  expect(config.NODE_ENV).toBe("development");
  expect(config.EMBEDDING_DIMENSIONS).toBe(1536);
  expect(config.CHAT_TEMPERATURE).toBe(0.2);
  expect("VAULT_PATH" in config).toBe(false);
});

test("the indexer requires VAULT_PATH", () => {
  const result = captureExit(() => {
    loadIndexerEnv(serverSource());
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("VAULT_PATH");

  const config = parseIndexerEnv(serverSource({ VAULT_PATH: "C:/notes" }));
  expect(config.VAULT_PATH).toBe("C:/notes");
  expect(config.VAULT_INCLUDE).toBe("devlog-agent/**/*.md");
  expect(config.CHUNK_MAX_TOKENS).toBe(700);
  expect(config.CHUNK_OVERLAP_TOKENS).toBe(80);
  expect(config.AZURE_SEARCH_INDEX).toBe("devlog-chunks");
});

test(".env.example lists every variable", () => {
  const examplePath = new URL("../../../.env.example", import.meta.url);
  const example = readFileSync(examplePath, "utf8");
  const exampleKeys = example
    .split(/\r?\n/)
    .map((line) => /^(?:export\s+)?([A-Z0-9_]+)=/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);

  const schemaKeys = [
    ...Object.keys(ServerEnv.shape),
    ...Object.keys(IndexerEnv.shape),
  ];

  expect([...new Set(exampleKeys)].sort()).toEqual(
    [...new Set(schemaKeys)].sort(),
  );
});
