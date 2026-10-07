export {
  InMemoryEmbedder,
  InMemoryNoteStore,
  InMemorySearchIndex,
} from "./fakes.js";
export type { Embedder, NoteStore, SearchIndex } from "./ports.js";
export {
  ChunkSchema,
  SearchHitSchema,
  SearchQuerySchema,
  type Chunk,
  type IndexedChunk,
  type SearchHit,
  type SearchQuery,
} from "./schemas.js";
