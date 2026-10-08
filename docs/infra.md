# Azure infrastructure

Recorded for T0.4. This file lists resource names, regions, endpoints, and deployment names. Keys and the storage connection string stay in a local `.env` file, which git ignores.

## Subscription

| | |
| --- | --- |
| Name | Azure subscription 1 |
| Id | 433d9c45-05fd-4a8e-9182-2ab85797e16e |

## Resource group

| | |
| --- | --- |
| Name | rg-ernes-102010-6283 |
| Location | westus3 |

The group already existed. T0.4 added the storage account to it. A resource group's location does not force every resource into that region.

## Foundry account

Reused. Kind `AIServices`, SKU `S0`, location `westus3`.

| | |
| --- | --- |
| Name | ernes-102010-3838-resource |
| Foundry endpoint | https://ernes-102010-3838-resource.services.ai.azure.com |
| Legacy OpenAI endpoint | https://ernes-102010-3838-resource.openai.azure.com |
| Project | ernes-102010-3838 |

`AZURE_OPENAI_ENDPOINT` is the Foundry endpoint. Chat and embeddings are `POST {endpoint}/openai/v1/chat/completions` and `POST {endpoint}/openai/v1/embeddings`. Send header `api-key` and set JSON `model` to the deployment name. This route takes no `api-version` query parameter. `AZURE_OPENAI_API_VERSION=v1` records that route.

Deployments are on the account. The Foundry project is `ernes-102010-3838`.

### Chat deployment

| | |
| --- | --- |
| Deployment name | grok-4.6 |
| Model | grok-4.6 |
| Format | xAI |
| Version | 1 |
| SKU | GlobalStandard |
| Capacity | 50 |

This deployment was already on the account.

### Embedding deployment

| | |
| --- | --- |
| Deployment name | text-embedding-3-small |
| Model | text-embedding-3-small |
| Format | OpenAI |
| Version | 1 |
| SKU | GlobalStandard |
| Capacity | 500 |
| Dimensions | 1536 |

This deployment was already on the account.

## Azure AI Search

Reused. This subscription already uses its one free search service: `ai-search-service-charlie`. T1.4 creates the index. The config default index name is `devlog-chunks`.

| | |
| --- | --- |
| Name | ai-search-service-charlie |
| SKU | free |
| Location | centralus |
| Status | running |
| Endpoint | https://ai-search-service-charlie.search.windows.net |
| List API | GET /indexes?api-version=2024-07-01 |

## Storage

Created for T0.4. `Microsoft.Storage` was registered on the subscription first.

| | |
| --- | --- |
| Name | stdevlogagent |
| Location | eastus2 |
| Kind | StorageV2 |
| SKU | Standard_LRS |
| Minimum TLS | TLS1_2 |
| HTTPS only | yes |
| Public blob access | disabled |
| Container | devlog-notes |

The container is private. `scripts/smoke-azure.ts` writes `smoke.txt` and then deletes it. Blob calls use REST API version `2023-11-03` and the account key from `AZURE_STORAGE_CONNECTION_STRING`.

## Region

New resources for this task go in eastus2. The storage account is in eastus2. The Foundry account stays in westus3 and the free search service stays in centralus, because both already existed in `rg-ernes-102010-6283`.

## Container Apps (T2.5)

Created in eastus2. The workflow is `docs/deploy.md`. The public host name is assigned by Azure.

| | |
| --- | --- |
| Registry | crdevlogagent |
| Login server | crdevlogagent.azurecr.io |
| Registry SKU | Basic, admin user enabled |
| Image | devlog-agent:20261008204302 |
| Log Analytics | log-devlog-agent |
| Workspace customer id | 28be5cc9-ae8c-47ab-94aa-9e81b95f6854 |
| Environment | cae-devlog-agent |
| Container App | ca-devlog-agent |
| Public URL | https://ca-devlog-agent.victoriouspebble-bfc7fd71.eastus2.azurecontainerapps.io |
| Ingress | external, target port 3000, transport Http |
| Scale | min replicas 0, max replicas 1 |
| Size | 0.5 CPU, 1Gi memory |

Keys are Container Apps secrets referenced as environment variables. They are not listed here. The Log Analytics shared key is not listed here either. The workspace customer id is an identifier, not a secret.

## Later tasks

- T1.4 created the `devlog-chunks` search index.
- T2.5 deployed the Container App. The record is above and in `docs/deploy.md`.
