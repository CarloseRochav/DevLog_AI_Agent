import { expect, test } from "vitest";
import { parseIndexerEnv, parseServerEnv, toLoggableConfig } from "./index.js";

const openaiKey = "openai-secret-key";
const searchKey = "search-secret-key";
const storageSecret = "AccountKey=storage-secret-value";
const agentKey = "a".repeat(32);

const source = {
  AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
  AZURE_OPENAI_API_KEY: openaiKey,
  EMBEDDING_DIMENSIONS: "1536",
  AZURE_SEARCH_ENDPOINT: "https://example.search.windows.net",
  AZURE_SEARCH_API_KEY: searchKey,
  AZURE_STORAGE_CONNECTION_STRING: storageSecret,
  AGENT_API_KEY: agentKey,
  VAULT_PATH: "C:/notes",
};

test("server config masks secrets and keeps the other fields", () => {
  const config = parseServerEnv(source);
  const logged = toLoggableConfig(config);

  expect(logged.AZURE_OPENAI_API_KEY).toBe("***");
  expect(logged.AZURE_SEARCH_API_KEY).toBe("***");
  expect(logged.AZURE_STORAGE_CONNECTION_STRING).toBe("***");
  expect(logged.AGENT_API_KEY).toBe("***");
  expect(logged.AZURE_OPENAI_ENDPOINT).toBe(config.AZURE_OPENAI_ENDPOINT);
  expect(logged.AZURE_SEARCH_INDEX).toBe("devlog-chunks");
  expect(logged.PORT).toBe(3000);

  const text = JSON.stringify(logged);
  expect(text).not.toContain(openaiKey);
  expect(text).not.toContain(searchKey);
  expect(text).not.toContain(storageSecret);
  expect(text).not.toContain(agentKey);
  expect(config.AZURE_OPENAI_API_KEY).toBe(openaiKey);
});

test("indexer config masks secrets and keeps the vault path", () => {
  const config = parseIndexerEnv(source);
  const logged = toLoggableConfig(config);

  expect(logged.AZURE_OPENAI_API_KEY).toBe("***");
  expect(logged.AZURE_SEARCH_API_KEY).toBe("***");
  expect(logged.AZURE_STORAGE_CONNECTION_STRING).toBe("***");
  expect(logged.VAULT_PATH).toBe("C:/notes");

  const text = JSON.stringify(logged);
  expect(text).not.toContain(openaiKey);
  expect(text).not.toContain(searchKey);
  expect(text).not.toContain(storageSecret);
});
