import type { ServerConfig } from "@devlog/config";
import {
  InMemoryNoteStore,
  InMemorySearchIndex,
  type IndexedChunk,
} from "@devlog/core";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { fakeModel } from "langchain";
import { expect, test } from "vitest";
import { createChatModel, createDevlogAgent } from "./create-devlog-agent.js";
import { SYSTEM_PROMPT } from "./prompt.js";

function config(): ServerConfig {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    AZURE_OPENAI_ENDPOINT: "https://example.services.ai.azure.com/",
    AZURE_OPENAI_API_KEY: "test-key",
    AZURE_OPENAI_API_VERSION: "v1",
    AZURE_OPENAI_CHAT_DEPLOYMENT: "grok-4.6",
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "text-embedding-3-small",
    EMBEDDING_DIMENSIONS: 1536,
    CHAT_TEMPERATURE: 0.2,
    AZURE_SEARCH_ENDPOINT: "https://search.example.net",
    AZURE_SEARCH_API_KEY: "search-key",
    AZURE_SEARCH_INDEX: "devlog-chunks",
    AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
    AZURE_STORAGE_CONTAINER: "devlog-notes",
    PORT: 3000,
    AGENT_API_KEY: "k".repeat(32),
    CORS_ORIGIN: "http://localhost",
    HISTORY_MAX_MESSAGES: 20,
  };
}

function chunk(): IndexedChunk {
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
  };
}

function textOf(message: BaseMessage): string {
  return message.text;
}

test("createChatModel targets the Foundry v1 chat route", () => {
  const model = createChatModel(config());

  expect(model.model).toBe("grok-4.6");
  expect(model.temperature).toBe(0.2);
  expect(model.useResponsesApi).toBe(false);
  expect(model.clientConfig.baseURL).toBe(
    "https://example.services.ai.azure.com/openai/v1",
  );
  expect(model.clientConfig.defaultHeaders).toMatchObject({
    "api-key": "test-key",
  });
});

test("createDevlogAgent runs search_architecture_docs and read_note", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([chunk()]);
  const notes = new InMemoryNoteStore();
  const markdown = "# Queue Worker\n\nThe worker calls sp_ProcessBatch.\n";
  await notes.put("devlog-agent/Queue Worker.md", markdown);
  const model = fakeModel()
    .respondWithTools([
      {
        name: "search_architecture_docs",
        args: { query: "queue worker" },
        id: "call-search",
      },
    ])
    .respondWithTools([
      {
        name: "read_note",
        args: { notePath: "devlog-agent/Queue Worker.md" },
        id: "call-read",
      },
    ])
    .respond(
      new AIMessage(
        "The worker calls sp_ProcessBatch. [Queue Worker.md > Procedure Call]",
      ),
    );
  const boundToolNames = new Set<string>();
  const bindTools = model.bindTools.bind(model);
  model.bindTools = (tools) => {
    for (const entry of tools) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        typeof entry.name === "string"
      ) {
        boundToolNames.add(entry.name);
      }
    }
    return bindTools(tools);
  };
  const agent = createDevlogAgent(config(), { index, notes }, { model });

  const result = await agent.invoke(
    {
      messages: [{ role: "user", content: "Where is sp_ProcessBatch called?" }],
    },
    { configurable: { thread_id: "t2.2-wiring" } },
  );

  const toolText = result.messages
    .filter((message) => message.getType() === "tool")
    .map(textOf)
    .join("\n");
  const promptText = model.calls
    .flatMap((call) => call.messages)
    .map(textOf)
    .join("\n");

  expect(SYSTEM_PROMPT).toContain("The notes don't cover this.");
  expect(promptText).toContain(SYSTEM_PROMPT);
  expect(toolText).toContain("devlog-agent/Queue Worker.md");
  expect(toolText).toContain("The worker calls sp_ProcessBatch.");
  expect(boundToolNames).toEqual(
    new Set(["search_architecture_docs", "read_note", "list_notes"]),
  );
});

test("createDevlogAgent answers after a blocked tool batch", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([chunk()]);
  const notes = new InMemoryNoteStore();
  const searchCall = (id: string) => ({
    name: "search_architecture_docs",
    args: { query: "queue worker" },
    id,
  });
  const model = fakeModel()
    .respondWithTools(
      Array.from({ length: 6 }, (_, index) => searchCall(`call-${index}`)),
    )
    .respondWithTools([searchCall("call-blocked")])
    .respond(new AIMessage("The notes don't cover this."));
  const agent = createDevlogAgent(config(), { index, notes }, { model });

  const result = await agent.invoke(
    { messages: [{ role: "user", content: "What is the payroll cluster?" }] },
    { configurable: { thread_id: "t2.2-tool-limit" } },
  );

  const answers = result.messages.filter(
    (message) =>
      AIMessage.isInstance(message) && (message.tool_calls ?? []).length === 0,
  );
  expect(textOf(answers.at(-1) ?? result.messages[0]!)).toBe(
    "The notes don't cover this.",
  );
  expect(model.callCount).toBe(3);
});
