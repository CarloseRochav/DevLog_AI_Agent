# Deployment workflow

T2.5. The chat server runs as one Azure Container App. Indexing stays on the machine that has the Obsidian vault. The container only reads the search index and the note blobs.

This file is the setup and configuration record. Resource names that exist only after a successful run are listed in [Recorded deployment](#recorded-deployment). Keys stay in the local `.env` and in Container Apps secrets. They are not written here.

## What is deployed

One app, `ca-devlog-agent`, serves `GET /health` and `POST /chat` (SSE) plus `DELETE /chat/:conversationId`. Phase 3 adds `/mcp` on this same app. There is no public HTML client. The test client is `scripts/chat.ps1`.

The process is `node dist/main.js`. It loads `ServerEnv`, builds the Azure embedder, search index, and blob note store, creates one agent with in-memory history, and listens on `PORT`. Startup logs the config through `toLoggableConfig`, which replaces `AZURE_OPENAI_API_KEY`, `AZURE_SEARCH_API_KEY`, `AZURE_STORAGE_CONNECTION_STRING`, and `AGENT_API_KEY` with `***`.

`VAULT_PATH` is not set in the container. The server schema does not read it. The CLI schema does, so `pnpm cli index` and `pnpm eval` still need it locally.

## Topology

```
local machine                         Azure
-----------                           -----
Obsidian vault
  pnpm cli index:setup
  pnpm cli index
        |  embeddings (Foundry, westus3)
        |  chunks     -> Azure AI Search (centralus, free)
        |  full notes -> Blob container devlog-notes (eastus2)
        v
scripts/deploy.ps1
  reads .env
  az acr build  ------------------>  crdevlogagent (eastus2)
  containerapp create/update ----->  ca-devlog-agent (eastus2)
                                        reads Search + Blob
                                        calls Foundry for chat + embeddings
                                        public HTTPS ingress :443 -> :3000
```

The resource group `rg-ernes-102010-6283` is in westus3. That location does not force new resources into westus3. Everything this workflow creates is in eastus2. The Foundry account stays in westus3 and the free search service stays in centralus. The container calls both over public HTTPS.

| Piece | Name | Region | Role |
| --- | --- | --- | --- |
| Subscription | Azure subscription 1 (`433d9c45-05fd-4a8e-9182-2ab85797e16e`) | | Existing |
| Resource group | rg-ernes-102010-6283 | westus3 | Existing |
| Foundry account | ernes-102010-3838-resource | westus3 | Chat `grok-4.6`, embeddings `text-embedding-3-small` (1536). Not created by this workflow |
| Search | ai-search-service-charlie | centralus | Free SKU. Index `devlog-chunks`. The subscription's only free search service |
| Storage | stdevlogagent | eastus2 | Private container `devlog-notes` |
| Registry | crdevlogagent | eastus2 | Basic, admin user enabled. Image `devlog-agent:<UTC yyyyMMddHHmmss>` |
| Log Analytics | log-devlog-agent | eastus2 | Console logs for the environment |
| Container Apps environment | cae-devlog-agent | eastus2 | Consumption. Logs go to the workspace above |
| Container App | ca-devlog-agent | eastus2 | External ingress, target port 3000, transport `http` |

## How to run it

From the repo root, with Azure CLI logged in to that subscription and `.env` filled in:

```powershell
pnpm azure:deploy
```

That is `pwsh -File scripts/deploy.ps1`. The script is idempotent. A missing registry, workspace, environment, or app is created. A later run builds a new image tag, updates the four app secrets and the registry password, and points the app at the new image.

To deploy an image that is already in the registry, pass its 14-digit tag and skip the build:

```powershell
pwsh -File scripts/deploy.ps1 -ImageTag yyyyMMddHHmmss
```

The script sets `PYTHONIOENCODING=utf-8` before it calls Azure CLI. pnpm prints a checkmark during install, and the Windows CLI log streamer throws on that character when Python's stdout is cp1252. The remote build can keep running after the local streamer crashes. `az acr task list-runs` is how to see that run.

Docker Desktop is not required. The image is built by `az acr build` in Azure.

## Image

`Dockerfile` is a two-stage build on `node:22-bookworm-slim`.

Build stage:

1. Install pnpm 12.9.1 with `npm install -g`. The image does not use Corepack. Node 22's Corepack build often stops on a signature prompt, and `CI=true` does not answer that prompt.
2. Copy the workspace manifests (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`) and every workspace package manifest, including `apps/cli`. The CLI is not a server runtime dependency. The frozen install still needs every importer that the lockfile records.
3. `pnpm install --frozen-lockfile`. `pnpm-workspace.yaml` sets `allowBuilds.esbuild: true`, so the install does not wait for a build approval.
4. Copy sources and `tsconfig.base.json`. `pnpm exec tsc -b apps/server/tsconfig.json --pretty false` compiles the server and the packages it references. Tests are not part of this build.
5. `pnpm deploy --filter @devlog/server --prod /out` writes a production tree whose root is the server package.

Runtime stage:

- Copy `/out` to `/app` as user `node`.
- `NODE_ENV=production`.
- `EXPOSE 3000`.
- `CMD ["node", "dist/main.js"]`. `pnpm deploy` places `dist/main.js` at the package root. The dev command `pnpm server` is different: it runs TypeScript from the repo with `node --env-file=.env`.

`.dockerignore` keeps `.env`, `.env.*`, `.git`, `node_modules`, `dist`, `eval`, and `docs` out of the upload. The build compiles its own `dist`. Secrets are not in the image. `az acr build` honors this file.

`packages/agent` references `packages/config` and `packages/core`. A clean `tsc -b apps/server` builds those projects first. Without the references, the agent project compiled against missing outputs.

The production tree does not list `langchain` or `@devlog/core` on the server package. Those are devDependencies of the server and real dependencies of `@devlog/agent`. `pnpm deploy --prod` keeps them because the agent needs them. The CLI is not in the runtime tree.

## Config and secrets

`scripts/deploy.ps1` reads `../.env` from the repo root. It strips one pair of wrapping double quotes, rejects an empty value, and rejects a value that is still a `<placeholder>`. `AGENT_API_KEY` must be at least 32 characters, matching `ServerEnv`. The script never prints a value.

On Windows, `az` is `az.cmd`. Cmd splits a command line on `;` and `&`. A storage connection string contains `;`, so the script calls `C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe -IBm azure.cli` for commands that carry secrets. Reads that only check whether a resource exists still use `az`. The helper is a simple function. An advanced function would treat `-o` as `-OutVariable` and refuse the Azure `--output` flag.

Plain environment variables come from `.env`, with the defaults below when the key is absent. `NODE_ENV` is forced to `production` even if `.env` says `development`. `PORT` is forced to `3000` because Container Apps does not set `PORT`, and the ingress target port is 3000.

| Variable | Source | Container value |
| --- | --- | --- |
| NODE_ENV | forced | `production` |
| LOG_LEVEL | `.env` or default | `info` |
| PORT | forced | `3000` |
| AZURE_OPENAI_ENDPOINT | `.env` | Foundry endpoint |
| AZURE_OPENAI_API_VERSION | `.env` | `v1` (records the `/openai/v1` route; no api-version query) |
| AZURE_OPENAI_CHAT_DEPLOYMENT | `.env` | `grok-4.6` |
| AZURE_OPENAI_EMBEDDING_DEPLOYMENT | `.env` | `text-embedding-3-small` |
| EMBEDDING_DIMENSIONS | `.env` | `1536` |
| CHAT_TEMPERATURE | `.env` or default | `0.2` |
| AZURE_SEARCH_ENDPOINT | `.env` | search endpoint |
| AZURE_SEARCH_INDEX | `.env` | `devlog-chunks` |
| AZURE_STORAGE_CONTAINER | `.env` | `devlog-notes` |
| CORS_ORIGIN | `.env` or default | `<FRONTEND_ORIGIN_PLACEHOLDER>` when unset |
| HISTORY_MAX_MESSAGES | `.env` or default | `20` |

`CORS_ORIGIN` is enforced when it is not `<FRONTEND_ORIGIN_PLACEHOLDER>`. The placeholder skips CORS. The browser client is still Phase 4.

Secrets are Container Apps secrets. The app sees them as environment variables. The secret names and the variables they fill:

| Secret name | Environment variable |
| --- | --- |
| azure-openai-api-key | AZURE_OPENAI_API_KEY |
| azure-search-api-key | AZURE_SEARCH_API_KEY |
| azure-storage-connection-string | AZURE_STORAGE_CONNECTION_STRING |
| agent-api-key | AGENT_API_KEY |
| acr-password | registry pull password only. Not an app env var |

The registry is Basic with the admin user enabled. The admin password is stored as `acr-password` and the app pulls with `--registry-password secretref:acr-password`. A later run refreshes that secret from `az acr credential show` and does not print it.

The Log Analytics workspace key is used only while creating `cae-devlog-agent` (`--logs-workspace-key`). It is not an application secret. The customer id is not a secret.

These indexer variables are local only and are not sent to the app: `VAULT_PATH`, `VAULT_INCLUDE`, `CHUNK_MAX_TOKENS`, `CHUNK_OVERLAP_TOKENS`.

## Container App shape

| Setting | Value | Why |
| --- | --- | --- |
| Ingress | external | Public HTTPS URL for `/health` and `/chat` |
| Target port | 3000 | Same as `PORT`. The process listens on all interfaces (`app.listen(port)` with no host) |
| Transport | `http` | HTTP/1.1. SSE is more predictable here than on HTTP/2 |
| CPU | 0.5 | Consumption pair used with 1.0Gi |
| Memory | 1.0Gi | Room for the Node process and the embedding client |
| Min replicas | 0 | Spec requirement. Idle apps scale to zero. The platform's HTTP cooldown is about 300 seconds |
| Max replicas | 1 | History is `MemorySaver` inside one process. A second replica would not see that history |
| Probes | none | `/health` returns 503 when the search index is missing. A liveness probe on that URL would restart the replica during a search blip. Acceptance is an external `GET /health` |
| Healthcheck in the image | none | Container Apps does not use a Dockerfile `HEALTHCHECK` |

Scale-to-zero drops the process, so the in-memory conversation map is empty after a cold start. `DELETE /chat/:conversationId` still clears one conversation while the replica is up. A new conversation id is the normal way to start over.

SSE responses already send `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`, and `Connection: keep-alive`. The environment proxy's default request timeout is about 240 seconds, which covers one chat turn.

Auth is unchanged from T2.3. `GET` and `HEAD` `/health` are public. Every other route requires header `x-api-key` equal to `AGENT_API_KEY`. A wrong or missing key is 401.

`/health` returns `200` and `{"status":"ok"}` when index `devlog-chunks` exists. It returns `503` and `{"status":"unavailable"}` when the index is missing or the search call throws.

## What the script does, in order

1. Register `Microsoft.ContainerRegistry`, `Microsoft.OperationalInsights`, and `Microsoft.App` if they are not already registered.
2. Create `crdevlogagent` (Basic, eastus2, admin enabled) when it is missing, then force the admin user on.
3. Build `devlog-agent:<UTC yyyyMMddHHmmss>` with `az acr build --timeout 1800`, unless `-ImageTag` names an image that is already in the registry. The tag is never `latest`.
4. Read the registry username and password into script variables.
5. Create `log-devlog-agent` when it is missing, then read its customer id and primary shared key.
6. Create `cae-devlog-agent` with `--logs-destination log-analytics` when it is missing.
7. Create `ca-devlog-agent`, or, when it already exists, `az containerapp secret set` and `az containerapp update` with the new image. Scale, CPU, and memory are set on both paths.
8. Read the ingress FQDN. Poll `https://<fqdn>/health` up to 36 times, 10 seconds apart, 30 second HTTP timeout. The first attempts fail while the replica cold-starts. That is expected.
9. On success, print `image:` and `url:` only. On failure, print the last 80 console log lines and exit non-zero.

The script does not call `/chat`. A chat turn spends model tokens, so it is not part of every redeploy. The acceptance check is a separate `scripts/chat.ps1` call after health returns 200.

## Verify

Health, with retries for the cold start:

```powershell
curl.exe -sS -D - https://<fqdn>/health
```

Expect `200` and `{"status":"ok"}`.

Chat. Load the key in the process and do not echo it:

```powershell
# AGENT_API_KEY is already in the environment, or was read from .env into $env:AGENT_API_KEY
pwsh -File scripts/chat.ps1 -BaseUrl "https://<fqdn>" -Message "Where is sp_ProcessBatch called?"
```

Expect SSE events. A normal turn includes `token` and ends with `done`. `sources` is always sent. The script prints the `conversationId` and then the event stream.

Console logs:

```powershell
az containerapp logs show --name ca-devlog-agent --resource-group rg-ernes-102010-6283 --tail 80 --type console
```

A healthy start logs `msg: "config"` with the four secrets as `***`, then `msg: "listening"` and `"port":3000`.

## Update and rebuild

Change the code or `.env`, then run `pnpm azure:deploy` again. The new image tag is a new timestamp. The running revision moves to that image. Secret values are rewritten from the current `.env`. Endpoints and deployment names are rewritten too.

Changing a plain variable in `.env` does nothing to the live app until the next deploy. Changing a secret is the same.

The container never reindexes. After notes change, run the indexer locally (`pnpm cli index`). The next chat request reads the updated index. A full rebuild is `pnpm cli index --full` after `pnpm cli index:setup` if the index was deleted.

## Not in this deployment

- The Obsidian vault. The container has no path to it.
- The indexer CLI and the eval command.
- MCP (`/mcp` is Phase 3).
- The frontend (Phase 4). `CORS_ORIGIN` is reserved for it.
- Rate limiting. The spec's abuse mitigation is the API key plus an Azure spending alert. A rate limit on `/chat` is not part of T2.5.
- Durable conversation history (Phase 5). A restart or a scale-to-zero clears it.
- A user-assigned identity for the registry. Pull uses the ACR admin user. That user is a password, stored as a Container Apps secret.

## Risks

- The free search service is the subscription's only one, and it can be removed after inactivity. `/health` then returns 503. Rebuild with `pnpm cli index:setup` and `pnpm cli index --full` from the machine that has the vault.
- Max replicas is 1 on purpose. Raising it splits history across processes.
- Scale-to-zero saves idle cost and drops history. The first request after idle pays a cold start. The health loop waits up to about six minutes for that.
- The public URL plus a leaked `AGENT_API_KEY` can spend Foundry tokens. The key is a Container Apps secret and is required on every route except `/health`.
- ACR admin credentials are powerful for this registry. They live only as the `acr-password` secret and in the script's memory during a deploy.

## Recorded deployment

First successful run, 8 Oct 2026. The image was built by `az acr build` run `ch1`. The local CLI log streamer then crashed on a pnpm checkmark (cp1252). The remote build still finished as Succeeded. The app was created with `-ImageTag 20261008204302`, which skips a second build. Later deploys can use `pnpm azure:deploy`; the script now sets `PYTHONUTF8=1` so the streamer survives that character.

Creating `cae-devlog-agent` stayed in provisioning state `Waiting` for many minutes, then `Succeeded`. That wait is normal for a new environment.

| | |
| --- | --- |
| Image | crdevlogagent.azurecr.io/devlog-agent:20261008204302 |
| Public URL | https://ca-devlog-agent.victoriouspebble-bfc7fd71.eastus2.azurecontainerapps.io |
| Health | `GET /health` returned `200` and `{"status":"ok"}` |
| Chat | `scripts/chat.ps1` against that URL, message "Where is sp_ProcessBatch called?", conversation `efde47b7-b7b3-4c35-8e62-0f294b103276`. The stream sent `token`, `tool_start`, `tool_end`, `sources`, and `done`. Usage was 4432 input tokens and 165 output tokens. Latency was 12800 ms. The answer cited `Queue Worker.md > Queue Worker > Procedure Call`. |

Live settings read back from Azure: external ingress, target port 3000, transport `Http`, CPU 0.5, memory 1Gi, min replicas 0, max replicas 1. Secret names on the app are `acr-password`, `azure-openai-api-key`, `azure-search-api-key`, `azure-storage-connection-string`, and `agent-api-key`. The four application keys are `secretRef` environment variables. `VAULT_PATH` is not set.
