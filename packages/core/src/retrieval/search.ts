import { z } from "zod";
import type { SearchIndex } from "../ports.js";
import { SearchQuerySchema, type SearchHit } from "../schemas.js";

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
): Promise<SearchHit[]> {
  const parsed = SearchQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new RetrievalError(queryErrorMessage(parsed.error));
  }
  return index.hybridSearch(parsed.data);
}
