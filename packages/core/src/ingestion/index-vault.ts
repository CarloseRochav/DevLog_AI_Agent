import type { Chunk, IndexedChunk } from "../schemas.js";
import type { Embedder, NoteStore, SearchIndex } from "../ports.js";
import { chunkNote } from "./chunk.js";
import { parseNote } from "./parse.js";
import type { VaultNote } from "./walk.js";

export class IndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

export interface IndexOptions {
  full: boolean;
  dryRun: boolean;
  embeddingModel: string;
  embeddingDimensions: number;
  maxTokens: number;
  overlapTokens: number;
  now?: string;
}

export interface IndexReport {
  notes: number;
  changed: number;
  unchanged: number;
  deleted: number;
  chunksUpserted: number;
  dryRun: boolean;
  elapsedMs: number;
  lines: string[];
  summary: string;
}

interface PreparedNote {
  note: VaultNote;
  chunks: Chunk[];
}

function stampMessage(
  indexModel: string,
  indexDimensions: number,
  configModel: string,
  configDimensions: number,
): string {
  const parts: string[] = [];
  if (indexModel !== configModel) {
    parts.push(
      `Embedding model is ${indexModel} in the index and ${configModel} in config.`,
    );
  }
  if (indexDimensions !== configDimensions) {
    parts.push(
      `Embedding dimensions are ${indexDimensions} in the index and ${configDimensions} in config.`,
    );
  }
  return `${parts.join(" ")} Re-run with --full.`;
}

function formatChunk(chunk: Chunk): string {
  const heading = chunk.headingPath.join(" > ");
  const label =
    heading === "" ? chunk.notePath : `${chunk.notePath} > ${heading}`;
  return `${label}\n${chunk.content}`;
}

function summaryLine(report: {
  notes: number;
  changed: number;
  unchanged: number;
  deleted: number;
  chunksUpserted: number;
  dryRun: boolean;
  elapsedMs: number;
}): string {
  const chunks = report.dryRun
    ? `${report.chunksUpserted} chunks`
    : `${report.chunksUpserted} chunks upserted`;
  const body = `${report.notes} notes · ${report.changed} changed · ${report.unchanged} unchanged · ${report.deleted} deleted · ${chunks} · ${(report.elapsedMs / 1000).toFixed(1)} s`;
  return report.dryRun ? `dry-run · ${body}` : body;
}

function prepare(
  note: VaultNote,
  options: IndexOptions,
  indexedAt: string,
): PreparedNote {
  const parsed = parseNote(note.markdown, note.notePath);
  return {
    note,
    chunks: chunkNote(parsed, {
      contentHash: note.contentHash,
      embeddingModel: options.embeddingModel,
      embeddingDimensions: options.embeddingDimensions,
      indexedAt,
      maxTokens: options.maxTokens,
      overlapTokens: options.overlapTokens,
    }),
  };
}

export async function indexVault(
  notes: VaultNote[],
  deps: { embedder: Embedder; index: SearchIndex; store: NoteStore },
  options: IndexOptions,
): Promise<IndexReport> {
  const started = Date.now();
  if (!options.full) {
    const stamp = await deps.index.readEmbeddingStamp();
    if (
      stamp !== null &&
      (stamp.embeddingModel !== options.embeddingModel ||
        stamp.embeddingDimensions !== options.embeddingDimensions)
    ) {
      throw new IndexError(
        stampMessage(
          stamp.embeddingModel,
          stamp.embeddingDimensions,
          options.embeddingModel,
          options.embeddingDimensions,
        ),
      );
    }
  }

  const indexed = await deps.index.listNoteHashes();
  const seen = new Set<string>();
  const toWrite: VaultNote[] = [];
  let unchanged = 0;
  for (const note of notes) {
    seen.add(note.notePath);
    const previous = indexed.get(note.notePath);
    if (!options.full && previous === note.contentHash) {
      unchanged += 1;
      continue;
    }
    toWrite.push(note);
  }

  const deleted = [...indexed.keys()]
    .filter((notePath) => !seen.has(notePath))
    .sort((left, right) => left.localeCompare(right));
  const indexedAt = options.now ?? new Date().toISOString();
  const prepared = toWrite.map((note) => prepare(note, options, indexedAt));
  const chunksUpserted = prepared.reduce(
    (count, item) => count + item.chunks.length,
    0,
  );

  if (options.dryRun) {
    const lines = prepared.flatMap((item) => item.chunks.map(formatChunk));
    for (const notePath of deleted) {
      lines.push(`delete ${notePath}`);
    }
    const elapsedMs = Date.now() - started;
    const report = {
      notes: notes.length,
      changed: toWrite.length,
      unchanged,
      deleted: deleted.length,
      chunksUpserted,
      dryRun: true,
      elapsedMs,
      lines,
    };
    return { ...report, summary: summaryLine(report) };
  }

  const flat = prepared.flatMap((item) => item.chunks);
  const vectors =
    flat.length === 0
      ? []
      : await deps.embedder.embed(flat.map((chunk) => chunk.embeddedText));
  if (vectors.length !== flat.length) {
    throw new Error(
      `Embedder returned ${vectors.length} vectors for ${flat.length} chunks`,
    );
  }

  let offset = 0;
  for (const item of prepared) {
    const indexedChunks: IndexedChunk[] = item.chunks.map((chunk) => {
      const vector = vectors[offset];
      offset += 1;
      if (vector === undefined) {
        throw new Error("Missing embedding for a chunk");
      }
      return { ...chunk, vector };
    });
    await deps.index.deleteByNotePath(item.note.notePath);
    if (indexedChunks.length > 0) {
      await deps.index.upsert(indexedChunks);
    }
    await deps.store.put(item.note.notePath, item.note.markdown);
  }

  for (const notePath of deleted) {
    await deps.index.deleteByNotePath(notePath);
    await deps.store.delete(notePath);
  }

  const elapsedMs = Date.now() - started;
  const report = {
    notes: notes.length,
    changed: toWrite.length,
    unchanged,
    deleted: deleted.length,
    chunksUpserted,
    dryRun: false,
    elapsedMs,
    lines: [] as string[],
  };
  return { ...report, summary: summaryLine(report) };
}
