import { z } from "zod";
import type { NoteSummary } from "../ports.js";
import type { ToolDefinition } from "./types.js";

const input = z.object({});

export const listNotes: ToolDefinition<typeof input, NoteSummary[]> = {
  name: "list_notes",
  description:
    "List the indexed notes with title, path, tags, and indexedAt. Use when asked what notes exist, or to choose a note path.",
  input,
  handler: (deps) => async () => deps.index.listNotes(),
};
