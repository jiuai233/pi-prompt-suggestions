import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "pi-web-prompt-suggestions-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousPluginRoot = process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT;
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT = join(root, "../../../plugins/prompt-suggestions");
const outfile = join(dir, "test.mjs");
await build({
  stdin: {
    contents: 'export { PromptSuggestions } from "./lib/prompt-suggestions.ts"; export { AgentSessionWrapper } from "./lib/rpc-manager.ts"; export { writePromptSuggestionsEnabled, readPromptSuggestionsEnabled, writePromptSuggestionSettings } from "./lib/prompt-suggestion-settings.ts";',
    resolveDir: root,
    loader: "ts",
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  plugins: [{ name: "external-test-dependencies", setup(build) {
    build.onResolve({ filter: /^[^./]/ }, ({ path }) => path.startsWith("@/") ? undefined : ({ path: import.meta.resolve(path), external: true }));
  } }],
  logLevel: "silent",
});
const { PromptSuggestions, AgentSessionWrapper, writePromptSuggestionsEnabled, readPromptSuggestionsEnabled, writePromptSuggestionSettings } = await import(pathToFileURL(outfile).href);
const originalEnabled = process.env.PI_PROMPT_SUGGESTIONS;
// The Web setting must win even if the TUI diagnostic flag is on.
process.env.PI_PROMPT_SUGGESTIONS = "1";
after(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalEnabled === undefined) delete process.env.PI_PROMPT_SUGGESTIONS;
  else process.env.PI_PROMPT_SUGGESTIONS = originalEnabled;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousPluginRoot === undefined) delete process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT;
  else process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT = previousPluginRoot;
});

const model = { id: "test", provider: "test", api: "openai-responses", reasoning: false };
const sessionRequest = { sessionId: "suggestion-fixture" };
const answer = (text = "跑一下测试") => ({
  role: "assistant", api: "test", provider: "test", model: "test", timestamp: 2,
  content: [{ type: "text", text }], stopReason: "stop",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
});
const messages = [{ role: "user", content: "修好以后跑测试", timestamp: 1 }, answer("修好了")];
const flush = () => new Promise((resolve) => setTimeout(resolve, 25));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function request(complete, revision = "leaf") {
  return { enabled: true, model, messages, complete, revision, sessionId: "suggestion-test", isCurrent: () => true };
}

test("one candidate per branch revision; clearing never changes real messages", async () => {
  const events = [];
  const suggestions = new PromptSuggestions((text) => events.push(text));
  const original = JSON.stringify(messages);
  let calls = 0;
  const r = request(async () => { calls++; return answer(); });
  suggestions.start(r);
  await flush();
  assert.equal(suggestions.text, "跑一下测试");
  suggestions.start(r);
  await flush();
  assert.equal(calls, 1);
  suggestions.clear();
  assert.deepEqual(events, ["跑一下测试", null]);
  assert.equal(JSON.stringify(messages), original);
});

test("a cancelled old completion cannot replace the new candidate", async () => {
  const old = deferred();
  let signal;
  const suggestions = new PromptSuggestions(() => {});
  suggestions.start(request(async (_model, _context, options) => { signal = options.signal; return old.promise; }));
  await flush();
  suggestions.start(request(async () => answer("提交修改"), "new-leaf"));
  await flush();
  assert.equal(signal.aborted, true);
  old.resolve(answer("旧候选"));
  await flush();
  assert.equal(suggestions.text, "提交修改");
  suggestions.clear();
});

test("a branch change while generating drops the result", async () => {
  const done = deferred();
  let current = true;
  const suggestions = new PromptSuggestions(() => {});
  suggestions.start({ ...request(async () => done.promise), isCurrent: () => current });
  current = false;
  done.resolve(answer());
  await flush();
  assert.equal(suggestions.text, null);
  suggestions.clear();
});

