import matter from "gray-matter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { z } from "zod";

const EMBED = /!\[\[([^\]\n]*)\]\]/g;
const WIKILINK = /\[\[([^\]\n]+)\]\]/g;
const TAG = /(^|[^A-Za-z0-9_/-])#([A-Za-z][A-Za-z0-9_/-]*)/g;
const CALLOUT = /^\[!([A-Za-z][\w-]*)\][+-]?[ \t]*([^\n]*)\n?([\s\S]*)$/;
const FENCED_OR_INLINE_CODE = /```[\s\S]*?```|`[^`\n]*`/g;

const processor = unified().use(remarkParse).use(remarkGfm);

export const ParsedBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    depth: z.number().int().min(1).max(6),
    text: z.string(),
  }),
  z.object({
    type: z.literal("paragraph"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("code"),
    lang: z.string().nullable(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("table"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("list"),
    text: z.string(),
  }),
]);

export const ParsedNoteSchema = z.object({
  notePath: z.string(),
  noteTitle: z.string(),
  tags: z.array(z.string()),
  links: z.array(z.string()),
  blocks: z.array(ParsedBlockSchema),
});

export type ParsedBlock = z.infer<typeof ParsedBlockSchema>;
export type ParsedNote = z.infer<typeof ParsedNoteSchema>;

interface MdastNode {
  type: string;
  value?: string;
  depth?: number;
  lang?: string | null;
  children?: MdastNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim().replace(/^#/, ""))
      .filter((item) => item !== "");
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringList(item));
  }
  return [];
}

function field(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  return (data as Record<string, unknown>)[key];
}

function fileStem(notePath: string): string {
  const base = notePath.split(/[/\\]/).pop() ?? notePath;
  return base.replace(/\.md$/i, "");
}

function linkTarget(inner: string): string {
  const withoutAlias = inner.split("|")[0] ?? "";
  return (withoutAlias.split(/[#^]/)[0] ?? "").trim();
}

function displayText(inner: string): string {
  const aliasAt = inner.indexOf("|");
  if (aliasAt !== -1) {
    return inner.slice(aliasAt + 1).trim();
  }
  return linkTarget(inner);
}

function collectTags(text: string, tags: string[]): void {
  for (const match of text.matchAll(TAG)) {
    const tag = (match[2] ?? "").replace(/\/+$/, "");
    if (tag !== "") {
      tags.push(tag);
    }
  }
}

function replaceWikilinks(text: string, links: string[]): string {
  const withoutEmbeds = text.replace(EMBED, (_match, inner: string) => {
    const target = linkTarget(inner);
    if (target !== "") {
      links.push(target);
    }
    return "";
  });
  return withoutEmbeds.replace(WIKILINK, (_match, inner: string) => {
    const target = linkTarget(inner);
    if (target !== "") {
      links.push(target);
    }
    return displayText(inner);
  });
}

function transformVisible(
  text: string,
  links: string[],
  tags: string[],
): string {
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCED_OR_INLINE_CODE)) {
    const index = match.index;
    const visible = text.slice(last, index);
    collectTags(visible, tags);
    parts.push(replaceWikilinks(visible, links));
    parts.push(match[0]);
    last = index + match[0].length;
  }
  const tail = text.slice(last);
  collectTags(tail, tags);
  parts.push(replaceWikilinks(tail, links));
  return parts.join("");
}

function tidy(text: string): string {
  return text.replace(/[ \t]{2,}/g, " ").trim();
}

function sliceSource(node: MdastNode, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    return "";
  }
  return source.slice(start, end).replace(/\n+$/, "");
}

function phrasing(node: MdastNode, links: string[], tags: string[]): string {
  if (node.type === "text") {
    const value = node.value ?? "";
    collectTags(value, tags);
    return replaceWikilinks(value, links);
  }
  if (node.type === "inlineCode" || node.type === "code") {
    return node.value ?? "";
  }
  if (node.type === "break") {
    return "\n";
  }
  return (node.children ?? [])
    .map((child) => phrasing(child, links, tags))
    .join("");
}

function keep(block: ParsedBlock): boolean {
  if (block.type === "code") {
    return true;
  }
  return block.text.trim() !== "";
}

function blocksFrom(
  node: MdastNode,
  source: string,
  links: string[],
  tags: string[],
): ParsedBlock[] {
  switch (node.type) {
    case "root":
      return (node.children ?? []).flatMap((child) =>
        blocksFrom(child, source, links, tags),
      );
    case "heading":
      return [
        {
          type: "heading",
          depth: node.depth ?? 1,
          text: tidy(phrasing(node, links, tags)),
        },
      ];
    case "paragraph":
      return [
        {
          type: "paragraph",
          text: tidy(phrasing(node, links, tags)),
        },
      ];
    case "code":
      return [
        {
          type: "code",
          lang: node.lang ?? null,
          text: node.value ?? "",
        },
      ];
    case "table":
      return [
        {
          type: "table",
          text: transformVisible(sliceSource(node, source), links, tags),
        },
      ];
    case "list":
      return [
        {
          type: "list",
          text: transformVisible(sliceSource(node, source), links, tags),
        },
      ];
    case "blockquote":
      return [quoteBlock(node, source, links, tags)];
    default:
      return [];
  }
}

function quoteBlock(
  node: MdastNode,
  source: string,
  links: string[],
  tags: string[],
): ParsedBlock {
  const inner = (node.children ?? []).flatMap((child) =>
    blocksFrom(child, source, links, tags),
  );
  const first = inner[0];
  if (first?.type === "paragraph") {
    const match = CALLOUT.exec(first.text);
    if (match) {
      const title = (match[2] ?? "").trim();
      const rest = (match[3] ?? "").replace(/^\n/, "").trim();
      const later = inner
        .slice(1)
        .map((block) => block.text.trim())
        .filter((text) => text !== "")
        .join("\n\n");
      const body = [rest, later].filter((part) => part !== "").join("\n\n");
      const text = [title, body].filter((part) => part !== "").join("\n");
      return { type: "paragraph", text };
    }
  }
  return {
    type: "paragraph",
    text: inner
      .map((block) => block.text.trim())
      .filter((text) => text !== "")
      .join("\n\n"),
  };
}

function titleFrom(
  data: unknown,
  blocks: ParsedBlock[],
  notePath: string,
): string {
  const raw = field(data, "title");
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.trim();
  }
  const heading = blocks.find(
    (block) => block.type === "heading" && block.depth === 1,
  );
  if (heading?.type === "heading" && heading.text !== "") {
    return heading.text;
  }
  return fileStem(notePath);
}

export function parseNote(markdown: string, notePath: string): ParsedNote {
  const file = matter(markdown);
  const source = file.content;
  const tree = processor.parse(source) as MdastNode;
  const links: string[] = [];
  const tags = [
    ...stringList(field(file.data, "tags")),
    ...stringList(field(file.data, "tag")),
  ];
  const blocks = blocksFrom(tree, source, links, tags).filter(keep);
  return ParsedNoteSchema.parse({
    notePath,
    noteTitle: titleFrom(file.data, blocks, notePath),
    tags: unique(tags),
    links: unique(links),
    blocks,
  });
}
