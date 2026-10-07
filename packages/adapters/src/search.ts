import {
  SearchHitSchema,
  SearchQuerySchema,
  type Embedder,
  type IndexedChunk,
  type SearchHit,
  type SearchIndex as SearchIndexPort,
  type SearchQuery,
} from "@devlog/core";
import {
  AzureKeyCredential,
  KnownAnalyzerNames,
  KnownVectorSearchAlgorithmMetric,
  SearchClient,
  SearchIndexClient,
  type SearchFieldArray,
  type SearchIndex,
  type SelectFields,
} from "@azure/search-documents";

const VECTOR_PROFILE = "devlog-hnsw";
const VECTOR_ALGORITHM = "devlog-hnsw-algo";
const VECTOR_NEIGHBORS = 20;
/** Azure index batches and $top page size. */
const BATCH_LIMIT = 1000;
const MAX_SKIP = 100_000;

const HIT_FIELDS = [
  "id",
  "notePath",
  "noteTitle",
  "headingPath",
  "content",
] as const;

export interface DevlogDocument {
  id: string;
  notePath: string;
  noteTitle: string;
  headingPath: string;
  content: string;
  tags: string[];
  links: string[];
  ordinal: number;
  contentHash: string;
  embeddingModel: string;
  embeddingDimensions: number;
  indexedAt: Date;
  contentVector: number[];
}

export interface IndexingOutcome {
  key: string;
  succeeded: boolean;
  statusCode: number;
  errorMessage?: string;
}

export interface DocumentSearchRequest {
  searchText: string;
  filter?: string;
  top: number;
  skip?: number;
  select: readonly string[];
  vector?: {
    vector: number[];
    kNearestNeighborsCount: number;
    fields: readonly string[];
  };
}

export interface DocumentHit {
  score?: unknown;
  document: Record<string, unknown>;
}

export interface DocumentClient {
  mergeOrUpload(documents: DevlogDocument[]): Promise<IndexingOutcome[]>;
  deleteByIds(ids: string[]): Promise<IndexingOutcome[]>;
  search(request: DocumentSearchRequest): Promise<DocumentHit[]>;
}

function escapeOData(value: string): string {
  return value.replaceAll("'", "''");
}