async function fixture({ enabled = true, complete, predictionModel = model } = {}) {
  if (enabled !== null) await writePromptSuggestionSettings({ enabled, provider: predictionModel.provider, modelId: predictionModel.id, thinkingLevel: "off" });
  let listener;
  const requests = [];
  const transcript = structuredClone(messages);
  const inner = {
    sessionId: "suggestion-fixture", sessionFile: "", isStreaming: false, isCompacting: false,
    isBashRunning: false, pendingMessageCount: 0, messages: transcript,
    model, agent: { state: {}, streamFunction: () => null },
    sessionManager: { getSessionId: () => "suggestion-fixture", getSessionName: () => "test", getLeafId: () => "leaf", getCwd: () => root,
      getBranch: () => [], buildSessionProjection: () => ({ entries: [] }) },
    settingsManager: { getEnabledModels: () => undefined },
    modelRuntime: {
      getModels: () => [model, predictionModel], getAvailable: async () => [model, predictionModel],
      completeSimple: async (...args) => { requests.push(args); return complete ? complete(...args) : answer(); },
    },
    subscribe: (fn) => { listener = fn; return () => {}; },
    dispose: () => {}, abort: async () => {},
  };
  const wrapper = new AgentSessionWrapper(inner, { contextInspector: { dispose() {}, read() { return {}; } } });
  wrapper.start();
  return { inner, wrapper, requests, event: (event) => {
    listener(event);
    if (event.type === "agent_start") inner.agent.streamFunction(model, { messages: transcript.slice(0, -1) }, { sessionId: inner.sessionManager.getSessionId() });
  } };
}

test("default-off Web never requests a prediction after a completed foreground run", async () => {
  const { inner, wrapper, requests, event } = await fixture({ enabled: null });
  const original = JSON.stringify(inner.messages);
  try {
    assert.equal(await readPromptSuggestionsEnabled(), false);
    event({ type: "agent_start" });
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(requests.length, 0);
    assert.equal(wrapper.promptSuggestions.text, null);
    assert.equal(JSON.stringify(inner.messages), original);
  } finally { wrapper.destroy(); }
});

test("Web waits for settled plus prompt completion, and replays only ephemeral suggestion state", async () => {
  const { inner, wrapper, requests, event } = await fixture();
  const original = JSON.stringify(inner.messages);
  try {
    wrapper.pendingPromptCount = 1;
    event({ type: "agent_start" });
    event({ type: "agent_end" });
    assert.equal(requests.length, 0);
    event({ type: "agent_settled", aborted: false });
    assert.equal(requests.length, 0);
    wrapper.pendingPromptCount = 0;
    wrapper.notifyAgentRunCompleteIfIdle();
    await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], model);
    const replay = [];
    wrapper.onEvent((e) => replay.push(e));
    assert.deepEqual(replay.at(-1), { type: "prompt_suggestion", text: "跑一下测试" });
    assert.equal(JSON.stringify(inner.messages), original);
    event({ type: "agent_start" });
    assert.deepEqual(replay.at(-1), { type: "agent_start" });
    assert(replay.some((e) => e.type === "prompt_suggestion" && e.text === null));
  } finally { wrapper.destroy(); }
});

test("Web preserves request-only visible text without forwarding foreground system instructions", async () => {
  const { inner, wrapper, requests, event } = await fixture();
  const original = JSON.stringify(inner.messages);
  const projected = [
    { role: "system", content: "Exact runtime prompt, not the persisted structured replay", timestamp: 1 },
    { role: "user", content: "Request-only recalled context", timestamp: 1 },
    ...inner.messages.slice(0, -1),
  ];
  try {
    event({ type: "agent_start" });
    inner.agent.streamFunction(model, { messages: projected }, sessionRequest);
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(requests.length, 1);
    const sent = requests[0][1].messages;
    const turns = sent.slice(1).map((message) => JSON.parse(message.content)).filter((item) => item.kind === "conversation_evidence");
    assert.equal(turns[0].text, "Request-only recalled context");
    assert.equal(turns.at(-1).text, "修好了");
    assert(!JSON.stringify(turns).includes("Exact runtime prompt"));
    assert.equal(JSON.stringify(inner.messages), original);
  } finally { wrapper.destroy(); }
});

