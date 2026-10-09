import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
  type UsageMetadata,
} from "@langchain/core/messages";
import { SearchHitSchema, type SearchHit } from "@devlog/core";
import type { createDevlogAgent } from "./create-devlog-agent.js";

export interface ChatTurn {
  conversationId: string;
  message: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ChatEvent =
  | { event: "tool_start"; data: { tool: string; input: unknown } }
  | { event: "tool_end"; data: { tool: string; hitCount: number } }
  | { event: "token"; data: { text: string; messageId: string } }
  | { event: "discard"; data: { messageId: string } }
  | { event: "sources"; data: { citations: SearchHit[] } }
  | {
      event: "done";
      data: { usage: ChatUsage; latencyMs: number };
    }
  | { event: "error"; data: { code: string; message: string } };

export interface ChatEventHooks {
  signal?: AbortSignal;
  onTool?: (tool: string, input: unknown) => void;
  onUsage?: (usage: ChatUsage) => void;
}

export interface ChatStreamAgent {
  stream(
    input: { messages: Array<{ role: "user"; content: string }> },
    config: {
      configurable: { thread_id: string };
      streamMode: ["messages", "updates"];
      signal?: AbortSignal;
    },
  ): Promise<AsyncIterable<unknown>>;
  readonly checkpointer?: unknown;
}

interface PendingTool {
  name: string;
  input: unknown;
  ready: boolean;
  started: boolean;
}

type DevlogAgent = ReturnType<typeof createDevlogAgent>;

export function toChatStreamAgent(agent: DevlogAgent): ChatStreamAgent {
  return {
    stream(input, config) {
      return agent.stream(
        { messages: input.messages },
        {
          configurable: { thread_id: config.configurable.thread_id },
          streamMode: ["messages", "updates"],
          signal: config.signal,
        },
      );
    },
    get checkpointer() {
      return agent.checkpointer;
    },
  };
}

export async function resetConversation(
  agent: ChatStreamAgent,
  conversationId: string,
): Promise<void> {
  const saver = agent.checkpointer;
  if (
    typeof saver === "object" &&
    saver !== null &&
    "deleteThread" in saver &&
    typeof saver.deleteThread === "function"
  ) {
    await saver.deleteThread(conversationId);
    return;
  }
  throw new Error("Chat history cannot be reset");
}

export async function* iterateChatEvents(
  agent: ChatStreamAgent,
  turn: ChatTurn,
  options: ChatEventHooks = {},
): AsyncGenerator<ChatEvent> {
  const started = performance.now();
  const pending = new Map<string, PendingTool>();
  const ended = new Set<string>();
  const usageByMessage = new Map<string, ChatUsage>();
  const citations: SearchHit[] = [];
  const streamed = new Set<string>();
  const discarded = new Set<string>();
  let anonymous = 0;
  const nextAnonymous = (): string => {
    anonymous += 1;
    return `anon-${anonymous}`;
  };

  const usage = (): ChatUsage => {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const entry of usageByMessage.values()) {
      inputTokens += entry.inputTokens;
      outputTokens += entry.outputTokens;
    }
    return { inputTokens, outputTokens };
  };

  try {
    // "updates" repeats messages already emitted on the "messages" channel.
    const stream = await agent.stream(
      { messages: [{ role: "user", content: turn.message }] },
      {
        configurable: { thread_id: turn.conversationId },
        streamMode: ["messages", "updates"],
        signal: options.signal,
      },
    );

    for await (const chunk of stream) {
      const message = messageFromChunk(chunk);
      if (message === undefined) {
        continue;
      }
      if (AIMessage.isInstance(message) || AIMessageChunk.isInstance(message)) {
        const messageId = messageKey(message, nextAnonymous);
        rememberUsage(usageByMessage, message, messageId);
        const toolTurn = isToolTurn(message);
        if (toolTurn && streamed.has(messageId) && !discarded.has(messageId)) {
          discarded.add(messageId);
          yield { event: "discard", data: { messageId } };
        }
        const calls = message.tool_calls ?? [];
        for (const call of calls) {
          rememberTool(pending, call);
        }
        for (const event of startReadyTools(pending, options.onTool)) {
          yield event;
        }
        if (!toolTurn && !discarded.has(messageId) && message.text !== "") {
          streamed.add(messageId);
          yield { event: "token", data: { text: message.text, messageId } };
        }
        continue;
      }
      if (!ToolMessage.isInstance(message)) {
        continue;
      }
      const id = message.tool_call_id || message.id || `tool-${ended.size}`;
      if (ended.has(id)) {
        continue;
      }
      const known = pending.get(id);
      const tool = message.name || known?.name || "tool";
      if (known === undefined || !known.started) {
        const input = known?.input ?? {};
        options.onTool?.(tool, input);
        yield { event: "tool_start", data: { tool, input } };
        if (known !== undefined) {
          known.started = true;
        }
      }
      ended.add(id);
      const result = toolResult(tool, message.text);
      citations.push(...result.citations);
      yield {
        event: "tool_end",
        data: { tool, hitCount: result.hitCount },
      };
    }

    yield { event: "sources", data: { citations } };
    yield {
      event: "done",
      data: {
        usage: usage(),
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
      },
    };
  } catch (error) {
    if (options.signal?.aborted) {
      return;
    }
    yield {
      event: "error",
      data: { code: "agent_error", message: publicErrorMessage(error) },
    };
  } finally {
    options.onUsage?.(usage());
  }
}

