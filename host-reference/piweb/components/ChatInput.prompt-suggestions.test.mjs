import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Script } from "node:vm";
import { build } from "esbuild";
import { createJiti } from "jiti";
import { chromium } from "playwright";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { getDraft, setDraft, clearDraft } = await jiti.import("@/lib/draft-store");
const { AgentEventConnection } = await jiti.import("@/lib/agent-event-connection");

const inputSource = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hookSource = ts.createSourceFile("useAgentSession.ts", readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);

function callback(source, name, context) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) return node.initializer;
    if (ts.isArrowFunction(node) && node.parameters[0]?.name.getText(source) === name) return node;
    return ts.forEachChild(node, find);
  }
  const node = find(source);
  assert.ok(node, `actual ${name} callback exists`);
  return new Script(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

function render(props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
    onSend() {}, onAbort() {}, isStreaming: false, promptSuggestion: "跑一下测试，再提交", ...props,
  })));
}

test("prediction is gray display content, never textarea value or an unaccepted draft", () => {
  const key = "prompt-suggestion-empty";
  clearDraft(key);
  try {
    const html = render({ draftKey: key });
    assert.match(html, /data-prompt-suggestion/);
    assert.match(html, /color:var\(--text-dim\)/);
    assert.match(html, /跑一下测试，再提交/);
    assert.match(html, /aria-label="采用"/);
    assert.match(html, /aria-keyshortcuts="Tab"/);
    assert.match(html, /<textarea[^>]*><\/textarea>/);
    // The overlay is aria-hidden and clears the placeholder, so the box keeps its own name.
    const textareaName = html.match(/<textarea[^>]*aria-label="([^"]+)"/)?.[1];
    assert.ok(textareaName);
    assert.notEqual(textareaName, "跑一下测试，再提交");
    assert.equal(getDraft(key), null);
    for (const props of [
      { compact: true }, { isStreaming: true }, { isCompacting: true }, { modelSwitching: true },
      { queuedMessages: { steering: ["queued"], followUp: [] } },
    ]) assert.doesNotMatch(render(props), /data-prompt-suggestion/);

    setDraft(key, { value: "real draft", images: [] });
    const draftHtml = render({ draftKey: key });
    assert.doesNotMatch(draftHtml, /data-prompt-suggestion/);
    assert.match(draftHtml, />real draft<\/textarea>/);
    setDraft(key, { value: "", images: [{ data: "AQID", mimeType: "image/png" }] });
    assert.doesNotMatch(render({ draftKey: key }), /data-prompt-suggestion/);
  } finally {
    clearDraft(key);
  }
});

