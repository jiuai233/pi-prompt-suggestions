import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readSuggestionSettings, writeSuggestionSettings } from "../plugin/api.mjs";

test("human text imports verbatim, preserves other settings, and an empty file clears preferences", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preference-import-"));
  try {
    const before = await writeSuggestionSettings(dir, { enabled: false, provider: "my-provider", modelId: "my-model", thinkingLevel: "off" });
    const file = join(dir, "human.txt");
    const raw = '  人自己写的偏好\r\n保留 "引号"、换行和尾部空格。  \n';
    const run = () => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./set-preferences.mjs", import.meta.url)), "--agent-dir", dir, "--file", file], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert(!result.stdout.includes("人自己写的偏好"));
    };
    await writeFile(file, raw, "utf8");
    run();
    assert.deepEqual(await readSuggestionSettings(dir), { ...before, preferences: raw });
    await writeFile(file, "", "utf8");
    run();
    assert.equal((await readSuggestionSettings(dir)).preferences, "");
    assert.equal(await readFile(file, "utf8"), "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
