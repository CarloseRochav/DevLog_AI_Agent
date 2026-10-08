# DevLog Agent — Spec (Phase 0–2)

Oct 1, 2026 · @Carlos

## 1. Overview

DevLog Agent is a personal RAG agent that answers questions about a project's architecture from Obsidian notes. It is built in TypeScript with LangChain.js v1, deployed on Azure, and reached from a frontend client (chat) and from MCP clients (tools). This spec covers Phase 0 (foundation), Phase 1 (RAG pipeline) and Phase 2 (the agent and its chat API).

**What it replaces:** the half-built Python/FastAPI DevLog Agent. Same goal, rebuilt in the JS/TS stack.

## 2. Goals, non-goals and constraints

**Goals**

- Answer architecture questions about one project, grounded in its Obsidian notes, with source citations (note + heading).
- Expose the same retrieval capabilities to the frontend chat and to MCP clients, from one tool registry.
- Run deployed on Azure, with indexing done from the local machine where the vault lives.
- Make retrieval quality measurable with an evaluation set.

**Non-goals (for Phases 0–2)**

- Writing to the vault. The agent is read-only over the notes.
- Multi-user support, accounts or Entra ID auth. A single API key is enough.
- Long-term memory across conversations (Phase 5).
- Automatic re-indexing on file change (Phase 5).
- The frontend UI itself (Phase 4). This spec only defines its API contract.

**Constraints**

| Area | Decision |
| --- | --- |
| Language | TypeScript (strict), Node.js 22+ |
| Validation | zod, one pinned version at the workspace root |
| Agent framework | LangChain.js v1 (`createAgent`); no `AgentExecutor` or `@langchain/classic` |
| Models | Azure OpenAI for chat and embeddings; deployment names are placeholders |
| Vector store | Azure AI Search, free tier, hybrid search |
| Raw notes | Azure Blob Storage |
| Hosting | Azure Container Apps, one app serving `/chat` and `/mcp` |
| MCP | Official `@modelcontextprotocol/sdk` (Phase 3) |
| Monorepo | pnpm workspaces |
| Corpus | About 12 Markdown files from one Obsidian folder |

## 3. Requirements

Tasks in section 10 reference these IDs.

### Functional

| ID | Requirement | Phase |
| --- | --- | --- |
| FR-CFG-01 | The system shall validate all environment variables with zod at startup and exit with a readable error listing every invalid variable. | 0 |
| FR-CFG-02 | Indexer-only variables (vault path) shall be optional in the server and required only by the `index` command. | 0 |
| FR-ING-01 | The indexer shall read Markdown files from `VAULT_PATH` matching `VAULT_INCLUDE` and ignore `.obsidian/`, attachments and non-`.md` files. | 1 |
| FR-ING-02 | The indexer shall parse frontmatter, tags, `[[wikilinks]]` and `![[embeds]]` into chunk metadata. | 1 |
| FR-ING-03 | The chunker shall split by headings (H1–H3) and prefix each chunk with `note title > heading path`. | 1 |
| FR-ING-04 | The chunker shall never split a fenced code block or Mermaid block. | 1 |
| FR-ING-05 | The indexer shall skip unchanged files (SHA-256 content hash) and delete chunks of files removed from the vault. | 1 |
| FR-ING-06 | The indexer shall upload each note's full content to Blob Storage. | 1 |
| FR-ING-07 | The indexer shall support `--dry-run` (print chunks, no writes) and `--full` (rebuild everything). | 1 |
| FR-IDX-01 | The system shall create or update the Azure AI Search index from code (`index:setup` command). | 1 |
| FR-IDX-02 | Each chunk shall store the embedding model and dimensions used; a mismatch with config shall force `--full`. | 1 |
| FR-RET-01 | Retrieval shall run hybrid search (keyword + vector) and return the top-k chunks with path, heading path and score. | 1 |
| FR-RET-02 | Retrieval shall support optional filters by tag and by note path. | 1 |
| FR-RET-03 | The `query` CLI command shall print retrieved chunks with sources. | 1 |
| FR-EVAL-01 | The `eval` command shall run the golden set and report hit@5 and MRR. | 1 |
| FR-AGT-01 | The agent shall answer using the tools `search_architecture_docs` and `read_note`, and shall cite sources for every factual claim. | 2 |
| FR-AGT-02 | The agent shall say it does not know when retrieval returns nothing relevant, instead of answering from general knowledge. | 2 |
| FR-AGT-03 | Tools shall be defined once (zod schema + handler) and reused by the agent and the MCP server. | 2 |
| FR-API-01 | `POST /chat` shall stream the answer to the frontend over Server-Sent Events. | 2 |
| FR-API-02 | The API shall keep conversation history per `conversationId` in memory, capped by message count. | 2 |

