import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import ts from "typescript";

const require = createRequire(import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const stored = {
  enabled: false, provider: "prediction-provider", modelId: "prediction-model", thinkingLevel: "low",
  preferences: "First experimental statement.\nSecond statement.\nThird statement.\nFourth statement.",
};
const models = [
  { provider: stored.provider, id: stored.modelId, name: "Prediction model", thinkingLevels: ["low", "high"], supported: true },
  { provider: "other-provider", id: "other-model", name: "Other enabled model", thinkingLevels: ["medium"], supported: true },
  { provider: "bridge", id: "bridge-model", name: "Bridge model", thinkingLevels: ["off"], supported: false, unsupportedReason: "Interactive bridge cannot predict" },
];

// Execute the actual components and their event handlers, using the same small
// hook fixture as VoiceSettings.test.mjs. No backend or production service runs.
function fixture(t, { settings = stored, catalog = models, draftRef = { current: null }, locale = "en", respond, parent = false, remembered } = {}) {
  let slots = [];
  let effects = [];
  let cursor = 0;
  let pending = [];
  let selection = remembered;
  const requests = [];
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useId() { return "fixture-id"; },
    useCallback(callback) { return callback; },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!effects[index] || deps.some((dep, i) => !Object.is(dep, effects[index].deps[i]))) {
        pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: callback() }; });
      }
    },
  };
  const exports = {};
  const source = readFileSync(new URL(`../components/${parent ? "ModelsConfig" : "PromptSuggestionSettings"}.tsx`, import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, AbortController,
    require(id) {
      if (id === "react") return hooks;
      if (id === "@/hooks/useI18n") return { useI18n: () => ({ locale, t: (key) => key }) };
      if (id === "./SettingsUi") return new Proxy({}, { get: (_target, key) => key });
      if (id === "@/lib/settings-navigation") return {
        getLastSettingsSelection: () => selection,
        setLastSettingsSelection: (_section, value) => { selection = value; },
      };
      if (id === "./EnabledModelsSection") return {
        useEnabledModels: () => ({ view: {} }), EnabledModelsBanner: "EnabledModelsBanner",
      };
      if (id === "./models-config-helpers") return { savedModelIds: () => new Map() };
      if (id === "./PromptSuggestionSettings") return {
        PromptSuggestionSettingsDetail: "PromptSuggestionSettingsDetail",
        promptSuggestionCopy: () => ({ title: "Prompt suggestions" }),
      };
      if (parent && !id.startsWith("react/")) return new Proxy({}, { get: (_target, key) => key });
      return require(id);
    },
    fetch: async (url, options = {}) => {
      const request = { url, ...options };
      requests.push(request);
      if (parent) return { ok: true, json: async () => url === "/api/models-config" ? { providers: {} } : { oauthProviders: [], apiKeyProviders: [] } };
      const response = await respond?.(request);
      if (response instanceof Error) throw response;
      return {
        ok: response?.ok ?? true, status: response?.status ?? 200,
        json: async () => response?.body ?? { settings: options.method === "PUT" ? JSON.parse(options.body) : { ...settings }, models: catalog },
      };
    },
  });
  const unmount = () => {
    effects.forEach((effect) => effect?.cleanup?.());
    effects = [];
    slots = [];
    pending = [];
  };
  t.after(unmount);
  return {
    requests, draftRef, exports, unmount,
    get remembered() { return selection; },
    render(cwd = "E:/project with spaces/中文") {
      cursor = 0;
      const tree = parent
        ? exports.ModelsConfig({ cwd, onClose() {} })
        : exports.PromptSuggestionSettingsDetail({ cwd, draftRef });
      const work = pending;
      pending = [];
      work.forEach((effect) => effect());
      return tree;
    },
  };
}

function elements(node, type) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
  return [...(node.type === type ? [node] : []), ...elements(node.props?.children, type)];
}
const find = (node, type, predicate = () => true) => elements(node, type).find(predicate);
const saveButton = (tree) => find(tree, "ConfigButton", (node) => node.props.variant === "primary");
const reloadButton = (tree) => find(tree, "ConfigButton", (node) => node.props.variant !== "primary");
const textOf = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return textOf(node.props?.children);
};
async function loaded(f) { f.render(); await flush(); return f.render(); }

