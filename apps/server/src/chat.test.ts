import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@devlog/config";
import {
  InMemoryNoteStore,
  InMemorySearchIndex,
  type IndexedChunk,
} from "@devlog/core";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { createDevlogAgent } from "@devlog/agent";
import { fakeModel } from "langchain";
import { expect, test } from "vitest";
import { createChatSession, type ChatSession } from "./chat.js";
import { startServer } from "./index.js";

const apiKey = "k".repeat(32);
const conversationA = "11111111-1111-4111-8111-111111111111";
const conversationB = "22222222-2222-4222-8222-222222222222";
const chatScript = fileURLToPath(
  new URL("../../../scripts/chat.ps1", import.meta.url),
);

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
    AGENT_API_KEY: apiKey,
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

function collect(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    log(line) {
      lines.push(line);
    },
  };
}

function requestLogs(lines: string[]): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as unknown)
    .flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "msg" in entry &&
        entry.msg === "request"
      ) {
        return [entry as Record<string, unknown>];
      }
      return [];
    });
}

function parseSse(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }
      return { event, data: JSON.parse(dataLines.join("\n")) as unknown };
    });
}

function tokenChunk(text: string, id: string): unknown {
  return ["messages", [new AIMessageChunk({ content: text, id }), {}]];
}