### Non-functional

| ID | Requirement |
| --- | --- |
| NFR-SEC-01 | Every endpoint except `/health` shall require the `x-api-key` header matching `AGENT_API_KEY`. |
| NFR-SEC-02 | Secrets shall never be logged; config logging shall mask keys. |
| NFR-OBS-01 | Every request shall log a request ID, latency, tool calls and token usage. |
| NFR-PERF-01 | Retrieval (embedding + search) shall complete in under 1.5 s at p95. |
| NFR-QA-01 | Retrieval shall reach hit@5 of at least 0.8 on the golden set before Phase 2 starts. |
| NFR-MNT-01 | Core packages shall not import Azure SDKs or LangChain directly, only through ports (see section 4). |

## 4. Architecture

Indexing runs on the local machine; serving runs on Azure. One core library feeds three thin entry points: the CLI, the chat API and the MCP server.

### 4.1 Monorepo layout

```
devlog-agent/
├─ packages/
│  ├─ config/         zod env schema, typed config, masked logging
│  ├─ core/           framework-free: no LangChain, no Azure SDK imports
│  │  ├─ ports/       Embedder, SearchIndex, NoteStore
│  │  ├─ ingestion/   vault walker, markdown parser, chunker, hasher
│  │  ├─ retrieval/   search service (query -> ranked chunks)
│  │  └─ tools/       tool definitions: zod schema + handler, no framework
│  ├─ adapters/       Azure AI Search, Blob Storage, Azure OpenAI embeddings
│  └─ agent/          LangChain v1: wraps core tools, createAgent, prompts
├─ apps/
│  ├─ cli/            index:setup, index, query, eval (runs locally)
│  └─ server/         Express or Fastify: /health, /chat (SSE), /mcp (Phase 3)
├─ eval/golden.jsonl  evaluation set
└─ docs/spec.md       this spec
```

### 4.2 Ports (the seams)

```ts
// packages/core/src/ports.ts
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SearchIndex {
  upsert(chunks: IndexedChunk[]): Promise<void>;
  deleteByNotePath(notePath: string): Promise<void>;
  hybridSearch(q: SearchQuery): Promise<SearchHit[]>;
  listNoteHashes(): Promise<Map<string, string>>; // notePath -> contentHash
}

export interface NoteStore {
  put(notePath: string, markdown: string): Promise<void>;
  get(notePath: string): Promise<string | null>;
  delete(notePath: string): Promise<void>;
}
```

Why ports: tests run against in-memory fakes, and moving from Azure AI Search to pgvector later is one new adapter, with no change to core.

### 4.3 One tool registry, two consumers

A tool is a plain object in `core/tools`. The agent package wraps it with LangChain's `tool()`; the MCP server registers the same schema and handler with the MCP SDK.

```ts
// packages/core/src/tools/search-architecture-docs.ts
export const searchArchitectureDocs = {
  name: "search_architecture_docs",
  description: "Search the project's architecture notes. Use for any question about components, data flow, or decisions.",
  input: z.object({
    query: z.string().min(3),
    topK: z.number().int().min(1).max(10).default(5),
    tags: z.array(z.string()).optional(),
  }),
  handler: (deps: ToolDeps) => async (args) => deps.retrieval.search(args),
} satisfies ToolDefinition;
```

