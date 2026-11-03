import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { before, after, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSuggestionSettings } from "./api.mjs";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import {
  CURSOR_MARKER,
  stripTerminalSequences,
  visibleWidth,
} from "../node_modules/@earendil-works/pi-tui/dist/index.js";

const answer = (text, extra = {}) => ({
  role: "assistant", content: [{ type: "text", text }],
  api: "test", provider: "test", model: "fixture", stopReason: "stop", timestamp: 3,
  usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  ...extra,
});
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir;
before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-suggestion-editor-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cleanup = new Set();
afterEach(() => {
  for (const shutdown of cleanup) shutdown();
  cleanup.clear();
});

async function fixture({ mode = "tui", createEditor = true, final = answer("检查完成"), systemPrompt = "Project prompt", enabled = true } = {}) {
  await writeSuggestionSettings(agentDir, { enabled, provider: "test", modelId: "fixture", thinkingLevel: "off" });
  const loaded = await loadExtensions([fileURLToPath(new URL("./index.ts", import.meta.url))], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  // Any accidental use of sendMessage/appendEntry is also rejected by the unbound SDK runtime.
  const sessionManager = SessionManager.inMemory(process.cwd());
  sessionManager.appendMessage({ role: "system", content: "Project prompt", toolsAdded: [], timestamp: 1 });
  sessionManager.appendMessage({ role: "user", content: "检查一下", timestamp: 2 });
  sessionManager.appendMessage(final);
  const requests = [];
  const waiters = new Set();
  const waitForRequests = async (count = 1) => {
    if (requests.length >= count) return;
    await new Promise((resolve, reject) => {
      const done = () => { if (requests.length >= count) { clearTimeout(timer); waiters.delete(done); resolve(); } };
      const timer = setTimeout(() => { waiters.delete(done); reject(new Error(`Expected ${count} prediction requests; got ${requests.length}`)); }, 1500);
      waiters.add(done);
    });
  };
  const statuses = [];
  let factory;
  let idle = true;
  let queued = false;
  let renders = 0;
  const tui = { terminal: { rows: 30, columns: 80 }, requestRender: () => { renders++; } };
  const editorTheme = { borderColor: (text) => text, selectList: {} };
  const ctx = {
    mode,
    getSystemPrompt: () => systemPrompt,
    model: { id: "fixture", provider: "test", api: "openai-responses", reasoning: false },
    sessionManager,
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    modelRegistry: {
      getAvailable: async () => [ctx.model],
      streamSimple(model, context, options) {
        let resolve, reject;
        const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
        requests.push({ model, context, options, resolve, reject });
        for (const notify of waiters) notify();
        return { result: () => promise };
      },
    },
    ui: {
      getEditorComponent: () => factory,
      setEditorComponent: (next) => { factory = next; },
      setStatus: (key, text) => statuses.push({ key, text }),
      theme: { fg: (_token, text) => `\x1b[90m${text}\x1b[39m` },
    },
  };
  const emit = (type, values = {}) => {
    const results = (extension.handlers.get(type) ?? []).map((handler) => handler({ type, ...values }, ctx));
    return results[0];
  };
  cleanup.add(() => emit("session_shutdown"));
  emit("session_start", { reason: "startup" });
  const makeEditor = () => factory?.(tui, editorTheme, new KeybindingsManager());
  const editor = createEditor ? makeEditor() : undefined;
  if (editor) { editor.focused = true; editor.render(80); }
  emit("context_with_system", { messages: sessionManager.buildSessionProjection().messages.slice(0, -1) });
  const history = structuredClone(sessionManager.getEntries());
  return {
    ctx, editor, requests, statuses, emit, makeEditor, sessionManager, history, waitForRequests,
    getFactory: () => factory,
    setFactory: (next) => { factory = next; },
    setIdle: (value) => { idle = value; },
    setQueued: (value) => { queued = value; },
    renderCount: () => renders,
  };
}

function displayed(editor, width = 80) {
  return editor.render(width).map(stripTerminalSequences).join("\n");
}

async function suggest(f, text = "跑一下测试，再提交") {
  const count = f.requests.length + 1;
  assert.equal(f.emit("agent_settled", { aborted: false }), undefined);
  await f.waitForRequests(count);
  f.requests.at(-1).resolve(answer(text));
  await tick();
}

test("TUI projects original dialogue and only post-compaction tools through the real SDK", async () => {
  const f = await fixture();
  f.sessionManager.appendMessage(answer("压缩前的解释", { content: [
    { type: "text", text: "压缩前的解释" },
    { type: "toolCall", id: "old", name: "read", arguments: { path: "OLD_TUI_ARGUMENT" } },
  ] }));
  const oldTool = f.sessionManager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "old",
    content: [{ type: "text", text: "OLD_TUI_TOOL" }], timestamp: 4 });
  f.sessionManager.appendCompaction("MAIN_TUI_SUMMARY", oldTool, 10_000);
  f.sessionManager.appendMessage({ role: "user", content: "继续检查新的", timestamp: 5 });
  f.sessionManager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "new",
    content: [{ type: "text", text: "NEW_TUI_TOOL" }], timestamp: 6 });
  f.sessionManager.appendMessage(answer("新检查完成"));
  f.emit("context_with_system", { messages: f.sessionManager.buildSessionProjection().messages.slice(0, -1) });
  f.emit("agent_settled", { aborted: false });
  await f.waitForRequests();
  const sent = JSON.stringify(f.requests[0].context);
  assert(sent.includes("检查一下"));
  assert(sent.includes("压缩前的解释"));
  assert(!sent.includes("OLD_TUI_ARGUMENT"));
  assert(!sent.includes("OLD_TUI_TOOL"));
  assert(!sent.includes("MAIN_TUI_SUMMARY"));
  assert(sent.includes("NEW_TUI_TOOL"));
  f.requests[0].resolve(answer("继续聊新结果吧"));
});

