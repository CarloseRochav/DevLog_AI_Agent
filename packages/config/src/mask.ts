import type { IndexerConfig, ServerConfig } from "./env.js";

const SECRET_KEYS = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_SEARCH_API_KEY",
  "AZURE_STORAGE_CONNECTION_STRING",
  "AGENT_API_KEY",
] as const;

export function toLoggableConfig<T extends ServerConfig | IndexerConfig>(
  config: T,
): T {
  const copy = { ...config } as T & Record<string, unknown>;
  for (const key of SECRET_KEYS) {
    if (key in copy) {
      copy[key] = "***";
    }
  }
  return copy;
}
