import { z } from "zod";
import { retrieve } from "../retrieval/search.js";
import type { SearchHit } from "../schemas.js";
import type { ToolDefinition } from "./types.js";

const input = z.object({
  query: z.string().min(3),
  topK: z.number().int().min(1).max(10).default(5),
  tags: z.array(z.string()).optional(),
});

export const searchArchitectureDocs: ToolDefinition<typeof input, SearchHit[]> =
  {
    name: "search_architecture_docs",
    description:
      "Search the project's architecture notes. Use for any question about components, data flow, or decisions.",
    input,
    handler: (deps) => async (args) =>
      // RRF scores measure rank agreement. Return the top-k with no cutoff.
      retrieve(deps.index, args, { minScore: 0 }),
  };
