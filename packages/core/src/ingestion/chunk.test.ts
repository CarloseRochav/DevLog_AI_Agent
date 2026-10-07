import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { expect, test } from "vitest";
import { chunkNote, type ChunkOptions } from "./chunk.js";
import { parseNote } from "./parse.js";

const encoder = getEncoding("cl100k_base");

const base: ChunkOptions = {
  contentHash: "hash",
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 1536,
  indexedAt: "2026-01-01T00:00:00.000Z",
};

function tokens(text: string): number {
  return encoder.encode(text).length;
}

function longBody(): string {
  let text = "token";
  while (tokens(text) < 50) {
    text = `${text} token`;
  }
  return text;
}

test("prefixes embedded text with the note title and heading path", () => {
  const note = parseNote(
    `---
tags:
  - worker
---

# Architecture

## Background Processing

### Queue Worker

The worker calls [[sp_ProcessBatch|the procedure]].

#### Detail

H4 stays with its parent.
`,
    "devlog-agent/Architecture.md",
  );
  const chunks = chunkNote(note, base);
  const prefix = "[Architecture > Background Processing > Queue Worker]";

  expect(chunks).toHaveLength(1);
  const chunk = chunks[0];
  expect(chunk?.headingPath).toEqual([
    "Architecture",
    "Background Processing",
    "Queue Worker",
  ]);
  expect(chunk?.embeddedText.startsWith(`${prefix}\n`)).toBe(true);
  expect(chunk?.content.startsWith("[")).toBe(false);
  expect(chunk?.content).toContain("the procedure");
  expect(chunk?.content).toContain("Detail");
  expect(chunk?.content).toContain("H4 stays with its parent.");
  expect(chunk?.headingPath).not.toContain("Detail");
  expect(chunk?.tags).toEqual(["worker"]);
  expect(chunk?.links).toEqual(["sp_ProcessBatch"]);
  expect(chunk?.hasCode).toBe(false);
  expect(chunk?.hasMermaid).toBe(false);
  expect(chunk?.tokenCount).toBe(tokens(chunk?.embeddedText ?? ""));
  expect(chunk?.id).toBe(
    createHash("sha1")
      .update("devlog-agent/Architecture.md#0")
      .digest("base64url"),
  );
});

test("keeps code, mermaid, and tables whole", () => {
  const markdown = `# Architecture

## Jobs

Before the fence.

\`\`\`ts
const value = "do-not-split-this-fence";
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

| Procedure | Caller |
| --- | --- |
| sp_ProcessBatch | Worker |
`;
  const note = parseNote(markdown, "devlog-agent/Jobs.md");
  const code = note.blocks.find(
    (block) => block.type === "code" && block.lang === "ts",
  );
  const mermaid = note.blocks.find(
    (block) => block.type === "code" && block.lang === "mermaid",
  );
  const table = note.blocks.find((block) => block.type === "table");
  expect(code?.type).toBe("code");
  expect(mermaid?.type).toBe("code");
  expect(table?.type).toBe("table");
  if (
    code?.type !== "code" ||
    mermaid?.type !== "code" ||
    table?.type !== "table"
  ) {
    return;
  }

  const chunks = chunkNote(note, {
    ...base,
    maxTokens: 8,
    overlapTokens: 0,
  });

  expect(chunks.filter((chunk) => chunk.content === code.text)).toHaveLength(1);
  expect(chunks.filter((chunk) => chunk.content === mermaid.text)).toHaveLength(
    1,
  );
  expect(chunks.filter((chunk) => chunk.content === table.text)).toHaveLength(
    1,
  );
  expect(chunks.some((chunk) => chunk.hasCode && chunk.hasMermaid)).toBe(true);
  expect(
    chunks.some((chunk) => chunk.hasCode && chunk.content === code.text),
  ).toBe(true);
});

test("splits an oversized section on paragraphs and overlaps", () => {
  const paragraph = "Alpha paragraph stays whole.";
  const separator = tokens("\n\n");
  const note = parseNote(
    `# Topic

${Array.from({ length: 6 }, () => paragraph).join("\n\n")}
`,
    "devlog-agent/Topic.md",
  );
  const chunks = chunkNote(note, {
    ...base,
    maxTokens: tokens(paragraph) * 2 + separator,
    overlapTokens: tokens(paragraph),
  });

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(
      chunk.content.split("\n\n").every((part) => part === paragraph),
    ).toBe(true);
  }
  const shared = chunks.some((chunk, index) => {
    const previous = chunks[index - 1];
    if (!previous) {
      return false;
    }
    return previous.content
      .split("\n\n")
      .some((part) => chunk.content.includes(part));
  });
  expect(shared).toBe(true);
});

test("merges a section under 50 tokens into the next sibling", () => {
  const body = longBody();
  const note = parseNote(
    `# Architecture

## Short

Hi.

## Long

${body}

## Later

${body}
`,
    "devlog-agent/Merge.md",
  );
  const chunks = chunkNote(note, base);

  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.headingPath).toEqual(["Architecture", "Short", "Long"]);
  expect(
    chunks[0]?.embeddedText.startsWith("[Architecture > Short > Long]\n"),
  ).toBe(true);
  expect(chunks[0]?.content).toContain("Hi.");
  expect(chunks[0]?.content).toContain(body);
  expect(chunks[1]?.headingPath).toEqual(["Architecture", "Later"]);
  expect(chunks[1]?.content).not.toContain("Hi.");
});

test("merges a trailing small section into the previous sibling", () => {
  const body = longBody();
  const note = parseNote(
    `# Architecture

## Long

${body}

## Tail

Hi.
`,
    "devlog-agent/Tail.md",
  );
  const chunks = chunkNote(note, base);

  expect(chunks).toHaveLength(1);
  expect(chunks[0]?.headingPath).toEqual(["Architecture", "Long", "Tail"]);
  expect(chunks[0]?.content).toContain(body);
  expect(chunks[0]?.content).toContain("Hi.");
});
