import type { Request, Response } from "express";
import { readObservation } from "./observe.js";

export function createHealthHandler(
  indexExists: () => Promise<boolean>,
  log: (line: string) => void,
) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const exists = await indexExists();
      res.status(exists ? 200 : 503).json({
        status: exists ? "ok" : "unavailable",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Health check failed";
      log(
        JSON.stringify({
          level: "error",
          msg: "health check failed",
          requestId: readObservation(res).requestId,
          error: message,
        }),
      );
      if (!res.headersSent) {
        res.status(503).json({ status: "unavailable" });
      }
    }
  };
}
