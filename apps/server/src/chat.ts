import type { NextFunction, Request, Response } from "express";
import {
  iterateChatEvents,
  resetConversation,
  toChatStreamAgent,
  type ChatEvent,
  type ChatStreamAgent,
  type createDevlogAgent,
} from "@devlog/agent";
import { z } from "zod";
import { addTokenUsage, recordToolCall } from "./observe.js";

export const ChatRequestSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

export interface ChatSession {
  agent: ChatStreamAgent;
}

export function createChatSession(
  agent: ReturnType<typeof createDevlogAgent>,
): ChatSession {
  return { agent: toChatStreamAgent(agent) };
}

export function createChatPostHandler(session: ChatSession) {
  return async function chatPost(req: Request, res: Response): Promise<void> {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_request", message: formatIssues(parsed.error) },
      });
      return;
    }

    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) {
        abort.abort();
      }
    };
    res.on("close", onClose);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    try {
      for await (const event of iterateChatEvents(
        session.agent,
        {
          conversationId: parsed.data.conversationId,
          message: parsed.data.message,
        },
        {
          signal: abort.signal,
          onTool(tool, input) {
            recordToolCall(res, tool, input);
          },
          onUsage(usage) {
            addTokenUsage(res, usage);
          },
        },
      )) {
        if (!writeEvent(res, event)) {
          abort.abort();
          break;
        }
      }
    } finally {
      res.off("close", onClose);
      endQuietly(res);
    }
  };
}

export function createChatDeleteHandler(session: ChatSession) {
  return async function chatDelete(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const parsed = z
      .string()
      .uuid()
      .safeParse(routeParam(req.params.conversationId));
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_request", message: formatIssues(parsed.error) },
      });
      return;
    }
    try {
      await resetConversation(session.agent, parsed.data);
    } catch (error) {
      next(error);
      return;
    }
    res.status(204).end();
  };
}

function writeEvent(res: Response, event: ChatEvent): boolean {
  if (res.writableEnded) {
    return false;
  }
  try {
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function endQuietly(res: Response): void {
  if (res.writableEnded) {
    return;
  }
  try {
    res.end();
  } catch {
    // The client already went away.
  }
}

function routeParam(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatIssues(error: z.ZodError): string {
  const message = error.issues
    .map((issue) => {
      const path = issue.path.map((part) => String(part)).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
  return message === "" ? "Invalid request." : message;
}
