import type {
  Embedder,
  EmbeddingStamp,
  NoteStore,
  SearchIndex,
} from "./ports.js";
import type { IndexedChunk, SearchHit, SearchQuery } from "./schemas.js";

function vectorFor(text: string, dimensions: number): number[] {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 33 + (char.codePointAt(0) ?? 0)) >>> 0;
  }

  const values: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    hash = (hash * 1664525 + 1013904223 + index) >>> 0;
    values.push((hash % 1000) / 1000);
  }
  return values;
}

function citation(chunk: IndexedChunk): string {
  return [chunk.noteTitle, ...chunk.headingPath].join(" > ");
}

export class InMemoryEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? "fake-embedder";
    this.dimensions = options?.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => vectorFor(text, this.dimensions));
  }
}

export class InMemorySearchIndex implements SearchIndex {
  private readonly chunks = new Map<string, IndexedChunk>();

  async upsert(chunks: IndexedChunk[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, { ...chunk });
    }
  }

  async deleteByNotePath(notePath: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.notePath === notePath) {
        this.chunks.delete(id);
      }
    }
  }

  async hybridSearch(q: SearchQuery): Promise<SearchHit[]> {
    const needle = q.query.toLowerCase();
    const tags = q.tags ?? [];
    return [...this.chunks.values()]
      .filter((chunk) => chunk.content.toLowerCase().includes(needle))
      .filter((chunk) => tags.every((tag) => chunk.tags.includes(tag)))
      .filter(
        (chunk) => q.notePath === undefined || chunk.notePath === q.notePath,
      )
      .sort((left, right) => left.ordinal - right.ordinal)
      .slice(0, q.topK)
      .map((chunk) => ({
        chunkId: chunk.id,
        notePath: chunk.notePath,
        noteTitle: chunk.noteTitle,
        headingPath: [...chunk.headingPath],
        content: chunk.content,
        score: 1,
        citation: citation(chunk),
      }));
  }

  async listNoteHashes(): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const chunk of this.chunks.values()) {
      hashes.set(chunk.notePath, chunk.contentHash);
    }
    return hashes;
  }

  async readEmbeddingStamp(): Promise<EmbeddingStamp | null> {
    const first = this.chunks.values().next().value;
    if (first === undefined) {
      return null;
    }
    return {
      embeddingModel: first.embeddingModel,
      embeddingDimensions: first.embeddingDimensions,
    };
  }
}

export class InMemoryNoteStore implements NoteStore {
  private readonly notes = new Map<string, string>();

  async put(notePath: string, markdown: string): Promise<void> {
    this.notes.set(notePath, markdown);
  }

  async get(notePath: string): Promise<string | null> {
    return this.notes.get(notePath) ?? null;
  }

  async delete(notePath: string): Promise<void> {
    this.notes.delete(notePath);
  }
}
