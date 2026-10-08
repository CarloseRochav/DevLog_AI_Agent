import type { z } from "zod";
import type { NoteStore, SearchIndex } from "../ports.js";

export interface ToolDeps {
  index: SearchIndex;
  notes: NoteStore;
}

export interface ToolDefinition<TInput extends z.ZodType, TOutput> {
  name: string;
  description: string;
  input: TInput;
  handler: (deps: ToolDeps) => (args: z.infer<TInput>) => Promise<TOutput>;
}
