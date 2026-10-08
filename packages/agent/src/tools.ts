import type { StructuredToolInterface } from "@langchain/core/tools";
import type { ToolDefinition, ToolDeps } from "@devlog/core/tools";
import { tool } from "langchain";
import type { z } from "zod";

export function toLangChainTool<TInput extends z.ZodType, TOutput>(
  def: ToolDefinition<TInput, TOutput>,
  deps: ToolDeps,
): StructuredToolInterface {
  return tool(
    async (args) => {
      const parsed = def.input.parse(args);
      return JSON.stringify(await def.handler(deps)(parsed));
    },
    {
      name: def.name,
      description: def.description,
      schema: def.input,
    },
  );
}
