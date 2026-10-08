import {
  AzureEmbedder,
  AzureNoteStore,
  createAzureSearchIndex,
  createNoteBlob,
  createSearchIndexClient,
} from "@devlog/adapters";
import { createDevlogAgent } from "@devlog/agent";
import { loadServerEnv, toLoggableConfig } from "@devlog/config";
import { createChatSession } from "./chat.js";
import { indexExists } from "./index-exists.js";
import { startServer } from "./index.js";

const config = loadServerEnv();
const search = createSearchIndexClient(
  config.AZURE_SEARCH_ENDPOINT,
  config.AZURE_SEARCH_API_KEY,
);
const embedder = new AzureEmbedder({
  endpoint: config.AZURE_OPENAI_ENDPOINT,
  apiKey: config.AZURE_OPENAI_API_KEY,
  deployment: config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
  dimensions: config.EMBEDDING_DIMENSIONS,
});
const searchIndex = createAzureSearchIndex({
  endpoint: config.AZURE_SEARCH_ENDPOINT,
  apiKey: config.AZURE_SEARCH_API_KEY,
  indexName: config.AZURE_SEARCH_INDEX,
  embedder,
});
const notes = new AzureNoteStore(
  createNoteBlob(
    config.AZURE_STORAGE_CONNECTION_STRING,
    config.AZURE_STORAGE_CONTAINER,
  ),
);
const chat = createChatSession(
  createDevlogAgent(config, { index: searchIndex, notes }),
);

console.log(
  JSON.stringify({
    msg: "config",
    config: toLoggableConfig(config),
  }),
);

try {
  const running = await startServer({
    port: config.PORT,
    apiKey: config.AGENT_API_KEY,
    indexExists: () => indexExists(search, config.AZURE_SEARCH_INDEX),
    chat,
  });
  console.log(JSON.stringify({ msg: "listening", port: running.port }));
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Server failed to start";
  console.error(message);
  process.exit(1);
}
