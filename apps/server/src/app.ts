import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { requireApiKey } from "./auth.js";
import { CORS_ORIGIN_PLACEHOLDER, createCorsMiddleware } from "./cors.js";
import {
  createChatDeleteHandler,
  createChatPostHandler,
  type ChatSession,
} from "./chat.js";
import { createHealthHandler } from "./health.js";
import {
  beginObservation,
  readObservation,
  recordOutcome,
  resolveRequestId,
  type RequestLogEntry,
  type RequestOutcome,
} from "./observe.js";

export interface CreateAppOptions {
  apiKey: string;
  indexExists: () => Promise<boolean>;
  log?: (line: string) => void;
  chat?: ChatSession;
  corsOrigin?: string;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  mountServer(app, options);
  finalizeServer(app, options);
  return app;
}

export function mountServer(app: Express, options: CreateAppOptions): void {
  const log = loggerOf(options);
  app.disable("x-powered-by");
  app.set("strict routing", true);
  app.set("case sensitive routing", true);
  app.use(requestLogger(log));
  if (
    options.corsOrigin !== undefined &&
    options.corsOrigin !== CORS_ORIGIN_PLACEHOLDER
  ) {
    app.use(createCorsMiddleware(options.corsOrigin));
  }
  app.use(requireApiKey(options.apiKey));
  app.get("/health", createHealthHandler(options.indexExists, log));
  if (options.chat !== undefined) {
    app.post(
      "/chat",
      express.json({ limit: "32kb" }),
      createChatPostHandler(options.chat),
    );
    app.delete("/chat/:conversationId", createChatDeleteHandler(options.chat));
  }
}

export function finalizeServer(app: Express, options: CreateAppOptions): void {
  const log = loggerOf(options);
  app.use(notFound);
  app.use(errorHandler(log));
}

export function notFound(_req: Request, res: Response): void {
  recordServerError(res, "not_found");
  res.status(404).json({
    error: { code: "not_found", message: "Not found" },
  });
}

function loggerOf(options: CreateAppOptions): (line: string) => void {
  return (
    options.log ??
    ((line: string) => {
      console.log(line);
    })
  );
}

function requestLogger(log: (line: string) => void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = resolveRequestId(req.get("x-request-id"));
    const observation = beginObservation(res, requestId);
    const method = req.method;
    const path = req.path;
    const started = performance.now();
    res.setHeader("x-request-id", requestId);

    let logged = false;
    const write = (): void => {
      if (logged) {
        return;
      }
      logged = true;
      const latencyMs = Math.max(0, Math.round(performance.now() - started));
      const outcome = observation.outcome ?? defaultOutcome(res);
      const entry: RequestLogEntry = {
        level: "info",
        msg: "request",
        requestId: observation.requestId,
        method,
        path,
        status: res.statusCode,
        latencyMs,
        outcome,
        ...(observation.errorCode === undefined
          ? {}
          : { errorCode: observation.errorCode }),
        ...(observation.error === undefined
          ? {}
          : { error: observation.error }),
        toolCalls: observation.toolCalls.map((call) => ({ ...call })),
        usage: { ...observation.usage },
      };
      try {
        log(JSON.stringify(entry));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "log failed";
        log(
          JSON.stringify({
            level: "error",
            msg: "request log failed",
            requestId: observation.requestId,
            method,
            path,
            status: res.statusCode,
            latencyMs,
            outcome,
            ...(observation.errorCode === undefined
              ? {}
              : { errorCode: observation.errorCode }),
            error: detail,
            toolCalls: observation.toolCalls.map((call) => ({
              tool: call.tool,
            })),
            usage: { ...observation.usage },
          }),
        );
      }
    };

    res.once("finish", write);
    res.once("close", () => {
      if (res.writableFinished) {
        write();
        return;
      }
      // The route's close listener is registered later and marks an aborted
      // chat in this same turn. Wait until that listener has run.
      setImmediate(write);
    });
    next();
  };
}

function defaultOutcome(res: Response): RequestOutcome {
  if (!res.writableFinished) {
    return "aborted";
  }
  if (res.statusCode >= 400) {
    return "error";
  }
  return "ok";
}

function recordServerError(res: Response, code: string): void {
  try {
    if (readObservation(res).outcome !== undefined) {
      return;
    }
  } catch {
    return;
  }
  recordOutcome(res, "error", code);
}

function errorHandler(log: (line: string) => void) {
  return (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const status = clientErrorStatus(error);
    const message =
      status === undefined
        ? error instanceof Error
          ? error.message
          : "Internal server error"
        : "invalid request body";
    log(
      JSON.stringify({
        level: "error",
        msg: "request failed",
        method: req.method,
        path: req.path,
        error: message,
      }),
    );
    if (res.headersSent) {
      next(error);
      return;
    }
    if (status === 413) {
      recordServerError(res, "payload_too_large");
      res.status(413).json({
        error: {
          code: "payload_too_large",
          message: "Request body is too large.",
        },
      });
      return;
    }
    if (status !== undefined) {
      recordServerError(res, "invalid_request");
      res.status(status).json({
        error: {
          code: "invalid_request",
          message: "Request body must be JSON.",
        },
      });
      return;
    }
    recordServerError(res, "internal");
    res.status(500).json({
      error: { code: "internal", message: "Internal server error" },
    });
  };
}

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const record = error as { status?: unknown; statusCode?: unknown };
  const value =
    typeof record.status === "number" ? record.status : record.statusCode;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < 400 || value > 499) {
    return undefined;
  }
  return value;
}
