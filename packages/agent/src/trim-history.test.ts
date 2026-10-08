import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { expect, test } from "vitest";
import { trimHistory } from "./trim-history.js";

function toolCall(id: string): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [
      {
        id,
        name: "search_architecture_docs",
        args: { query: "queue worker" },
        type: "tool_call",
      },
    ],
  });
}

function toolResult(id: string, content: string): ToolMessage {
  return new ToolMessage({ content, tool_call_id: id });
}

function assertToolsStayWithRequests(messages: readonly BaseMessage[]): void {
  const requested = new Set<string>();
  for (const message of messages) {
    if (message.getType() === "ai" && AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        if (call.id !== undefined) {
          requested.add(call.id);
        }
      }
    }
    if (message.getType() === "tool" && ToolMessage.isInstance(message)) {
      expect(requested.has(message.tool_call_id)).toBe(true);
    }
  }
}

test("trim drops old turns at a user boundary", () => {
  const messages = [
    new SystemMessage("stay"),
    new HumanMessage("one"),
    new AIMessage("first"),
    new HumanMessage("two"),
    new AIMessage("second"),
    new HumanMessage("three"),
    new AIMessage("third"),
  ];

  const trimmed = trimHistory(messages, 5);

  expect(trimmed.map((message) => message.content)).toEqual([
    "stay",
    "two",
    "second",
    "three",
    "third",
  ]);
  expect(trimmed[1]?.getType()).toBe("human");
  expect(messages).toHaveLength(7);
});

test("trim keeps the current turn", () => {
  const messages = [
    new HumanMessage("old"),
    new AIMessage("old answer"),
    new HumanMessage("current"),
    toolCall("call-current"),
    toolResult("call-current", "hits"),
    new AIMessage("final"),
  ];

  const trimmed = trimHistory(messages, 2);

  expect(trimmed.map((message) => message.getType())).toEqual([
    "human",
    "ai",
    "tool",
    "ai",
  ]);
  expect(trimmed[0]?.content).toBe("current");
  assertToolsStayWithRequests(trimmed);
});

test("trim keeps a tool result with its assistant message", () => {
  const messages = [
    new HumanMessage("old"),
    toolCall("call-old"),
    toolResult("call-old", "old hits"),
    new HumanMessage("current"),
    toolCall("call-current"),
    toolResult("call-current", "current hits"),
  ];

  const trimmed = trimHistory(messages, 2);

  expect(trimmed).toHaveLength(3);
  expect(trimmed[0]?.content).toBe("current");
  assertToolsStayWithRequests(trimmed);
  expect(trimmed.some((message) => message.content === "old hits")).toBe(false);
});
