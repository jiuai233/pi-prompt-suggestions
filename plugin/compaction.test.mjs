import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { convertToLlm } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";
import { buildCompactedSuggestionContext, buildSuggestionMessages, generateSuggestion } from "./core.mjs";
import { suggestionThreadPath } from "./threads.mjs";

const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text, extra = []) => ({ role: "assistant", content: [{ type: "text", text }, ...extra],
  api: "openai-responses", provider: "test", model: "test", stopReason: "stop", timestamp: 2 });
const tool = (text) => ({ role: "toolResult", toolName: "read", toolCallId: "read-call", content: [{ type: "text", text }], timestamp: 3 });
const call = (text) => ({ type: "toolCall", id: "read-call", name: "read", arguments: { path: text } });
const response = (id) => ({ ...assistant("PREDICTION_NOT_REAL"), responseId: id, usage: { totalTokens: 10 } });
const evidence = (context) => context.messages.filter(m => m.role === "user").map(m => JSON.parse(m.content)).filter(m => m.kind === "conversation_evidence");
const source = (session) => {
  const compacted = buildCompactedSuggestionContext(session.getBranch(), session.buildSessionProjection().entries);
  return compacted && { id: compacted.id, messages: convertToLlm(compacted.messages) };
};
function sessionFixture() {
  const session = SessionManager.inMemory(process.cwd());
  const firstUser = session.appendMessage(user("先解释机制，不要直接开始实施。"));
  session.appendMessage(assistant("这是原始解释。", [call("OLD_TOOL_ARGUMENT"), { type: "thinking", thinking: "FOREGROUND_SECRET" }]));
  session.appendMessage({ ...assistant(""), content: [call("OLD_TOOL_ONLY")] });
  const oldTool = session.appendMessage(tool("OLD_TOOL_BODY"));
  session.appendMessage(assistant("旧任务的原始结论。"));
  return { session, firstUser, oldTool };
}
const worker = (request) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./test/thread-worker.mjs", import.meta.url)), JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  child.on("error", reject);
  child.on("close", code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `Worker exited ${code}`)));
});

test("real SDK compaction restores dialogue verbatim, drops retained old tools and keeps new projected tools", () => {
  const { session, oldTool } = sessionFixture();
  assert.equal(source(session), undefined, "before compaction keep the actual request snapshot");
  const compactId = session.appendCompaction("MAIN_SUMMARY_NOT_SOURCE", oldTool, 10_000);
  session.appendMessage(user("那现在看一下新文件。"));
  session.appendMessage({ ...assistant(""), content: [call("NEW_TOOL_ARGUMENT")] });
  session.appendMessage(tool("NEW_TOOL_BODY"));
  session.appendMessage(assistant("新文件检查完了。"));
  assert(JSON.stringify(session.buildSessionProjection().messages).includes("OLD_TOOL_BODY"), "old tool really is in the main kept region");
  const before = JSON.stringify(session.getEntries());
  const compacted = source(session);
  const turns = evidence({ messages: buildSuggestionMessages(compacted.messages, "", "leaf") });
  assert.equal(compacted.id, compactId);
  assert.deepEqual(turns.slice(0, 3).map(t => t.text), ["先解释机制，不要直接开始实施。", "这是原始解释。", "旧任务的原始结论。"]);
  const sent = JSON.stringify(turns);
  for (const excluded of ["OLD_TOOL_ARGUMENT", "OLD_TOOL_ONLY", "OLD_TOOL_BODY", "FOREGROUND_SECRET", "MAIN_SUMMARY_NOT_SOURCE"]) assert(!sent.includes(excluded), excluded);
  assert(sent.includes("NEW_TOOL_ARGUMENT"));
  assert(sent.includes("NEW_TOOL_BODY"));
  assert.equal(turns.at(-1).text, "新文件检查完了。");
  assert.equal(JSON.stringify(session.getEntries()), before, "projection never edits the real conversation");
  session.appendCompaction("SECOND_SUMMARY", oldTool, 20_000);
  const second = JSON.stringify(evidence({ messages: buildSuggestionMessages(source(session).messages) }));
  assert(!second.includes("NEW_TOOL_ARGUMENT"));
  assert(!second.includes("NEW_TOOL_BODY"));
  assert(second.includes("那现在看一下新文件。"));
  assert(second.includes("新文件检查完了。"));
});

test("dialogue comes only from the selected native branch", () => {
  const { session, firstUser } = sessionFixture();
  session.branch(firstUser);
  const alternate = session.appendMessage(assistant("当前分支的回答。"));
  session.appendCompaction("branch summary", alternate, 10_000);
  const sent = JSON.stringify(source(session));
  assert(sent.includes("先解释机制，不要直接开始实施。"));
  assert(sent.includes("当前分支的回答。"));
  assert(!sent.includes("旧任务的原始结论。"));
});

for (const model of [
  { api: "openai-responses", provider: "xai", id: "test" },
  { api: "openai-codex-responses", provider: "openai-codex", id: "test" },
]) test(`${model.provider}: compaction resets the chain, restores in another process, then clears new tools at the next compaction`, async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "suggestion-compaction-"));
  const { session, oldTool } = sessionFixture();
  const options = { enabled: true, model, agentDir, sessionId: "same-tui-web-session", preferences: "原样偏好" };
  const checkpoint = () => readFile(suggestionThreadPath(agentDir, options.sessionId), "utf8").then(JSON.parse);
  try {
    await generateSuggestion({ ...options, messages: convertToLlm(session.buildSessionProjection().messages), complete: async () => response("before") });
    session.appendCompaction("main summary", oldTool, 10_000);
    session.appendMessage(user("压缩后继续检查。"));
    session.appendMessage(tool("NEW_TOOL_BODY"));
    session.appendMessage(assistant("新的检查结果。"));
    await generateSuggestion({ ...options, messages: [], compaction: source(session), complete: async (_model, context, request) => {
      assert.equal(request.onPayload?.({}).previous_response_id, undefined);
      const text = JSON.stringify(context);
      assert(!text.includes("OLD_TOOL_BODY"));
      assert(!text.includes("OLD_TOOL_ARGUMENT"));
      assert(!text.includes("PREDICTION_NOT_REAL"));
      assert(text.includes("NEW_TOOL_BODY"));
      return response("after");
    } });
    const clean = await checkpoint();
    assert.equal(clean.lastRequest.mode, "full");
    assert.equal(clean.compactionId, source(session).id);
    session.appendMessage(user("真实下一句。"));
    session.appendMessage(assistant("真实新回复。"));
    const restored = await worker({ ...options, messages: [], compaction: source(session) });
    assert.equal(restored.sent.previous_response_id, model.provider === "xai" ? "after" : undefined);
    assert.equal((await checkpoint()).lastRequest.mode, model.provider === "xai" ? "delta" : "append");
    assert(restored.evidence.some(t => t.text === "真实下一句。"));
    assert(!JSON.stringify(restored.evidence).includes("OLD_TOOL_BODY"));
    session.appendCompaction("next main summary", oldTool, 20_000);
    await generateSuggestion({ ...options, messages: [], compaction: source(session), complete: async (_model, context, request) => {
      assert.equal(request.onPayload?.({}).previous_response_id, undefined);
      const text = JSON.stringify(context);
      assert(!text.includes("NEW_TOOL_BODY"));
      assert(!text.includes("PREDICTION_NOT_REAL"));
      assert(text.includes("新的检查结果。"));
      assert(text.includes("真实下一句。"));
      return response("after-next-compaction");
    } });
    assert.equal((await checkpoint()).lastRequest.mode, "full");
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