test("loads only the prediction endpoint with the encoded project and trusts its raw defaults", async (t) => {
  const f = fixture(t);
  const tree = await loaded(f);
  assert.equal(f.requests[0].url, `/api/prompt-suggestions/settings?cwd=${encodeURIComponent("E:/project with spaces/中文")}`);
  assert.equal(find(tree, "ConfigSwitch").props.checked, false);
  assert.equal(find(tree, "textarea").props.value, stored.preferences);
  assert.deepEqual(plain(f.draftRef.current.settings), stored);
  assert.equal(saveButton(tree).props.disabled, true);
});

test("only supported models appear, with their names, providers and own thinking levels", async (t) => {
  const f = fixture(t);
  let tree = await loaded(f);
  let [modelSelect] = elements(tree, "select");
  const options = elements(modelSelect, "option");
  assert.deepEqual(
    options.map((node) => node.props.value),
    models.filter((model) => model.supported).map((model) => JSON.stringify([model.provider, model.id])),
  );
  for (const [index, model] of models.filter((entry) => entry.supported).entries()) {
    assert.equal(textOf(options[index]).replace(/\s+/g, " "), `${model.name} · ${model.provider}`);
    assert.ok(!options[index].props.disabled);
  }
  assert.ok(!textOf(tree).includes(models[2].name));
  assert.ok(!textOf(tree).includes(models[2].unsupportedReason));
  modelSelect.props.onChange({ target: { value: JSON.stringify(["bridge", "bridge-model"]) } });
  assert.equal(f.draftRef.current.settings.modelId, stored.modelId);
  modelSelect.props.onChange({ target: { value: JSON.stringify(["other-provider", "other-model"]) } });
  tree = f.render();
  const [, thinking] = elements(tree, "select");
  assert.equal(thinking.props.value, "medium");
  assert.deepEqual(elements(thinking, "option").map((node) => node.props.value), ["medium"]);
  find(tree, "ConfigSwitch").props.onChange(true);
  saveButton(f.render()).props.onClick();
  await flush();
  const request = f.requests.find((request) => request.method === "PUT");
  assert.deepEqual(JSON.parse(request.body), { ...stored, enabled: true, provider: "other-provider", modelId: "other-model", thinkingLevel: "medium" });
  assert.ok(f.requests.every((request) => request.url.startsWith("/api/prompt-suggestions/settings")), "never writes the chat model");
});

test("sends whitespace and empty preferences unchanged; success waits for the real save response", async (t) => {
  for (const preferences of ["  我的原文\n\n保留空格  \t", ""]) {
    const pendingSave = deferred();
    const f = fixture(t, { respond: (request) => request.method === "PUT" ? pendingSave.promise : undefined });
    let tree = await loaded(f);
    find(tree, "textarea").props.onChange({ target: { value: preferences } });
    tree = f.render();
    assert.match(textOf(tree), /Unsaved changes/);
    saveButton(tree).props.onClick();
    tree = f.render();
    assert.equal(saveButton(tree).props.children, "i18n.saving");
    assert.doesNotMatch(textOf(tree), /Applies to the next prediction/);
    assert.equal(JSON.parse(f.requests.at(-1).body).preferences, preferences);
    pendingSave.resolve(undefined);
    await flush();
    tree = f.render();
    assert.match(textOf(tree), /Applies to the next prediction/);
    assert.equal(find(tree, "textarea").props.value, preferences);
    assert.equal(saveButton(tree).props.disabled, true);
  }
});

