import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function apiKeyMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (provided === undefined) {
    return false;
  }
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) {
    return false;
  }
  return timingSafeEqual(actual, wanted);
}

function isPublicHealth(req: Request): boolean {
  return (
    (req.method === "GET" || req.method === "HEAD") && req.path === "/health"
  );
}

export function requireApiKey(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isPublicHealth(req)) {
      next();
      return;
    }
    if (!apiKeyMatches(req.get("x-api-key"), apiKey)) {
      res.status(401).json({
        error: { code: "unauthorized", message: "Unauthorized" },
      });
      return;
    }
    next();
  };
}
