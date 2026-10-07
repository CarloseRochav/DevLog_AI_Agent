export const packageName = "@devlog/adapters";

export { AzureEmbedder, type AzureEmbedderOptions } from "./embedder.js";
export { AzureNoteStore, createNoteBlob, type NoteBlob } from "./blob.js";
export {
  AzureSearchIndex,
  createAzureSearchIndex,
  createSearchIndexClient,
  devlogChunksIndex,
  ensureDevlogIndex,
  type AzureSearchClientOptions,
  type DevlogDocument,
  type DocumentClient,
  type DocumentHit,
  type DocumentSearchRequest,
  type IndexingOutcome,
} from "./search.js";
