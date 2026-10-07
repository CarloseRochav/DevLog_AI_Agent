import {
  createSearchIndexClient,
  setupDevlogIndex,
  type DevlogIndexClient,
} from "@devlog/adapters";
import {
  ConfigError,
  parseIndexerEnv,
  type EnvSource,
  type IndexerConfig,
} from "@devlog/config";

export const packageName = "@devlog/cli";

export interface CliIO {
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface RunCliOptions {
  env: EnvSource;
  io: CliIO;
  openIndex?: (config: IndexerConfig) => DevlogIndexClient;
}

function usage(): string {
  return "Usage: pnpm cli index:setup";
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions,
): Promise<number> {
  if (argv[2] !== "index:setup") {
    options.io.error(usage());
    return 1;
  }

  let config: IndexerConfig;
  try {
    config = parseIndexerEnv(options.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      options.io.error(error.message);
      return 1;
    }
    throw error;
  }

  const client =
    options.openIndex === undefined
      ? createSearchIndexClient(
          config.AZURE_SEARCH_ENDPOINT,
          config.AZURE_SEARCH_API_KEY,
        )
      : options.openIndex(config);
  const result = await setupDevlogIndex(
    client,
    config.AZURE_SEARCH_INDEX,
    config.EMBEDDING_DIMENSIONS,
  );
  options.io.log(`${result} index ${config.AZURE_SEARCH_INDEX}`);
  return 0;
}