function odataFilter(query: {
  tags?: string[];
  notePath?: string;
}): string | undefined {
  const parts: string[] = [];
  if (query.notePath !== undefined) {
    parts.push(`notePath eq '${escapeOData(query.notePath)}'`);
  }
  for (const tag of query.tags ?? []) {
    parts.push(`tags/any(t: t eq '${escapeOData(tag)}')`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" and ");
}

function fileName(notePath: string): string {
  const parts = notePath.split(/[/\\]/);
  const last = parts[parts.length - 1];
  if (last === undefined || last === "") {
    return notePath;
  }
  return last;
}

function headingPathFromField(value: unknown): unknown {
  if (value === undefined || value === "") {
    return [];
  }
  if (typeof value === "string") {
    return value.split(" > ");
  }
  return value;
}

function assertSucceeded(results: IndexingOutcome[], action: string): void {
  const failed = results.filter((result) => !result.succeeded);
  if (failed.length === 0) {
    return;
  }
  const detail = failed
    .map((result) => {
      const message =
        result.errorMessage === undefined ? "" : ` ${result.errorMessage}`;
      return `${result.key} (${result.statusCode}${message})`;
    })
    .join("; ");
  throw new Error(`${action} failed: ${detail}`);
}

function toDocument(chunk: IndexedChunk): DevlogDocument {
  return {
    id: chunk.id,
    notePath: chunk.notePath,
    noteTitle: chunk.noteTitle,
    headingPath: chunk.headingPath.join(" > "),
    content: chunk.content,
    tags: chunk.tags,
    links: chunk.links,
    ordinal: chunk.ordinal,
    contentHash: chunk.contentHash,
    embeddingModel: chunk.embeddingModel,
    embeddingDimensions: chunk.embeddingDimensions,
    indexedAt: new Date(chunk.indexedAt),
    contentVector: chunk.vector,
  };
}

function toSearchHit(hit: DocumentHit): {
  chunkId: unknown;
  notePath: unknown;
  noteTitle: unknown;
  headingPath: unknown;
  content: unknown;
  score: unknown;
  citation: string;
} {
  const notePath = hit.document.notePath;
  const headings = headingPathFromField(hit.document.headingPath);
  const citation =
    typeof notePath === "string" && Array.isArray(headings)
      ? [fileName(notePath), ...headings].join(" > ")
      : "";
  return {
    chunkId: hit.document.id,
    notePath,
    noteTitle: hit.document.noteTitle,
    headingPath: headings,
    content: hit.document.content,
    score: hit.score,
    citation,
  };
}

export function devlogChunksIndex(
  name: string,
  dimensions: number,
): SearchIndex {
  return {
    name,
    fields: [
      {
        name: "id",
        type: "Edm.String",
        key: true,
        searchable: false,
        filterable: false,
        facetable: false,
        sortable: false,
      },
      {
        name: "notePath",
        type: "Edm.String",
        searchable: false,
        filterable: true,
        facetable: true,
        sortable: false,
      },
      {
        name: "noteTitle",
        type: "Edm.String",
        searchable: true,
        filterable: false,
        facetable: false,
        sortable: false,
      },
      {
        name: "headingPath",
        type: "Edm.String",
        searchable: true,
        filterable: false,
        facetable: false,
        sortable: false,
      },
      {
        name: "content",
        type: "Edm.String",
        searchable: true,
        filterable: false,
        facetable: false,
        sortable: false,
        analyzerName: KnownAnalyzerNames.EnMicrosoft,
      },
      {
        name: "tags",
        type: "Collection(Edm.String)",
        searchable: false,
        filterable: true,
        facetable: true,
      },
      {
        name: "links",
        type: "Collection(Edm.String)",
        searchable: false,
        filterable: true,
        facetable: false,
      },
      {
        name: "ordinal",
        type: "Edm.Int32",
        filterable: false,
        facetable: false,
        sortable: true,
      },
      {
        name: "contentHash",
        type: "Edm.String",
        searchable: false,
        filterable: true,
        facetable: false,
        sortable: false,
      },
      {
        name: "embeddingModel",
        type: "Edm.String",
        searchable: false,
        filterable: true,
        facetable: false,
        sortable: false,
      },
      {
        name: "embeddingDimensions",
        type: "Edm.Int32",
        filterable: true,
        facetable: false,
        sortable: false,
      },
      {
        name: "indexedAt",
        type: "Edm.DateTimeOffset",
        filterable: false,
        facetable: false,
        sortable: true,
      },
      {
        name: "contentVector",
        type: "Collection(Edm.Single)",
        // The service rejects a vector profile unless the field is searchable.
        searchable: true,
        vectorSearchDimensions: dimensions,
        vectorSearchProfileName: VECTOR_PROFILE,
      },
    ],
    vectorSearch: {
      algorithms: [
        {
          name: VECTOR_ALGORITHM,
          kind: "hnsw",
          parameters: { metric: KnownVectorSearchAlgorithmMetric.Cosine },
        },
      ],
      profiles: [
        {
          name: VECTOR_PROFILE,
          algorithmConfigurationName: VECTOR_ALGORITHM,
        },
      ],
    },
  };
}

export class AzureSearchIndex implements SearchIndexPort {
  constructor(
    private readonly documents: DocumentClient,
    private readonly embedder: Embedder,
  ) {}

  async upsert(chunks: IndexedChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    const results = await this.documents.mergeOrUpload(chunks.map(toDocument));
    assertSucceeded(results, "upsert");
  }

  async deleteByNotePath(notePath: string): Promise<void> {
    const ids: string[] = [];
    await this.eachPage(
      {
        searchText: "*",
        filter: `notePath eq '${escapeOData(notePath)}'`,
        select: ["id"],
      },
      (hits) => {
        for (const hit of hits) {
          if (typeof hit.document.id === "string") {
            ids.push(hit.document.id);
          }
        }
      },
    );
    for (let start = 0; start < ids.length; start += BATCH_LIMIT) {
      const results = await this.documents.deleteByIds(
        ids.slice(start, start + BATCH_LIMIT),
      );
      assertSucceeded(results, "deleteByNotePath");
    }
  }

  async hybridSearch(q: SearchQuery): Promise<SearchHit[]> {
    const parsed = SearchQuerySchema.parse(q);
    const vectors = await this.embedder.embed([parsed.query]);
    const vector = vectors[0];
    if (vectors.length !== 1 || vector === undefined) {
      throw new Error(
        `Embedder returned ${vectors.length} vectors for one query`,
      );
    }

    const hits = await this.documents.search({
      searchText: parsed.query,
      filter: odataFilter(parsed),
      top: parsed.topK,
      select: HIT_FIELDS,
      vector: {
        vector,
        kNearestNeighborsCount: VECTOR_NEIGHBORS,
        fields: ["contentVector"],
      },
    });
    return hits.map((hit) => SearchHitSchema.parse(toSearchHit(hit)));
  }

  async listNoteHashes(): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    await this.eachPage(
      { searchText: "*", select: ["notePath", "contentHash"] },
      (hits) => {
        for (const hit of hits) {
          const notePath = hit.document.notePath;
          const contentHash = hit.document.contentHash;
          if (typeof notePath !== "string" || typeof contentHash !== "string") {
            continue;
          }
          if (!hashes.has(notePath)) {
            hashes.set(notePath, contentHash);
          }
        }
      },
    );
    return hashes;
  }

  private async eachPage(
    request: Omit<DocumentSearchRequest, "top" | "skip">,
    onPage: (hits: DocumentHit[]) => void,
  ): Promise<void> {
    for (let skip = 0; skip <= MAX_SKIP; skip += BATCH_LIMIT) {
      const hits = await this.documents.search({
        ...request,
        top: BATCH_LIMIT,
        skip,
      });
      onPage(hits);
      if (hits.length < BATCH_LIMIT) {
        return;
      }
    }
  }
}

