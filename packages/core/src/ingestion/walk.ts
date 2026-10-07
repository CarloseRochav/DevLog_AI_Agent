import { createHash } from "node:crypto";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([".obsidian", "attachments", ".trash"]);

export interface VaultNote {
  notePath: string;
  markdown: string;
  contentHash: string;
}

function ignored(filePath: string): boolean {
  const parts = filePath.replaceAll("\\", "/").split("/");
  return parts.some((part) => IGNORED_DIRECTORIES.has(part));
}

function notePathFor(vaultPath: string, entry: string): string | undefined {
  const absolute = path.isAbsolute(entry) ? entry : path.join(vaultPath, entry);
  const relative = path.relative(vaultPath, absolute).replaceAll("\\", "/");
  if (
    relative === "" ||
    relative.startsWith("../") ||
    path.isAbsolute(relative) ||
    !relative.endsWith(".md") ||
    ignored(relative)
  ) {
    return undefined;
  }
  return relative;
}

export async function walkVault(
  vaultPath: string,
  include: string,
): Promise<VaultNote[]> {
  const notes: VaultNote[] = [];
  const matches = glob(include, {
    cwd: vaultPath,
    withFileTypes: false,
    exclude: (fileName: string) => ignored(fileName),
  });

  for await (const entry of matches) {
    const notePath = notePathFor(vaultPath, entry);
    if (notePath === undefined) {
      continue;
    }
    const absolute = path.isAbsolute(entry)
      ? entry
      : path.join(vaultPath, entry);
    const bytes = await readFile(absolute);
    notes.push({
      notePath,
      markdown: bytes.toString("utf8"),
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  notes.sort((left, right) => left.notePath.localeCompare(right.notePath));
  return notes;
}
