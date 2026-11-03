import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SuggestionController, generateSuggestion } from "./api.mjs";
import { suggestionThreadPath } from "./threads.mjs";

const usage = { input: 20, cacheRead: 100, output: 3, totalTokens: 123, cost: { total: 0.001 } };
const answer = (responseId, text = "接着解释吧") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason: "stop", responseId, usage,
});
async function fixture(run) {
  const agentDir = await mkdtemp(join(tmpdir(), "suggestion-lifecycle-"));
  try {
    const initial = {
      enabled: true, agentDir, sessionId: "main-session", revision: "old",
      model: { provider: "openai-codex", id: "test-model", api: "openai-codex-responses" },
      messages: [{ role: "user", content: "真实对话，不写入结束日志" }],
      preferences: "私密偏好，不写入结束日志", isCurrent: () => true,
    };
    await generateSuggestion({ ...initial, complete: async () => answer("old-response") });
    const path = suggestionThreadPath(agentDir, initial.sessionId);
    const before = await readFile(path, "utf8");
    await run({ ...initial, revision: "new", messages: [...initial.messages, { role: "assistant", content: "新的真实回复" }] }, path, before);
  } finally { await rm(agentDir, { recursive: true, force: true }); }
}
const records = async (agentDir) => (await readFile(join(agentDir, "logs", "prompt-suggestions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);

// These clocks advance the real controller timer; no paid request or two-minute sleep.
test("a still-current prediction can finish after twenty seconds and is logged once", t => fixture(async (request, path) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const original = structuredClone(request.messages);
  let finish, signal;
  const entered = Promise.withResolvers();
  const events = [];
  const engine = new SuggestionController(text => events.push(text));
  const running = engine.start({ ...request, complete: async (_model, _context, options) => {
    signal = options.signal;
    entered.resolve();
    return new Promise(resolve => { finish = resolve; });
  } });
  await entered.promise;
  t.mock.timers.tick(30_000);
  assert.equal(signal.aborted, false);
  finish(answer("slow-response"));
  await running;
  assert.deepEqual(events, ["接着解释吧"]);
  assert.equal(JSON.parse(await readFile(path, "utf8")).responseId, "slow-response");
  const log = await records(request.agentDir);
  assert.equal(log.length, 1);
  assert.equal(log[0].outcome, "success");
  assert.equal(log[0].elapsedMs, 30_000);
  assert.equal(log[0].modelRequests, 1);
  assert.deepEqual(log[0].usage, usage);
  assert(!JSON.stringify(log).includes("私密偏好"));
  assert(!JSON.stringify(log).includes("真实对话"));
  assert(!JSON.stringify(log).includes("接着解释吧"));
  assert.deepEqual(request.messages, original);
}));

test("the two-minute budget aborts without publishing or replacing the recoverable history", t => fixture(async (request, path, before) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let finish, signal;
  const entered = Promise.withResolvers();
  const events = [], errors = [];
  const engine = new SuggestionController(text => events.push(text), error => errors.push(error));
  const running = engine.start({ ...request, complete: async (_model, _context, options) => {
    signal = options.signal;
    entered.resolve();
    return new Promise(resolve => { finish = resolve; });
  } });
  await entered.promise;
  t.mock.timers.tick(119_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, "budget_exhausted");
  finish(answer("too-late-response"));
  await running;
  assert.deepEqual(events, []);
  assert.deepEqual(errors, []);
  assert.equal(await readFile(path, "utf8"), before);
  const [log] = await records(request.agentDir);
  assert.equal(log.outcome, "cancelled");
  assert.equal(log.reason, "budget_exhausted");
  assert.equal(log.elapsedMs, 120_000);
  assert.deepEqual(log.usage, usage, "known late usage is recorded, not discarded with the candidate");
}));

test("a new turn still cancels immediately, rejects late output and records its distinct reason", () => fixture(async (request, path, before) => {
  let finish, signal;
  const entered = Promise.withResolvers();
  const engine = new SuggestionController(() => assert.fail("obsolete candidate must not be shown"));
  const running = engine.start({ ...request, complete: async (_model, _context, options) => {
    signal = options.signal;
    entered.resolve();
    return new Promise(resolve => { finish = resolve; });
  } });
  await entered.promise;
  engine.clear();
  assert.equal(signal.aborted, true);
  finish(answer("obsolete-response"));
  await running;
  assert.equal(await readFile(path, "utf8"), before);
  const [log] = await records(request.agentDir);
  assert.equal(log.outcome, "cancelled");
  assert.equal(log.reason, "no_longer_needed");
}));

test("provider errors surface once without plugin retries and unknown usage is null", () => fixture(async (request, path, before) => {
  const errors = [];
  const engine = new SuggestionController(() => assert.fail("failed prediction must not be shown"), error => errors.push(error.message));
  await engine.start({ ...request, complete: async () => ({
    ...answer(""), stopReason: "error", errorMessage: "Network unavailable",
    usage: { input: 0, cacheRead: 0, output: 0, totalTokens: 0 },
  }) });
  assert.deepEqual(errors, ["Network unavailable"]);
  assert.equal(await readFile(path, "utf8"), before);
  const [log] = await records(request.agentDir);
  assert.equal(log.outcome, "error");
  assert.equal(log.error, "Network unavailable");
  assert.equal(log.modelRequests, 1);
  assert.equal(log.usage, null);
}));
