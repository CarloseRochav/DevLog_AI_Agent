import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { chunkNote } from "../ingestion/chunk.js";
import { parseNote } from "../ingestion/parse.js";
import type { SearchHit } from "../schemas.js";
import { EvalError, matchesSource, parseGoldenSet } from "./golden.js";
import { evaluateRetrieval } from "./metrics.js";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    chunkId: "chunk-a",
    notePath: "devlog-agent/Architecture.md",
    noteTitle: "Architecture",
    headingPath: ["Architecture", "Queue Worker"],
    content: "The queue worker retries failed batches.",
    score: 0.02,
    citation: "Architecture.md > Queue Worker",
    ...overrides,
  };
}

test("a source matches the file name, the full path, or one heading", () => {
  const architecture = hit();
  expect(matchesSource(architecture, "Architecture.md#Queue Worker")).toBe(
    true,
  );
  expect(
    matchesSource(architecture, "devlog-agent/Architecture.md#Queue Worker"),
  ).toBe(true);
  expect(matchesSource(architecture, "Architecture.md#Data Flow")).toBe(false);
  expect(
    matchesSource(
      hit({
        notePath: "devlog-agent/Decisions.md",
        headingPath: ["Decisions", "Blob Storage"],
      }),
      "Decisions.md",
    ),
  ).toBe(true);
  expect(
    matchesSource(
      hit({ notePath: "devlog-agent\\Decisions.md", headingPath: [] }),
      "Decisions.md",
    ),
  ).toBe(true);
  expect(matchesSource(architecture, "Decisions.md")).toBe(false);
});

test("evaluateRetrieval scores hit@5 and MRR and reports negative top scores", () => {
  const questions = parseGoldenSet(
    [
      '{"id":"q01","question":"How does the worker retry failed batches?","expected":["Architecture.md#Queue Worker"],"type":"exact-name"}',
      '{"id":"q02","question":"Where is the payload kept?","expected":["Storage.md"],"type":"concept"}',
      '{"id":"q03","question":"What is the on-call phone number for weekend incidents?","expected":[],"type":"negative"}',
      '{"id":"q04","question":"Which Kubernetes cluster runs the nightly payroll job?","expected":[],"type":"negative"}',
    ].join("\n"),
  );
  const hits = new Map<string, SearchHit[]>([
    [
      "q01",
      [hit(), hit({ chunkId: "other", notePath: "devlog-agent/Other.md" })],
    ],
    [
      "q02",
      [
        hit({
          chunkId: "miss",
          notePath: "devlog-agent/Other.md",
          headingPath: [],
        }),
      ],
    ],
    ["q03", []],
    ["q04", [hit({ chunkId: "noise", score: 0.01 })]],
  ]);

  const report = evaluateRetrieval(questions, hits, {
    threshold: 0,
    timestamp: "2026-10-07T00:00:00.000Z",
  });

  expect(report.hitAt5).toBe(0.5);
  expect(report.mrr).toBe(0.5);
  expect(report.passed).toBe(false);
  expect(report.questions.map((question) => question.hit)).toEqual([
    true,
    false,
    null,
    null,
  ]);
  expect(report.questions.map((question) => question.topScore)).toEqual([
    0.02,
    0.02,
    null,
    0.01,
  ]);
  expect(report.questions[1]?.rank).toBeNull();
  expect(report.questions[2]?.rank).toBeNull();
  expect(report.lines[0]).toBe("id  type  hit  rank  top  question");
  expect(report.lines[1]).toBe(
    "q01  exact-name  yes  1  0.0200  How does the worker retry failed batches?",
  );
  expect(report.lines[3]).toBe(
    "q03  negative  -  -  -  What is the on-call phone number for weekend incidents?",
  );
  expect(report.summary).toBe("hit@5 0.500 (1/2) · MRR 0.500 · threshold 0");
});

test("a match past rank 5 misses hit@5 and still counts in MRR", () => {
  const questions = parseGoldenSet(
    [
      '{"id":"q01","question":"How does the worker retry failed batches?","expected":["Architecture.md#Queue Worker"],"type":"exact-name"}',
      '{"id":"q02","question":"What is the on-call phone number for weekend incidents?","expected":[],"type":"negative"}',
    ].join("\n"),
  );
  const misses = Array.from({ length: 5 }, (_, index) =>
    hit({
      chunkId: `miss-${index}`,
      notePath: "devlog-agent/Other.md",
      headingPath: [],
    }),
  );
  const report = evaluateRetrieval(
    questions,
    new Map([
      ["q01", [...misses, hit({ chunkId: "late" })]],
      ["q02", []],
    ]),
    { threshold: 0.02, timestamp: "2026-10-07T00:00:00.000Z" },
  );

  expect(report.questions[0]).toMatchObject({
    hit: false,
    rank: 6,
    topScore: 0.02,
  });
  expect(report.questions[1]).toMatchObject({
    hit: null,
    rank: null,
    topScore: null,
  });
  expect(report.hitAt5).toBe(0);
  expect(report.mrr).toBeCloseTo(1 / 6);
  expect(report.passed).toBe(false);
  expect(report.summary).toBe("hit@5 0.000 (0/1) · MRR 0.167 · threshold 0.02");
});

