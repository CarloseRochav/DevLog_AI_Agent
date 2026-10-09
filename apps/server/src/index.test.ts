import type { Server } from "node:http";
import express, { type Response } from "express";
import { expect, test } from "vitest";
import {
  addTokenUsage,
  finalizeServer,
  indexExists,
  listen,
  mountServer,
  packageName,
  recordToolCall,
  startServer,
  type IndexLookup,
} from "./index.js";
import {
  beginObservation,
  readObservation,
  recordFailure,
  resolveRequestId,
} from "./observe.js";

const apiKey = "k".repeat(32);

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

async function withServer(
  indexExistsCheck: () => Promise<boolean>,
  run: (baseUrl: string, lines: string[]) => Promise<void>,
): Promise<void> {
  const output = collect();
  const running = await startServer({
    apiKey,
    indexExists: indexExistsCheck,
    log: output.log,
    port: 0,
    host: "127.0.0.1",
  });
  try {
    await run(`http://127.0.0.1:${running.port}`, output.lines);
  } finally {
    await stop(running.server);
  }
}

test("@devlog/server loads", () => {
  expect(packageName).toBe("@devlog/server");
});

test("GET /health is open and reports that the index exists", async () => {
  await withServer(
    async () => true,
    async (baseUrl, lines) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
      expect(response.headers.get("x-powered-by")).toBeNull();

      const requestId = response.headers.get("x-request-id");
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(requestLogs(lines)).toEqual([
        expect.objectContaining({
          level: "info",
          msg: "request",
          requestId,
          method: "GET",
          path: "/health",
          status: 200,
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      ]);
      const latencyMs = requestLogs(lines)[0]?.latencyMs;
      expect(latencyMs).toEqual(expect.any(Number));
      expect(latencyMs).toBeGreaterThanOrEqual(0);
      expect(lines.join("\n")).not.toContain(apiKey);
    },
  );
});

test("GET /health returns 503 when the index is missing", async () => {
  await withServer(
    async () => false,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    },
  );
});

test("GET /health returns 503 when the index check throws", async () => {
  await withServer(
    async () => {
      throw new Error("search unavailable");
    },
    async (baseUrl, lines) => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });

      const body = lines.map((line) => JSON.parse(line) as unknown);
      const failure = body.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          "msg" in entry &&
          entry.msg === "health check failed",
      );
      const request = requestLogs(lines)[0];
      expect(failure).toMatchObject({
        level: "error",
        msg: "health check failed",
        requestId: request?.requestId,
        error: "search unavailable",
      });
      expect(lines.join("\n")).not.toContain(apiKey);
    },
  );
});

test("HEAD /health is open", async () => {
  await withServer(
    async () => true,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`, { method: "HEAD" });
      expect(response.status).toBe(200);
    },
  );
});

test("a missing API key returns 401", async () => {
  await withServer(
    async () => true,
    async (baseUrl, lines) => {
      const response = await fetch(`${baseUrl}/chat`, { method: "POST" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "unauthorized", message: "Unauthorized" },
      });
      expect(requestLogs(lines)[0]).toMatchObject({
        method: "POST",
        path: "/chat",
        status: 401,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
  );
});

test("a wrong API key returns 401 and is not logged", async () => {
  const wrong = `wrong-${"z".repeat(26)}`;
  await withServer(
    async () => true,
    async (baseUrl, lines) => {
      const response = await fetch(`${baseUrl}/chat?access=${wrong}`, {
        headers: { "x-api-key": wrong },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: "unauthorized", message: "Unauthorized" },
      });
      const text = lines.join("\n");
      expect(text).not.toContain(wrong);
      expect(text).not.toContain(apiKey);
      expect(requestLogs(lines)[0]).toMatchObject({
        path: "/chat",
        status: 401,
        outcome: "error",
        errorCode: "unauthorized",
      });
    },
  );
});

test("the API key allows an unknown route through to 404", async () => {
  await withServer(
    async () => true,
    async (baseUrl, lines) => {
      const response = await fetch(`${baseUrl}/chat`, {
        headers: { "x-api-key": apiKey },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "Not found" },
      });
      expect(lines.join("\n")).not.toContain(apiKey);
    },
  );
});

test("POST /health requires the API key", async () => {
  await withServer(
    async () => true,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`, { method: "POST" });
      expect(response.status).toBe(401);
    },
  );
});

