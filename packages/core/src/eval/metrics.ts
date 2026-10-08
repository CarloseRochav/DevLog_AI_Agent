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
  /** Null for a negative question. Those rows are informational and do not affect `passed`. */
  hit: boolean | null;
  rank: number | null;
  /** Highest retrieved score, or null when the question returned no hits. */
  topScore: number | null;
  hits: EvalHitSummary[];
}

export interface EvalReport {
  timestamp: string;
  threshold: number;
  hitAt5: number;
  mrr: number;
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

function topScore(hits: readonly ScoredHit[]): number | null {
  if (hits.length === 0) {
    return null;
  }
  return Math.max(...hits.map((hit) => hit.score));
}

function formatHit(hit: boolean | null): string {
  if (hit === null) {
    return "-";
  }
  return hit ? "yes" : "no";
}

function formatTop(score: number | null): string {
  if (score === null) {
    return "-";
  }
  return score.toFixed(4);
}

export function evaluateRetrieval(
  questions: readonly GoldenQuestion[],
  hitsById: ReadonlyMap<string, readonly ScoredHit[]>,
  options: { threshold: number; timestamp: string },
): EvalReport {
  let scored = 0;
  let hitCount = 0;
  let reciprocal = 0;
  const results: EvalQuestionResult[] = [];

  for (const question of questions) {
    const hits = hitsById.get(question.id) ?? [];
    const best = topScore(hits);
    if (question.type === "negative") {
      results.push({
        id: question.id,
        type: question.type,
        question: question.question,
        hit: null,
        rank: null,
        topScore: best,
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
      topScore: best,
      hits: hits.map(summarize),
    });
  }

  const hitAt5 = ratio(hitCount, scored);
  const mrr = ratio(reciprocal, scored);
  const passed = scored > 0 && hitCount * 5 >= scored * 4;
  const lines = [
    "id  type  hit  rank  top  question",
    ...results.map(
      (result) =>
        `${result.id}  ${result.type}  ${formatHit(result.hit)}  ${result.rank ?? "-"}  ${formatTop(result.topScore)}  ${result.question}`,
    ),
  ];
  const summary = `hit@5 ${hitAt5.toFixed(3)} (${hitCount}/${scored}) · MRR ${mrr.toFixed(3)} · threshold ${String(options.threshold)}`;

  return {
    timestamp: options.timestamp,
    threshold: options.threshold,
    hitAt5,
    mrr,
    passed,
    questions: results,
    lines,
    summary,
  };
}
