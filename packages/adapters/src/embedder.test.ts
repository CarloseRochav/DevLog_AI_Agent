import { ZodError } from "zod";
import { expect, test } from "vitest";
import { AzureEmbedder } from "./embedder.js";

function vectors(count: number, dimensions: number): number[][] {
  return Array.from({ length: count }, (_, index) =>
    Array.from({ length: dimensions }, () => index),
  );
}

function embeddingBody(
  count: number,
  dimensions: number,
  reverse = false,
): { data: Array<{ index: number; embedding: number[] }> } {
  const data = vectors(count, dimensions).map((embedding, index) => ({
    index,
    embedding,
  }));
  if (reverse) {
    data.reverse();
  }
  return { data };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function createEmbedder(options: {
  responses: Response[];
  dimensions?: number;
  deployment?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
}) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const sleeps: number[] = [];
  const responses = [...options.responses];
  const embedder = new AzureEmbedder({
    endpoint: options.endpoint ?? "https://example.test/",
    apiKey: options.apiKey ?? "test-key",
    deployment: options.deployment ?? "text-embedding-3-small",
    model: options.model,
    dimensions: options.dimensions ?? 4,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      const next = responses.shift();
      if (next === undefined) {
        throw new Error("unexpected fetch");
      }
      return next;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { embedder, requests, sleeps };
}

function requestBody(init: RequestInit | undefined): {
  model: string;
  input: string[];
} {
  return JSON.parse(String(init?.body)) as { model: string; input: string[] };
}

test("batches embeddings and preserves response order", async () => {
  const texts = Array.from({ length: 40 }, (_, index) => `text-${index}`);
  const { embedder, requests, sleeps } = createEmbedder({
    dimensions: 4,
    responses: [
      jsonResponse(embeddingBody(16, 4, true)),
      jsonResponse(embeddingBody(16, 4)),
      jsonResponse(embeddingBody(8, 4)),
    ],
  });

  const result = await embedder.embed(texts);

  expect(embedder.model).toBe("text-embedding-3-small");
  expect(embedder.dimensions).toBe(4);
  expect(requests).toHaveLength(3);
  expect(
    requests.map((request) => requestBody(request.init).input.length),
  ).toEqual([16, 16, 8]);
  expect(requestBody(requests[0]?.init).model).toBe("text-embedding-3-small");
  expect(requests[0]?.url).toBe("https://example.test/openai/v1/embeddings");
  const headers = requests[0]?.init?.headers as Record<string, string>;
  expect(headers["api-key"]).toBe("test-key");
  expect(headers["content-type"]).toBe("application/json");
  expect(sleeps).toEqual([]);
  expect(result).toHaveLength(40);
  expect(result[0]).toEqual([0, 0, 0, 0]);
  expect(result[15]).toEqual([15, 15, 15, 15]);
  expect(result[16]).toEqual([0, 0, 0, 0]);
});

test("orders vectors by the response index", async () => {
  const { embedder } = createEmbedder({
    dimensions: 2,
    responses: [
      jsonResponse({
        data: [
          { index: 1, embedding: [9, 9] },
          { index: 0, embedding: [1, 1] },
        ],
      }),
    ],
  });

  await expect(embedder.embed(["a", "b"])).resolves.toEqual([
    [1, 1],
    [9, 9],
  ]);
});

test("uses the deployment name in the request and an optional port model", async () => {
  const { embedder, requests } = createEmbedder({
    deployment: "text-embedding-3-small",
    model: "port-name",
    dimensions: 2,
    responses: [jsonResponse(embeddingBody(1, 2))],
  });

  expect(embedder.model).toBe("port-name");
  await embedder.embed(["ping"]);
  expect(requestBody(requests[0]?.init).model).toBe("text-embedding-3-small");
});

test("empty input does not call fetch", async () => {
  const { embedder, requests } = createEmbedder({ responses: [] });

  await expect(embedder.embed([])).resolves.toEqual([]);
  expect(requests).toEqual([]);
});

test("retries HTTP 429 with exponential backoff", async () => {
  const { embedder, requests, sleeps } = createEmbedder({
    dimensions: 2,
    responses: [
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
      jsonResponse(embeddingBody(1, 2)),
    ],
  });

  await expect(embedder.embed(["ping"])).resolves.toEqual([[0, 0]]);
  expect(requests).toHaveLength(3);
  expect(sleeps).toEqual([500, 1000]);
});

test("honors a numeric Retry-After header", async () => {
  const { embedder, sleeps } = createEmbedder({
    dimensions: 2,
    responses: [
      new Response(null, { status: 429, headers: { "retry-after": "3" } }),
      jsonResponse(embeddingBody(1, 2)),
    ],
  });

  await embedder.embed(["ping"]);
  expect(sleeps).toEqual([3000]);
});

test("stops after five retries of HTTP 429", async () => {
  const { embedder, requests, sleeps } = createEmbedder({
    apiKey: "secret-key-value",
    responses: [
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
    ],
  });

  const error = await embedder.embed(["ping"]).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) {
    expect(error.message).toMatch(/HTTP 429/);
    expect(error.message).not.toContain("secret-key-value");
  }
  expect(requests).toHaveLength(6);
  expect(sleeps).toEqual([500, 1000, 2000, 4000, 8000]);
});

test("fails other HTTP errors without sleeping", async () => {
  const { embedder, requests, sleeps } = createEmbedder({
    apiKey: "secret-key-value",
    responses: [new Response("nope", { status: 400 })],
  });

  const error = await embedder.embed(["ping"]).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) {
    expect(error.message).toMatch(/HTTP 400/);
    expect(error.message).not.toContain("secret-key-value");
  }
  expect(requests).toHaveLength(1);
  expect(sleeps).toEqual([]);
});

test("rejects a vector whose length does not match dimensions", async () => {
  const { embedder } = createEmbedder({
    dimensions: 4,
    responses: [
      jsonResponse({
        data: [{ index: 0, embedding: [1, 2] }],
      }),
    ],
  });

  await expect(embedder.embed(["ping"])).rejects.toBeInstanceOf(ZodError);
});