test("default-off TUI does not request a prediction after settling", async () => {
  const f = await fixture({ enabled: false });
  f.emit("agent_settled", { aborted: false });
  await tick();
  assert.equal(f.requests.length, 0);
  assert.equal(f.editor.getText(), "");
});

test("real SDK loads the extension and waits for an actual terminal editor factory", async () => {
  const f = await fixture({ createEditor: false });
  f.emit("agent_settled", { aborted: false });
  assert.equal(f.requests.length, 0);
  const editor = f.makeEditor();
  assert.ok(editor);
  f.emit("context_with_system", { messages: f.sessionManager.buildSessionProjection().messages.slice(0, -1) });
  assert.equal(f.emit("agent_settled", { aborted: false }), undefined);
  await f.waitForRequests();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.toolChoice, undefined);
  f.emit("session_shutdown");
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.getFactory(), undefined);
  f.requests[0].resolve(answer("stale"));
  await tick();

  const rpc = await fixture({ mode: "rpc" });
  assert.equal(rpc.getFactory(), undefined);
  rpc.emit("agent_settled", { aborted: false });
  assert.equal(rpc.requests.length, 0);
});

test("ghost rendering preserves text, focus marker, width, borders, and acceptance never submits", async () => {
  const f = await fixture();
  let submissions = 0;
  f.editor.onSubmit = () => { submissions++; };
  await suggest(f);
  assert.equal(f.editor.getText(), "");
  assert.ok(displayed(f.editor).includes("跑一下测试，再提交"));
  for (const width of [1, 2, 5, 20, 80]) {
    f.editor.setPaddingX(1);
    const lines = f.editor.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}: ${JSON.stringify(lines.map((line) => [stripTerminalSequences(line), visibleWidth(line)]))}`);
    assert.ok(lines[1].includes(CURSOR_MARKER));
    assert.equal(lines.length, 3);
  }
  assert.equal(f.editor.getText(), "");
  f.editor.handleInput("\t");
  assert.equal(f.editor.getText(), "跑一下测试，再提交");
  assert.equal(submissions, 0);
  assert.deepEqual(f.sessionManager.getEntries(), f.history);
  assert.ok(f.renderCount() > 0);
  f.emit("session_shutdown");
});

test("TUI preserves request-only visible context without copying the foreground system prompt", async () => {
  const f = await fixture({ systemPrompt: "Forced current prompt" });
  const original = JSON.stringify(f.sessionManager.buildSessionProjection().messages);
  const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
  f.emit("context_with_system", { messages: [
    { role: "system", content: "Persisted replay prompt", toolsAdded: tools, timestamp: 1 },
    { role: "user", content: "Request-only recalled context", timestamp: 1 },
  ] });
  f.emit("agent_settled", { aborted: false });
  await f.waitForRequests();
  const sent = f.requests[0].context.messages;
  const evidence = sent.slice(1).map((message) => JSON.parse(message.content)).filter((item) => item.kind === "conversation_evidence");
  assert.equal(evidence[0].text, "Request-only recalled context");
  assert(!JSON.stringify(evidence).includes("Persisted replay prompt"));
  assert.equal(sent[0].toolsAdded, undefined);
  assert.equal(JSON.stringify(f.sessionManager.buildSessionProjection().messages), original);
  f.emit("session_shutdown");
});

test("TUI supplies its agent directory and persists a response for incremental prediction", async () => {
  const f = await fixture();
  f.ctx.model.provider = "xai";
  await writeSuggestionSettings(agentDir, { provider: "xai" });
  f.emit("agent_settled", { aborted: false });
  await f.waitForRequests();
  const first = f.requests[0];
  assert.equal(first.options.onPayload({}).store, true);
  first.resolve(answer("先说明原理", { responseId: "tui-root" }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  f.emit("agent_start");
  f.sessionManager.appendMessage({ role: "user", content: "实际新增问题", timestamp: 4 });
  f.sessionManager.appendMessage(answer("新的真实回复", { timestamp: 5 }));
  f.emit("context_with_system", { messages: f.sessionManager.buildSessionProjection().messages.slice(0, -1) });
  f.emit("agent_settled", { aborted: false });
  await f.waitForRequests(2);
  const second = f.requests[1];
  assert.equal(second.options.onPayload({}).previous_response_id, "tui-root");
  assert(!JSON.stringify(second.context).includes("检查一下"));
  second.resolve(answer("继续解释", { responseId: "tui-next" }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  f.emit("session_shutdown");
});

test("Esc owns only a displayed candidate; all other core control keys remain native", async () => {
  const f = await fixture();
  let escapes = 0, exits = 0, clears = 0, modelActions = 0, shortcuts = 0;
  f.editor.onEscape = () => { escapes++; };
  f.editor.onCtrlD = () => { exits++; };
  f.editor.onAction("app.clear", () => { clears++; });
  f.editor.onAction("app.model.cycleForward", () => { modelActions++; });
  f.editor.onExtensionShortcut = (data) => { if (data !== "\x18") return false; shortcuts++; return true; };
  await suggest(f);
  f.editor.handleInput("\x1b");
  assert.equal(escapes, 0);
  assert.equal(f.editor.getText(), "");
  assert.ok(!displayed(f.editor).includes("跑一下测试"));
  f.editor.handleInput("\x1b");
  f.editor.handleInput("\x04");
  f.editor.handleInput("\x03");
  f.editor.handleInput("\x10");
  f.editor.handleInput("\x18");
  assert.deepEqual([escapes, exits, clears, modelActions, shortcuts], [1, 1, 1, 1, 1]);
  let nativeTabs = 0;
  f.editor.onExtensionShortcut = (data) => { if (data !== "\t") return false; nativeTabs++; return true; };
  f.editor.handleInput("\t");
  assert.equal(nativeTabs, 1);
  f.emit("session_shutdown");
});

test("Chinese input, paste and programmatic edits clear the ghost and cancel pending work", async () => {
  for (const edit of [
    (editor) => editor.handleInput("中文"),
    (editor) => editor.handleInput("\x1b[200~中文粘贴\x1b[201~"),
    (editor) => editor.setText("中文草稿"),
    (editor) => editor.insertTextAtCursor("中文插入"),
  ]) {
    const f = await fixture();
    await suggest(f);
    edit(f.editor);
    assert.ok(f.editor.getText().startsWith("中文"));
    assert.ok(!displayed(f.editor).includes("跑一下测试"));
    f.editor.setText("");
    f.emit("agent_settled", { aborted: false });
    await f.waitForRequests(2);
    const request = f.requests.at(-1);
    edit(f.editor);
    assert.equal(request.options.signal.aborted, true);
    f.editor.setText(""); // Returning to empty must not revive a stale result.
    request.resolve(answer("stale candidate"));
    await tick();
    assert.ok(!displayed(f.editor).includes("stale candidate"));
    f.emit("session_shutdown");
  }
});

test("lifecycle changes abort and reject late model results", async () => {
  for (const event of ["input", "agent_start", "model_select", "session_before_switch", "session_before_fork", "session_before_tree", "session_tree", "session_before_compact", "session_start", "session_shutdown"]) {
    const f = await fixture();
    f.emit("agent_settled", { aborted: false });
    await f.waitForRequests();
    const request = f.requests[0];
    f.emit(event);
    assert.equal(request.options.signal.aborted, true, event);
    request.resolve(answer(`stale ${event}`));
    await tick();
    assert.ok(!displayed(f.editor).includes(`stale ${event}`), event);
    f.emit("session_shutdown");
  }
});

test("a newer request wins even if an aborted provider ignores its signal", async () => {
  const f = await fixture();
  f.emit("agent_settled", { aborted: false });
  await f.waitForRequests();
  const first = f.requests[0];
  f.sessionManager.appendMessage(answer("新一轮完成"));
  f.emit("context_with_system", { messages: f.sessionManager.buildSessionProjection().messages.slice(0, -1) });
  f.emit("agent_settled", { aborted: false });
  await f.waitForRequests(2);
  const second = f.requests[1];
  assert.equal(first.options.signal.aborted, true);
  second.resolve(answer("new candidate"));
  await tick();
  first.resolve(answer("old candidate"));
  await tick();
  assert.ok(displayed(f.editor).includes("new candidate"));
  assert.ok(!displayed(f.editor).includes("old candidate"));
  f.emit("session_shutdown");
});

test("drafts, aborted/error turns and queued messages do not start prediction", async () => {
  for (const setup of [
    (f) => f.editor.setText("draft"),
    (f) => f.setIdle(false),
    (f) => f.setQueued(true),
  ]) {
    const f = await fixture();
    setup(f);
    f.emit("agent_settled", { aborted: false });
    assert.equal(f.requests.length, 0);
    f.emit("session_shutdown");
  }
  for (const reason of ["error", "aborted", "toolUse"]) {
    const f = await fixture({ final: answer("partial", { stopReason: reason }) });
    f.emit("agent_settled", { aborted: false });
    assert.equal(f.requests.length, 0);
    f.emit("session_shutdown");
  }
  const aborted = await fixture();
  aborted.emit("agent_settled", { aborted: true });
  assert.equal(aborted.requests.length, 0);
  aborted.emit("session_shutdown");
});

test("terminal control sequences cannot alter rendering or accepted text", async () => {
  const f = await fixture();
  await suggest(f, "\x1b[31m跑测试\x1b[0m\n再检查");
  assert.equal(f.editor.getText(), "");
  assert.ok(displayed(f.editor).includes("跑测试 再检查"));
  f.editor.handleInput("\t");
  assert.equal(f.editor.getText(), "跑测试 再检查");
});

test("another editor owner suppresses requests and shutdown restores the prior owner", async () => {
  const f = await fixture();
  const anotherFactory = () => {};
  f.setFactory(anotherFactory);
  f.emit("agent_settled", { aborted: false });
  assert.equal(f.requests.length, 0);
  f.emit("session_start");
  f.makeEditor();
  f.emit("session_shutdown");
  assert.equal(f.getFactory(), anotherFactory);
});

test("changed leaves and pending input prevent publication, errors are visible, shutdown preserves another factory", async () => {
  for (const change of [
    (f) => f.sessionManager.resetLeaf(),
    (f) => f.sessionManager.newSession(),
    (f) => f.setQueued(true),
    (f) => f.setIdle(false),
  ]) {
    const f = await fixture();
    f.emit("agent_settled", { aborted: false });
    await f.waitForRequests();
    change(f);
    f.requests[0].resolve(answer("stale candidate"));
    await tick();
    assert.ok(!displayed(f.editor).includes("stale candidate"));
    f.emit("session_shutdown");
  }
  const f = await fixture();
  f.emit("agent_settled", { aborted: false });
  await f.waitForRequests();
  f.requests[0].reject(new Error("network unavailable"));
  await tick();
  assert.ok(f.statuses.some(({ text }) => text?.includes("network unavailable")));
  const anotherFactory = () => {};
  f.setFactory(anotherFactory);
  f.emit("session_shutdown");
  assert.equal(f.getFactory(), anotherFactory);
});
