import { z } from "zod";
import type { SearchIndex } from "../ports.js";
import { SearchQuerySchema, type SearchHit } from "../schemas.js";

// Tuned on eval/golden.jsonl. A hit in first place on both keyword and
// vector scores about 0.0333. The negative questions top out at about 0.0331.
export const DEFAULT_MIN_SCORE = 0.0332;

export class RetrievalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalError";
  }
}

function queryErrorMessage(error: z.ZodError): string {
  const shortQuery = error.issues.some(
    (issue) => issue.path[0] === "query" && issue.code === "too_small",
  );
  if (shortQuery) {
    return "Query must be at least 3 characters.";
  }
  return "Invalid search query.";
}

export async function retrieve(
  index: SearchIndex,
  query: z.input<typeof SearchQuerySchema>,
  options?: { minScore?: number },
): Promise<SearchHit[]> {
  const parsed = SearchQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new RetrievalError(queryErrorMessage(parsed.error));
  }
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const hits = await index.hybridSearch(parsed.data);
  return hits.filter((hit) => hit.score >= minScore);
}
