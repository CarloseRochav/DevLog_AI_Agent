import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { walkVault } from "./walk.js";

async function writeNote(
  root: string,
  notePath: string,
  markdown: string,
): Promise<void> {
  const absolute = path.join(root, notePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, markdown);
}

test("walkVault reads included markdown and skips ignored paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devlog-vault-"));
  const architecture = "# Architecture\n";
  try {
    await writeNote(root, "devlog-agent/Architecture.md", architecture);
    await writeNote(root, "devlog-agent/nested/Note.md", "# Note\n");
    await writeNote(root, "devlog-agent/.obsidian/cache.md", "# Hidden\n");
    await writeNote(root, "devlog-agent/attachments/pic.md", "# Pic\n");
    await writeNote(root, "devlog-agent/.trash/old.md", "# Old\n");
    await writeNote(root, "devlog-agent/skip.txt", "nope");
    await writeNote(root, "other/Nope.md", "# Nope\n");

    const notes = await walkVault(root, "devlog-agent/**/*.md");

    expect(notes.map((note) => note.notePath)).toEqual([
      "devlog-agent/Architecture.md",
      "devlog-agent/nested/Note.md",
    ]);
    expect(notes[0]?.markdown).toBe(architecture);
    expect(notes[0]?.contentHash).toBe(
      createHash("sha256").update(architecture).digest("hex"),
    );
    expect(notes[0]?.notePath).not.toContain("\\");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
