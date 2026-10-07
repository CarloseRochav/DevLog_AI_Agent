export {
  InMemoryEmbedder,
  InMemoryNoteStore,
  InMemorySearchIndex,
} from "./fakes.js";
export type { Embedder, NoteStore, SearchIndex } from "./ports.js";
export { chunkNote, type ChunkOptions } from "./ingestion/chunk.js";
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