**Before:** the chat agent and the MCP server each have their own search tool, and their descriptions and limits drift apart. **After:** changing `topK`'s maximum in one file changes it for both.

### 4.4 Deployment topology

&#91;embedded content: deployment topology · local indexing, Azure serving\]

The deployed app never touches the vault: the local CLI writes the index and the notes, and the Container App only reads them.

## 5. Configuration

All configuration comes from environment variables validated by one zod schema; model and deployment names stay as placeholders until chosen.

```ts
// packages/config/src/env.ts
import { z } from "zod";

const Base = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Azure OpenAI
  AZURE_OPENAI_ENDPOINT: z.string().url(),
  AZURE_OPENAI_API_KEY: z.string().min(1),
  AZURE_OPENAI_API_VERSION: z.string().default("<API_VERSION_PLACEHOLDER>"),
  AZURE_OPENAI_CHAT_DEPLOYMENT: z.string().default("<CHAT_DEPLOYMENT_PLACEHOLDER>"),
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z.string().default("<EMBEDDING_DEPLOYMENT_PLACEHOLDER>"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive(), // must match the index
  CHAT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),

  // Azure AI Search
  AZURE_SEARCH_ENDPOINT: z.string().url(),
  AZURE_SEARCH_API_KEY: z.string().min(1),
  AZURE_SEARCH_INDEX: z.string().default("devlog-chunks"),

  // Blob Storage
  AZURE_STORAGE_CONNECTION_STRING: z.string().min(1),
  AZURE_STORAGE_CONTAINER: z.string().default("devlog-notes"),
});

export const ServerEnv = Base.extend({
  PORT: z.coerce.number().default(3000),
  AGENT_API_KEY: z.string().min(32),
  CORS_ORIGIN: z.string().default("<FRONTEND_ORIGIN_PLACEHOLDER>"),
  HISTORY_MAX_MESSAGES: z.coerce.number().int().default(20),
});

export const IndexerEnv = Base.extend({
  VAULT_PATH: z.string().min(1),
  VAULT_INCLUDE: z.string().default("<PROJECT_FOLDER>/**/*.md"),
  CHUNK_MAX_TOKENS: z.coerce.number().int().default(700),
  CHUNK_OVERLAP_TOKENS: z.coerce.number().int().default(80),
});
```

- The server parses `ServerEnv`; the CLI parses `IndexerEnv`. This replaces an "optional vault path" with two explicit schemas, which is stricter (FR-CFG-02).
- On failure, print `z.prettifyError()` style output (or a formatted `issues` list) and exit with code 1 (FR-CFG-01).
- Ship a `.env.example` with every key and placeholder values. `.env` stays out of git.
- In Azure, keys go into Container Apps secrets, referenced as environment variables.

## 6. Ingestion and chunking

The indexer turns each note into heading-aware chunks with metadata, and only re-processes notes whose content hash changed.

### 6.1 Pipeline

1. **Walk:** glob `VAULT_INCLUDE` under `VAULT_PATH`; exclude `.obsidian/**`, `**/attachments/**`, `.trash/**`.
2. **Diff:** compute SHA-256 per file; compare with `SearchIndex.listNoteHashes()`. Classify each note as new, changed, unchanged or deleted.
3. **Parse** (new and changed only): frontmatter via `gray-matter`; body via a Markdown AST (`unified` + `remark-parse` + `remark-gfm`).
4. **Chunk:** apply the rules in 6.2.
5. **Embed:** batch chunk texts (batch size 16) through the `Embedder` port; retry with backoff on HTTP 429.
6. **Write:** for a changed note, `deleteByNotePath` then `upsert`; then `NoteStore.put` with the full Markdown. For a deleted note, delete chunks and the blob.
7. **Report:** print a summary such as `12 notes · 3 changed · 41 chunks upserted · 2.4 s`.

