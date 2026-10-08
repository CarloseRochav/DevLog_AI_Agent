import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
  EvalError,
  IndexError,
  RetrievalError,
  evaluateRetrieval,
  indexVault,
  parseGoldenSet,
  retrieve,
  walkVault,
  type EvalReport,
  type IndexReport,
  type SearchHit,
  type SearchIndex,
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

export interface QueryFlags {
  query: string;
  topK: number;
  tags: string[];
  notePath?: string;
}

export interface EvalFlags {
  threshold?: number;
}

export interface EvalPaths {
  vaultDir: string;
  goldenPath: string;
  resultsDir: string;
  now?: string;
}

export interface RunCliOptions {
  env: EnvSource;
  io: CliIO;
  openIndex?: (config: IndexerConfig) => DevlogIndexClient;
  runIndex?: (config: IndexerConfig, flags: IndexFlags) => Promise<IndexReport>;
  runQuery?: (config: IndexerConfig, flags: QueryFlags) => Promise<SearchHit[]>;
  runEval?: (config: IndexerConfig, flags: EvalFlags) => Promise<EvalReport>;
  evalPaths?: EvalPaths;
}

function usage(): string {
  return [
    "Usage: pnpm cli index:setup",
    "       pnpm cli index [--dry-run] [--full]",
    "       pnpm cli query <text> [--top N] [--tag <tag>] [--note <path>]",
    "       pnpm cli eval [--threshold N]",
  ].join("\n");
}

const EVAL_INCLUDE = "devlog-agent/**/*.md";

function defaultEvalPaths(): EvalPaths {
  return {
    vaultDir: path.resolve("eval/vault"),
    goldenPath: path.resolve("eval/golden.jsonl"),
    resultsDir: path.resolve("eval/results"),
  };
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

function parseQueryArgs(
  args: readonly string[],
): { ok: true; flags: QueryFlags } | { ok: false; reason: "usage" | "short" } {
  let query: string | undefined;
  let topK = 5;
  const tags: string[] = [];
  let notePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      return { ok: false, reason: "usage" };
    }
    if (arg === "--top" || arg === "--tag" || arg === "--note") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, reason: "usage" };
      }
      index += 1;
      if (arg === "--top") {
        if (!/^(?:[1-9]|10)$/.test(value)) {
          return { ok: false, reason: "usage" };
        }
        topK = Number(value);
      } else if (arg === "--tag") {
        tags.push(value);
      } else if (notePath !== undefined) {
        return { ok: false, reason: "usage" };
      } else {
        notePath = value;
      }
      continue;
    }
    if (arg.startsWith("--") || query !== undefined) {
      return { ok: false, reason: "usage" };
    }
    query = arg;
  }

  if (query === undefined) {
    return { ok: false, reason: "usage" };
  }
  if (query.length < 3) {
    return { ok: false, reason: "short" };
  }

  return {
    ok: true,
    flags: {
      query,
      topK,
      tags,
      ...(notePath === undefined ? {} : { notePath }),
    },
  };
}

function parseEvalArgs(
  args: readonly string[],
): { ok: true; flags: EvalFlags } | { ok: false } {
  let threshold: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--threshold") {
      return { ok: false };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false };
    }
    index += 1;
    if (threshold !== undefined || !/^(?:\d+)(?:\.\d+)?$/.test(value)) {
      return { ok: false };
    }
    threshold = Number(value);
  }
  return {
    ok: true,
    flags: { threshold: threshold ?? 0 },
  };
}

function resultFileName(timestamp: string): string {
  return `${timestamp.replaceAll(":", "-")}.json`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForNotes(
  index: SearchIndex,
  notePaths: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const hashes = await index.listNoteHashes();
    if (notePaths.every((notePath) => hashes.has(notePath))) {
      return;
    }
    await delay(1000);
  }
  throw new EvalError(
    "Indexed notes were not visible in search before the deadline.",
  );
}

