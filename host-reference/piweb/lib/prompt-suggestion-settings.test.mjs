import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const previousRoot = process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT;
process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT = fileURLToPath(new URL("../../../../plugins/prompt-suggestions", import.meta.url));
after(() => {
  if (previousRoot === undefined) delete process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT;
  else process.env.PI_PROMPT_SUGGESTIONS_UNIT_ROOT = previousRoot;
});
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { readPromptSuggestionsEnabled, writePromptSuggestionsEnabled, subscribePromptSuggestionsEnabled, writePromptSuggestionSettings, readPromptSuggestionSettings } = await jiti.import("./prompt-suggestion-settings.ts");

test("legacy Web boolean migrates to the plugin config without modifying main settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-prompt-suggestion-settings-"));
  const file = join(dir, "settings.json");
  try {
    assert.equal(await readPromptSuggestionsEnabled(file), false);
    for (const value of ["true", 1, null, false, true]) {
      await writeFile(file, JSON.stringify({ promptSuggestionsEnabled: value, defaultModel: "main" }));
      assert.equal(await readPromptSuggestionsEnabled(file), value === true);
    }
    const changes = [];
    const stop = subscribePromptSuggestionsEnabled((value) => changes.push(value), file);
    await writePromptSuggestionsEnabled(false, file);
    assert.equal(await readPromptSuggestionsEnabled(file), false);
    stop();
    await writePromptSuggestionsEnabled(true, file);
    assert.deepEqual(changes, [false]);
    const preferences = "  用户自己写的\n原样保留~  ";
    await writePromptSuggestionSettings({ preferences }, file);
    assert.equal((await readPromptSuggestionSettings(file)).preferences, preferences);
    assert.equal(await readPromptSuggestionsEnabled(file), true);
    assert.equal(JSON.parse(await readFile(file, "utf8")).defaultModel, "main");
    assert.equal(JSON.parse(await readFile(join(dir, "prompt-suggestions.json"), "utf8")).preferences, preferences);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