### 6.2 Chunking rules

| Rule | Detail |
| --- | --- |
| Split points | H1, H2 and H3 headings. H4+ stays inside its parent section. |
| Context prefix | Each chunk's embedded text starts with `[<note title> > <H1> > <H2> > <H3>]`. |
| Size cap | `CHUNK_MAX_TOKENS` (default 700). An oversized section splits on paragraph boundaries with `CHUNK_OVERLAP_TOKENS` overlap. |
| Atomic blocks | Fenced code, Mermaid and tables are never split. A single block over the cap becomes its own chunk. |
| Small sections | A section under 50 tokens merges into the next sibling, keeping both headings in the prefix. |
| Wikilinks | `[[Note]]` and `[[Note\|Alias]]` become plain text (`Alias`) in the content; the target goes to `links` metadata. |
| Embeds | `![[Note]]` is recorded in `links`, not inlined (avoids duplicate content). |
| Callouts | `> [!note] Title` keeps its title and body as plain text, without the marker. |
| Token counting | `js-tiktoken` with the encoding of the embedding model. |

**Before (fixed 500-character windows):**

```
chunk 7: "...the Worker Service polls the queue every 30s and"
chunk 8: "calls sp_ProcessBatch with a TVP. Retries use..."
```

**After (heading-aware with prefix):**

```
[Architecture > Background Processing > Queue Worker]
The Worker Service polls the queue every 30s and calls sp_ProcessBatch
with a TVP. Retries use exponential backoff...
```

### 6.3 Chunk schema

```ts
export const ChunkSchema = z.object({
  id: z.string(),               // sha1(notePath + "#" + ordinal), URL-safe
  notePath: z.string(),         // relative to the vault, e.g. "ProjectX/Architecture.md"
  noteTitle: z.string(),
  headingPath: z.array(z.string()),
  ordinal: z.number().int(),    // position within the note
  content: z.string(),          // text shown to the LLM (no prefix)
  embeddedText: z.string(),     // prefix + content, what gets embedded
  tags: z.array(z.string()),
  links: z.array(z.string()),
  hasCode: z.boolean(),
  hasMermaid: z.boolean(),
  contentHash: z.string(),      // hash of the whole note
  tokenCount: z.number().int(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number().int(),
  indexedAt: z.string().datetime(),
});
```

## 7. Index schema and retrieval

One Azure AI Search index holds the chunks; a single hybrid request (keyword text + vector) returns results already fused by the service.

### 7.1 Index fields (`devlog-chunks`)

| Field | Type | Attributes |
| --- | --- | --- |
| `id` | Edm.String | key |
| `notePath` | Edm.String | filterable, facetable |
| `noteTitle` | Edm.String | searchable |
| `headingPath` | Edm.String | searchable (joined with " > ") |
| `content` | Edm.String | searchable, analyzer `en.microsoft` |
| `tags` | Collection(Edm.String) | filterable, facetable |
| `links` | Collection(Edm.String) | filterable |
| `ordinal` | Edm.Int32 | sortable |
| `contentHash` | Edm.String | filterable |
| `embeddingModel` | Edm.String | filterable |
| `embeddingDimensions` | Edm.Int32 | filterable |
| `indexedAt` | Edm.DateTimeOffset | sortable |
| `contentVector` | Collection(Edm.Single) | `dimensions = EMBEDDING_DIMENSIONS`, HNSW profile, cosine |

- The schema is defined in code with `@azure/search-documents` and applied by `index:setup` (FR-IDX-01). Running it twice is safe.
- The notes are in English (decided Oct 5), so `content` uses the `en.microsoft` analyzer.

### 7.2 Retrieval contract

