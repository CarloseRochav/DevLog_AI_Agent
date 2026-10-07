import type { IndexedChunk, SearchHit, SearchQuery } from "./schemas.js";

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SearchIndex {
  upsert(chunks: IndexedChunk[]): Promise<void>;
  deleteByNotePath(notePath: string): Promise<void>;
  hybridSearch(q: SearchQuery): Promise<SearchHit[]>;
  listNoteHashes(): Promise<Map<string, string>>;
}

export interface NoteStore {
  put(notePath: string, markdown: string): Promise<void>;
  get(notePath: string): Promise<string | null>;
  delete(notePath: string): Promise<void>;
}
