import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getModelRuntimeWithExtensions } from "./model-runtime";
import { findDeferredModel, withDeferredProviderModels } from "./deferred-provider-models";
import { resolveVisibleModels } from "./model-scope";
import { loadPromptSuggestionPlugin, type SuggestionModelOption } from "./prompt-suggestions-plugin";

/** Session calls use precisely the same enabled-model resolver as foreground selection. */
export async function sessionSuggestionModels(runtime: ModelRuntime, patterns: string[] | undefined) {
  const api = await loadPromptSuggestionPlugin();
  const scope = await resolveVisibleModels(withDeferredProviderModels(runtime), patterns);
  return scope.visible.map((model) => ({ model, option: api.suggestionModelOption(model, getSupportedThinkingLevels(model)) }));
}

/** The settings page reuses /api/models, including its cwd admission and enabled scope. */
export async function promptSuggestionModelOptions(cwd?: string): Promise<SuggestionModelOption[]> {
  // A session's suggestion model lookup must not load the settings route.
  const { GET: getModels } = await import("../app/api/models/route");
  const url = new URL("http://localhost/api/models");
  if (cwd) url.searchParams.set("cwd", cwd);
  const response = await getModels(new Request(url));
  const data = await response.json() as {
    error?: string;
    modelList?: Array<{ provider: string; id: string; name: string }>;
    thinkingLevels?: Record<string, string[]>;
  };
  if (!response.ok) throw new Error(data.error || "读取已启用模型失败。");
  const [runtime, api] = await Promise.all([getModelRuntimeWithExtensions(), loadPromptSuggestionPlugin()]);
  return (data.modelList ?? []).map((entry) => {
    const model = runtime.getModel(entry.provider, entry.id) ?? findDeferredModel(runtime, entry.provider, entry.id);
    const levels = data.thinkingLevels?.[`${entry.provider}:${entry.id}`] ?? ["off"];
    return model ? api.suggestionModelOption(model, levels) : {
      ...entry, thinkingLevels: levels, supported: false,
      unsupportedReason: "该模型尚未加载，重新打开模型设置后再试。",
    };
  });
}
