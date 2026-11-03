import { dirname } from "node:path";
import { getGlobalSettingsPath } from "./global-settings-file";
import { loadPromptSuggestionPlugin, type SuggestionSettings } from "./prompt-suggestions-plugin";

export async function readPromptSuggestionSettings(settingsPath = getGlobalSettingsPath()): Promise<SuggestionSettings> {
  const api = await loadPromptSuggestionPlugin();
  return api.readSuggestionSettings(dirname(settingsPath));
}

export async function writePromptSuggestionSettings(
  patch: Partial<SuggestionSettings>,
  settingsPath = getGlobalSettingsPath(),
): Promise<SuggestionSettings> {
  const api = await loadPromptSuggestionPlugin();
  return api.writeSuggestionSettings(dirname(settingsPath), patch);
}

export async function readPromptSuggestionsEnabled(settingsPath = getGlobalSettingsPath()): Promise<boolean> {
  return (await readPromptSuggestionSettings(settingsPath)).enabled;
}

export async function writePromptSuggestionsEnabled(enabled: boolean, settingsPath = getGlobalSettingsPath()): Promise<boolean> {
  return (await writePromptSuggestionSettings({ enabled }, settingsPath)).enabled;
}

export function subscribePromptSuggestionsEnabled(
  listener: (enabled: boolean) => void,
  settingsPath = getGlobalSettingsPath(),
): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  void loadPromptSuggestionPlugin().then((api) => {
    if (!disposed) unsubscribe = api.subscribeSuggestionSettings(dirname(settingsPath), (settings) => listener(settings.enabled));
  }).catch((error: unknown) => {
    console.error("[prompt-suggestions] settings subscription failed:", error);
  });
  return () => { disposed = true; unsubscribe?.(); };
}