async function stop(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

async function withChat(
  chat: ChatSession | undefined,
  run: (baseUrl: string, lines: string[]) => Promise<void>,
): Promise<void> {
  const output = collect();
  const running = await startServer({
    apiKey,
    indexExists: async () => true,
    log: output.log,
    port: 0,
    host: "127.0.0.1",
    ...(chat === undefined ? {} : { chat }),
  });
  try {
    await run(`http://127.0.0.1:${running.port}`, output.lines);
  } finally {
    await stop(running.server);
  }
}

function postChat(
  baseUrl: string,
  body: unknown,
  key: string | null = apiKey,
): Promise<Response> {
  return fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(key === null ? {} : { "x-api-key": key }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function openPost(baseUrl: string, body: unknown): Promise<IncomingMessage> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL("/chat", baseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-api-key": apiKey,
          "content-length": Buffer.byteLength(payload),
        },
      },
      (incoming) => {
        resolve(incoming);
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function readChunk(stream: Readable, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for a streamed token"));
    }, ms);
    const onData = (chunk: string | Buffer): void => {
      cleanup();
      resolve(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    const onEnd = (): void => {
      cleanup();
      resolve("");
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

async function readRest(stream: Readable): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) {
    parts.push(typeof chunk === "string" ? chunk : String(chunk));
  }
  return parts.join("");
}

function runChatScript(
  baseUrl: string,
  message: string,
  conversationId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        chatScript,
        "-Message",
        message,
        "-BaseUrl",
        baseUrl,
        "-ConversationId",
        conversationId,
      ],
      { env: { ...process.env, AGENT_API_KEY: apiKey } },
    );
    const timer = setTimeout(() => {
      child.kill();
    }, 8_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`chat.ps1 exited ${code}: ${stderr}\n${stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

test("POST /chat streams section 8.5 events and logs the turn", async () => {
  const index = new InMemorySearchIndex();
  await index.upsert([chunk()]);
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
  const chat = createChatSession(
    createDevlogAgent(
      config(),
      { index, notes: new InMemoryNoteStore() },
      { model },
    ),
  );

  await withChat(chat, async (baseUrl, lines) => {
    const response = await postChat(baseUrl, {
      conversationId: conversationA,
      message: "Where is sp_ProcessBatch called?",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).not.toContain("You are DevLog Agent");
    expect(body).not.toContain(apiKey);

    const events = parseSse(body);
    expect(events.map((event) => event.event)).toEqual([
      "tool_start",
      "tool_end",
      "token",
      "sources",
      "done",
    ]);
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
    expect(events[3]).toMatchObject({
      event: "sources",
      data: {
        citations: [
          expect.objectContaining({
            citation: "Queue Worker > Procedure Call",
          }),
        ],
      },
    });
    expect(events[4]).toMatchObject({
      event: "done",
      data: { usage: { inputTokens: 11, outputTokens: 7 } },
    });

    expect(requestLogs(lines)).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/chat",
        status: 200,
        toolCalls: [
          {
            tool: "search_architecture_docs",
            input: { query: "queue worker" },
          },
        ],
        usage: { inputTokens: 11, outputTokens: 7 },
      }),
    ]);
    expect(lines.join("\n")).not.toContain(apiKey);
  });
});

test("a second message sees the first until DELETE resets it", async () => {
  const model = fakeModel()
    .respond(new AIMessage("answer-alpha"))
    .respond(new AIMessage("answer-beta"))
    .respond(new AIMessage("answer-gamma"));
  const chat = createChatSession(
    createDevlogAgent(
      config(),
      { index: new InMemorySearchIndex(), notes: new InMemoryNoteStore() },
      { model },
    ),
  );

  await withChat(chat, async (baseUrl) => {
    const first = await postChat(baseUrl, {
      conversationId: conversationB,
      message: "alpha-phrase-z9",
    });
    expect(parseSse(await first.text()).map((event) => event.event)).toContain(
      "token",
    );

    const second = await postChat(baseUrl, {
      conversationId: conversationB,
      message: "beta-phrase-z9",
    });
    const secondEvents = parseSse(await second.text());
    expect(secondEvents).toContainEqual({
      event: "token",
      data: { text: "answer-beta" },
    });
    const secondCall = model.calls[1]?.messages
      .map((message) => message.text)
      .join("\n");
    expect(secondCall).toContain("alpha-phrase-z9");
    expect(secondCall).toContain("answer-alpha");

    const reset = await fetch(`${baseUrl}/chat/${conversationB}`, {
      method: "DELETE",
      headers: { "x-api-key": apiKey },
    });
    expect(reset.status).toBe(204);
    expect(await reset.text()).toBe("");

    const third = await postChat(baseUrl, {
      conversationId: conversationB,
      message: "gamma-phrase-z9",
    });
    expect(parseSse(await third.text())).toContainEqual({
      event: "token",
      data: { text: "answer-gamma" },
    });
    const thirdCall = model.calls[2]?.messages
      .map((message) => message.text)
      .join("\n");
    expect(thirdCall).toContain("gamma-phrase-z9");
    expect(thirdCall).not.toContain("alpha-phrase-z9");
    expect(thirdCall).not.toContain("answer-alpha");

    const again = await fetch(`${baseUrl}/chat/${conversationB}`, {
      method: "DELETE",
      headers: { "x-api-key": apiKey },
    });
    expect(again.status).toBe(204);
  });
});

test("tokens are written before the rest of the turn", async () => {
  let releaseGate = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    releaseGate();
  };
  const chat: ChatSession = {
    agent: {
      async stream() {
        return (async function* () {
          yield tokenChunk("Hello", "stream");
          await gate;
          yield tokenChunk(" world", "stream");
        })();
      },
    },
  };

  await withChat(chat, async (baseUrl) => {
    const incoming = await openPost(baseUrl, {
      conversationId: conversationA,
      message: "hello",
    });
    try {
      expect(incoming.statusCode).toBe(200);
      incoming.setEncoding("utf8");
      let text = "";
      const deadline = Date.now() + 3_000;
      while (!text.includes("Hello")) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for the first token: ${text}`);
        }
        text += await readChunk(incoming, 3_000);
      }
      expect(text).toContain("event: token");
      expect(text).not.toContain("world");
      release();
      text += await readRest(incoming);
      expect(text).toContain("world");
      expect(text).toContain("event: done");
    } finally {
      release();
      incoming.destroy();
    }
  });
}, 8_000);

test("scripts/chat.ps1 prints the event stream", async () => {
  const chat: ChatSession = {
    agent: {
      async stream() {
        return (async function* () {
          yield tokenChunk("Hello from curl", "curl");
        })();
      },
    },
  };

  await withChat(chat, async (baseUrl) => {
    const stdout = await runChatScript(baseUrl, "hello", conversationA);
    expect(stdout).toContain("event: token");
    expect(stdout).toContain("Hello from curl");
    expect(stdout).toContain("event: done");
  });
});

