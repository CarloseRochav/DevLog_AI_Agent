const DUMMY_TOOL = {
  type: "function",
  function: {
    name: "echo",
    description:
      "Echo a short word. Use this tool instead of answering in text.",
    parameters: {
      type: "object",
      properties: {
        word: {
          type: "string",
          description: "The word to echo.",
        },
      },
      required: ["word"],
      additionalProperties: false,
    },
  },
} as const;

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
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toolCallNames(message: Record<string, unknown>): string[] {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) {
    return [];
  }
  const names: string[] = [];
  for (const call of calls) {
    const record = asRecord(call);
    const fn = asRecord(record?.function);
    const name = fn?.name;
    if (typeof name === "string" && name !== "") {
      names.push(name);
    }
  }
  return names;
}

async function main(): Promise<void> {
  const env = readRequired([
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_CHAT_DEPLOYMENT",
  ]);
  const endpoint = (env.get("AZURE_OPENAI_ENDPOINT") ?? "").replace(/\/+$/, "");
  const apiKey = env.get("AZURE_OPENAI_API_KEY") ?? "";
  const model = env.get("AZURE_OPENAI_CHAT_DEPLOYMENT") ?? "";

  const response = await fetch(`${endpoint}/openai/v1/chat/completions`, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: "Call the echo tool with word ping. Do not answer in text.",
        },
      ],
      tools: [DUMMY_TOOL],
      tool_choice: "required",
      max_completion_tokens: 512,
      reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  if (!response.ok) {
    const detail = redact(text).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`chat tools failed: HTTP ${response.status} ${detail}`);
  }

  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    throw new Error("chat tools returned non-JSON");
  }

  const choices = asRecord(root)?.choices;
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
  const message = asRecord(choice?.message);
  if (message === null) {
    throw new Error("chat tools response had no message");
  }

  const names = toolCallNames(message);
  const finish = choice?.finish_reason;
  const finishReason = typeof finish === "string" ? finish : "unknown";
  if (names.length === 0) {
    const content = message.content;
    const preview =
      typeof content === "string"
        ? content.trim().replace(/\s+/g, " ").slice(0, 120)
        : "";
    console.log(`tool_calls: none`);
    console.log(`finish_reason: ${finishReason}`);
    if (preview !== "") {
      console.log(`content: ${preview}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`tool_calls: ${names.length}`);
  console.log(`names: ${names.join(", ")}`);
  console.log(`finish_reason: ${finishReason}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "chat tools failed";
  console.error(redact(message));
  process.exit(1);
});