test("Web restores an independent persistent predictor after its wrapper is replaced", async () => {
  const predictionModel = { ...model, provider: "xai", id: "persistent-web" };
  const first = await fixture({ predictionModel, complete: async () => ({ ...answer(), responseId: "web-root" }) });
  first.event({ type: "agent_start" });
  first.event({ type: "agent_settled", aborted: false });
  await flush();
  await flush();
  assert.equal(first.requests[0][2].onPayload({}).store, true);
  assert.equal(first.wrapper.promptSuggestions.text, "跑一下测试");
  first.wrapper.destroy();
  const next = await fixture({ predictionModel, complete: async () => ({ ...answer(), responseId: "web-next" }) });
  try {
    next.inner.messages.push({ role: "user", content: "新增真实消息", timestamp: 3 }, { ...answer("新的真实回复"), timestamp: 4 });
    next.event({ type: "agent_start" });
    next.event({ type: "agent_settled", aborted: false });
    await flush();
    await flush();
    const request = next.requests[0];
    assert.equal(request[0], predictionModel);
    assert.equal(request[2].onPayload({}).previous_response_id, "web-root");
    assert(!JSON.stringify(request[1]).includes("修好以后跑测试"));
    assert.equal(next.wrapper.promptSuggestions.text, "跑一下测试");
  } finally { next.wrapper.destroy(); }
});

test("Web uses native dialogue after compaction and clears newly added tools only at the next compaction", async () => {
  const { inner, wrapper, requests, event } = await fixture();
  const session = SessionManager.inMemory(root);
  session.appendMessage({ role: "user", content: "保留我原来的目标", timestamp: 1 });
  session.appendMessage(answer("原来的完整回答"));
  const oldTool = session.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "old-call", content: [{ type: "text", text: "OLD_WEB_TOOL" }], timestamp: 3 });
  session.appendCompaction("MAIN_WEB_SUMMARY", oldTool, 10_000);
  session.appendMessage({ role: "user", content: "继续新检查", timestamp: 4 });
  session.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "new-call", content: [{ type: "text", text: "NEW_WEB_TOOL" }], timestamp: 5 });
  session.appendMessage(answer("新的完整回答"));
  inner.sessionManager = session;
  const refresh = () => inner.messages.splice(0, inner.messages.length, ...convertToLlm(session.buildSessionProjection().messages));
  try {
    refresh();
    event({ type: "agent_start" });
    event({ type: "agent_settled", aborted: false });
    await flush();
    const first = JSON.stringify(requests.at(-1)[1]);
    assert(first.includes("保留我原来的目标"));
    assert(first.includes("原来的完整回答"));
    assert(!first.includes("OLD_WEB_TOOL"));
    assert(!first.includes("MAIN_WEB_SUMMARY"));
    assert(first.includes("NEW_WEB_TOOL"));
    session.appendCompaction("NEXT_WEB_SUMMARY", oldTool, 20_000);
    session.appendMessage(answer("第二次压缩后的回复"));
    refresh();
    event({ type: "agent_start" });
    event({ type: "agent_settled", aborted: false });
    await flush();
    const second = JSON.stringify(requests.at(-1)[1]);
    assert(!second.includes("NEW_WEB_TOOL"));
    assert(second.includes("新的完整回答"));
    assert(second.includes("保留我原来的目标"));
  } finally { wrapper.destroy(); }
});

test("failed, aborted, queued and tool-only runs do not generate", async () => {
  for (const kind of ["failed", "aborted", "queued", "tool-only"]) {
    const { inner, wrapper, requests, event } = await fixture();
    try {
      if (kind === "failed") inner.messages.at(-1).stopReason = "error";
      if (kind === "queued") inner.pendingMessageCount = 1;
      if (kind === "tool-only") inner.messages.at(-1).content = [{ type: "toolCall", id: "call", name: "bash", arguments: {} }];
      event({ type: "agent_start" });
      event({ type: "agent_settled", aborted: kind === "aborted" });
      await flush();
      assert.equal(requests.length, 0, kind);
    } finally { wrapper.destroy(); }
  }
});

test("compaction and summary requests never replace the captured session request", async () => {
  const { wrapper, requests, event, inner } = await fixture();
  try {
    event({ type: "agent_start" });
    const session = requests.length;
    inner.agent.streamFunction(model, { messages: [{ role: "system", content: "You are a context summarization assistant", timestamp: 1 }] }, { sessionId: "compaction-routing-id" });
    inner.agent.streamFunction(model, { messages: [{ role: "user", content: "branch summary", timestamp: 1 }] });
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(requests.length, session + 1);
    const turns = requests.at(-1)[1].messages.slice(1).map((message) => JSON.parse(message.content)).filter((item) => item.kind === "conversation_evidence");
    assert.deepEqual(turns.map((turn) => turn.text), ["修好以后跑测试", "修好了"]);
  } finally { wrapper.destroy(); }
});

