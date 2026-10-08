import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";

const NOTE_TOKEN_LIMIT = 8000;
const encoder = getEncoding("cl100k_base");

const input = z.object({
  notePath: z.string().min(1),
});

export type ReadNoteResult =
  { notePath: string; content: string; truncated: boolean } | { error: string };

function truncateNote(markdown: string): {
  content: string;
  truncated: boolean;
} {
  const tokens = encoder.encode(markdown);
  if (tokens.length <= NOTE_TOKEN_LIMIT) {
    return { content: markdown, truncated: false };
  }
  return {
    content: encoder.decode(tokens.slice(0, NOTE_TOKEN_LIMIT)),
    truncated: true,
  };
}

export const readNote: ToolDefinition<typeof input, ReadNoteResult> = {
  name: "read_note",
  description:
    "Read the full Markdown of one architecture note. The text is truncated at 8000 tokens. Use when a search chunk is incomplete or the user names a note.",
  input,
  handler: (deps) => async (args) => {
    const markdown = await deps.notes.get(args.notePath);
    if (markdown === null) {
      return { error: `Note not found: ${args.notePath}` };
    }
    return { notePath: args.notePath, ...truncateNote(markdown) };
  },
};
