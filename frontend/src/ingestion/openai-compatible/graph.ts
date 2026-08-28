import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { OpenAICompatibleClient } from "./client";
import type { OpenAICompatibleMessage } from "./types";

export const LlmGraphState = Annotation.Root({
  messages: Annotation<OpenAICompatibleMessage[]>(),
  lastAssistantText: Annotation<string>(),
});

export interface LlmGraphDependencies {
  client: Pick<OpenAICompatibleClient, "complete">;
  /** A persistent saver can be supplied without changing the graph or format. */
  checkpointer?: BaseCheckpointSaver;
}

export function createLlmGraph({ client, checkpointer }: LlmGraphDependencies) {
  const callModel: typeof LlmGraphState.Node = async (state) => {
    const assistant = await client.complete(state.messages);
    return {
      messages: [...state.messages, assistant],
      lastAssistantText: assistant.content,
    };
  };

  return new StateGraph(LlmGraphState)
    .addNode("call_model", callModel)
    .addEdge(START, "call_model")
    .addEdge("call_model", END)
    .compile(checkpointer ? { checkpointer } : undefined);
}

