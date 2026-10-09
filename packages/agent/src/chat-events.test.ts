import type { ServerConfig } from "@devlog/config";
import {
  InMemoryNoteStore,
  InMemorySearchIndex,
  type IndexedChunk,
} from "@devlog/core";
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
} from "@langchain/core/messages";
import { fakeModel } from "langchain";
import { expect, test } from "vitest";
import {
  iterateChatEvents,
  resetConversation,
  toChatStreamAgent,
  type ChatEvent,
  type ChatStreamAgent,
} from "./chat-events.js";
import { createDevlogAgent } from "./create-devlog-agent.js";

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

async function collect(
  agent: ChatStreamAgent,
  message: string,
  conversationId = "11111111-1111-4111-8111-111111111111",
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of iterateChatEvents(agent, {
    conversationId,
    message,
  })) {
    events.push(event);
  }
  return events;
}

function scripted(chunks: unknown[]): ChatStreamAgent {
  return {
    async stream() {
      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    },
  };
}

test("a search turn emits tools, tokens, sources, and done", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([chunk()]);
  const notes = new InMemoryNoteStore();
  const model = fakeModel()
    .respondWithTools([
      {
        name: "search_architecture_docs",
        args: { query: "queue worker" },
        id: "call-search",
      },
    ])
    .respond(
      new AIMessage({
        content:
          "The worker calls sp_ProcessBatch. [Queue Worker > Procedure Call]",
        usage_metadata: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      }),
    );
  const agent = toChatStreamAgent(
    createDevlogAgent(config(), { index, notes }, { model }),
  );

  const events = await collect(agent, "Where is sp_ProcessBatch called?");
  const names = events.map((event) => event.event);

  expect(names).toEqual(["tool_start", "tool_end", "token", "sources", "done"]);
  expect(events[0]).toEqual({
    event: "tool_start",
    data: {
      tool: "search_architecture_docs",
      input: { query: "queue worker" },
    },
  });
  expect(events[1]).toEqual({
    event: "tool_end",
    data: { tool: "search_architecture_docs", hitCount: 1 },
  });
  expect(events[2]).toMatchObject({
    event: "token",
    data: {
      text: "The worker calls sp_ProcessBatch. [Queue Worker > Procedure Call]",
    },
  });
  expect(JSON.stringify(events)).not.toContain("You are DevLog Agent");
  expect(events[3]).toMatchObject({
    event: "sources",
    data: {
      citations: [
        expect.objectContaining({
          citation: "Queue Worker > Procedure Call",
          notePath: "devlog-agent/Queue Worker.md",
        }),
      ],
    },
  });
  expect(events[4]).toMatchObject({
    event: "done",
    data: { usage: { inputTokens: 11, outputTokens: 7 } },
  });
});

test("token chunks stay separate and tool results report hit counts", async () => {
  const agent = scripted([
    [
      "messages",
      [
        new AIMessageChunk({
          content: "Hel",
          id: "answer",
        }),
        {},
      ],
    ],
    ["updates", { model_request: { messages: [] } }],
    [
      "messages",
      [
        new AIMessageChunk({
          content: "lo",
          id: "answer",
          usage_metadata: {
            input_tokens: 4,
            output_tokens: 2,
            total_tokens: 6,
          },
        }),
        {},
      ],
    ],
    [
      "messages",
      [
        new ToolMessage({
          content: JSON.stringify([{ notePath: "a.md" }, { notePath: "b.md" }]),
          name: "list_notes",
          tool_call_id: "call-list",
        }),
        {},
      ],
    ],
    [
      "messages",
      [
        new ToolMessage({
          content: JSON.stringify({ error: "Note not found: missing.md" }),
          name: "read_note",
          tool_call_id: "call-read",
        }),
        {},
      ],
    ],
  ]);

  const events = await collect(agent, "hello");

  expect(events.filter((event) => event.event === "token")).toEqual([
    { event: "token", data: { text: "Hel", messageId: "answer" } },
    { event: "token", data: { text: "lo", messageId: "answer" } },
  ]);
  expect(events).toContainEqual({
    event: "tool_end",
    data: { tool: "list_notes", hitCount: 2 },
  });
  expect(events).toContainEqual({
    event: "tool_end",
    data: { tool: "read_note", hitCount: 0 },
  });
  expect(events.at(-1)).toMatchObject({
    event: "done",
    data: { usage: { inputTokens: 4, outputTokens: 2 } },
  });
});

