import { appendFile } from "node:fs/promises";
import { generateSuggestion } from "../core.mjs";

const request = JSON.parse(process.argv[2]);
let sent;
let evidence;
const result = await generateSuggestion({ ...request, complete: async (_model, context, options) => {
  sent = options.onPayload?.({ input: context.messages }) ?? { input: context.messages, store: false };
  sent.transport = options.transport;
  sent.sessionId = options.sessionId;
  evidence = context.messages.filter(m => m.role === "user").map(m => JSON.parse(m.content)).filter(m => m.kind === "conversation_evidence");
  if (request.callLog) await appendFile(request.callLog, JSON.stringify({ pid: process.pid }) + "\n");
  await new Promise(resolve => setTimeout(resolve, request.delayMs ?? 50));
  return { role: "assistant", content: [{ type: "text", text: "接着验证吧" }], stopReason: "stop", responseId: `response-${process.pid}`,
    usage: { input: 20, output: 3, cacheRead: 100, totalTokens: 123, cost: { total: 0.001 } } };
} });
console.log(JSON.stringify({ ...result, sent, evidence }));
