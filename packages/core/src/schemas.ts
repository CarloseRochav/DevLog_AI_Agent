import { z } from "zod";

export const ChunkSchema = z.object({
  id: z.string(),
  notePath: z.string(),
  noteTitle: z.string(),
  headingPath: z.array(z.string()),
  ordinal: z.number().int(),
  content: z.string(),
  embeddedText: z.string(),
  tags: z.array(z.string()),
  links: z.array(z.string()),
  hasCode: z.boolean(),
  hasMermaid: z.boolean(),
  contentHash: z.string(),
  tokenCount: z.number().int(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number().int(),
  indexedAt: z.iso.datetime(),
});

export type Chunk = z.infer<typeof ChunkSchema>;

export type IndexedChunk = Chunk & {
  vector: number[];
};

export const SearchQuerySchema = z.object({
  query: z.string().min(3),
  topK: z.number().int().min(1).max(10).default(5),
  tags: z.array(z.string()).optional(),
  notePath: z.string().optional(),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchHitSchema = z.object({
  chunkId: z.string(),
  notePath: z.string(),
  noteTitle: z.string(),
  headingPath: z.array(z.string()),
  content: z.string(),
  score: z.number(),
  citation: z.string(),
});

export type SearchHit = z.infer<typeof SearchHitSchema>;
