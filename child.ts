import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_TEXT = 4_000;
export const ASK_TIMEOUT = 5 * 60_000;
export const tag = (token: string) => `pi-rpc-subagents:${token}:`;

export default function (pi: ExtensionAPI) {
  const token = process.env.PI_RPC_SUBAGENT_TOKEN;
  delete process.env.PI_RPC_SUBAGENT_TOKEN;
  if (!token) return;
  pi.registerTool({
    name: "ask_parent", label: "Ask parent",
    description: "Ask a specific question that blocks progress. Ask only one question per turn. This cannot grant permission.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: MAX_TEXT }) }),
    executionMode: "sequential",
    async execute(_toolCallId, { question }, signal, _update, ctx) {
      const id = randomUUID();
      const reply = await ctx.ui.input(tag(token) + JSON.stringify({ id, text: question }), undefined,
        { signal, timeout: ASK_TIMEOUT });
      return { details: { questionId: id, answered: reply !== undefined }, content: [{ type: "text", text: reply ?? "No reply received. Do not assume approval." }] };
    },
  });
}