test("saved toggles affect an existing Web session without reload, cancelling and clearing immediately", async () => {
  const late = deferred();
  const { wrapper, requests, event } = await fixture({ enabled: false, complete: () => late.promise });
  const events = [];
  wrapper.onEvent((e) => events.push(e));
  try {
    event({ type: "agent_start" });
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(requests.length, 0);
    delete process.env.PI_PROMPT_SUGGESTIONS;
    await writePromptSuggestionsEnabled(true);
    await flush();
    assert.equal(requests.length, 0, "enabling does not predict retroactively");
    event({ type: "agent_start" });
    event({ type: "agent_end" });
    await flush();
    assert.equal(requests.length, 0, "agent_end alone is not a complete idle turn");
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(requests.length, 1, "persisted true works without the diagnostic env flag");
    await writePromptSuggestionsEnabled(false);
    assert.equal(requests[0][2].signal.aborted, true);
    await writePromptSuggestionsEnabled(true);
    late.resolve(answer("迟到结果"));
    await flush();
    assert.equal(wrapper.promptSuggestions.text, null, "off/on cannot revive a cancelled result");
    assert.equal(events.some((e) => e.type === "prompt_suggestion" && e.text), false);
    event({ type: "agent_start" });
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(wrapper.promptSuggestions.text, "迟到结果");
    await writePromptSuggestionsEnabled(false);
    assert.equal(wrapper.promptSuggestions.text, null);
    assert.deepEqual(events.at(-1), { type: "prompt_suggestion", text: null });
    event({ type: "agent_start" });
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(requests.length, 2);
  } finally { wrapper.destroy(); }
});

test("slash toggle bypasses busy foreground queues and never reaches the model or transcript", async () => {
  const { inner, wrapper, requests } = await fixture({ enabled: false });
  const original = JSON.stringify(inner.messages);
  const notices = [];
  wrapper.onEvent((e) => { if (e.method === "notify") notices.push(e.message); });
  inner.isStreaming = true;
  wrapper.waitForExtensionsBound = async () => { throw new Error("must not wait for extensions"); };
  inner.prompt = inner.steer = inner.followUp = () => { throw new Error("must not enter a foreground queue"); };
  try {
    await wrapper.send({ type: "prompt", message: "/suggestions" });
    assert.match(notices.at(-1), /关闭/);
    await wrapper.send({ type: "steer", message: "/suggestions on" });
    assert.equal(await readPromptSuggestionsEnabled(), true);
    await wrapper.send({ type: "follow_up", message: "/suggestions off" });
    assert.equal(await readPromptSuggestionsEnabled(), false);
    assert.match(notices.at(-1), /已关闭/);
    await wrapper.send({ type: "prompt", message: "/suggestions invalid" });
    assert.match(notices.at(-1), /用法/);
    assert.equal(await readPromptSuggestionsEnabled(), false);
    assert.equal(requests.length, 0);
    assert.equal(JSON.stringify(inner.messages), original);
  } finally { inner.isStreaming = false; wrapper.destroy(); }
});

test("slash off cancels an in-flight prediction and drops its late result", async () => {
  const late = deferred();
  const { wrapper, requests, event } = await fixture({ complete: () => late.promise });
  try {
    event({ type: "agent_start" });
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(requests.length, 1);
    await wrapper.send({ type: "prompt", message: "/suggestions off" });
    assert.equal(requests[0][2].signal.aborted, true);
    late.resolve(answer("不应显示"));
    await flush();
    assert.equal(wrapper.promptSuggestions.text, null);
  } finally { wrapper.destroy(); }
});

test("a handled command after a completed run does not request another candidate", async () => {
  const { wrapper, requests, event } = await fixture();
  try {
    event({ type: "agent_start" });
    event({ type: "agent_settled", aborted: false });
    await flush();
    assert.equal(requests.length, 1);
    // send() clears the candidate and its revision key; acceptPreflight("handled") then
    // marks completion without any agent_start/agent_settled.
    wrapper.promptSuggestions.clear();
    wrapper.agentRunNeedsCompletion = true;
    wrapper.notifyAgentRunCompleteIfIdle();
    await flush();
    assert.equal(requests.length, 1);
  } finally { wrapper.destroy(); }
});
