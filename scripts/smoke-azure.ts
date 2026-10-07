import { createHmac } from "node:crypto";

const SEARCH_API_VERSION = "2024-07-01";
const BLOB_API_VERSION = "2023-11-03";
const SMOKE_BLOB = "smoke.txt";
const EMBEDDING_DIMENSIONS = 1536;

function readRequired(names: readonly string[]): Map<string, string> {
  const missing: string[] = [];
  const values = new Map<string, string>();
  for (const name of names) {
    const value = process.env[name]?.trim() ?? "";
    if (value === "") {
      missing.push(name);
    } else {
      values.set(name, value);
    }
  }
  if (missing.length > 0) {
    console.error(`Missing environment: ${missing.join(", ")}`);
    process.exit(1);
  }
  return values;
}

function redact(text: string): string {
  return text
    .replace(/api-key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api-key ***")
    .replace(/AccountKey=[^;\s]+/gi, "AccountKey=***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/SharedKey\s+\S+/gi, "SharedKey ***");
}

async function request(
  label: string,
  url: string,
  init: RequestInit,
): Promise<string> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    const detail = redact(text).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`${label} failed: HTTP ${response.status} ${detail}`);
  }
  return text;
}

function parseJson(label: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned non-JSON`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function endpointOf(url: string): string {
  return url.replace(/\/+$/, "");
}

async function smokeChat(
  endpoint: string,
  apiKey: string,
  deployment: string,
): Promise<string> {
  const text = await request(
    "chat",
    `${endpointOf(endpoint)}/openai/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: deployment,
        messages: [
          { role: "user", content: "Reply with the single word pong." },
        ],
        max_completion_tokens: 128,
        reasoning_effort: "low",
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const root = asRecord(parseJson("chat", text));
  const choices = root?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("chat response had no choices");
  }
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const content = message?.content;
  if (typeof content === "string" && content.trim() !== "") {
    const line = content.trim().replace(/\s+/g, " ").slice(0, 60);
    return `chat: ok "${line}"`;
  }
  const finish = choice?.finish_reason;
  const reason = typeof finish === "string" ? finish : "unknown";
  return `chat: ok finish_reason=${reason}`;
}