test("clean reload and navigation adopt changed server settings without enabling Save", async (t) => {
  let remote = { ...stored };
  const f = fixture(t, { respond: () => ({ body: { settings: { ...remote }, models } }) });
  let tree = await loaded(f);
  assert.equal(saveButton(tree).props.disabled, true);
  remote = { ...stored, enabled: true, thinkingLevel: "high", preferences: "Changed elsewhere while clean" };
  reloadButton(tree).props.onClick();
  f.render();
  await flush();
  tree = f.render();
  assert.equal(find(tree, "textarea").props.value, remote.preferences);
  assert.equal(find(tree, "ConfigSwitch").props.checked, true);
  assert.equal(elements(tree, "select")[1].props.value, "high");
  assert.equal(saveButton(tree).props.disabled, true);
  assert.doesNotMatch(textOf(tree), /Unsaved changes/);
  remote = { ...remote, preferences: "Changed again before returning" };
  f.unmount();
  tree = await loaded(f);
  assert.equal(find(tree, "textarea").props.value, remote.preferences);
  assert.equal(saveButton(tree).props.disabled, true);
});

test("saved and reverted drafts are clean on the next reload", async (t) => {
  for (const save of [false, true]) {
    let remote = { ...stored };
    const f = fixture(t, { respond: (request) => {
      if (request.method === "PUT") remote = JSON.parse(request.body);
      return { body: { settings: { ...remote }, models } };
    } });
    let tree = await loaded(f);
    find(tree, "textarea").props.onChange({ target: { value: "local edit" } });
    tree = f.render();
    if (save) {
      saveButton(tree).props.onClick();
      await flush();
    } else {
      find(tree, "textarea").props.onChange({ target: { value: stored.preferences } });
    }
    tree = f.render();
    assert.equal(saveButton(tree).props.disabled, true);
    remote = { ...remote, preferences: "Remote value after clean transition" };
    reloadButton(tree).props.onClick();
    f.render();
    await flush();
    tree = f.render();
    assert.equal(find(tree, "textarea").props.value, remote.preferences);
    assert.equal(saveButton(tree).props.disabled, true);
  }
});

test("navigation and reload preserve a raw unsaved draft despite remote changes; a different project does not inherit it", async (t) => {
  let remote = { ...stored };
  const f = fixture(t, { respond: () => ({ body: { settings: { ...remote }, models } }) });
  let tree = await loaded(f);
  find(tree, "textarea").props.onChange({ target: { value: "  unsaved\n " } });
  remote = { ...stored, preferences: "Remote edit must not erase the raw draft" };
  f.unmount();
  tree = await loaded(f);
  assert.equal(find(tree, "textarea").props.value, "  unsaved\n ");
  reloadButton(tree).props.onClick();
  f.render();
  await flush();
  tree = f.render();
  assert.equal(find(tree, "textarea").props.value, "  unsaved\n ");
  assert.equal(saveButton(tree).props.disabled, false);
  f.unmount();
  f.render("E:/different-project");
  await flush();
  tree = f.render("E:/different-project");
  assert.equal(find(tree, "textarea").props.value, remote.preferences);
});

test("failed reading is visible and retryable without permitting a premature save", async (t) => {
  let fail = true;
  const f = fixture(t, { respond: () => fail ? { ok: false, status: 503, body: { error: "Settings unavailable" } } : undefined });
  let tree = await loaded(f);
  assert.match(textOf(find(tree, "p", (node) => node.props.role === "alert")), /Settings unavailable/);
  assert.equal(saveButton(tree).props.disabled, true);
  fail = false;
  reloadButton(tree).props.onClick();
  f.render();
  await flush();
  tree = f.render();
  assert.equal(find(tree, "p", (node) => node.props.role === "alert"), undefined);
  assert.equal(find(tree, "textarea").props.value, stored.preferences);
});

test("save failures keep the draft and can retry; settings are taken from the successful server response", async (t) => {
  let fail = true;
  const canonical = { ...stored, preferences: "server-confirmed text" };
  const f = fixture(t, { respond: (request) => request.method !== "PUT" ? undefined : fail
    ? { ok: false, status: 500, body: { error: "Disk is locked" } }
    : { body: { settings: canonical, models } } });
  let tree = await loaded(f);
  find(tree, "textarea").props.onChange({ target: { value: "local draft" } });
  saveButton(f.render()).props.onClick();
  await flush();
  tree = f.render();
  assert.match(textOf(tree), /Disk is locked/);
  assert.doesNotMatch(textOf(tree), /Applies to the next prediction/);
  assert.equal(find(tree, "textarea").props.value, "local draft");
  assert.equal(saveButton(tree).props.disabled, false);
  fail = false;
  saveButton(tree).props.onClick();
  await flush();
  tree = f.render();
  assert.equal(find(tree, "textarea").props.value, canonical.preferences);
  assert.match(textOf(tree), /Applies to the next prediction/);
});

