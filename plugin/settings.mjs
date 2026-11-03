import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { DEFAULT_PREFERENCES } from "./preferences.mjs";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_SETTINGS = Object.freeze({ enabled: false, provider: "xai", modelId: "grok-4.7", thinkingLevel: "low", preferences: DEFAULT_PREFERENCES });
const channels = globalThis[Symbol.for("pi.prompt-suggestions.settings.v1")] ??= new Map();
function channel(agentDir) {
  let state = channels.get(agentDir);
  if (!state) { state = { listeners: new Set(), pending: Promise.resolve() }; channels.set(agentDir, state); }
  return state;
}
export const suggestionSettingsPath = (agentDir) => join(agentDir, "prompt-suggestions.json");

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export function normalizeSuggestionSettings(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("灰字预测设置必须是对象。");
  const result = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in value)) continue;
    if (typeof value[key] !== typeof DEFAULT_SETTINGS[key]) throw new Error(`灰字预测设置 ${key} 的类型不正确。`);
    result[key] = value[key];
  }
  if (!THINKING_LEVELS.includes(result.thinkingLevel)) throw new Error("请选择有效的推理档位。");
  result.provider = result.provider.trim();
  result.modelId = result.modelId.trim();
  if (!result.provider || !result.modelId) throw new Error("请选择预测模型。");
  return result; // preferences deliberately retains every character, including whitespace.
}

export async function readSuggestionSettings(agentDir) {
  const stored = await readJson(suggestionSettingsPath(agentDir));
  if (stored !== undefined) return normalizeSuggestionSettings(stored);
  // Read the old Web switch only until the first save creates the plugin file.
  const legacy = await readJson(join(agentDir, "settings.json"));
  return { ...DEFAULT_SETTINGS, enabled: legacy?.promptSuggestionsEnabled === true };
}

export function subscribeSuggestionSettings(agentDir, listener) {
  const { listeners } = channel(agentDir);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function writeSuggestionSettings(agentDir, patch) {
  const state = channel(agentDir);
  const operation = async () => {
    await mkdir(agentDir, { recursive: true });
    const file = suggestionSettingsPath(agentDir);
    // The queue orders local notifications; only this filesystem lock protects
    // the read/merge/write against other Web/TUI processes. realpath:false also
    // permits the first save, before the settings file exists.
    const release = await lockfile.lock(file, {
      realpath: false, retries: { retries: 10, minTimeout: 10, maxTimeout: 1000 },
    });
    let settings;
    try {
      settings = normalizeSuggestionSettings({ ...await readSuggestionSettings(agentDir), ...patch });
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
      }
    } finally {
      await release();
    }
    for (const listener of state.listeners) listener(settings);
    return settings;
  };
  const next = state.pending.then(operation, operation);
  state.pending = next;
  return next;
}
