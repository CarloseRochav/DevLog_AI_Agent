import { randomUUID } from "node:crypto";
import type { Response } from "express";

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/;

const observations = new WeakMap<Response, Observation>();

export interface ToolCallLog {
  tool: string;
  input?: unknown;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type RequestOutcome = "ok" | "error" | "aborted";

export interface Observation {
  requestId: string;
  toolCalls: ToolCallLog[];
  usage: TokenUsage;
  outcome?: RequestOutcome;
  errorCode?: string;
  error?: string;
}

export interface RequestLogEntry {
  level: "info";
  msg: "request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  outcome: RequestOutcome;
  errorCode?: string;
  error?: string;
  toolCalls: ToolCallLog[];
  usage: TokenUsage;
}

export function resolveRequestId(header: string | undefined): string {
  if (header !== undefined && REQUEST_ID.test(header)) {
    return header;
  }
  return randomUUID();
}

export function beginObservation(
  res: Response,
  requestId: string,
): Observation {
  const observation: Observation = {
    requestId,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  observations.set(res, observation);
  return observation;
}

export function readObservation(res: Response): Observation {
  const observation = observations.get(res);
  if (observation === undefined) {
    throw new Error("Request observation is missing");
  }
  return observation;
}

export function recordOutcome(
  res: Response,
  outcome: RequestOutcome,
  errorCode?: string,
): void {
  const observation = readObservation(res);
  observation.outcome = outcome;
  if (errorCode !== undefined) {
    observation.errorCode = errorCode;
  }
}

export function recordFailure(
  res: Response,
  errorCode: string,
  error: string,
): void {
  const observation = readObservation(res);
  observation.outcome = "error";
  observation.errorCode = errorCode;
  observation.error = error.slice(0, 500);
}

export function recordToolCall(
  res: Response,
  tool: string,
  input?: unknown,
): void {
  const call: ToolCallLog = input === undefined ? { tool } : { tool, input };
  readObservation(res).toolCalls.push(call);
}

export function addTokenUsage(res: Response, usage: TokenUsage): void {
  const current = readObservation(res).usage;
  current.inputTokens = addCount(current.inputTokens, usage.inputTokens);
  current.outputTokens = addCount(current.outputTokens, usage.outputTokens);
}

function addCount(current: number, value: number): number {
  if (!Number.isFinite(value)) {
    return current;
  }
  return current + value;
}