```ts
export const SearchQuerySchema = z.object({
  query: z.string().min(3),
  topK: z.number().int().min(1).max(10).default(5),
  tags: z.array(z.string()).optional(),
  notePath: z.string().optional(),
});

export const SearchHitSchema = z.object({
  chunkId: z.string(),
  notePath: z.string(),
  noteTitle: z.string(),
  headingPath: z.array(z.string()),
  content: z.string(),
  score: z.number(),
  citation: z.string(), // e.g. "Architecture.md > Background Processing > Queue Worker"
});
```

### 7.3 Retrieval algorithm

1. Embed the query through the `Embedder` port.
2. Send one search request: `search = query` (keyword), `vectorQueries = [{ vector, kNearestNeighborsCount: 20, fields: "contentVector" }]`, `top = topK`, and an OData `filter` built from `tags` / `notePath`.
3. The service fuses keyword and vector ranks with Reciprocal Rank Fusion.
4. The CLI and eval may drop hits below a minimum score. The agent tools do not (decided Oct 7): hybrid scores are Reciprocal Rank Fusion values, which measure rank agreement, not relevance, so the tools return the top-k and the model decides relevance under the 8.4 prompt (FR-AGT-02).
5. Map results to `SearchHit[]`, validated with zod at the adapter boundary.

**Why hybrid matters here:** a question like "where is `sp_ProcessBatch` called?" contains an exact identifier. Vector search alone may rank a generic "batch processing" paragraph first; the keyword half matches the exact name.

## 8. RAG agent design (Phase 2)

The agent is a LangChain v1 `createAgent` with three tools; it decides when to search (agentic RAG) instead of retrieving on every message, and streams its answer to the frontend over SSE.

### 8.1 Packages

- `langchain` (v1): `createAgent`, `tool`, middleware
- `@langchain/openai`: `AzureChatOpenAI`, `AzureOpenAIEmbeddings`
- `@langchain/langgraph`: `MemorySaver` checkpointer for conversation state
- Not used: `@langchain/classic`, `AgentExecutor`, `BufferWindowMemory`, LangChain vector store wrappers (retrieval stays in `core`)

### 8.2 Tools

| Tool | Input | Returns | When the agent uses it |
| --- | --- | --- | --- |
| `search_architecture_docs` | `query`, `topK?`, `tags?` | `SearchHit[]` with `citation` | Any question about components, flows, decisions or code names |
| `read_note` | `notePath` | Full Markdown of one note (truncated at 8k tokens) | A chunk is relevant but incomplete, or the user names a note |
| `list_notes` | none | Note titles, paths and tags | "What do you have?" or to pick a `notePath` filter |

The agent package wraps each core tool definition:

```ts
// packages/agent/src/tools.ts
import { tool } from "langchain";
import { searchArchitectureDocs, readNote, listNotes } from "@devlog/core/tools";

export const toLangChainTool = (def: ToolDefinition, deps: ToolDeps) =>
  tool(async (args) => JSON.stringify(await def.handler(deps)(args)), {
    name: def.name,
    description: def.description,
    schema: def.input,
  });
```

### 8.3 Agent construction