test("four of five hits pass when every negative question still has a hit", () => {
  const lines = [1, 2, 3, 4, 5].map(
    (id) =>
      `{"id":"q0${id}","question":"Where is item ${id} documented clearly?","expected":["Architecture.md#Queue Worker"],"type":"concept"}`,
  );
  lines.push(
    '{"id":"n1","question":"What is the on-call phone number for weekend incidents?","expected":[],"type":"negative"}',
    '{"id":"n2","question":"Which Kubernetes cluster runs the nightly payroll job?","expected":[],"type":"negative"}',
  );
  const questions = parseGoldenSet(lines.join("\n"));
  const hits = new Map<string, SearchHit[]>();
  for (const id of ["q01", "q02", "q03", "q04"]) {
    hits.set(id, [hit()]);
  }
  hits.set("q05", [
    hit({
      chunkId: "miss",
      notePath: "devlog-agent/Other.md",
      headingPath: [],
    }),
  ]);
  hits.set("n1", [hit({ chunkId: "noise-a", score: 0.0331 })]);
  hits.set("n2", [hit({ chunkId: "noise-b", score: 0.01 })]);

  const report = evaluateRetrieval(questions, hits, {
    threshold: 0,
    timestamp: "2026-10-07T00:00:00.000Z",
  });

  expect(report.hitAt5).toBe(0.8);
  expect(report.mrr).toBe(0.8);
  expect(report.passed).toBe(true);
  expect(
    report.questions.find((question) => question.id === "n1"),
  ).toMatchObject({ hit: null, rank: null, topScore: 0.0331 });
  expect(
    report.questions.find((question) => question.id === "n2"),
  ).toMatchObject({ hit: null, rank: null, topScore: 0.01 });
  expect(report.summary).toBe("hit@5 0.800 (4/5) · MRR 0.800 · threshold 0");
});

test("parseGoldenSet rejects a bad line and a duplicated id", () => {
  expect(() => parseGoldenSet("")).toThrow(EvalError);
  expect(() => parseGoldenSet("{")).toThrow(/Golden line 1 is not JSON/);
  expect(() =>
    parseGoldenSet(
      '{"id":"q","question":"no","expected":[],"type":"negative"}',
    ),
  ).toThrow(/Golden line 1 is invalid/);
  expect(() =>
    parseGoldenSet(
      '{"id":"q01","question":"Why is this absent?","expected":["A.md"],"type":"negative"}',
    ),
  ).toThrow(/Golden line 1 is invalid/);
  expect(() =>
    parseGoldenSet(
      [
        '{"id":"q01","question":"How does the worker retry failed batches?","expected":["Architecture.md"],"type":"concept"}',
        '{"id":"q01","question":"How does the worker retry failed batches?","expected":["Architecture.md"],"type":"concept"}',
      ].join("\n"),
    ),
  ).toThrow(/Golden id q01 is duplicated/);
});

test("the golden set has 15 questions and covers every eval note", async () => {
  const vaultDir = path.resolve("eval/vault/devlog-agent");
  const goldenText = await readFile(path.resolve("eval/golden.jsonl"), "utf8");
  const questions = parseGoldenSet(goldenText);
  const noteFiles = (await readdir(vaultDir))
    .filter((name) => name.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));

  expect(questions).toHaveLength(15);
  expect(
    questions.filter((question) => question.type === "exact-name"),
  ).toHaveLength(3);
  expect(
    questions.filter((question) => question.type === "negative"),
  ).toHaveLength(2);
  expect(new Set(questions.map((question) => question.type))).toEqual(
    new Set(["exact-name", "concept", "decision", "cross-note", "negative"]),
  );

  const corpus = (
    await Promise.all(
      noteFiles.map(async (name) =>
        readFile(path.join(vaultDir, name), "utf8"),
      ),
    )
  ).join("\n");
  for (const word of ["on-call", "phone", "Kubernetes", "cluster", "payroll"]) {
    expect(corpus.toLowerCase()).not.toContain(word.toLowerCase());
  }

  const covered = new Set<string>();
  for (const question of questions) {
    for (const source of question.expected) {
      const hash = source.indexOf("#");
      const note = hash === -1 ? source : source.slice(0, hash);
      const heading = hash === -1 ? undefined : source.slice(hash + 1);
      expect(noteFiles).toContain(note);
      covered.add(note);
      if (heading === undefined) {
        continue;
      }
      const markdown = await readFile(path.join(vaultDir, note), "utf8");
      const chunks = chunkNote(parseNote(markdown, `devlog-agent/${note}`), {
        contentHash: "hash",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        indexedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(chunks.some((chunk) => chunk.headingPath.includes(heading))).toBe(
        true,
      );
    }
  }
  expect([...covered].sort((left, right) => left.localeCompare(right))).toEqual(
    noteFiles,
  );
});