function messageFromChunk(chunk: unknown): BaseMessage | undefined {
  if (
    !Array.isArray(chunk) ||
    chunk[0] !== "messages" ||
    !Array.isArray(chunk[1])
  ) {
    return undefined;
  }
  const message: unknown = chunk[1][0];
  if (
    AIMessage.isInstance(message) ||
    AIMessageChunk.isInstance(message) ||
    ToolMessage.isInstance(message)
  ) {
    return message;
  }
  return undefined;
}

function messageKey(
  message: { id?: string },
  nextAnonymous: () => string,
): string {
  if (typeof message.id === "string" && message.id !== "") {
    return message.id;
  }
  return nextAnonymous();
}

function isToolTurn(message: AIMessage | AIMessageChunk): boolean {
  if ((message.tool_calls ?? []).length > 0) {
    return true;
  }
  if ((message.invalid_tool_calls ?? []).length > 0) {
    return true;
  }
  if (!("tool_call_chunks" in message)) {
    return false;
  }
  const chunks = message.tool_call_chunks;
  return Array.isArray(chunks) && chunks.length > 0;
}

function rememberUsage(
  usageByMessage: Map<string, ChatUsage>,
  message: { usage_metadata?: UsageMetadata },
  messageId: string,
): void {
  const metadata = message.usage_metadata;
  if (metadata === undefined) {
    return;
  }
  const inputTokens = finite(metadata.input_tokens);
  const outputTokens = finite(metadata.output_tokens);
  usageByMessage.set(messageId, {
    inputTokens,
    outputTokens,
  });
}

function rememberTool(
  pending: Map<string, PendingTool>,
  call: { id?: string; name?: string; args?: unknown },
): void {
  if (call.id === undefined || call.id === "" || call.name === undefined) {
    return;
  }
  const current = pending.get(call.id) ?? {
    name: call.name,
    input: {},
    ready: false,
    started: false,
  };
  if (call.name !== "") {
    current.name = call.name;
  }
  const parsed = normalizeArgs(call.args);
  if (parsed.ready) {
    current.input = parsed.input;
    current.ready = true;
  }
  pending.set(call.id, current);
}

function* startReadyTools(
  pending: Map<string, PendingTool>,
  onTool: ((tool: string, input: unknown) => void) | undefined,
): Generator<ChatEvent> {
  for (const tool of pending.values()) {
    if (!tool.ready || tool.started) {
      continue;
    }
    tool.started = true;
    onTool?.(tool.name, tool.input);
    yield { event: "tool_start", data: { tool: tool.name, input: tool.input } };
  }
}

function normalizeArgs(args: unknown): { ready: boolean; input: unknown } {
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed === "") {
      return { ready: false, input: {} };
    }
    try {
      return { ready: true, input: JSON.parse(trimmed) as unknown };
    } catch {
      return { ready: false, input: {} };
    }
  }
  if (typeof args === "object" && args !== null) {
    return { ready: true, input: args };
  }
  return { ready: false, input: {} };
}

function toolResult(
  tool: string,
  text: string,
): { hitCount: number; citations: SearchHit[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { hitCount: 0, citations: [] };
  }
  if (tool === "search_architecture_docs" && Array.isArray(parsed)) {
    const citations: SearchHit[] = [];
    for (const item of parsed) {
      const result = SearchHitSchema.safeParse(item);
      if (result.success) {
        citations.push(result.data);
      }
    }
    return { hitCount: parsed.length, citations };
  }
  if (tool === "list_notes" && Array.isArray(parsed)) {
    return { hitCount: parsed.length, citations: [] };
  }
  if (
    tool === "read_note" &&
    typeof parsed === "object" &&
    parsed !== null &&
    "content" in parsed &&
    typeof parsed.content === "string"
  ) {
    return { hitCount: 1, citations: [] };
  }
  if (Array.isArray(parsed)) {
    return { hitCount: parsed.length, citations: [] };
  }
  return { hitCount: 0, citations: [] };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.slice(0, 500);
  }
  return "The agent failed before it could answer.";
}