test("empty, missing and unsupported catalogs cannot enable predictions, but can still turn them off", async (t) => {
  for (const catalog of [
    [], [models[1]], [{ ...models[0], supported: false, unsupportedReason: "Bridge unavailable" }],
    models.map((model, index) => index === 0 ? { ...model, supported: false } : model),
  ]) {
    const f = fixture(t, { settings: { ...stored, enabled: true }, catalog });
    let tree = await loaded(f);
    const [modelSelect, thinking] = elements(tree, "select");
    assert.equal(modelSelect.props.value, "", "show a placeholder rather than implying a replacement was selected");
    assert.equal(elements(modelSelect, "option")[0].props.value, "");
    assert.equal(elements(modelSelect, "option")[0].props.disabled, true);
    assert.equal(elements(modelSelect, "option").length, 1 + catalog.filter((model) => model.supported).length);
    assert.equal(modelSelect.props.disabled, !catalog.some((model) => model.supported));
    assert.equal(thinking.props.disabled, true);
    assert.deepEqual(plain(f.draftRef.current.settings), { ...stored, enabled: true });
    assert.equal(f.requests.length, 1, "loading never saves or replaces an unavailable model");
    assert.match(textOf(tree), /available model/i);
    assert.ok(!textOf(tree).includes("Bridge unavailable"));
    find(tree, "textarea").props.onChange({ target: { value: "keep me" } });
    tree = f.render();
    assert.equal(saveButton(tree).props.disabled, true);
    find(tree, "ConfigSwitch").props.onChange(false);
    tree = f.render();
    assert.equal(saveButton(tree).props.disabled, false);
    saveButton(tree).props.onClick();
    await flush();
    assert.deepEqual(JSON.parse(f.requests.at(-1).body), { ...stored, enabled: false, preferences: "keep me" });
  }
});

test("reload filters a changed catalog without replacing an unsaved model or raw preferences", async (t) => {
  let catalog = models;
  const f = fixture(t, { respond: () => ({ body: { settings: { ...stored, preferences: "remote text" }, models: catalog } }) });
  let tree = await loaded(f);
  const preferences = "  unsaved 原文\n\n \t";
  find(tree, "textarea").props.onChange({ target: { value: preferences } });
  find(f.render(), "ConfigSwitch").props.onChange(true);
  catalog = models.map((model) => model.id === stored.modelId ? { ...model, supported: false } : model);
  reloadButton(f.render()).props.onClick();
  f.render();
  await flush();
  tree = f.render();
  const [modelSelect] = elements(tree, "select");
  assert.equal(modelSelect.props.value, "");
  assert.deepEqual(
    elements(modelSelect, "option").map((node) => node.props.value),
    ["", JSON.stringify([models[1].provider, models[1].id])],
  );
  assert.ok(!textOf(tree).includes(models[2].unsupportedReason));
  assert.equal(find(tree, "textarea").props.value, preferences);
  assert.deepEqual(plain(f.draftRef.current.settings), { ...stored, enabled: true, preferences });
  assert.equal(saveButton(tree).props.disabled, true);
  assert.ok(f.requests.every((request) => request.method !== "PUT"));
});

test("save responses filter the refreshed catalog and retain the confirmed model and raw preferences", async (t) => {
  const refreshed = models.map((model) => model.id === stored.modelId ? { ...model, supported: false } : model);
  const f = fixture(t, { respond: (request) => request.method === "PUT"
    ? { body: { settings: JSON.parse(request.body), models: refreshed } } : undefined });
  let tree = await loaded(f);
  const preferences = "  saved 原文\n\n \t";
  find(tree, "textarea").props.onChange({ target: { value: preferences } });
  saveButton(f.render()).props.onClick();
  await flush();
  tree = f.render();
  const [modelSelect] = elements(tree, "select");
  assert.equal(modelSelect.props.value, "");
  assert.deepEqual(
    elements(modelSelect, "option").map((node) => node.props.value),
    ["", JSON.stringify([models[1].provider, models[1].id])],
  );
  assert.ok(!textOf(tree).includes(models[2].unsupportedReason));
  assert.equal(find(tree, "textarea").props.value, preferences);
  assert.deepEqual(plain(f.draftRef.current.settings), { ...stored, preferences });
  assert.deepEqual(plain(f.draftRef.current.saved), { ...stored, preferences });
  assert.equal(saveButton(tree).props.disabled, true);
  assert.equal(f.requests.filter((request) => request.method === "PUT").length, 1);
});

