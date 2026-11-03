import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSuggestionMessages, generateSuggestion } from "./core.mjs";
import { suggestionThreadPath } from "./threads.mjs";

const model = { provider: "xai", id: "grok-4.7-build-fast", api: "openai-responses", reasoning: true };
const messages = [{ role: "user", content: "真实目标", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "完成检查" }], timestamp: 2 }];
const response = (responseId, text = "接着验证吧") => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", responseId,
  usage: { input: 20, output: 3, cacheRead: 100, totalTokens: 123, cost: { total: 0.001 } } });
async function fixture(run) {
  const agentDir = await mkdtemp(join(tmpdir(), "persistent-suggestions-"));
  try { await run({ enabled: true, model, messages, preferences: "我的偏好", sessionId: "session-a", agentDir, revision: "leaf-1" }); }
  finally { await rm(agentDir, { recursive: true, force: true }); }
}
const evidence = (context) => context.messages.filter(m => m.role === "user").map(m => JSON.parse(m.content)).filter(m => m.kind === "conversation_evidence");
const worker = (request) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./test/thread-worker.mjs", import.meta.url)), JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `Worker exit ${code}`)));
});

test("stable per-turn evidence keeps the old prefix and puts the changing revision last", () => {
  const a = buildSuggestionMessages(messages, "偏好", "first");
  const b = buildSuggestionMessages([...messages, { role: "user", content: "继续", timestamp: 3 }], "偏好", "second");
  assert.deepEqual(a.slice(0, -1), b.slice(0, a.length - 1));
  assert.equal(JSON.parse(a[1].content).preferences, "偏好");
  assert.equal(JSON.parse(a.at(-1).content).revision, "first");
  assert.match(a[0].content, /之前的助手输出只是预测/);
});

test("a new process restores the checkpoint and sends only newly observed real evidence", () => fixture(async request => {
  const before = JSON.stringify(request.messages);
  await generateSuggestion({ ...request, complete: async (_model, context, options) => {
    const payload = options.onPayload({ input: context.messages, store: false });
    assert.equal(payload.store, true);
    assert.equal(payload.previous_response_id, undefined);
    assert.equal(evidence(context).length, 2);
    return response("response-1", "这句只是猜测");
  } });
  const next = [...messages, { role: "user", content: "实际说的是先解释原理", timestamp: 3 }];
  const result = await worker({ ...request, messages: next, revision: "leaf-2" });
  assert.equal(result.sent.previous_response_id, "response-1");
  assert.equal(result.sent.store, true);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].text, "实际说的是先解释原理");
  assert(!JSON.stringify(result.sent).includes("这句只是猜测"));
  const state = JSON.parse(await readFile(suggestionThreadPath(request.agentDir, request.sessionId), "utf8"));
  assert.equal(state.lastRequest.mode, "delta");
  assert.equal(state.totals.requests, 2);
  assert.equal(state.turnHashes.length, 3);
  assert.equal(JSON.stringify(request.messages), before);
}));

test("changed evidence or preferences rebuilds from the entire current snapshot, not obsolete history", () => fixture(async request => {
  let calls = 0;
  const complete = async (_model, context, options) => {
    const payload = options.onPayload({ input: context.messages });
    assert.equal(payload.previous_response_id, undefined);
    assert.deepEqual(evidence(context).map(x => x.text), calls === 1 ? ["压缩后的当前有效证据"] : messages.map(m => typeof m.content === "string" ? m.content : m.content[0].text));
    return response(`response-${++calls}`);
  };
  await generateSuggestion({ ...request, complete });
  await generateSuggestion({ ...request, messages: [{ role: "user", content: "压缩后的当前有效证据" }], revision: "compacted", complete });
  await generateSuggestion({ ...request, preferences: "修改偏好", revision: "preferences", complete });
  assert.equal(calls, 3);
}));

test("missing stored response rebuilds once, while a network failure is not replayed", () => fixture(async request => {
  await generateSuggestion({ ...request, complete: async () => response("response-1") });
  const next = { ...request, messages: [...messages, { role: "user", content: "新增" }], revision: "leaf-2" };
  let calls = 0;
  await generateSuggestion({ ...next, complete: async (_model, context, options) => {
    const payload = options.onPayload({ input: context.messages });
    calls++;
    if (calls === 1) {
      assert.equal(payload.previous_response_id, "response-1");
      return { ...response(""), stopReason: "error", errorMessage: 'xai API error (404): 404 "Response with id=response-1 not found"' };
    }
    assert.equal(payload.previous_response_id, undefined);
    assert.equal(evidence(context).length, 3);
    return response("response-2");
  } });
  assert.equal(calls, 2);
  let failures = 0;
  await assert.rejects(generateSuggestion({ ...next, messages: [...next.messages, { role: "user", content: "再新增" }], complete: async () => {
    failures++; throw new Error("Network unavailable");
  } }), /Network unavailable/);
  assert.equal(failures, 1);
}));

test("an oversized prediction chain rebuilds once without clipping current real evidence", () => fixture(async request => {
  await generateSuggestion({ ...request, complete: async () => response("response-1") });
  const next = [...messages, { role: "toolResult", content: [{ type: "text", text: "完整正文".repeat(5000) }] }];
  let calls = 0;
  await generateSuggestion({ ...request, messages: next, revision: "leaf-2", complete: async (_model, context, options) => {
    calls++;
    if (calls === 1) return { ...response(""), stopReason: "error", errorMessage: "xai API error (400): [input_too_large] The prompt is too long" };
    assert.equal(options.onPayload({}).previous_response_id, undefined);
    assert.equal(evidence(context).at(-1).text, next.at(-1).content[0].text);
    return response("rebuilt");
  } });
  assert.equal(calls, 2);
}));

test("cancelled completion cannot overwrite the last recoverable response", () => fixture(async request => {
  await generateSuggestion({ ...request, complete: async () => response("response-1") });
  const controller = new AbortController();
  const result = await generateSuggestion({ ...request, messages: [...messages, { role: "user", content: "新增" }], signal: controller.signal,
    complete: async () => { controller.abort(); return response("late-response", "迟到候选"); } });
  assert.equal(result.text, null);
  const state = JSON.parse(await readFile(suggestionThreadPath(request.agentDir, request.sessionId), "utf8"));
  assert.equal(state.responseId, "response-1");
}));

test("independent Web/TUI processes wait for an 11-second prediction and reuse its checkpoint", () => fixture(async request => {
  const callLog = join(request.agentDir, "calls.jsonl");
  const results = await Promise.all([worker({ ...request, callLog, delayMs: 11_000 }), worker({ ...request, callLog, delayMs: 11_000 })]);
  assert(results.every(x => x.text === "接着验证吧"));
  const lines = (await readFile(callLog, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const state = JSON.parse(await readFile(suggestionThreadPath(request.agentDir, request.sessionId), "utf8"));
  assert.equal(state.totals.requests, 1);
}));