test("prediction Tab is unmodified, IME-safe, fill-only, and subordinate to completion menus", () => {
  const cases = [
    ["Tab", {}, {}, "accept"],
    ["Tab", { shiftKey: true }, {}, "native"],
    ["Tab", { ctrlKey: true }, {}, "native"],
    ["Tab", { altKey: true }, {}, "native"],
    ["Tab", { metaKey: true }, {}, "native"],
    ["Tab", {}, { isComposingRef: { current: true } }, "native"],
    ["Tab", { nativeEvent: { isComposing: true } }, {}, "native"],
    ["Tab", { nativeEvent: { keyCode: 229 } }, {}, "native"],
    ["Tab", {}, { lastCompositionEndAtRef: { current: 950 } }, "native"],
    ["Tab", {}, { lastCompositionEndAtRef: { current: 900 } }, "accept"],
    ["Escape", {}, {}, "dismiss"],
    ["Escape", {}, { visiblePromptSuggestion: null }, "dismiss"],
    ["Escape", {}, { isComposingRef: { current: true } }, "native"],
    ["Tab", {}, { historyMenuOpen: true }, "history"],
    ["Tab", {}, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["Tab", {}, { atMenuOpen: true, atQuery: {} }, "file"],
    ["Escape", {}, { historyMenuOpen: true }, "history-close"],
    ["Escape", {}, { slashMenuOpen: true, slashQuery: "help" }, "slash-close"],
    ["Escape", {}, { atMenuOpen: true, atQuery: {} }, "file-close"],
  ];
  for (const [key, keys, overrides, expected] of cases) {
    let action = "native";
    const handler = callback(inputSource, "handleKeyDown", {
      Date: { now: () => 1000 }, COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: false, enterSendMode: "enter",
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      visiblePromptSuggestion: "candidate", value: "",
      historyMenuOpen: false, inputHistory: ["old"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      acceptPromptSuggestion() { action = "accept"; }, dismissPromptSuggestion() { action = "dismiss"; },
      applyHistoryInput() { action = "history"; }, applySlashCommand() { action = "slash"; }, applyAtCompletion() { action = "file"; },
      setHistoryMenuOpen() { action = "history-close"; }, setSlashMenuOpen() { action = "slash-close"; }, setAtMenuOpen() { action = "file-close"; },
      handleSend() { throw new Error("accepting a prediction must not send"); },
      ...overrides,
    });
    handler({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault() {}, ...keys });
    assert.equal(action, expected, `${key} ${JSON.stringify(keys)} ${JSON.stringify(overrides)}`);
  }
});

test("tap acceptance rechecks composition grace, actual input and pending attachments", () => {
  for (const boundary of ["none", "composition", "grace", "input", "attachment"]) {
    const textarea = { value: boundary === "input" ? "typed" : "" };
    const edits = [];
    let dismissed = 0;
    const accept = callback(inputSource, "acceptPromptSuggestion", {
      Date: { now: () => 1000 }, COMPOSITION_END_ENTER_GRACE_MS: 100,
      textareaRef: { current: textarea }, visiblePromptSuggestion: "candidate",
      isComposingRef: { current: boundary === "composition" },
      lastCompositionEndAtRef: { current: boundary === "grace" ? 950 : 0 },
      pendingImageCountRef: { current: boundary === "attachment" ? 1 : 0 },
      dismissPromptSuggestion() { dismissed++; },
      replaceTextareaRange(ta, start, end, text) { edits.push([start, end, text]); ta.value = text; },
      valueRef: { current: "" }, setValue() {},
    });
    accept();
    assert.deepEqual(edits, boundary === "none" ? [[0, 0, "candidate"]] : [], boundary);
    assert.equal(dismissed, boundary === "none" ? 1 : 0, boundary);
  }
});

function eventHarness() {
  const state = { text: null };
  const context = {
    promptSuggestionDismissedRef: { current: false }, promptSuggestionVersionRef: { current: 0 },
    setPromptSuggestion(text) { state.text = text; },
    dispatch() {}, cancelEventStreamGrace() {}, setAgentRunning() {}, setAgentPhase() {}, setRetryInfo() {},
    sdkAgentActiveRef: { current: false }, agentRunningRef: { current: false },
    sessionIdRef: { current: "one" }, sessionPropIdRef: { current: "one" }, sessionHookMountedRef: { current: true },
    refreshContextUsage() {},
  };
  const handle = callback(hookSource, "handleAgentEvent", context);
  const dismiss = callback(hookSource, "dismissPromptSuggestion", context);
  return { state, context, handle, dismiss };
}

test("dedicated events stay dismissed through clears/reconnects; only a new run unlocks them", () => {
  const { state, context, handle, dismiss } = eventHarness();
  handle({ type: "prompt_suggestion", text: "next" });
  assert.equal(state.text, "next");
  handle({ type: "prompt_suggestion", text: null });
  assert.equal(state.text, null);
  dismiss();
  handle({ type: "prompt_suggestion", text: "late" });
  assert.equal(state.text, null);
  handle({ type: "connected", isStreaming: true });
  handle({ type: "prompt_suggestion", text: "replayed cache" });
  assert.equal(state.text, null);
  assert.equal(context.promptSuggestionDismissedRef.current, true);
  handle({ type: "agent_start" });
  assert.equal(context.promptSuggestionDismissedRef.current, false);
  handle({ type: "prompt_suggestion", text: "new run" });
  assert.equal(state.text, "new run");
  handle({ type: "prompt_suggestion", text: {} });
  assert.equal(state.text, "new run", "malformed boundary input is ignored");
});

test("initial state snapshot cannot overwrite a newer event, edit, run or session", () => {
  for (const boundary of ["none", "event", "edit", "run", "session", "unmount"]) {
    const { state, context, handle, dismiss } = eventHarness();
    const apply = callback(hookSource, "loadedAgentState", {
      ...context, disposed: boundary === "unmount", session: { id: "one" }, suggestionVersion: 0,
    });
    if (boundary === "event") handle({ type: "prompt_suggestion", text: "newer" });
    if (boundary === "edit") dismiss();
    if (boundary === "run") handle({ type: "agent_start" });
    if (boundary === "session") context.sessionIdRef.current = "two";
    apply({ running: false, state: { promptSuggestion: "snapshot" } });
    assert.equal(state.text, boundary === "none" ? "snapshot" : boundary === "event" ? "newer" : null, boundary);
  }
});

test("real event connection rejects closed/previous-session delivery and consumes the new snapshot", async () => {
  const { state, context, handle } = eventHarness();
  context.handleAgentEventRef = { current: handle };
  const sources = [];
  const connection = new AgentEventConnection({
    createSource(sid) {
      const source = { sid, readyState: 1, onmessage: null, onerror: null, close() {} };
      sources.push(source);
      return source;
    },
    onEvent: callback(hookSource, "onEvent", context),
    shouldMaintain: () => false, readinessTimeoutMs: 1000, reconnectDelayMs: 10,
  });
  const send = (source, event) => source.onmessage({ data: JSON.stringify(event) });
  try {
    const ready = connection.ensureConnected("one");
    send(sources[0], { type: "connected" });
    await ready;
    send(sources[0], { type: "prompt_suggestion", text: "one" });
    assert.equal(state.text, "one");
    context.sessionPropIdRef.current = "two";
    send(sources[0], { type: "prompt_suggestion", text: "old during selection" });
    assert.equal(state.text, "one");
    context.sessionIdRef.current = "two";
    const nextReady = connection.ensureConnected("two");
    send(sources[1], { type: "connected" });
    await nextReady;
    send(sources[0], { type: "prompt_suggestion", text: "closed connection" });
    assert.equal(state.text, null);
    send(sources[1], { type: "prompt_suggestion", text: "two snapshot" });
    assert.equal(state.text, "two snapshot");
    connection.close();
    const reconnect = connection.ensureConnected("two");
    send(sources[2], { type: "connected" });
    await reconnect;
    send(sources[2], { type: "prompt_suggestion", text: "two replay" });
    assert.equal(state.text, "two replay");
  } finally {
    connection.close();
  }
});

test("send and tree navigation invalidate outstanding predictions before awaiting RPC", async () => {
  const { state, context, handle, dismiss } = eventHarness();
  const common = {
    ...context, dismissPromptSuggestion: dismiss, bashRunningRef: { current: false },
    agentRunningRef: { current: false }, loadSession: async () => {},
    sendAgentCommand: async () => ({}), setBranchViewVersion() {},
    setActiveLeafId() {}, loadContext: async () => ({}), isCompacting: false,
  };
  for (const [name, arg] of [["handleNavigate", "entry"], ["handleLeafChange", "leaf"]]) {
    handle({ type: "agent_start" });
    handle({ type: "prompt_suggestion", text: "candidate" });
    await callback(hookSource, name, common)(arg);
    handle({ type: "prompt_suggestion", text: "late" });
    assert.equal(state.text, null, name);
  }
  handle({ type: "agent_start" });
  handle({ type: "prompt_suggestion", text: "candidate" });
  await callback(hookSource, "handleSend", {
    ...common, agentRunningRef: { current: true }, composerDraftKey: "one", restoreSubmission() {},
  })("real input");
  handle({ type: "prompt_suggestion", text: "late after send" });
  assert.equal(state.text, null);
});

test("ChatWindow wires only its main composer to predictions", () => {
  const source = ts.createSourceFile("ChatWindow.tsx", readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const composers = [];
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "ChatInput") {
      composers.push(node.attributes.properties.map((prop) => prop.name?.getText(source)));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(composers.length, 2);
  const main = composers.find((props) => !props.includes("compact"));
  const compact = composers.find((props) => props.includes("compact"));
  assert.ok(main.includes("promptSuggestion"));
  assert.ok(main.includes("onDismissPromptSuggestion"));
  assert.ok(!compact.includes("promptSuggestion"));
  assert.ok(!compact.includes("onDismissPromptSuggestion"));
});

test("mounted composer supports native undo, pending dismissal, IME and mobile tap", { timeout: 60000 }, async () => {
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const bundle = await build({
    absWorkingDir: rootDir, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"development"' },
    stdin: { loader: "tsx", resolveDir: rootDir, contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { ChatInput } from "./components/ChatInput";
      import { I18nProvider } from "./hooks/useI18n";
      import { getDraft } from "./lib/draft-store";
      const root = createRoot(document.getElementById("root"));
      const ref = React.createRef();
      let key = 0;
      window.sent = [];
      window.dismissals = 0;
      window.readDraft = getDraft;
      window.inputRef = ref;
      window.renderInput = (props = {}, remount = false) => {
        if (remount) key++;
        flushSync(() => root.render(<I18nProvider><ChatInput key={key} ref={ref} onSend={(text) => window.sent.push(text)}
          onAbort={() => {}} onDismissPromptSuggestion={() => window.dismissals++} isStreaming={false}
          promptSuggestion="跑一下测试，再提交" {...props} /></I18nProvider>));
      };
      window.renderInput({draftKey: "browser-prediction"});
    ` },
  });
  const server = createServer((req, res) => {
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); }
    else if (req.url.startsWith("/api/account-usage")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ provider: "", status: "unsupported", checkedAt: Date.now(), expiresAt: null, pools: [], problems: [] }));
    } else if (req.url.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); }
    else res.end(`<!doctype html><meta charset="utf-8"><style>
      :root{--bg:#fff;--text:#1a1a1a;--text-dim:#5e6673;--text-muted:#515c6b;--border:#e0e0e0}
      *{box-sizing:border-box} body{margin:0;font:14px Arial} #root{max-width:800px} button,textarea{font:inherit}
      @media(max-width:767px){.chat-input-textarea{font-size:16px!important}}
      </style><div id="root"></div><script src="/bundle.js"></script>`);
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({
      headless: true,
      channel: process.env.PIWEB_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    });
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    const errors = [];
    await page.addInitScript(() => window.addEventListener("error", (event) => {
      window.fixtureError = event.error?.stack || event.message;
    }));
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error("Mounted composer page error:", error.message);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const textarea = page.locator("textarea");
    const ghost = page.locator("[data-prompt-suggestion]");
    await page.waitForFunction(() => document.querySelector("[data-prompt-suggestion]") || window.fixtureError);
    assert.equal(await page.evaluate(() => window.fixtureError ?? null), null);
    await ghost.waitFor();
    assert.deepEqual(errors, []);
    if (process.env.PIWEB_PROMPT_SUGGESTION_ARTIFACTS) {
      await page.screenshot({ path: `${process.env.PIWEB_PROMPT_SUGGESTION_ARTIFACTS}/prompt-suggestion-desktop.png` });
    }
    assert.equal(await textarea.inputValue(), "");
    assert.equal((await page.evaluate(() => window.readDraft("browser-prediction")))?.value ?? "", "");
    await textarea.focus();
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelector("textarea").value === "跑一下测试，再提交");
    assert.equal(await ghost.count(), 0);
    assert.deepEqual(await page.evaluate(() => window.sent), []);
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => document.querySelector("textarea").value === "");
    assert.equal(await ghost.count(), 0, "undoing acceptance must not revive it");

    // A new run, not a new candidate string, unlocks the display.
    await page.evaluate(() => window.renderInput({ isStreaming: true }));
    await page.waitForFunction(() => !document.querySelector("[data-prompt-suggestion]"));
    await page.evaluate(() => window.renderInput());
    await ghost.waitFor();
    await textarea.fill("manual input");
    await textarea.fill("");
    await page.evaluate(() => window.renderInput({ promptSuggestion: "late after edit" }));
    assert.equal(await ghost.count(), 0);

    await page.evaluate(() => window.renderInput({ promptSuggestion: null }, true));
    await textarea.focus();
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.renderInput({ promptSuggestion: "late after Escape" }));
    assert.equal(await ghost.count(), 0);

    await page.evaluate(() => window.renderInput({}, true));
    await ghost.waitFor();
    await textarea.dispatchEvent("compositionstart");
    await page.keyboard.press("Tab");
    assert.equal(await textarea.inputValue(), "");
    assert.equal(await ghost.count(), 0);
    await textarea.dispatchEvent("compositionend", { data: "" });

    // Touch uses the same undoable fill action, with no submission.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.renderInput({ promptSuggestion: "先跑一下组件测试，再检查类型错误，然后整理本次修改的验证结果。" }, true));
    await ghost.waitFor();
    const wrapped = await ghost.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }));
    assert.ok(wrapped.height > 30, "a wrapped prediction expands the empty composer");
    assert.ok(wrapped.content <= wrapped.height + 1, "the short multi-line prediction is not clipped");
    assert.equal(await textarea.inputValue(), "");
    await page.evaluate(() => window.renderInput({}, true));
    const adopt = page.getByRole("button", { name: "采用", exact: true });
    await adopt.waitFor();
    assert.equal(await adopt.textContent(), "采用");
    if (process.env.PIWEB_PROMPT_SUGGESTION_ARTIFACTS) {
      await page.screenshot({ path: `${process.env.PIWEB_PROMPT_SUGGESTION_ARTIFACTS}/prompt-suggestion-mobile.png` });
    }
    await adopt.tap();
    assert.equal(await textarea.inputValue(), "跑一下测试，再提交");
    assert.deepEqual(await page.evaluate(() => window.sent), []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