async function smokeEmbedding(
  endpoint: string,
  apiKey: string,
  deployment: string,
): Promise<string> {
  const text = await request(
    "embedding",
    `${endpointOf(endpoint)}/openai/v1/embeddings`,
    {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: deployment, input: "ping" }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const root = asRecord(parseJson("embedding", text));
  const data = root?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("embedding response had no data");
  }
  const embedding = asRecord(data[0])?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("embedding response had no vector");
  }
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding dimensions ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}`,
    );
  }
  return `embedding: ${embedding.length}`;
}

async function smokeSearch(endpoint: string, apiKey: string): Promise<string> {
  const text = await request(
    "search",
    `${endpointOf(endpoint)}/indexes?api-version=${SEARCH_API_VERSION}`,
    {
      method: "GET",
      headers: { "api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const root = asRecord(parseJson("search", text));
  const value = root?.value;
  if (!Array.isArray(value)) {
    throw new Error("search response had no value array");
  }
  const names = value.map((item) => {
    const name = asRecord(item)?.name;
    return typeof name === "string" ? name : "?";
  });
  if (names.length === 0) {
    return "search: 0 indexes";
  }
  return `search: ${names.length} indexes (${names.join(", ")})`;
}

function connectionParts(connectionString: string): {
  accountName: string;
  accountKey: string;
  endpointSuffix: string;
} {
  const parts = new Map<string, string>();
  for (const segment of connectionString.split(";")) {
    if (segment === "") continue;
    const splitAt = segment.indexOf("=");
    if (splitAt <= 0) continue;
    parts.set(segment.slice(0, splitAt), segment.slice(splitAt + 1).trim());
  }
  const accountName = parts.get("AccountName") ?? "";
  const accountKey = parts.get("AccountKey") ?? "";
  const endpointSuffix = parts.get("EndpointSuffix") || "core.windows.net";
  if (accountName === "" || accountKey === "") {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING is missing AccountName or AccountKey",
    );
  }
  return { accountName, accountKey, endpointSuffix };
}

function blobAuthorization(input: {
  method: string;
  accountName: string;
  accountKey: string;
  url: string;
  contentType: string;
  contentLength: number;
  headers: Record<string, string>;
}): string {
  const canonicalHeaders = Object.entries(input.headers)
    .filter(([name]) => name.toLowerCase().startsWith("x-ms-"))
    .map(([name, value]) => [
      name.toLowerCase(),
      value.trim().replace(/\s+/g, " "),
    ])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");

  const url = new URL(input.url);
  const resource = `/${input.accountName}${decodeURIComponent(url.pathname)}`;
  const lengthField =
    input.contentLength > 0 ? String(input.contentLength) : "";
  const signed = [
    input.method,
    "",
    "",
    lengthField,
    "",
    input.contentType,
    "",
    "",
    "",
    "",
    "",
    "",
  ].join("\n");
  const stringToSign = `${signed}\n${canonicalHeaders}${resource}`;
  const signature = createHmac(
    "sha256",
    Buffer.from(input.accountKey, "base64"),
  )
    .update(stringToSign, "utf8")
    .digest("base64");
  return `SharedKey ${input.accountName}:${signature}`;
}

async function smokeBlob(
  connectionString: string,
  container: string,
): Promise<string> {
  const { accountName, accountKey, endpointSuffix } =
    connectionParts(connectionString);
  const url =
    `https://${accountName}.blob.${endpointSuffix}/` +
    `${encodeURIComponent(container)}/${encodeURIComponent(SMOKE_BLOB)}`;
  const body = "smoke";
  const contentType = "text/plain; charset=UTF-8";
  const date = new Date().toUTCString();
  const putHeaders = {
    "x-ms-blob-type": "BlockBlob",
    "x-ms-date": date,
    "x-ms-version": BLOB_API_VERSION,
  };
  const putAuth = blobAuthorization({
    method: "PUT",
    accountName,
    accountKey,
    url,
    contentType,
    contentLength: Buffer.byteLength(body),
    headers: putHeaders,
  });
  await request("blob put", url, {
    method: "PUT",
    headers: {
      ...putHeaders,
      authorization: putAuth,
      "content-type": contentType,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  const deleteDate = new Date().toUTCString();
  const deleteHeaders = {
    "x-ms-date": deleteDate,
    "x-ms-version": BLOB_API_VERSION,
  };
  const deleteAuth = blobAuthorization({
    method: "DELETE",
    accountName,
    accountKey,
    url,
    contentType: "",
    contentLength: 0,
    headers: deleteHeaders,
  });
  await request("blob delete", url, {
    method: "DELETE",
    headers: {
      ...deleteHeaders,
      authorization: deleteAuth,
    },
    signal: AbortSignal.timeout(30_000),
  });
  return `blob: wrote and deleted ${SMOKE_BLOB}`;
}

async function main(): Promise<void> {
  const env = readRequired([
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_CHAT_DEPLOYMENT",
    "AZURE_OPENAI_EMBEDDING_DEPLOYMENT",
    "AZURE_SEARCH_ENDPOINT",
    "AZURE_SEARCH_API_KEY",
    "AZURE_STORAGE_CONNECTION_STRING",
  ]);
  const container =
    process.env.AZURE_STORAGE_CONTAINER?.trim() || "devlog-notes";

  console.log(
    await smokeSearch(
      env.get("AZURE_SEARCH_ENDPOINT") ?? "",
      env.get("AZURE_SEARCH_API_KEY") ?? "",
    ),
  );
  console.log(
    await smokeBlob(
      env.get("AZURE_STORAGE_CONNECTION_STRING") ?? "",
      container,
    ),
  );
  console.log(
    await smokeEmbedding(
      env.get("AZURE_OPENAI_ENDPOINT") ?? "",
      env.get("AZURE_OPENAI_API_KEY") ?? "",
      env.get("AZURE_OPENAI_EMBEDDING_DEPLOYMENT") ?? "",
    ),
  );
  console.log(
    await smokeChat(
      env.get("AZURE_OPENAI_ENDPOINT") ?? "",
      env.get("AZURE_OPENAI_API_KEY") ?? "",
      env.get("AZURE_OPENAI_CHAT_DEPLOYMENT") ?? "",
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "smoke failed";
  console.error(redact(message));
  process.exit(1);
});
