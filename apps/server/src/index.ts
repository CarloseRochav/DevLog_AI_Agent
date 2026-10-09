import { once } from "node:events";
import type { Server } from "node:http";
import type { Express } from "express";
import { createApp, type CreateAppOptions } from "./app.js";

export const packageName = "@devlog/server";

export interface ListeningServer {
  server: Server;
  port: number;
}

export async function listen(
  app: Express,
  port = 0,
  host?: string,
): Promise<ListeningServer> {
  const server = host === undefined ? app.listen(port) : app.listen(port, host);
  try {
    await once(server, "listening");
  } catch (error) {
    server.close();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Server is not listening on a TCP port");
  }
  return { server, port: address.port };
}

export async function startServer(
  options: CreateAppOptions & { port: number; host?: string },
): Promise<ListeningServer & { app: Express }> {
  const app = createApp(options);
  const listening = await listen(app, options.port, options.host);
  return { app, ...listening };
}

export {
  createApp,
  finalizeServer,
  mountServer,
  notFound,
  type CreateAppOptions,
} from "./app.js";
export { createChatSession, type ChatSession } from "./chat.js";
export { indexExists, type IndexLookup } from "./index-exists.js";
export {
  addTokenUsage,
  recordFailure,
  recordOutcome,
  recordToolCall,
  type RequestLogEntry,
  type RequestOutcome,
  type TokenUsage,
  type ToolCallLog,
} from "./observe.js";
