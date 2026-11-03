import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateSuggestion, supportsPersistentSuggestion } from "./core.mjs";
import { suggestionThreadPath } from "./threads.mjs";

const model = { provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses", reasoning: true };
const messages = [
  { role: "system", content: "主会话系统规则不能转发" },
  { role: "user", content: "解释报告即可" },
  { role: "assistant", content: [{ type: "thinking", thinking: "主助手隐藏推理不能转发", thinkingSignature: "foreground-secret" }, { type: "text", text: "只解释，未实施。" }] },
];
const response = (id = "prediction-1") => ({
  role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content: [{ type: "thinking", thinking: "预测线程自己的推理", thinkingSignature: "own-reasoning-signature" }, { type: "text", text: "那解释一下缓存呢？", textSignature: "own-text-signature" }],
  stopReason: "stop", responseId: id, timestamp: 1, usage: { totalTokens: 100 },
});
const evidence = (context) => context.messages.filter(m => m.role === "user").map(m => JSON.parse(m.content)).filter(m => m.kind === "conversation_evidence");
const checkpoint = request => readFile(suggestionThreadPath(request.agentDir, request.sessionId), "utf8").then(JSON.parse);
async function fixture(run) {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-suggestions-"));
  try { await run({ enabled: true, model, messages, preferences: "我的原文", thinkingLevel: "low", sessionId: "codex-main-session", agentDir, revision: "first" }); }
  finally { await rm(agentDir, { recursive: true, force: true }); }
}
const worker = request => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./test/thread-worker.mjs", import.meta.url)), JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `Worker exit ${code}`)));
});

test("Codex persists exact private history for SDK delta and restores it in a new process", () => fixture(async request => {
  assert.equal(supportsPersistentSuggestion(model), true);
  const before = structuredClone(request.messages);
  let firstContext;
  await generateSuggestion({ ...request, complete: async (_model, context, options) => {
    firstContext = structuredClone(context.messages);
    assert.equal(options.transport, "auto");
    assert.equal(options.sessionId, "codex-main-session:prompt-suggestions");
    assert.equal(options.requestIdentity.threadId, options.sessionId);
    assert.equal(options.onPayload, undefined, "Codex SDK owns store:false and connection-local previous_response_id");
    assert(!JSON.stringify(context).includes("foreground-secret"));
    assert(!JSON.stringify(context).includes("主会话系统规则"));
    assert(!JSON.stringify(context).includes("主助手隐藏推理"));
    assert.equal(evidence(context).length, 2);
    return response();
  } });
  const next = [...messages, { role: "user", content: "我的真实下一句不是你的猜测" }];
  await generateSuggestion({ ...request, messages: next, revision: "second", complete: async (_model, context) => {
    assert.deepEqual(context.messages.slice(0, firstContext.length), firstContext);
    assert.deepEqual(context.messages[firstContext.length], response());
    assert.equal(evidence(context).length, 3);
    assert(!evidence(context).some(turn => turn.text.includes("那解释一下缓存呢")));
    return response("prediction-2");
  } });
  const state = await checkpoint(request);
  assert.equal(state.lastRequest.mode, "append");
  assert.equal(state.lastRequest.evidenceTurns, 1);
  assert.equal(state.lastRequest.history, undefined, "do not duplicate history in request statistics");
  assert.equal(state.history.filter(m => m.role === "assistant").length, 2);
  assert.equal(state.history[firstContext.length].content[0].thinkingSignature, "own-reasoning-signature");
  const restored = await worker({ ...request, messages: [...next, { role: "assistant", content: "恢复进程后继续解释。" }], revision: "third" });
  assert.equal(restored.sent.transport, "auto");
  assert.equal(restored.sent.store, false);
  assert.equal(restored.sent.previous_response_id, undefined);
  assert.equal(restored.sent.sessionId, "codex-main-session:prompt-suggestions");
  assert.deepEqual(restored.sent.input.slice(0, state.history.length), state.history);
  assert.equal(restored.evidence.length, 4);
  assert.equal((await checkpoint(request)).totals.requests, 3);
  assert.deepEqual(request.messages, before);
}));

test("Codex rebuilds local history on changed evidence or prediction configuration", () => fixture(async request => {
  await generateSuggestion({ ...request, complete: async () => response() });
  for (const change of [{ messages: [{ role: "user", content: "压缩后的完整有效证据" }] }, { preferences: "新的偏好原文" }]) {
    await generateSuggestion({ ...request, ...change, complete: async (_model, context) => {
      assert.equal(context.messages.filter(m => m.role === "assistant").length, 0);
      assert.deepEqual(evidence(context).map(turn => turn.text), change.messages ? ["压缩后的完整有效证据"] : ["解释报告即可", "只解释，未实施。"]);
      return response("rebuilt");
    } });
    assert.equal((await checkpoint(request)).lastRequest.mode, "full");
  }
}));

test("unchanged Codex evidence is reused; cancelled appends cannot overwrite recoverable history", () => fixture(async request => {
  await generateSuggestion({ ...request, complete: async () => response() });
  const state = await checkpoint(request);
  const cached = await generateSuggestion({ ...request, complete: async () => assert.fail("unchanged evidence must not call model") });
  assert.equal(cached.text, state.text);
  const controller = new AbortController();
  const result = await generateSuggestion({ ...request, messages: [...messages, { role: "user", content: "新证据" }], signal: controller.signal,
    complete: async () => { controller.abort(); return response("too-late"); } });
  assert.equal(result.text, null);
  assert.deepEqual(await checkpoint(request), state);
}));

test("an oversized Codex prediction history rebuilds once without trimming real evidence or retrying network failures", () => fixture(async request => {
  await generateSuggestion({ ...request, complete: async () => response() });
  const next = [...messages, { role: "toolResult", content: [{ type: "text", text: "完整报告".repeat(3000) }] }];
  let calls = 0;
  await generateSuggestion({ ...request, messages: next, complete: async (_model, context) => {
    if (++calls === 1) return { ...response(), stopReason: "error", errorMessage: "context_length_exceeded" };
    assert.equal(context.messages.filter(m => m.role === "assistant").length, 0);
    assert.equal(evidence(context).at(-1).text, next.at(-1).content[0].text);
    return response("rebuilt");
  } });
  assert.equal(calls, 2);
  assert.equal((await checkpoint(request)).lastRequest.mode, "full");
  calls = 0;
  await assert.rejects(generateSuggestion({ ...request, messages: [...next, { role: "user", content: "继续" }], complete: async () => {
    calls++; throw new Error("Network unavailable");
  } }), /Network unavailable/);
  assert.equal(calls, 1);
}));