```ts
// packages/agent/src/create-devlog-agent.ts
import { createAgent, modelCallLimitMiddleware, toolCallLimitMiddleware } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface CreateDevlogAgentOptions {
  model?: BaseChatModel; // injected in tests (fakeModel); Azure model when omitted
}

export function createDevlogAgent(cfg: ServerConfig, deps: ToolDeps, options: CreateDevlogAgentOptions = {}) {
  // Azure Foundry v1 route is OpenAI-compatible: POST {endpoint}/openai/v1/chat/completions,
  // no api-version query. Mirror whatever the embeddings adapter (T1.3) already uses for this route.
  const model = options.model ?? new ChatOpenAI({
    model: cfg.AZURE_OPENAI_CHAT_DEPLOYMENT,
    apiKey: cfg.AZURE_OPENAI_API_KEY,
    temperature: cfg.CHAT_TEMPERATURE,
    configuration: {
      baseURL: `${cfg.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/v1`,
      defaultHeaders: { "api-key": cfg.AZURE_OPENAI_API_KEY },
    },
  });

  return createAgent({
    model,
    tools: [searchArchitectureDocs, readNote, listNotes].map((d) => toLangChainTool(d, deps)),
    systemPrompt: SYSTEM_PROMPT,
    checkpointer: new MemorySaver(), // thread_id = conversationId
    middleware: [
      resumeAfterBlockedToolsMiddleware(), // langchain 1.5.15 ends the run after a fully blocked tool batch; this returns to the model
      modelCallLimitMiddleware({ runLimit: 8 }),
      toolCallLimitMiddleware({ runLimit: 6 }),
      trimHistoryMiddleware(cfg.HISTORY_MAX_MESSAGES), // wrapModelCall: trims what the model sees; the checkpoint keeps the full thread
    ],
  });
}
```

**Decided (Oct 7, from the T2.2 plan review):**

- The chat model uses `ChatOpenAI` pointed at the Foundry `/openai/v1` route, not `AzureChatOpenAI` with an api-version. Exact option names are verified against the installed `@langchain/openai` before coding.
- `options.model` is injectable so the wiring test never calls Azure.
- Middleware names verified against installed `langchain@1.5.15`. Limits: 8 model calls and 6 tool calls per run. Pins from T2.2: langchain 1.5.15, @langchain/langgraph 1.4.20 (the version langchain resolves), ChatOpenAI with useResponsesApi: false.
- History is trimmed by message count inside wrapModelCall, not summarized: summarization costs an extra model call and can drop citations.
- Trimming rules: keep the newest `HISTORY_MAX_MESSAGES`; never leave a tool result without the assistant message that requested it (cut at a user-message boundary); never trim the current turn.

### 8.4 System prompt (v1)

```
You are DevLog Agent. You answer questions about the architecture of DevLog Agent
using only the project's notes, which you reach through your tools.

Rules:
- Search before answering any question about the project. Search again with
  different terms if the first results are weak.
- Every factual claim cites its source in square brackets, copying the search hit's
  citation field exactly, for example [Monitoring.md > Stuck Queue].
- If two searches return nothing on-topic, stop searching and answer that the
  notes don't cover it. Do not read notes just to be sure.
- If the notes don't cover the question, begin your answer with exactly:
  "The notes don't cover this." Do not fill gaps with general knowledge;
  you may offer general guidance only if clearly labeled as not from the notes.
- Prefer concrete names (services, tables, procedures) exactly as written in the notes.
- Answer in the language of the user's message.
```

### 8.5 Chat API contract

`POST /chat` with header `x-api-key`. Request body:

```ts
export const ChatRequestSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});
```

Response: `text/event-stream`. Events, in order:

| Event | Data | Purpose |
| --- | --- | --- |
| `tool_start` | `{ tool, input }` | Show "searching notes..." in the UI |
| `tool_end` | `{ tool, hitCount }` | Close the indicator |
| `token` | `{ text }` | Append to the answer as it streams |
| `sources` | `{ citations: SearchHit[] }` | Render source chips under the answer |
| `done` | `{ usage: { inputTokens, outputTokens }, latencyMs }` | End of turn; logged per NFR-OBS-01 |
| `error` | `{ code, message }` | Recoverable error shown to the user |

Implementation: iterate `agent.stream({ messages: [{ role: "user", content }] }, { configurable: { thread_id: conversationId }, streamMode: ["messages", "updates"] })` and map chunks to these events. Other endpoints: `GET /health` (no auth) and `DELETE /chat/:conversationId` to reset a conversation.

## 9. Evaluation

Retrieval must reach hit@5 ≥ 0.8 on a 15-question golden set before the agent is built on top of it (NFR-QA-01).

### 9.1 Golden set format (`eval/golden.jsonl`)

One JSON object per line, validated with zod:

```json
{"id":"q01","question":"How does the worker retry failed batches?","expected":["Architecture.md#Queue Worker"],"type":"exact-name"}
{"id":"q02","question":"Why did we choose Blob Storage over a file share?","expected":["Decisions.md"],"type":"decision"}
```

- `expected`: note paths, optionally with `#heading`. A hit counts if any retrieved chunk matches.
- `type`: `exact-name`, `concept`, `decision`, `cross-note`, `negative` (a question the notes do not answer; expected = `[]`).
- Write the questions yourself, the way you would really ask them, before tuning anything. Cover each of the 12 notes at least once, with at least 3 `exact-name` and 2 `negative` questions.

### 9.2 Metrics

| Metric | Definition | Target |
| --- | --- | --- |
| hit@5 | Share of questions with at least one expected source in the top 5 | ≥ 0.8 |
| MRR | Mean of 1 / rank of the first expected source | Tracked, no target yet |
| Negative precision | Retired at retrieval level (Oct 7): RRF scores can't separate off-topic hits (q13's top hit scored 0.0331, the same as real rank-2 hits). Negatives are checked at the agent level instead: the answer starts with "The notes don't cover this." | q13, q14 refuse (agent check) |

