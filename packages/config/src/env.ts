import { prettifyError, z } from "zod";

const Base = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  AZURE_OPENAI_ENDPOINT: z.url(),
  AZURE_OPENAI_API_KEY: z.string().min(1),
  AZURE_OPENAI_API_VERSION: z.string().default("<API_VERSION_PLACEHOLDER>"),
  AZURE_OPENAI_CHAT_DEPLOYMENT: z
    .string()
    .default("<CHAT_DEPLOYMENT_PLACEHOLDER>"),
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z
    .string()
    .default("<EMBEDDING_DEPLOYMENT_PLACEHOLDER>"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive(),
  CHAT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),

  AZURE_SEARCH_ENDPOINT: z.url(),
  AZURE_SEARCH_API_KEY: z.string().min(1),
  AZURE_SEARCH_INDEX: z.string().default("devlog-chunks"),

  AZURE_STORAGE_CONNECTION_STRING: z.string().min(1),
  AZURE_STORAGE_CONTAINER: z.string().default("devlog-notes"),
});

export const ServerEnv = Base.extend({
  PORT: z.coerce.number().default(3000),
  AGENT_API_KEY: z.string().min(32),
  CORS_ORIGIN: z.string().default("<FRONTEND_ORIGIN_PLACEHOLDER>"),
  HISTORY_MAX_MESSAGES: z.coerce.number().int().default(20),
});

export const IndexerEnv = Base.extend({
  VAULT_PATH: z.string().min(1),
  VAULT_INCLUDE: z.string().default("devlog-agent/**/*.md"),
  CHUNK_MAX_TOKENS: z.coerce.number().int().default(700),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().default(80),
});

export type ServerConfig = z.infer<typeof ServerEnv>;
export type IndexerConfig = z.infer<typeof IndexerEnv>;

export type EnvSource = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseEnv<T extends z.ZodType>(
  schema: T,
  source: EnvSource,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(prettifyError(result.error));
  }
  return result.data;
}

function loadEnv<T>(parse: (source: EnvSource) => T, source: EnvSource): T {
  try {
    return parse(source);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

export function parseServerEnv(source: EnvSource): ServerConfig {
  return parseEnv(ServerEnv, source);
}

export function parseIndexerEnv(source: EnvSource): IndexerConfig {
  return parseEnv(IndexerEnv, source);
}

export function loadServerEnv(source: EnvSource = process.env): ServerConfig {
  return loadEnv(parseServerEnv, source);
}

export function loadIndexerEnv(source: EnvSource = process.env): IndexerConfig {
  return loadEnv(parseIndexerEnv, source);
}
