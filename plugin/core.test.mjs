import assert from "node:assert/strict";
import test from "node:test";
import { generateSuggestion, EVIDENCE_INSTRUCTION } from "./core.mjs";

const model = { id: "test-model", provider: "test-provider", api: "openai-responses", reasoning: true };
const answer = (content, extra = {}) => ({
  role: "assistant",
  content: typeof content === "string" ? [{ type: "text", text: content }] : content,
  stopReason: "stop",
  usage: { output: 12 },
  ...extra,
});

const transcript = () => [
  { role: "system", content: "Project prompt", toolsAdded: [{ name: "read", parameters: { type: "object" } }], timestamp: 1 },
  { role: "user", content: "帮忙检查这个文件", timestamp: 2 },
  answer([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } }]),
  { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file body" }], timestamp: 3 },
  answer("检查完成"),
];

test("prediction is off by default and explicit off never calls the model", async () => {
  let calls = 0;
  for (const enabled of [undefined, false]) {
    assert.deepEqual(await generateSuggestion({ enabled, model, messages: transcript(), complete: async () => {
      calls++;
      return answer("must not generate");
    } }), { text: null });
  }
  assert.equal(calls, 0);
});

test("full visible evidence and raw preferences use a private tool-free request", async () => {
  const messages = transcript();
  const before = structuredClone(messages);
  const controller = new AbortController();
  const preferences = "  我自己的原话\n不需要替我概括。  ";
  let calls = 0;
  const result = await generateSuggestion({
    enabled: true, model, messages, preferences, thinkingLevel: "high", signal: controller.signal, sessionId: "session-a",
    complete: async (selected, context, options) => {
      calls++;
      assert.equal(selected, model);
      assert.equal(context.messages[0].content, EVIDENCE_INSTRUCTION);
      const packet = context.messages.slice(1).map((message) => JSON.parse(message.content));
      const turns = packet.filter((item) => item.kind === "conversation_evidence");
      assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant", "toolResult", "assistant"]);
      assert.equal(turns[0].text, "帮忙检查这个文件");
      assert.equal(turns[2].text, "file body");
      assert.equal(packet[0].preferences, preferences);
      assert.equal(context.messages.at(-1).role, "user");
      assert.equal(options.toolChoice, undefined);
      assert.equal(options.reasoning, "high");
      assert.equal(options.sessionId, "session-a:prompt-suggestions");
      assert.equal(options.requestIdentity.sessionId, options.sessionId);
      assert.equal(options.transport, "sse");
      assert.equal(options.signal, controller.signal);
      assert.equal(options.maxTokens, undefined);
      return answer("  跑一下测试，再提交  ");
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(messages, before);
  assert.deepEqual(result, { text: "跑一下测试，再提交", usage: { output: 12 } });
});

test("empty preference text omits the card, and long text is not clipped", async () => {
  const body = "完整会话文字".repeat(5000);
  await generateSuggestion({ enabled: true, model, messages: [{ role: "user", content: body }], preferences: "",
    complete: async (_model, context) => {
      assert.equal(context.messages.length, 3);
      assert.equal(JSON.parse(context.messages[1].content).text, body);
      return answer("继续。");
    },
  });
});

test("blank or thinking-only output produces no candidate", async () => {
  for (const content of [" \n ", [{ type: "thinking", thinking: "No obvious next step" }]]) {
    const result = await generateSuggestion({ enabled: true, model, messages: transcript(), complete: async () => answer(content) });
    assert.equal(result.text, null);
  }
});

test("tool calls are discarded without execution or another completion", async () => {
  let calls = 0;
  const result = await generateSuggestion({
    enabled: true, model, messages: transcript(),
    complete: async () => {
      calls++;
      return answer([{ type: "text", text: "run tests" }, { type: "toolCall", name: "bash", arguments: {} }]);
    },
  });
  assert.equal(result.text, null);
  assert.equal(calls, 1);
});

test("cancellation before or during completion cannot return a candidate", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  assert.deepEqual(await generateSuggestion({
    enabled: true, model, messages: transcript(), signal: controller.signal,
    complete: async () => { calls++; return answer("stale"); },
  }), { text: null });
  assert.equal(calls, 0);

  const active = new AbortController();
  const result = await generateSuggestion({
    enabled: true, model, messages: transcript(), signal: active.signal,
    complete: async () => { active.abort(); return answer("stale"); },
  });
  assert.equal(result.text, null);
  assert.equal((await generateSuggestion({
    enabled: true, model, messages: transcript(), complete: async () => answer("partial", { stopReason: "aborted" }),
  })).text, null);
});

test("session-bound provider APIs never receive the prediction request", async () => {
  for (const api of ["antigravity-stream-json", "cursor-host-sdk", "pi-claude-code-provider-headless", undefined]) {
    let calls = 0;
    const result = await generateSuggestion({
      enabled: true, model: { ...model, api }, messages: transcript(), complete: async () => { calls++; return answer("Run tests"); },
    });
    assert.deepEqual(result, { text: null });
    assert.equal(calls, 0);
  }
});

test("provider errors stay visible to the caller", async () => {
  const failure = new Error("Network unavailable");
  await assert.rejects(generateSuggestion({
    enabled: true, model, messages: transcript(), complete: async () => { throw failure; },
  }), (error) => error === failure);
  await assert.rejects(generateSuggestion({
    enabled: true, model, messages: transcript(), complete: async () => answer("", { stopReason: "error", errorMessage: "Rate limited" }),
  }), /Rate limited/);
});

test("uses configured reasoning without changing the foreground model", async () => {
  for (const reasoning of [false, true]) {
    await generateSuggestion({
      enabled: true, model: { ...model, reasoning }, thinkingLevel: "low", messages: transcript(),
      complete: async (_model, _context, options) => {
        assert.equal(options.reasoning, reasoning ? "low" : undefined);
        return answer("Run tests");
      },
    });
  }
});