**Baseline (Oct 7, threshold 0):** hit@5 1.00 (13/13), MRR 0.923. q01 and q11 are found at rank 2.

### 9.3 Running it

`pnpm eval` prints a per-question table and the totals, and writes `eval/results/<timestamp>.json`. Re-run after every chunking or retrieval change and keep the results in git, so improvements are visible over time.

Phase 2 adds an answer-level check: for 5 questions, verify that the agent's answer cites an expected source. This stays manual until it proves useful to automate.

## 10. Task breakdown

Sixteen tasks across three phases; each is sized for one working session and is done only when its acceptance criteria pass.

### Phase 0: Foundation

- [x] **T0.1 Monorepo scaffold.** pnpm workspaces, TypeScript strict, ESM, `tsx` for dev, Vitest, ESLint + Prettier, Node 22 in `.nvmrc`.
  - `pnpm build`, `pnpm test` and `pnpm lint` pass on an empty project.
  - zod is declared once at the root; `pnpm why zod` shows a single version.
- [x] **T0.2 Config package** \[FR-CFG-01, FR-CFG-02, NFR-SEC-02\].
  - Tests: a missing key exits with a message naming it; keys are masked in logged config.
  - `.env.example` lists every variable.
- [x] **T0.3 Ports and fakes** \[NFR-MNT-01\].
  - `Embedder`, `SearchIndex`, `NoteStore` interfaces plus in-memory fakes used by tests.
  - A lint rule (`no-restricted-imports`) blocks `@azure/*` and `langchain` inside `packages/core`.
- [x] **T0.4 Azure resources.** Azure OpenAI chat and embedding deployments, AI Search (free), Storage account + container.
  - Resource names recorded in `docs/infra.md`; a smoke script calls each service once.

### Phase 1: RAG pipeline

- [x] **T1.1 Markdown parser** \[FR-ING-02\].
  - Fixture notes with frontmatter, tags, wikilinks with alias, embeds, callouts, Mermaid; snapshot tests of parsed output.
- [x] **T1.2 Chunker** \[FR-ING-03, FR-ING-04\].
  - Tests: heading prefix present; code and Mermaid blocks intact; oversized section splits with overlap; tiny section merges.
- [x] **T1.3 Azure adapters.** Embeddings (batching, 429 backoff), Search index, Blob store.
  - Integration tests behind an env flag; adapter outputs validated with zod.
- [x] **T1.4 `index:setup` command** \[FR-IDX-01\].
  - Creates the index from section 7.1; second run is a no-op.