function toOutcome(result: {
  key: string;
  succeeded: boolean;
  statusCode: number;
  errorMessage?: string;
}): IndexingOutcome {
  return {
    key: result.key,
    succeeded: result.succeeded,
    statusCode: result.statusCode,
    errorMessage: result.errorMessage,
  };
}

class SdkDocumentClient implements DocumentClient {
  constructor(private readonly client: SearchClient<DevlogDocument>) {}

  async mergeOrUpload(documents: DevlogDocument[]): Promise<IndexingOutcome[]> {
    const result = await this.client.mergeOrUploadDocuments(documents);
    return result.results.map(toOutcome);
  }

  async deleteByIds(ids: string[]): Promise<IndexingOutcome[]> {
    const result = await this.client.deleteDocuments("id", ids);
    return result.results.map(toOutcome);
  }

  async search(request: DocumentSearchRequest): Promise<DocumentHit[]> {
    const response = await this.client.search(request.searchText, {
      filter: request.filter,
      top: request.top,
      skip: request.skip,
      select: request.select as SelectFields<DevlogDocument>[],
      vectorSearchOptions:
        request.vector === undefined
          ? undefined
          : {
              queries: [
                {
                  kind: "vector",
                  vector: request.vector.vector,
                  kNearestNeighborsCount: request.vector.kNearestNeighborsCount,
                  fields: request.vector
                    .fields as SearchFieldArray<DevlogDocument>,
                },
              ],
            },
    });

    const hits: DocumentHit[] = [];
    for await (const result of response.results) {
      hits.push({
        score: result.score,
        document: {
          ...(result.document as unknown as Record<string, unknown>),
        },
      });
    }
    return hits;
  }
}

export interface AzureSearchClientOptions {
  endpoint: string;
  apiKey: string;
  indexName: string;
  embedder: Embedder;
}

export function createAzureSearchIndex(
  options: AzureSearchClientOptions,
): AzureSearchIndex {
  const client = new SearchClient<DevlogDocument>(
    options.endpoint,
    options.indexName,
    new AzureKeyCredential(options.apiKey),
  );
  return new AzureSearchIndex(new SdkDocumentClient(client), options.embedder);
}

