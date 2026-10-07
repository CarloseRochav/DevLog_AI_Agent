import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const eslint = new ESLint({ cwd: root });

async function lint(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  if (result === undefined) {
    throw new Error(`ESLint returned no result for ${filePath}`);
  }
  return result;
}

function restricted(result: {
  messages: { ruleId: string | null }[];
}): boolean {
  return result.messages.some((message) =>
    message.ruleId?.includes("no-restricted-imports"),
  );
}

test("blocks @azure imports in core", async () => {
  const result = await lint(
    "packages/core/src/forbidden-azure.ts",
    'import client from "@azure/search-documents";\nexport const value = client;\n',
  );

  expect(result.errorCount).toBeGreaterThan(0);
  expect(restricted(result)).toBe(true);
});

test("blocks langchain imports in core", async () => {
  const result = await lint(
    "packages/core/src/forbidden-langchain.ts",
    'import { createAgent } from "langchain";\nexport const agent = createAgent;\n',
  );

  expect(result.errorCount).toBeGreaterThan(0);
  expect(restricted(result)).toBe(true);
});

test("blocks @langchain imports in core", async () => {
  const result = await lint(
    "packages/core/src/forbidden-langchain-openai.ts",
    'import { AzureChatOpenAI } from "@langchain/openai";\nexport const model = AzureChatOpenAI;\n',
  );

  expect(result.errorCount).toBeGreaterThan(0);
  expect(restricted(result)).toBe(true);
});

test("blocks type-only Azure imports in core", async () => {
  const result = await lint(
    "packages/core/src/forbidden-azure-type.ts",
    'import type { SearchClient } from "@azure/search-documents";\nexport type Client = SearchClient;\n',
  );

  expect(result.errorCount).toBeGreaterThan(0);
  expect(restricted(result)).toBe(true);
});

test("allows Azure imports outside core", async () => {
  const result = await lint(
    "packages/adapters/src/search.ts",
    'import client from "@azure/search-documents";\nexport const value = client;\n',
  );

  expect(restricted(result)).toBe(false);
  expect(result.errorCount).toBe(0);
});

test("allows relative imports in core", async () => {
  const result = await lint(
    "packages/core/src/clean.ts",
    'export { Embedder } from "./ports.js";\n',
  );

  expect(restricted(result)).toBe(false);
  expect(result.errorCount).toBe(0);
});