test("a failed turn streams an error event", async () => {
  const chat: ChatSession = {
    agent: {
      async stream() {
        return (async function* () {
          yield tokenChunk("Partial", "p");
          throw new Error("model down");
        })();
      },
    },
  };

  await withChat(chat, async (baseUrl) => {
    const response = await postChat(baseUrl, {
      conversationId: conversationA,
      message: "hello",
    });
    expect(response.status).toBe(200);
    expect(parseSse(await response.text())).toEqual([
      { event: "token", data: { text: "Partial" } },
      { event: "error", data: { code: "agent_error", message: "model down" } },
    ]);
  });
});

test("invalid chat requests are rejected before the stream starts", async () => {
  const chat: ChatSession = {
    agent: {
      async stream() {
        throw new Error("the agent should not run");
      },
    },
  };

  await withChat(chat, async (baseUrl, lines) => {
    const missing = await postChat(baseUrl, {});
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as {
      error: { code: string; message: string };
    };
    expect(missingBody.error.code).toBe("invalid_request");
    expect(missingBody.error.message).toContain("conversationId");

    const empty = await postChat(baseUrl, {
      conversationId: conversationA,
      message: "",
    });
    expect(empty.status).toBe(400);

    const tooLong = await postChat(baseUrl, {
      conversationId: conversationA,
      message: "m".repeat(4001),
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const marker = "leak-marker-z9";
    const broken = await postChat(baseUrl, `{"${marker}":`);
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must be JSON.",
      },
    });
    expect(lines.join("\n")).not.toContain(marker);

    const badDelete = await fetch(`${baseUrl}/chat/not-a-uuid`, {
      method: "DELETE",
      headers: { "x-api-key": apiKey },
    });
    expect(badDelete.status).toBe(400);
    expect(await badDelete.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });
});

test("a body over 32kb is rejected and not logged", async () => {
  const chat: ChatSession = {
    agent: {
      async stream() {
        throw new Error("the agent should not run");
      },
    },
  };
  const marker = "PAYLOADMARKER";

  await withChat(chat, async (baseUrl, lines) => {
    const response = await postChat(baseUrl, {
      conversationId: conversationA,
      message: marker.repeat(3_000),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "Request body is too large.",
      },
    });
    expect(lines.join("\n")).not.toContain(marker);
  });
});

test("chat routes require the API key and stay absent until mounted", async () => {
  await withChat(undefined, async (baseUrl) => {
    const response = await postChat(
      baseUrl,
      { conversationId: conversationA, message: "hello" },
      apiKey,
    );
    expect(response.status).toBe(404);
  });

  const chat: ChatSession = {
    agent: {
      async stream() {
        return (async function* () {})();
      },
    },
  };
  await withChat(chat, async (baseUrl) => {
    const missing = await postChat(
      baseUrl,
      { conversationId: conversationA, message: "hello" },
      null,
    );
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/chat/${conversationB}`, {
      method: "DELETE",
      headers: { "x-api-key": "n".repeat(32) },
    });
    expect(wrong.status).toBe(401);

    const get = await fetch(`${baseUrl}/chat`, {
      headers: { "x-api-key": apiKey },
    });
    expect(get.status).toBe(404);
  });
});

test("DELETE reports a server error when history cannot be reset", async () => {
  const chat: ChatSession = {
    agent: {
      async stream() {
        return (async function* () {})();
      },
    },
  };

  await withChat(chat, async (baseUrl, lines) => {
    const response = await fetch(`${baseUrl}/chat/${conversationA}`, {
      method: "DELETE",
      headers: { "x-api-key": apiKey },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal", message: "Internal server error" },
    });
    expect(lines.join("\n")).toContain("Chat history cannot be reset");
    expect(lines.join("\n")).not.toContain(apiKey);
  });
});
