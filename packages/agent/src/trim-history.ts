import type { BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

function isHuman(message: BaseMessage): boolean {
  return message.getType() === "human";
}

export function trimHistory(
  messages: readonly BaseMessage[],
  maxMessages: number,
): BaseMessage[] {
  const firstHuman = messages.findIndex(isHuman);
  if (firstHuman === -1) {
    return [...messages];
  }

  const prefix = messages.slice(0, firstHuman);
  const turns: BaseMessage[][] = [];
  for (const message of messages.slice(firstHuman)) {
    const turn = turns[turns.length - 1];
    if (turn === undefined || isHuman(message)) {
      turns.push([message]);
    } else {
      turn.push(message);
    }
  }

  const count = (kept: readonly BaseMessage[][]): number =>
    prefix.length + kept.reduce((sum, turn) => sum + turn.length, 0);

  let kept = turns;
  while (kept.length > 1 && count(kept) > maxMessages) {
    kept = kept.slice(1);
  }
  return [...prefix, ...kept.flat()];
}

export function trimHistoryMiddleware(maxMessages: number) {
  return createMiddleware({
    name: "TrimHistory",
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        messages: trimHistory(request.messages, maxMessages),
      }),
  });
}
