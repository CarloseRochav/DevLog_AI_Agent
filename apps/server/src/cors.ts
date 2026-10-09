import type { NextFunction, Request, Response } from "express";

export const CORS_ORIGIN_PLACEHOLDER = "<FRONTEND_ORIGIN_PLACEHOLDER>";

const ALLOW_METHODS = "GET, HEAD, POST, DELETE, OPTIONS";
const ALLOW_HEADERS = "x-api-key, content-type, x-request-id";
const EXPOSE_HEADERS = "x-request-id";

export function createCorsMiddleware(origin: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestOrigin = req.get("origin");
    if (requestOrigin === origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Expose-Headers", EXPOSE_HEADERS);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
        res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
      }
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
