import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { ChunkSchema, type Chunk } from "../schemas.js";
import type { ParsedBlock, ParsedNote } from "./parse.js";

const SMALL_SECTION_TOKENS = 50;
const encoder = getEncoding("cl100k_base");

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
  contentHash: string;
  embeddingModel: string;
  embeddingDimensions: number;
  indexedAt: string;
}

type Piece =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "table"; text: string };

interface Section {
  parentPath: string[];
  headings: string[];
  depth: number;
  pieces: Piece[];
}

function countTokens(text: string): number {
  if (text === "") {
    return 0;
  }
  return encoder.encode(text).length;
}

function render(pieces: Piece[]): string {
  return pieces
    .map((piece) => piece.text)
    .filter((text) => text !== "")
    .join("\n\n");
}

function samePath(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

function isSibling(left: Section, right: Section): boolean {
  return (
    left.depth === right.depth && samePath(left.parentPath, right.parentPath)
  );
}

function combine(left: Section, right: Section): Section {
  return {
    parentPath: left.parentPath,
    headings: [...left.headings, ...right.headings],
    depth: left.depth,
    pieces: [...left.pieces, ...right.pieces],
  };
}

function isSmall(section: Section): boolean {
  return countTokens(render(section.pieces)) < SMALL_SECTION_TOKENS;
}

function pieceFrom(block: ParsedBlock): Piece {
  if (block.type === "code") {
    return { kind: "code", lang: block.lang, text: block.text };
  }
  if (block.type === "table") {
    return { kind: "table", text: block.text };
  }
  return { kind: "text", text: block.text };
}

function sectionsFrom(note: ParsedNote): Section[] {
  const stack: { depth: number; text: string }[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  function start(depth: number, text: string): void {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
      stack.pop();
    }
    current = {
      parentPath: stack.map((item) => item.text),
      headings: [text],
      depth,
      pieces: [],
    };
    stack.push({ depth, text });
    sections.push(current);
  }

  for (const block of note.blocks) {
    if (block.type === "heading" && block.depth <= 3) {
      start(block.depth, block.text);
      continue;
    }
    if (!current) {
      current = { parentPath: [], headings: [], depth: 0, pieces: [] };
      sections.push(current);
    }
    current.pieces.push(pieceFrom(block));
  }

  return sections.filter((section) => section.pieces.length > 0);
}

function mergeSmallSections(sections: Section[]): Section[] {
  const forward: Section[] = [];
  for (const section of sections) {
    const previous = forward[forward.length - 1];
    if (previous && isSmall(previous) && isSibling(previous, section)) {
      forward[forward.length - 1] = combine(previous, section);
    } else {
      forward.push(section);
    }
  }

  const merged: Section[] = [];
  for (const section of forward) {
    const previous = merged[merged.length - 1];
    if (previous && isSmall(section) && isSibling(previous, section)) {
      merged[merged.length - 1] = combine(previous, section);
    } else {
      merged.push(section);
    }
  }
  return merged;
}

function overlapPieces(pieces: Piece[], overlapTokens: number): Piece[] {
  let chosen: Piece[] = [];
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (!piece || piece.kind === "code" || piece.kind === "table") {
      break;
    }
    const candidate = [piece, ...chosen];
    if (candidate.length === pieces.length) {
      break;
    }
    if (countTokens(render(candidate)) > overlapTokens) {
      break;
    }
    chosen = candidate;
  }
  return chosen;
}

function splitPieces(
  pieces: Piece[],
  maxTokens: number,
  overlapTokens: number,
): Piece[][] {
  const groups: Piece[][] = [];
  let current: Piece[] = [];

  for (const piece of pieces) {
    if (countTokens(piece.text) > maxTokens) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
      }
      groups.push([piece]);
      continue;
    }
    if (
      current.length > 0 &&
      countTokens(render([...current, piece])) > maxTokens
    ) {
      const overlap = overlapPieces(current, overlapTokens);
      groups.push(current);
      current = overlap;
      if (
        current.length > 0 &&
        countTokens(render([...current, piece])) > maxTokens
      ) {
        current = [];
      }
    }
    current.push(piece);
  }

  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function headingPath(section: Section): string[] {
  return [...section.parentPath, ...section.headings];
}

function prefixLine(noteTitle: string, path: string[]): string {
  const parts = [...path];
  if (parts[0] !== noteTitle) {
    parts.unshift(noteTitle);
  }
  if (parts.length === 0) {
    parts.push(noteTitle);
  }
  return `[${parts.join(" > ")}]`;
}

function chunkId(notePath: string, ordinal: number): string {
  return createHash("sha1")
    .update(`${notePath}#${ordinal}`)
    .digest("base64url");
}

export function chunkNote(note: ParsedNote, options: ChunkOptions): Chunk[] {
  const maxTokens = options.maxTokens ?? 700;
  const overlapTokens = options.overlapTokens ?? 80;
  const sections = mergeSmallSections(sectionsFrom(note));
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const path = headingPath(section);
    const prefix = prefixLine(note.noteTitle, path);
    for (const group of splitPieces(section.pieces, maxTokens, overlapTokens)) {
      const content = render(group);
      if (content === "") {
        continue;
      }
      const embeddedText = `${prefix}\n${content}`;
      const ordinal = chunks.length;
      chunks.push(
        ChunkSchema.parse({
          id: chunkId(note.notePath, ordinal),
          notePath: note.notePath,
          noteTitle: note.noteTitle,
          headingPath: path,
          ordinal,
          content,
          embeddedText,
          tags: [...note.tags],
          links: [...note.links],
          hasCode: group.some((piece) => piece.kind === "code"),
          hasMermaid: group.some(
            (piece) =>
              piece.kind === "code" && piece.lang?.toLowerCase() === "mermaid",
          ),
          contentHash: options.contentHash,
          tokenCount: countTokens(embeddedText),
          embeddingModel: options.embeddingModel,
          embeddingDimensions: options.embeddingDimensions,
          indexedAt: options.indexedAt,
        }),
      );
    }
  }

  return chunks;
}
