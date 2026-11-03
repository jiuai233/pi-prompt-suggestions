import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { suggestionSettingsPath, writeSuggestionSettings } from "../plugin/api.mjs";

const { values } = parseArgs({ options: { "agent-dir": { type: "string" }, file: { type: "string" } } });
if (!values["agent-dir"] || !isAbsolute(values["agent-dir"]) || !values.file) {
  throw new Error('Usage: node scripts/set-preferences.mjs --agent-dir "<absolute agentDir>" --file "<UTF-8 preferences file>"');
}
const preferences = await readFile(resolve(values.file), "utf8");
await writeSuggestionSettings(values["agent-dir"], { preferences });
console.log(JSON.stringify({ settingsFile: suggestionSettingsPath(values["agent-dir"]), preferencesCharacters: preferences.length }));