test("a second message sees the first until the conversation is reset", async () => {
  const index = new InMemorySearchIndex();
  const notes = new InMemoryNoteStore();
  const model = fakeModel()
    .respond(new AIMessage("answer-alpha"))
    .respond(new AIMessage("answer-beta"))
    .respond(new AIMessage("answer-gamma"));
  const agent = toChatStreamAgent(
    createDevlogAgent(config(), { index, notes }, { model }),
  );
  const conversationId = "22222222-2222-4222-8222-222222222222";

  await collect(agent, "alpha-phrase-z9", conversationId);
  await collect(agent, "beta-phrase-z9", conversationId);

  const secondCall = model.calls[1]?.messages
    .map((message) => message.text)
    .join("\n");
  expect(secondCall).toContain("alpha-phrase-z9");
  expect(secondCall).toContain("answer-alpha");

  await resetConversation(agent, conversationId);
  await collect(agent, "gamma-phrase-z9", conversationId);

  const thirdCall = model.calls[2]?.messages
    .map((message) => message.text)
    .join("\n");
  expect(thirdCall).toContain("gamma-phrase-z9");
  expect(thirdCall).not.toContain("alpha-phrase-z9");
  expect(thirdCall).not.toContain("answer-alpha");
});

test("a failed run emits an error event", async () => {
  const agent: ChatStreamAgent = {
    async stream() {
      return (async function* () {
        yield [
          "messages",
          [new AIMessageChunk({ content: "Partial", id: "p" }), {}],
        ];
        throw new Error("model down");
      })();
    },
  };

  const events = await collect(agent, "hello");

  expect(events).toEqual([
    { event: "token", data: { text: "Partial", messageId: "p" } },
    { event: "error", data: { code: "agent_error", message: "model down" } },
  ]);
});

test("pre-tool text is discarded when that message becomes a tool call", async () => {
  const agent = scripted([
    [
      "messages",
      [
        new AIMessageChunk({
          content: "Let me search...",
          id: "call-msg",
        }),
        {},
      ],
    ],
    [
      "messages",
      [
        new AIMessageChunk({
          content: "still talking",
          id: "call-msg",
          tool_call_chunks: [
            {
              id: "call-1",
              name: "search_architecture_docs",
              args: '{"query":"queue"}',
              index: 0,
            },
          ],
        }),
        {},
      ],
    ],
    [
      "messages",
      [
        new AIMessageChunk({
          content: "The worker calls sp_ProcessBatch.",
          id: "answer",
        }),
        {},
      ],
    ],
  ]);

  const events = await collect(agent, "hello");
  const discarded = new Set(
    events.flatMap((event) =>
      event.event === "discard" ? [event.data.messageId] : [],
    ),
  );
  const joined = events
    .flatMap((event) =>
      event.event === "token" && !discarded.has(event.data.messageId)
        ? [event.data.text]
        : [],
    )
    .join("");

  expect(events).toContainEqual({
    event: "token",
    data: { text: "Let me search...", messageId: "call-msg" },
  });
  expect(events).toContainEqual({
    event: "discard",
    data: { messageId: "call-msg" },
  });
  expect(events.filter((event) => event.event === "discard")).toHaveLength(1);
  expect(events).not.toContainEqual({
    event: "token",
    data: { text: "still talking", messageId: "call-msg" },
  });
  expect(joined).not.toContain("Let me search");
  expect(joined).toBe("The worker calls sp_ProcessBatch.");
  const discardAt = events.findIndex((event) => event.event === "discard");
  const toolAt = events.findIndex((event) => event.event === "tool_start");
  expect(discardAt).toBeGreaterThanOrEqual(0);
  expect(toolAt).toBeGreaterThan(discardAt);
});

test("a tool call that arrives with its text emits no token and no discard", async () => {
  const agent = scripted([
    [
      "messages",
      [
        new AIMessageChunk({
          content: "Let me search...",
          id: "call-msg",
          tool_calls: [
            {
              id: "call-1",
              name: "search_architecture_docs",
              args: { query: "queue" },
            },
          ],
        }),
        {},
      ],
    ],
  ]);

  const events = await collect(agent, "hello");

  expect(events.filter((event) => event.event === "token")).toEqual([]);
  expect(events.filter((event) => event.event === "discard")).toEqual([]);
  expect(events).toContainEqual({
    event: "tool_start",
    data: {
      tool: "search_architecture_docs",
      input: { query: "queue" },
    },
  });
});

test("an aborted run emits no error event", async () => {
  const abort = new AbortController();
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const agent: ChatStreamAgent = {
    async stream() {
      return (async function* () {
        yield [
          "messages",
          [new AIMessageChunk({ content: "Partial", id: "p" }), {}],
        ];
        abort.abort();
        throw new Error("The operation was aborted");
      })();
    },
  };

  const events: ChatEvent[] = [];
  for await (const event of iterateChatEvents(
    agent,
    {
      conversationId: "33333333-3333-4333-8333-333333333333",
      message: "hello",
    },
    {
      signal: abort.signal,
      onUsage(value) {
        usage = value;
      },
    },
  )) {
    events.push(event);
  }

  expect(events).toEqual([
    { event: "token", data: { text: "Partial", messageId: "p" } },
  ]);
  expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 });
});