test("thinking levels come from the selected model, including a model with no levels", async (t) => {
  const f = fixture(t, { catalog: [{ ...models[0], thinkingLevels: [] }] });
  let tree = await loaded(f);
  assert.equal(elements(tree, "select")[1].props.disabled, true);
  find(tree, "ConfigSwitch").props.onChange(true);
  assert.equal(saveButton(f.render()).props.disabled, false);
  const invalid = fixture(t, { settings: { ...stored, enabled: true, thinkingLevel: "removed-level" } });
  tree = await loaded(invalid);
  find(tree, "textarea").props.onChange({ target: { value: "change" } });
  assert.equal(saveButton(invalid.render()).props.disabled, true);
  elements(tree, "select")[1].props.onChange({ target: { value: "high" } });
  assert.equal(saveButton(invalid.render()).props.disabled, false);
});

test("a late read from an abandoned page cannot replace the current raw draft", async (t) => {
  const abandoned = deferred();
  let gets = 0;
  const f = fixture(t, { respond: (request) => request.method !== "PUT" && ++gets === 1 ? abandoned.promise : undefined });
  f.render();
  const signal = f.requests[0].signal;
  f.unmount();
  assert.equal(signal.aborted, true);
  let tree = await loaded(f);
  find(tree, "textarea").props.onChange({ target: { value: "  newer page draft  " } });
  abandoned.resolve({ body: { settings: { ...stored, preferences: "stale read" }, models } });
  await flush();
  tree = f.render();
  assert.equal(find(tree, "textarea").props.value, "  newer page draft  ");
  assert.equal(f.draftRef.current.settings.preferences, "  newer page draft  ");
});

test("Chinese copy uses the same page controls and the preferences font is inherited", async (t) => {
  for (const locale of ["zh-CN", "zh-TW"]) {
    const f = fixture(t, { locale });
    const tree = await loaded(f);
    assert.match(textOf(tree), /灰字[预預][测測]/);
    const textarea = find(tree, "textarea");
    assert.equal(textarea.props.style.fontFamily, "inherit");
    assert.equal(textarea.props.style.minWidth, 0);
    assert.equal(textarea.props.style.width, "100%");
    assert.equal(textarea.props.style.boxSizing, "border-box");
  }
});

test("the Models sidebar restores suggestions, keeps a parent draft ref and separates its save from models.json", async (t) => {
  const f = fixture(t, { parent: true, remembered: JSON.stringify({ type: "suggestions" }) });
  let tree = await loaded(f);
  const rows = elements(tree, "ConfigSidebarItem");
  assert.equal(textOf(find(rows[0], "ConfigSidebarText")), "voiceSettings.title");
  assert.equal(textOf(find(rows[1], "ConfigSidebarText")), "Prompt suggestions");
  assert.equal(rows[1].props.active, true);
  const detail = find(tree, "PromptSuggestionSettingsDetail");
  assert.equal(detail.props.cwd, "E:/project with spaces/中文");
  assert.equal(find(find(tree, "ConfigFooter"), "ConfigButton", (node) => node.props.variant === "primary"), undefined);
  rows[0].props.onClick();
  tree = f.render();
  assert.equal(JSON.parse(f.remembered).type, "voice");
  elements(tree, "ConfigSidebarItem")[1].props.onClick();
  tree = f.render();
  assert.equal(JSON.parse(f.remembered).type, "suggestions");
  assert.equal(find(tree, "PromptSuggestionSettingsDetail").props.draftRef, detail.props.draftRef);
});