- [x] **T1.5 `index` command** \[FR-ING-01, 05, 06, 07, FR-IDX-02\].
  - First run indexes all notes; second run reports 0 changed; editing one note re-indexes only it; deleting one removes its chunks and blob.
  - `--dry-run` writes nothing; a changed `EMBEDDING_DIMENSIONS` refuses to run without `--full`.
- [x] **T1.6 Retrieval service + `query` command** \[FR-RET-01, 02, 03, NFR-PERF-01\].
  - `pnpm cli query "..."` prints citations and scores; tag filter narrows results; p95 under 1.5 s over 20 runs.
- [ ] **T1.7 Golden set + `eval` command** \[FR-EVAL-01, NFR-QA-01\].
  - 15 questions per section 9.1; report shows hit@5 ≥ 0.8 (tune chunking and threshold until it does).

### Phase 2: Agent and chat API

- [x] **T2.1 Core tool definitions** \[FR-AGT-03\].
  - `search_architecture_docs`, `read_note`, `list_notes` in `core/tools`, unit-tested with fakes.
- [x] **T2.2 Agent package** \[FR-AGT-01, FR-AGT-02\].
  - `createDevlogAgent()` per section 8.3; a test with a fake model verifies the tool wiring.
  - Manual check: 5 golden questions answered with citations; 2 negative questions answered starting with exactly "The notes don't cover this.".
- [ ] **T2.3 Server: auth, health, logging** \[NFR-SEC-01, NFR-OBS-01\].
  - Missing or wrong `x-api-key` returns 401; logs show request ID, latency, tool calls, token usage.
- [ ] **T2.4 `POST /chat` with SSE** \[FR-API-01, FR-API-02\].
  - Events match section 8.5; a second message with the same `conversationId` sees the first; `DELETE` resets it.
  - A minimal test client (`curl -N` script or small HTML page) shows tokens streaming.
- [ ] **T2.5 Deploy to Container Apps.** Dockerfile (multi-stage, Node 22 slim), secrets as env vars, min replicas 0.
  - `/health` returns 200 from the public URL; `/chat` works from the test client.

## 11. Risks, open decisions and future phases

The biggest risk is the free search tier disappearing; it is acceptable only because the index is rebuildable in one command.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Free Azure AI Search service is deleted after inactivity | Agent returns no results | `index:setup` + `index --full` rebuild it in minutes; `/health` checks the index exists |
| LangChain v1 API names differ from this spec | Compile errors in T2.2 | Pin versions; verify against the installed docs before coding; adjust spec section 8 first |
| zod version conflict between LangChain, MCP SDK and app code | Type or runtime errors | Single zod version at root (T0.1); check `pnpm why zod` in CI |
| Public endpoint abused | Azure OpenAI cost | API key (NFR-SEC-01), rate limit on `/chat`, spending alert in Azure |
| Notes go stale versus the index | Outdated answers | `indexedAt` shown in `list_notes`; manual re-index after editing notes |

### Open decisions

- [x] Note language: are the architecture notes in English or Spanish? Sets the `content` analyzer (`en.microsoft` or `es.microsoft`).

  **Decided (Oct 5):** English, so `content` uses `en.microsoft`.
- [x] Embedding deployment: which model, which sets `EMBEDDING_DIMENSIONS`.

  **Decided (Oct 6):** `text-embedding-3-small`, so `EMBEDDING_DIMENSIONS=1536`.
- [x] HTTP framework for `apps/server`: Express (familiar) or Fastify (built-in schema validation).

  **Decided (Oct 6):** Express; request validation stays in zod.
- [ ] Project name and folder for `<PROJECT_NAME>` and `VAULT_INCLUDE`.

### Future phases

| Phase | Scope |
| --- | --- |
| 3 | MCP server at `/mcp` (streamable HTTP) reusing `core/tools`; tested from Claude Desktop or Claude Code |
| 4 | Frontend chat client consuming the SSE contract in 8.5 |
| 5 | Persistent conversations, wikilink graph expansion in retrieval, automatic re-index (GitHub Action or watcher), optional semantic reranker |
