import {
  AzureEmbedder,
  AzureNoteStore,
  createAzureSearchIndex,
  createNoteBlob,
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
import {
  IndexError,
  indexVault,
  walkVault,
  type IndexReport,
} from "@devlog/core";

export const packageName = "@devlog/cli";

export interface CliIO {
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface IndexFlags {
  dryRun: boolean;
  full: boolean;
}

export interface RunCliOptions {
  env: EnvSource;
  io: CliIO;
  openIndex?: (config: IndexerConfig) => DevlogIndexClient;
  runIndex?: (config: IndexerConfig, flags: IndexFlags) => Promise<IndexReport>;
}

function usage(): string {
  return [
    "Usage: pnpm cli index:setup",
    "       pnpm cli index [--dry-run] [--full]",
  ].join("\n");
}

function parseIndexFlags(args: readonly string[]): IndexFlags | undefined {
  let dryRun = false;
  let full = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--full") {
      full = true;
    } else {
      return undefined;
    }
  }
  return { dryRun, full };
}

function readConfig(
  options: RunCliOptions,
): { ok: true; config: IndexerConfig } | { ok: false } {
  try {
    return { ok: true, config: parseIndexerEnv(options.env) };
  } catch (error) {
    if (error instanceof ConfigError) {
      options.io.error(error.message);
      return { ok: false };
    }
    throw error;
  }
}

async function indexVaultCommand(
  config: IndexerConfig,
  flags: IndexFlags,
): Promise<IndexReport> {
  const embedder = new AzureEmbedder({
    endpoint: config.AZURE_OPENAI_ENDPOINT,
    apiKey: config.AZURE_OPENAI_API_KEY,
    deployment: config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    dimensions: config.EMBEDDING_DIMENSIONS,
  });
  const index = createAzureSearchIndex({
    endpoint: config.AZURE_SEARCH_ENDPOINT,
    apiKey: config.AZURE_SEARCH_API_KEY,
    indexName: config.AZURE_SEARCH_INDEX,
    embedder,
  });
  const store = new AzureNoteStore(
    createNoteBlob(
      config.AZURE_STORAGE_CONNECTION_STRING,
      config.AZURE_STORAGE_CONTAINER,
    ),
  );
  const notes = await walkVault(config.VAULT_PATH, config.VAULT_INCLUDE);
  return indexVault(
    notes,
    { embedder, index, store },
    {
      full: flags.full,
      dryRun: flags.dryRun,
      embeddingModel: config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      embeddingDimensions: config.EMBEDDING_DIMENSIONS,
      maxTokens: config.CHUNK_MAX_TOKENS,
      overlapTokens: config.CHUNK_OVERLAP_TOKENS,
    },
  );
}

async function runSetup(
  config: IndexerConfig,
  options: RunCliOptions,
): Promise<number> {
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

async function runIndexCommand(
  config: IndexerConfig,
  flags: IndexFlags,
  options: RunCliOptions,
): Promise<number> {
  try {
    const report = await (options.runIndex ?? indexVaultCommand)(config, flags);
    for (const line of report.lines) {
      options.io.log(line);
    }
    options.io.log(report.summary);
    return 0;
  } catch (error) {
    if (error instanceof IndexError) {
      options.io.error(error.message);
      return 1;
    }
    throw error;
  }
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions,
): Promise<number> {
  const command = argv[2];
  if (command !== "index:setup" && command !== "index") {
    options.io.error(usage());
    return 1;
  }

  let flags: IndexFlags | undefined;
  if (command === "index") {
    flags = parseIndexFlags(argv.slice(3));
    if (flags === undefined) {
      options.io.error(usage());
      return 1;
    }
  }

  const parsed = readConfig(options);
  if (!parsed.ok) {
    return 1;
  }

  if (flags === undefined) {
    return runSetup(parsed.config, options);
  }
  return runIndexCommand(parsed.config, flags, options);
}