test("a safe request id is echoed and a hostile one is replaced", async () => {
  await withServer(
    async () => true,
    async (baseUrl, lines) => {
      const kept = await fetch(`${baseUrl}/health`, {
        headers: { "x-request-id": "req-42" },
      });
      expect(kept.headers.get("x-request-id")).toBe("req-42");
      expect(requestLogs(lines).at(-1)).toMatchObject({ requestId: "req-42" });

      const hostile = "unsafe/secret-token";
      const replaced = await fetch(`${baseUrl}/health`, {
        headers: { "x-request-id": hostile },
      });
      const requestId = replaced.headers.get("x-request-id");
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(lines.join("\n")).not.toContain("secret-token");
      expect(requestLogs(lines).at(-1)).toMatchObject({ requestId });
    },
  );
});

test("a request id with a newline is discarded", () => {
  const requestId = resolveRequestId("bad id\nsecret-token");
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(requestId).not.toContain("secret-token");
});

test("request logs include tool calls and token usage", async () => {
  const output = collect();
  const app = express();
  const options = {
    apiKey,
    indexExists: async () => true,
    log: output.log,
  };
  mountServer(app, options);
  app.post("/chat", (_req, res) => {
    recordToolCall(res, "search_architecture_docs", { query: "queue worker" });
    recordToolCall(res, "read_note", { path: "Queue Worker.md" });
    addTokenUsage(res, { inputTokens: 10, outputTokens: 2 });
    addTokenUsage(res, { inputTokens: 1, outputTokens: 2 });
    addTokenUsage(res, { inputTokens: Number.NaN, outputTokens: 5 });
    res.status(204).end();
  });
  finalizeServer(app, options);

  const running = await listen(app, 0, "127.0.0.1");
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/chat`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
    });
    expect(response.status).toBe(204);
    expect(requestLogs(output.lines)).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/chat",
        status: 204,
        toolCalls: [
          {
            tool: "search_architecture_docs",
            input: { query: "queue worker" },
          },
          { tool: "read_note", input: { path: "Queue Worker.md" } },
        ],
        usage: { inputTokens: 11, outputTokens: 9 },
      }),
    ]);
    expect(output.lines.join("\n")).not.toContain(apiKey);
  } finally {
    await stop(running.server);
  }
});

test("an unexpected error returns 500 without the internal message", async () => {
  const output = collect();
  const app = express();
  const options = {
    apiKey,
    indexExists: async () => true,
    log: output.log,
  };
  mountServer(app, options);
  app.get("/boom", () => {
    throw new Error("explode");
  });
  finalizeServer(app, options);

  const running = await listen(app, 0, "127.0.0.1");
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/boom`, {
      headers: { "x-api-key": apiKey },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal", message: "Internal server error" },
    });
    const text = output.lines.join("\n");
    expect(text).toContain("explode");
    expect(text).not.toContain(apiKey);
    expect(requestLogs(output.lines)[0]).toMatchObject({
      path: "/boom",
      status: 500,
    });
  } finally {
    await stop(running.server);
  }
});

test("recordFailure stores the code and a bounded message", () => {
  const res = {} as Response;
  beginObservation(res, "req-1");
  recordFailure(res, "agent_error", "x".repeat(600));
  expect(readObservation(res)).toMatchObject({
    outcome: "error",
    errorCode: "agent_error",
    error: "x".repeat(500),
  });
});

test("recordToolCall requires an active request", () => {
  expect(() => recordToolCall({} as never, "search_architecture_docs")).toThrow(
    /observation/i,
  );
});

test("indexExists reports a present index", async () => {
  const client: IndexLookup = {
    async getIndex() {
      return { name: "devlog-chunks" };
    },
  };
  await expect(indexExists(client, "devlog-chunks")).resolves.toBe(true);
});

test("indexExists treats a 404 as a missing index", async () => {
  const byStatusCode: IndexLookup = {
    async getIndex() {
      throw { statusCode: 404 };
    },
  };
  const byStatus: IndexLookup = {
    async getIndex() {
      throw { status: 404 };
    },
  };
  await expect(indexExists(byStatusCode, "devlog-chunks")).resolves.toBe(false);
  await expect(indexExists(byStatus, "devlog-chunks")).resolves.toBe(false);
});

test("indexExists rethrows errors other than a missing index", async () => {
  const client: IndexLookup = {
    async getIndex() {
      throw new Error("unavailable");
    },
  };
  await expect(indexExists(client, "devlog-chunks")).rejects.toThrow(
    "unavailable",
  );
});
