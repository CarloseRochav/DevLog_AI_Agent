export {
  InMemoryEmbedder,
  InMemoryNoteStore,
  InMemorySearchIndex,
} from "./fakes.js";
export type {
  Embedder,
  EmbeddingStamp,
  NoteStore,
  SearchIndex,
} from "./ports.js";
export { chunkNote, type ChunkOptions } from "./ingestion/chunk.js";
export {
  IndexError,
  indexVault,
  type IndexOptions,
  type IndexReport,
} from "./ingestion/index-vault.js";
export { walkVault, type VaultNote } from "./ingestion/walk.js";
export { RetrievalError, retrieve } from "./retrieval/search.js";
export {
  parseNote,
  ParsedBlockSchema,
  ParsedNoteSchema,
  type ParsedBlock,
  type ParsedNote,
} from "./ingestion/parse.js";
export {
  ChunkSchema,
  SearchHitSchema,
  SearchQuerySchema,
  type Chunk,
  type IndexedChunk,
  type SearchHit,
  type SearchQuery,
} from "./schemas.js";
