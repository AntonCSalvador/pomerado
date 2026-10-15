import type { AgentInputItem } from "@openai/agents";

/**
 * The Responses API compacts the context it is sent when this is the last input item, and
 * returns the compaction item that replaces that context. Sent after the same request a turn
 * sent, it reads that request's cached prefix.
 */
export const compactionTrigger: AgentInputItem = {
  type: "unknown",
  providerData: { type: "compaction_trigger" },
};
