import type { IndexedChunk, SearchHit, SearchQuery } from "./schemas.js";

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingStamp {
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface NoteSummary {
  notePath: string;
  noteTitle: string;
  tags: string[];
  indexedAt: string;
}

export interface SearchIndex {
  upsert(chunks: IndexedChunk[]): Promise<void>;
  deleteByNotePath(notePath: string): Promise<void>;
  hybridSearch(q: SearchQuery): Promise<SearchHit[]>;
  listNoteHashes(): Promise<Map<string, string>>;
  listNotes(): Promise<NoteSummary[]>;
  readEmbeddingStamp(): Promise<EmbeddingStamp | null>;
}

export interface NoteStore {
  put(notePath: string, markdown: string): Promise<void>;
  get(notePath: string): Promise<string | null>;
  delete(notePath: string): Promise<void>;
}