async function writeEvalResult(
  report: EvalReport,
  resultsDir: string,
): Promise<void> {
  await mkdir(resultsDir, { recursive: true });
  const body = {
    timestamp: report.timestamp,
    threshold: report.threshold,
    hitAt5: report.hitAt5,
    mrr: report.mrr,
    passed: report.passed,
    questions: report.questions,
  };
  await writeFile(
    path.join(resultsDir, resultFileName(report.timestamp)),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
}

function formatHits(hits: readonly SearchHit[]): string[] {
  if (hits.length === 0) {
    return ["0 hits"];
  }
  const lines: string[] = [];
  for (const [index, hit] of hits.entries()) {
    if (index > 0) {
      lines.push("");
    }
    lines.push(`${hit.score.toFixed(3)}  ${hit.citation}`);
    lines.push(hit.content);
  }
  return lines;
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

async function queryIndex(
  config: IndexerConfig,
  flags: QueryFlags,
): Promise<SearchHit[]> {
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
  return retrieve(index, {
    query: flags.query,
    topK: flags.topK,
    ...(flags.tags.length === 0 ? {} : { tags: flags.tags }),
    ...(flags.notePath === undefined ? {} : { notePath: flags.notePath }),
  });
}

async function runQueryCommand(
  config: IndexerConfig,
  flags: QueryFlags,
  options: RunCliOptions,
): Promise<number> {
  try {
    const hits = await (options.runQuery ?? queryIndex)(config, flags);
    for (const line of formatHits(hits)) {
      options.io.log(line);
    }
    return 0;
  } catch (error) {
    if (error instanceof RetrievalError) {
      options.io.error(error.message);
      return 1;
    }
    throw error;
  }
}

async function evalCommand(
  config: IndexerConfig,
  flags: EvalFlags,
  paths: EvalPaths,
): Promise<EvalReport> {
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
  const notes = await walkVault(paths.vaultDir, EVAL_INCLUDE);
  await indexVault(
    notes,
    { embedder, index, store },
    {
      full: false,
      dryRun: false,
      prune: false,
      embeddingModel: config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      embeddingDimensions: config.EMBEDDING_DIMENSIONS,
      maxTokens: config.CHUNK_MAX_TOKENS,
      overlapTokens: config.CHUNK_OVERLAP_TOKENS,
    },
  );
  await waitForNotes(
    index,
    notes.map((note) => note.notePath),
  );
  const questions = parseGoldenSet(await readFile(paths.goldenPath, "utf8"));
  const minScore = flags.threshold ?? 0;
  const hitsById = new Map<string, SearchHit[]>();
  for (const question of questions) {
    hitsById.set(
      question.id,
      await retrieve(
        index,
        { query: question.question, topK: 5 },
        { minScore },
      ),
    );
  }
  return evaluateRetrieval(questions, hitsById, {
    threshold: minScore,
    timestamp: paths.now ?? new Date().toISOString(),
  });
}

async function runEvalCommand(
  config: IndexerConfig,
  flags: EvalFlags,
  options: RunCliOptions,
): Promise<number> {
  const paths = options.evalPaths ?? defaultEvalPaths();
  try {
    const report = await (
      options.runEval ??
      ((evalConfig, evalFlags) => evalCommand(evalConfig, evalFlags, paths))
    )(config, flags);
    for (const line of report.lines) {
      options.io.log(line);
    }
    options.io.log(report.summary);
    await writeEvalResult(report, paths.resultsDir);
    return report.passed ? 0 : 1;
  } catch (error) {
    if (
      error instanceof RetrievalError ||
      error instanceof IndexError ||
      error instanceof EvalError
    ) {
      options.io.error(error.message);
      return 1;
    }
    throw error;
  }
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
  if (
    command !== "index:setup" &&
    command !== "index" &&
    command !== "query" &&
    command !== "eval"
  ) {
    options.io.error(usage());
    return 1;
  }

  let indexFlags: IndexFlags | undefined;
  let queryFlags: QueryFlags | undefined;
  let evalFlags: EvalFlags | undefined;
  if (command === "index") {
    indexFlags = parseIndexFlags(argv.slice(3));
    if (indexFlags === undefined) {
      options.io.error(usage());
      return 1;
    }
  } else if (command === "query") {
    const parsedQuery = parseQueryArgs(argv.slice(3));
    if (!parsedQuery.ok) {
      options.io.error(
        parsedQuery.reason === "short"
          ? "Query must be at least 3 characters."
          : usage(),
      );
      return 1;
    }
    queryFlags = parsedQuery.flags;
  } else if (command === "eval") {
    const parsedEval = parseEvalArgs(argv.slice(3));
    if (!parsedEval.ok) {
      options.io.error(usage());
      return 1;
    }
    evalFlags = parsedEval.flags;
  }

  const parsed = readConfig(options);
  if (!parsed.ok) {
    return 1;
  }

  if (command === "query" && queryFlags !== undefined) {
    return runQueryCommand(parsed.config, queryFlags, options);
  }
  if (command === "eval" && evalFlags !== undefined) {
    return runEvalCommand(parsed.config, evalFlags, options);
  }
  if (indexFlags === undefined) {
    return runSetup(parsed.config, options);
  }
  return runIndexCommand(parsed.config, indexFlags, options);
}
