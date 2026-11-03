import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SuggestionCommandOptions } from "../../../../plugins/prompt-suggestions/api.mjs";
import { loadPromptSuggestionPlugin } from "./prompt-suggestions-plugin";
import { promptSuggestionModelOptions } from "./prompt-suggestion-models";

export function isPromptSuggestionCommand(message: string): boolean {
  return /^\/suggestions(?:\s|$)/i.test(message.trim());
}

/** Host command: never enters the model transcript or foreground run queue. */
export async function runPromptSuggestionCommand(
  message: string,
  options: Partial<SuggestionCommandOptions> & { cwd?: string } = {},
): Promise<string> {
  const api = await loadPromptSuggestionPlugin();
  return api.runSuggestionCommand(message, {
    agentDir: options.agentDir ?? getAgentDir(),
    getModels: options.getModels ?? (() => promptSuggestionModelOptions(options.cwd)),
    ui: options.ui,
    overrides: options.overrides,
  });
}
