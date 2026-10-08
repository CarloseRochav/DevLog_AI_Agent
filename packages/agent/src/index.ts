export const packageName = "@devlog/agent";

export {
  createChatModel,
  createDevlogAgent,
  type CreateDevlogAgentOptions,
} from "./create-devlog-agent.js";
export { SYSTEM_PROMPT } from "./prompt.js";
export { toLangChainTool } from "./tools.js";
export { trimHistory, trimHistoryMiddleware } from "./trim-history.js";
