import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseNote } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("parses frontmatter, links, callouts, and mermaid", () => {
  const note = parseNote(
    fixture("architecture.md"),
    "devlog-agent/Architecture.md",
  );

  expect(note.notePath).toBe("devlog-agent/Architecture.md");
  expect(note.noteTitle).toBe("Architecture");
  expect(note.tags).toEqual(["worker", "queue", "retry"]);
  expect(note.links).toEqual([
    "sp_ProcessBatch",
    "Indexer",
    "Runbook",
    "Queue Worker",
    "Vault",
  ]);

  const text = note.blocks.map((block) => block.text).join("\n");
  expect(text).toContain("the procedure");
  expect(text).toContain("the queue");
  expect(text).toContain("the vault");
  expect(text).not.toContain("[[");
  expect(text).not.toContain("![[");
  expect(text).not.toContain("[!note]");
  expect(text).toContain("Retry policy");
  expect(text).toContain("Failed batches wait and then retry.");

  expect(note.blocks).toContainEqual({
    type: "heading",
    depth: 4,
    text: "Detail",
  });
  expect(note.blocks).toContainEqual({
    type: "code",
    lang: "mermaid",
    text: "flowchart LR\n  A --> B",
  });
  expect(
    note.blocks.some(
      (block) =>
        block.type === "table" && block.text.includes("sp_ProcessBatch"),
    ),
  ).toBe(true);
  expect(
    note.blocks.some(
      (block) => block.type === "list" && block.text.includes("the vault"),
    ),
  ).toBe(true);

  expect(note).toMatchSnapshot();
});

test("parses a note without frontmatter", () => {
  const note = parseNote(fixture("plain.md"), "devlog-agent/plain.md");

  expect(note.noteTitle).toBe("plain");
  expect(note.tags).toEqual([]);
  expect(note.links).toEqual(["Queue Worker", "Indexer", "diagram.png"]);

  const text = note.blocks.map((block) => block.text).join("\n");
  expect(text).toContain("retries");
  expect(text).toContain("Indexer");
  expect(text).not.toContain("[[");
  expect(text).not.toContain("[!warning]");
  expect(text).toContain("Watch the clock.");
  expect(text).not.toContain("diagram.png");
  expect(note.blocks).toContainEqual({
    type: "code",
    lang: "js",
    text: 'const label = "#hidden";',
  });

  expect(note).toMatchSnapshot();
});

test("uses the first H1 when frontmatter has no title", () => {
  const note = parseNote(
    "# Queue Worker\n\nThe worker runs nightly.\n",
    "devlog-agent/other.md",
  );

  expect(note.noteTitle).toBe("Queue Worker");
  expect(note.notePath).toBe("devlog-agent/other.md");
});

test("keeps a folded callout title and body without the marker", () => {
  const note = parseNote(
    "> [!info]- Folded\n> Hidden body\n",
    "devlog-agent/callout.md",
  );

  expect(note.blocks).toEqual([
    { type: "paragraph", text: "Folded\nHidden body" },
  ]);
});
