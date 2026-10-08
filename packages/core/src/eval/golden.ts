import { z } from "zod";

export class EvalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EvalError";
  }
}

export const GoldenQuestionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(3),
    expected: z.array(z.string().min(1)),
    type: z.enum([
      "exact-name",
      "concept",
      "decision",
      "cross-note",
      "negative",
    ]),
  })
  .superRefine((question, context) => {
    if (question.type === "negative" && question.expected.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A negative question has no expected source.",
        path: ["expected"],
      });
    }
    if (question.type !== "negative" && question.expected.length === 0) {
      context.addIssue({
        code: "custom",
        message: "An expected source is required.",
        path: ["expected"],
      });
    }
  });

export type GoldenQuestion = z.infer<typeof GoldenQuestionSchema>;

export function parseGoldenSet(text: string): GoldenQuestion[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new EvalError("Golden set is empty.");
  }
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new EvalError(`Golden line ${lineNumber} is not JSON.`, {
        cause: error,
      });
    }
    const parsed = GoldenQuestionSchema.safeParse(value);
    if (!parsed.success) {
      throw new EvalError(`Golden line ${lineNumber} is invalid.`);
    }
    if (seen.has(parsed.data.id)) {
      throw new EvalError(`Golden id ${parsed.data.id} is duplicated.`);
    }
    seen.add(parsed.data.id);
    return parsed.data;
  });
}

function fileName(notePath: string): string {
  const parts = notePath.split(/[/\\]/);
  return parts[parts.length - 1] ?? notePath;
}

export function matchesSource(
  hit: { notePath: string; headingPath: readonly string[] },
  source: string,
): boolean {
  const hash = source.indexOf("#");
  const note = hash === -1 ? source : source.slice(0, hash);
  const heading = hash === -1 ? undefined : source.slice(hash + 1);
  const name = fileName(hit.notePath);
  const noteMatches =
    hit.notePath === note ||
    name === note ||
    hit.notePath.endsWith(`/${note}`) ||
    hit.notePath.endsWith(`\\${note}`);
  if (!noteMatches) {
    return false;
  }
  if (heading === undefined || heading === "") {
    return true;
  }
  return hit.headingPath.includes(heading);
}
