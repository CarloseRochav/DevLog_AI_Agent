# DevLog Agent: rules for coding agents

## Source of truth
- `docs/spec.md` is the specification. Read the relevant sections before any task.
- Requirement IDs (FR-*, NFR-*) and task IDs (T0.1, T1.2, ...) come from the spec.
- Never change behavior that contradicts the spec. If the spec is wrong, ambiguous or
  outdated, STOP and report it; do not silently work around it.

## Stack (fixed)
- Node.js 22+, TypeScript strict, ESM, pnpm workspaces, Vitest, ESLint + Prettier.
- zod: one version, declared at the workspace root only.
- LangChain.js v1 only (`createAgent` from `langchain`). Never use `AgentExecutor`,
  `@langchain/classic`, or `BufferWindowMemory`.
- Azure OpenAI (chat + `text-embedding-3-small`, 1536 dims), Azure AI Search, Azure Blob Storage.
- HTTP server: Express. Validate requests with zod.

## Architecture rules
- `packages/core` must not import `@azure/*` or `langchain`. Only through ports.
- Tools are defined once in `packages/core/tools` (zod schema + handler).
- Validate all external data (env, API responses, adapter outputs) with zod at the boundary.

## Library APIs
- Do not trust memory for library APIs (LangChain, @azure/search-documents, MCP SDK).
  Check the installed package's types in node_modules or its official docs before using an API.
  If an API differs from the spec's example code, follow the real API and report the difference.

## Safety
- Never commit secrets or `.env`. Keep `.env.example` updated with placeholders.
- Never log keys; config logging masks them.
- Never read from or write to an Obsidian vault except through the indexer, read-only.

## Commands
- `pnpm build`, `pnpm test`, `pnpm lint` must pass before any task is reported done.