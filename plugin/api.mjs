import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { generateSuggestion, supportsSuggestion } from "./core.mjs";
import { readSuggestionSettings, writeSuggestionSettings } from "./settings.mjs";
export { buildCompactedSuggestionContext, buildSuggestionMessages, generateSuggestion, supportsPersistentSuggestion, supportsSuggestion } from "./core.mjs";
export { DEFAULT_PREFERENCES } from "./preferences.mjs";
export { DEFAULT_SETTINGS, normalizeSuggestionSettings, readSuggestionSettings, subscribeSuggestionSettings, suggestionSettingsPath, THINKING_LEVELS, writeSuggestionSettings } from "./settings.mjs";
export const apiVersion = 1;

export function validatePredictionSelection(settings, models) {
  const choice = models.find((model) => model.provider === settings.provider && model.id === settings.modelId);
  if (!choice) throw new Error("预测模型未启用，请从已启用模型中选择。");
  if (!choice.supported) throw new Error(choice.unsupportedReason || "该模型暂不支持独立灰字预测。");
  if (choice.thinkingLevels.length && !choice.thinkingLevels.includes(settings.thinkingLevel)) throw new Error("当前模型不支持所选推理档位，请重新选择。");
  return choice;
}

export function suggestionModelOption(model, thinkingLevels) {
  const supported = supportsSuggestion(model);
  return { provider: model.provider, id: model.id, name: model.name || model.id, thinkingLevels, supported,
    ...(!supported ? { unsupportedReason: "该模型使用原生会话，暂未接入独立灰字预测。" } : {}),
  };
}

async function recordOutcome(agentDir, record) {
  if (!agentDir) return;
  try {
    const directory = join(agentDir, "logs");
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "prompt-suggestions.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    // A logging failure must not discard an otherwise usable candidate.
    console.error("[prompt-suggestions] outcome log failed:", error);
  }
}

/** Shared lifecycle; adapters only supply their editor and current-session check. */
export class SuggestionController {
  text = null;
  controller = null;
  key = null;
  constructor(onChange, onError = () => {}) { this.onChange = onChange; this.onError = onError; }
  clear() {
    this.controller?.abort("no_longer_needed");
    this.controller = null;
    this.key = null;
    if (this.text !== null) { this.text = null; this.onChange(null); }
  }
  start(request) {
    if (!request.enabled) { this.clear(); return; }
    const key = JSON.stringify([request.model.provider, request.model.id, request.revision, request.thinkingLevel, request.preferences]);
    if (key === this.key) return;
    this.clear();
    this.key = key;
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = Date.now();
    // Resource budget, not a diagnosis that a slow provider has failed.
    const timer = setTimeout(() => controller.abort("budget_exhausted"), 120_000);
    timer.unref?.();
    let outcome, reason, errorMessage, usage = null, modelRequests = 0;
    const complete = async (...args) => {
      modelRequests++;
      const response = await request.complete(...args);
      // Failed/aborted SDK responses may contain only an all-zero usage placeholder.
      if (response.usage && (!["error", "aborted"].includes(response.stopReason) || response.usage.totalTokens > 0)) usage = response.usage;
      return response;
    };
    return generateSuggestion({ ...request, complete, signal: controller.signal }).then(({ text }) => {
      if (controller.signal.aborted || this.controller !== controller || !request.isCurrent()) {
        outcome = "cancelled";
        reason = controller.signal.aborted ? controller.signal.reason : "no_longer_needed";
        return;
      }
      outcome = text === null ? "empty" : "success";
      this.text = text;
      this.onChange(text);
    }).catch((error) => {
      if (controller.signal.aborted) {
        outcome = "cancelled";
        reason = controller.signal.reason;
      } else {
        outcome = "error";
        errorMessage = error instanceof Error ? error.message : String(error);
        if (this.controller === controller) this.onError(error);
      }
    }).finally(async () => {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
      await recordOutcome(request.agentDir, {
        at: new Date().toISOString(), sessionId: request.sessionId, revision: request.revision,
        model: `${request.model.provider}/${request.model.id}`, elapsedMs: Date.now() - startedAt,
        outcome, reason, error: errorMessage, modelRequests, usage,
      });
    });
  }
}

/** The same / command implementation is used by TUI and Web. */
export async function runSuggestionCommand(message, { agentDir, getModels, ui, overrides = {} }) {
  const input = message.trim().replace(/^\/suggestions(?:\s|$)/i, "");
  const space = input.search(/\s/);
  const action = (space < 0 ? input : input.slice(0, space)).toLowerCase();
  const argument = space < 0 ? "" : input.slice(space).trim();
  const current = { ...await readSuggestionSettings(agentDir), ...overrides };
  const save = async (patch) => {
    const next = await writeSuggestionSettings(agentDir, patch);
    for (const key of Object.keys(patch)) delete overrides[key];
    return next;
  };
  if (!action || action === "status") return `灰字预测：${current.enabled ? "开启" : "关闭"} · ${current.provider}/${current.modelId} · ${current.thinkingLevel}`;
  if (action === "on" || action === "off") {
    if (action === "on") validatePredictionSelection(current, await getModels());
    await save({ enabled: action === "on" });
    return action === "on" ? "灰字预测已开启，下一次对话结束且空闲后生成。" : "灰字预测已关闭。";
  }
  if (action === "model") {
    const models = await getModels();
    const available = models.filter((model) => model.supported);
    const selected = argument || await ui?.select("选择灰字预测模型", available.map((model) => `${model.provider}/${model.id}`));
    if (selected === undefined) return "未更改预测模型。";
    const model = available.find((model) => `${model.provider}/${model.id}` === selected);
    if (!model) throw new Error("请选择已启用且支持灰字预测的模型。");
    const thinkingLevel = model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels.includes("low") ? "low" : model.thinkingLevels[0] ?? "off";
    await save({ provider: model.provider, modelId: model.id, thinkingLevel });
    return `预测模型已保存：${selected} · ${thinkingLevel}。`;
  }
  if (action === "thinking") {
    const models = await getModels();
    const model = models.find((item) => item.provider === current.provider && item.id === current.modelId);
    if (!model) throw new Error("请先选择已启用的预测模型。");
    const selected = argument || await ui?.select("选择预测推理档位", model.thinkingLevels);
    if (selected === undefined) return "未更改推理档位。";
    if (!model.thinkingLevels.includes(selected)) throw new Error("当前模型不支持所选推理档位。");
    await save({ thinkingLevel: selected });
    return `预测推理档位已保存：${selected}。`;
  }
  if (action === "preferences" || action === "profile") {
    const text = argument === "clear" ? "" : argument || await ui?.editor("用户偏好原文", current.preferences);
    if (text === undefined) return "未更改用户偏好。";
    await save({ preferences: text });
    return "用户偏好已保存，下一次预测生效。";
  }
  return "用法：/suggestions on|off|status|model [provider/model]|thinking [档位]|preferences";
}