export function createSearchIndexClient(
  endpoint: string,
  apiKey: string,
): SearchIndexClient {
  return new SearchIndexClient(endpoint, new AzureKeyCredential(apiKey));
}

export async function ensureDevlogIndex(
  client: Pick<SearchIndexClient, "createOrUpdateIndex">,
  name: string,
  dimensions: number,
): Promise<void> {
  await client.createOrUpdateIndex(devlogChunksIndex(name, dimensions));
}

const FIELD_ATTRIBUTES = [
  "name",
  "type",
  "key",
  "searchable",
  "filterable",
  "facetable",
  "sortable",
  "analyzerName",
  "vectorSearchDimensions",
  "vectorSearchProfileName",
] as const;

export type SetupResult = "created" | "updated" | "unchanged";

export interface DevlogIndexClient {
  getIndex(name: string): Promise<SearchIndex>;
  createOrUpdateIndex(index: SearchIndex): Promise<SearchIndex>;
}

function isMissingIndex(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as { statusCode?: unknown; status?: unknown };
  return record.statusCode === 404 || record.status === 404;
}

function fieldAttribute(
  field: SearchIndex["fields"][number],
  key: string,
): unknown {
  return (field as unknown as Record<string, unknown>)[key];
}

function fieldMatches(
  actual: SearchIndex["fields"][number],
  expected: SearchIndex["fields"][number],
): boolean {
  for (const key of FIELD_ATTRIBUTES) {
    const expectedValue = fieldAttribute(expected, key);
    if (expectedValue === undefined) {
      continue;
    }
    if (fieldAttribute(actual, key) !== expectedValue) {
      return false;
    }
  }
  return true;
}

function vectorMatches(actual: SearchIndex, expected: SearchIndex): boolean {
  const expectedAlgorithms = expected.vectorSearch?.algorithms ?? [];
  const actualAlgorithms = actual.vectorSearch?.algorithms ?? [];
  const expectedProfiles = expected.vectorSearch?.profiles ?? [];
  const actualProfiles = actual.vectorSearch?.profiles ?? [];
  if (
    actualAlgorithms.length !== expectedAlgorithms.length ||
    actualProfiles.length !== expectedProfiles.length
  ) {
    return false;
  }

  const expectedAlgorithm = expectedAlgorithms[0];
  const actualAlgorithm = actualAlgorithms.find(
    (algorithm) => algorithm.name === expectedAlgorithm?.name,
  );
  if (
    expectedAlgorithm === undefined ||
    actualAlgorithm === undefined ||
    actualAlgorithm.kind !== expectedAlgorithm.kind ||
    actualAlgorithm.parameters?.metric !== expectedAlgorithm.parameters?.metric
  ) {
    return false;
  }

  const expectedProfile = expectedProfiles[0];
  const actualProfile = actualProfiles.find(
    (profile) => profile.name === expectedProfile?.name,
  );
  return (
    expectedProfile !== undefined &&
    actualProfile !== undefined &&
    actualProfile.algorithmConfigurationName ===
      expectedProfile.algorithmConfigurationName
  );
}

function indexMatches(actual: SearchIndex, expected: SearchIndex): boolean {
  if (actual.name !== expected.name) {
    return false;
  }
  if (actual.fields.length !== expected.fields.length) {
    return false;
  }
  for (const expectedField of expected.fields) {
    const actualField = actual.fields.find(
      (field) => field.name === expectedField.name,
    );
    if (
      actualField === undefined ||
      !fieldMatches(actualField, expectedField)
    ) {
      return false;
    }
  }
  return vectorMatches(actual, expected);
}

export async function setupDevlogIndex(
  client: DevlogIndexClient,
  name: string,
  dimensions: number,
): Promise<SetupResult> {
  const desired = devlogChunksIndex(name, dimensions);
  let existing: SearchIndex | undefined;
  try {
    existing = await client.getIndex(name);
  } catch (error) {
    if (!isMissingIndex(error)) {
      throw error;
    }
  }

  if (existing === undefined) {
    await client.createOrUpdateIndex(desired);
    return "created";
  }
  if (indexMatches(existing, desired)) {
    return "unchanged";
  }
  await client.createOrUpdateIndex(desired);
  return "updated";
}
