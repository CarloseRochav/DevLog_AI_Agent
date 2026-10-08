import { matchesSource, type GoldenQuestion } from "./golden.js";

export interface EvalHitSummary {
  notePath: string;
  headingPath: string[];
  score: number;
  citation: string;
}

export interface EvalQuestionResult {
  id: string;
  type: GoldenQuestion["type"];
  question: string;
  hit: boolean;
  rank: number | null;
  hits: EvalHitSummary[];
}

export interface EvalReport {
  timestamp: string;
  threshold: number;
  hitAt5: number;
  mrr: number;
  negativePrecision: number;
  passed: boolean;
  questions: EvalQuestionResult[];
  lines: string[];
  summary: string;
}

interface ScoredHit {
  notePath: string;
  headingPath: readonly string[];
  score: number;
  citation: string;
}

function matchRank(
  hits: readonly ScoredHit[],
  expected: readonly string[],
): number | null {
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    if (
      hit !== undefined &&
      expected.some((source) => matchesSource(hit, source))
    ) {
      return index + 1;
    }
  }
  return null;
}

function summarize(hit: ScoredHit): EvalHitSummary {
  return {
    notePath: hit.notePath,
    headingPath: [...hit.headingPath],
    score: hit.score,
    citation: hit.citation,
  };
}

function ratio(part: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return part / total;
}

export function evaluateRetrieval(
  questions: readonly GoldenQuestion[],
  hitsById: ReadonlyMap<string, readonly ScoredHit[]>,
  options: { threshold: number; timestamp: string },
): EvalReport {
  let scored = 0;
  let hitCount = 0;
  let reciprocal = 0;
  let negativeTotal = 0;
  let negativeHit = 0;
  const results: EvalQuestionResult[] = [];

  for (const question of questions) {
    const hits = hitsById.get(question.id) ?? [];
    if (question.type === "negative") {
      negativeTotal += 1;
      const clear = hits.length === 0;
      if (clear) {
        negativeHit += 1;
      }
      results.push({
        id: question.id,
        type: question.type,
        question: question.question,
        hit: clear,
        rank: null,
        hits: hits.map(summarize),
      });
      continue;
    }

    scored += 1;
    const rank = matchRank(hits, question.expected);
    const found = rank !== null && rank <= 5;
    if (found) {
      hitCount += 1;
    }
    reciprocal += rank === null ? 0 : 1 / rank;
    results.push({
      id: question.id,
      type: question.type,
      question: question.question,
      hit: found,
      rank,
      hits: hits.map(summarize),
    });
  }

  const hitAt5 = ratio(hitCount, scored);
  const mrr = ratio(reciprocal, scored);
  const negativePrecision = ratio(negativeHit, negativeTotal);
  const passed =
    scored > 0 &&
    negativeTotal > 0 &&
    hitCount * 5 >= scored * 4 &&
    negativeHit * 2 >= negativeTotal;
  const lines = [
    "id  type  hit  rank  question",
    ...results.map(
      (result) =>
        `${result.id}  ${result.type}  ${result.hit ? "yes" : "no"}  ${result.rank ?? "-"}  ${result.question}`,
    ),
  ];
  const summary = `hit@5 ${hitAt5.toFixed(3)} (${hitCount}/${scored}) · MRR ${mrr.toFixed(3)} · negative precision ${negativePrecision.toFixed(3)} (${negativeHit}/${negativeTotal}) · threshold ${String(options.threshold)}`;

  return {
    timestamp: options.timestamp,
    threshold: options.threshold,
    hitAt5,
    mrr,
    negativePrecision,
    passed,
    questions: results,
    lines,
    summary,
  };
}
