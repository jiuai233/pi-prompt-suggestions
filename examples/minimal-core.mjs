import assert from "node:assert/strict";
import { generateSuggestion } from "../plugin/core.mjs";

// Offline fixture only. Replace complete with the host SDK for real predictions.
const result = await generateSuggestion({
  enabled: true,
  model: { provider: "fixture", id: "offline", api: "openai-responses" },
  messages: [
    { role: "user", content: "先解释缓存的原理。" },
    { role: "assistant", content: [{ type: "text", text: "已解释，尚未实施修改。" }] },
  ],
  preferences: "未选定路线时，先比较原理与差异。",
  complete: async (_model, context, options) => {
    assert(options.sessionId.endsWith(":prompt-suggestions"));
    const evidence = context.messages.filter(m => m.role === "user").map(m => JSON.parse(m.content));
    assert(evidence.some(m => m.kind === "conversation_evidence" && m.role === "assistant"));
    return { role: "assistant", content: [{ type: "text", text: "那两种方案有什么差异？" }], stopReason: "stop" };
  },
});
console.log(JSON.stringify({ offline: true, paidRequests: 0, candidate: result.text }, null, 2));
