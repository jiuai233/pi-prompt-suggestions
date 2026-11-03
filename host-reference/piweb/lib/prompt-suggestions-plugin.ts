import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveUnit } from "../../../../control/core/src/units.mjs";
import type * as SuggestionApi from "../../../../plugins/prompt-suggestions/api.mjs";

export type PromptSuggestionPlugin = typeof SuggestionApi;
export type { SuggestionSettings, SuggestionModelOption } from "../../../../plugins/prompt-suggestions/api.mjs";

/** Same managed-unit loader as voice: the Web bundle does not embed plugin code. */
export async function loadPromptSuggestionPlugin({
  unitRoot = process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT,
}: { unitRoot?: string } = {}): Promise<PromptSuggestionPlugin> {
  const resolved = unitRoot
    ? { root: unitRoot, unit: JSON.parse(await readFile(path.join(unitRoot, "unit.json"), "utf8")) }
    : resolveUnit("plugin.prompt-suggestions", { "prompt-suggestions-api": [1] });
  if (resolved.unit.id !== "plugin.prompt-suggestions" || resolved.unit.provides?.["prompt-suggestions-api"] !== 1) {
    throw new Error("plugin.prompt-suggestions requires prompt-suggestions-api version 1");
  }
  const entry = pathToFileURL(path.join(resolved.root, "api.mjs")).href;
  const api = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ entry);
  if (api.apiVersion !== 1) throw new Error("Unsupported prompt-suggestions Node API version");
  return api as PromptSuggestionPlugin;
}
