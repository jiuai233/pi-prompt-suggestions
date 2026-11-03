import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS, readSuggestionSettings, writeSuggestionSettings, subscribeSuggestionSettings, runSuggestionCommand, validatePredictionSelection, suggestionModelOption, SuggestionController } from "./api.mjs";

const choice = { provider: "xai", id: "grok-4.7", name: "Grok 4.7", thinkingLevels: ["off", "low", "high"], supported: true };
const second = { provider: "test", id: "other", name: "Other", thinkingLevels: ["off"], supported: true };
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const fixture = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-suggestions-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("default off, one-time legacy read, and preferences survive model-only saves", () => fixture(async (dir) => {
  assert.deepEqual(await readSuggestionSettings(dir), DEFAULT_SETTINGS);
  await writeFile(join(dir, "settings.json"), JSON.stringify({ promptSuggestionsEnabled: true, defaultModel: "foreground" }));
  assert.equal((await readSuggestionSettings(dir)).enabled, true);
  const raw = "  用户亲自写的偏好\r\n哈哈~  ";
  const changes = [];
  const stop = subscribeSuggestionSettings(dir, (settings) => changes.push(settings));
  await writeSuggestionSettings(dir, { preferences: raw });
  await Promise.all([writeSuggestionSettings(dir, { provider: "test", modelId: "other" }), writeSuggestionSettings(dir, { thinkingLevel: "off" })]);
  const saved = await readSuggestionSettings(dir);
  assert.equal(saved.preferences, raw);
  assert.equal(saved.modelId, "other");
  assert.equal(saved.thinkingLevel, "off");
  assert.equal(changes.length, 3);
  stop();
  await writeFile(join(dir, "settings.json"), JSON.stringify({ promptSuggestionsEnabled: false, defaultModel: "foreground" }));
  assert.equal((await readSuggestionSettings(dir)).enabled, true, "plugin file is now the only writer/source");
  assert.equal(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).defaultModel, "foreground");
  await writeSuggestionSettings(dir, { preferences: "" });
  assert.equal((await readSuggestionSettings(dir)).preferences, "");
}));

test("a rejected settings patch preserves the file and releases the lock for the next save", () => fixture(async (dir) => {
  const before = await writeSuggestionSettings(dir, { preferences: "keep this preference" });
  await assert.rejects(writeSuggestionSettings(dir, { thinkingLevel: "invalid-level" }));
  assert.deepEqual(await readSuggestionSettings(dir), before);
  const after = await writeSuggestionSettings(dir, { preferences: "normal save after rejection" });
  assert.deepEqual(await readSuggestionSettings(dir), { ...before, preferences: after.preferences });
  assert.equal(after.preferences, "normal save after rejection");
}));

test("model menu, reasoning and raw preference editor share one command implementation", () => fixture(async (agentDir) => {
  const raw = "我自己写的\n  不替换空格。  ";
  const options = { agentDir, getModels: async () => [choice, second], ui: {
    select: async (_title, items) => items.find((item) => item === "test/other"),
    editor: async () => raw,
  }, overrides: { enabled: true } };
  assert.match(await runSuggestionCommand("/suggestions model", options), /test\/other/);
  assert.equal((await readSuggestionSettings(agentDir)).thinkingLevel, "off");
  await runSuggestionCommand("/suggestions preferences", options);
  assert.equal((await readSuggestionSettings(agentDir)).preferences, raw);
  await runSuggestionCommand("/suggestions off", options);
  assert.equal(options.overrides.enabled, undefined);
  assert.equal((await readSuggestionSettings(agentDir)).enabled, false);
  await runSuggestionCommand("/suggestions on", options);
  assert.equal((await readSuggestionSettings(agentDir)).enabled, true);
  await assert.rejects(runSuggestionCommand("/suggestions model not/enabled", options), /已启用/);
  await assert.rejects(runSuggestionCommand("/suggestions thinking high", options), /不支持/);
}));

test("only an enabled independent-request model can be selected", () => {
  assert.equal(validatePredictionSelection(DEFAULT_SETTINGS, [choice]), choice);
  assert.throws(() => validatePredictionSelection(DEFAULT_SETTINGS, []), /未启用/);
  const native = suggestionModelOption({ provider: "claude", id: "native", name: "Native", api: "pi-claude-code-provider-headless" }, ["high"]);
  assert.equal(native.supported, false);
  assert.throws(() => validatePredictionSelection({ ...DEFAULT_SETTINGS, provider: "claude", modelId: "native", thinkingLevel: "high" }, [native]), /原生会话/);
});

test("cancelled completion cannot replace the next candidate or write history", async () => {
  let finish;
  let oldSignal;
  const events = [];
  const engine = new SuggestionController((text) => events.push(text));
  const messages = [{ role: "user", content: "原对话" }];
  const before = JSON.stringify(messages);
  const common = { enabled: true, model: { api: "openai-responses", id: "grok", provider: "test" }, messages, sessionId: "foreground", isCurrent: () => true };
  engine.start({ ...common, revision: "old", complete: async (_m, _c, options) => { oldSignal = options.signal; return new Promise((resolve) => { finish = resolve; }); } });
  engine.clear();
  engine.start({ ...common, revision: "new", complete: async () => answer("新候选") });
  await new Promise((resolve) => setImmediate(resolve));
  finish(answer("迟到旧候选"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldSignal.aborted, true);
  assert.equal(engine.text, "新候选");
  assert.deepEqual(events, ["新候选"]);
  assert.equal(JSON.stringify(messages), before);
  engine.clear();
});
