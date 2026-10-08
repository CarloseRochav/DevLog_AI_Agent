import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { ServerConfig } from "@devlog/config";
import {
  listNotes,
  readNote,
  searchArchitectureDocs,
  type ToolDeps,
} from "@devlog/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import {
  createAgent,
  createMiddleware,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from "langchain";
import { SYSTEM_PROMPT } from "./prompt.js";
import { toLangChainTool } from "./tools.js";
import { trimHistoryMiddleware } from "./trim-history.js";

export interface CreateDevlogAgentOptions {
  model?: BaseChatModel;
}

export function createChatModel(cfg: ServerConfig): ChatOpenAI {
  const endpoint = cfg.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, "");
  return new ChatOpenAI({
    model: cfg.AZURE_OPENAI_CHAT_DEPLOYMENT,
    apiKey: cfg.AZURE_OPENAI_API_KEY,
    temperature: cfg.CHAT_TEMPERATURE,
    useResponsesApi: false,
    configuration: {
      baseURL: `${endpoint}/openai/v1`,
      defaultHeaders: { "api-key": cfg.AZURE_OPENAI_API_KEY },
    },
  });
}

function blockedToolBatch(messages: readonly BaseMessage[]): boolean {
  const lastAi = [...messages]
    .reverse()
    .find((message) => AIMessage.isInstance(message));
  const calls = lastAi?.tool_calls ?? [];
  if (calls.length === 0) {
    return false;
  }
  return calls.every((call) =>
    messages.some(
      (message) =>
        ToolMessage.isInstance(message) &&
        message.tool_call_id === call.id &&
        message.text.includes("Tool call limit exceeded"),
    ),
  );
}

// langchain@1.5.15 ends the run when a fully blocked tool batch appends
// ToolMessages from afterModel. Jump back so the model can still answer.
function resumeAfterBlockedToolsMiddleware() {
  return createMiddleware({
    name: "ResumeAfterBlockedTools",
    afterModel: {
      canJumpTo: ["model"],
      hook: (state) => {
        if (!blockedToolBatch(state.messages)) {
          return;
        }
        return { jumpTo: "model" as const };
      },
    },
  });
}

export function createDevlogAgent(
  cfg: ServerConfig,
  deps: ToolDeps,
  options: CreateDevlogAgentOptions = {},
) {
  const model = options.model ?? createChatModel(cfg);
  return createAgent({
    model,
    tools: [
      toLangChainTool(searchArchitectureDocs, deps),
      toLangChainTool(readNote, deps),
      toLangChainTool(listNotes, deps),
    ],
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: new MemorySaver(),
    middleware: [
      resumeAfterBlockedToolsMiddleware(),
      modelCallLimitMiddleware({ runLimit: 8 }),
      toolCallLimitMiddleware({ runLimit: 6 }),
      trimHistoryMiddleware(cfg.HISTORY_MAX_MESSAGES),
    ],
  });
}
