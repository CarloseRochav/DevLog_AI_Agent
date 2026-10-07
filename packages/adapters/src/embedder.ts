import type { Embedder } from "@devlog/core";
import { z } from "zod";

const BATCH_SIZE = 16;
/** First request plus five retries. Only HTTP 429 is retried. */
const MAX_RETRIES = 5;

export interface AzureEmbedderOptions {
  endpoint: string;
  apiKey: string;
  deployment: string;
  dimensions: number;
  /** Port model name. Defaults to the deployment name. */
  model?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return 500 * 2 ** attempt;
}

export class AzureEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly deployment: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AzureEmbedderOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.deployment = options.deployment;
    this.model = options.model ?? options.deployment;
    this.dimensions = options.dimensions;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      vectors.push(...(await this.embedBatch(batch)));
    }
    return vectors;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const response = await this.fetchImpl(
        `${this.endpoint}/openai/v1/embeddings`,
        {
          method: "POST",
          headers: {
            "api-key": this.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: this.deployment, input: texts }),
        },
      );

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          throw new Error("Embeddings request failed with HTTP 429");
        }
        await this.sleep(retryDelayMs(response, attempt));
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Embeddings request failed with HTTP ${response.status}`,
        );
      }

      return this.parseEmbeddings(await response.json(), texts.length);
    }

    throw new Error("Embeddings request failed");
  }

  private parseEmbeddings(payload: unknown, count: number): number[][] {
    const schema = z.object({
      data: z.array(
        z.object({
          index: z.number().int(),
          embedding: z.array(z.number()).length(this.dimensions),
        }),
      ),
    });
    const parsed = schema.parse(payload);
    const ordered = [...parsed.data].sort(
      (left, right) => left.index - right.index,
    );
    if (ordered.length !== count) {
      throw new Error(
        `Embeddings response returned ${ordered.length} vectors for ${count} inputs`,
      );
    }
    return ordered.map((item) => item.embedding);
  }
}
