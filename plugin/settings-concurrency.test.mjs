import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

if (process.argv[2] === "--settings-child") {
  const [dir, patch] = process.argv.slice(3);
  const file = join(dir, "prompt-suggestions.json");
  // Pause the actual read result, not a copy of the merge algorithm. A second
  // process must hit the real lock while the first holds this read barrier.
  const originalRead = fs.promises.readFile;
  fs.promises.readFile = async (...args) => {
    const value = await originalRead(...args);
    if (String(args[0]) === file) {
      process.send({ type: "read-ready", pid: process.pid, settings: JSON.parse(value) });
      await once(process, "message");
    }
    return value;
  };
  const originalMkdir = fs.mkdir;
  fs.mkdir = (...args) => {
    const callback = args.pop();
    return originalMkdir(...args, (error, ...values) => {
      if (String(args[0]) === `${file}.lock` && error?.code === "EEXIST") {
        process.send({ type: "lock-busy", pid: process.pid, code: error.code });
      }
      callback(error, ...values);
    });
  };
  syncBuiltinESMExports();
  const { writeSuggestionSettings } = await import("./settings.mjs");
  process.send({ type: "ready", pid: process.pid });
  await once(process, "message");
  const settings = await writeSuggestionSettings(dir, JSON.parse(patch));
  process.send({ type: "saved", pid: process.pid, settings });
  process.disconnect();
} else {
  test("two independent processes serialize the real read/merge/write and preserve different patches", { timeout: 20000 }, async (t) => {
    const { readSuggestionSettings, writeSuggestionSettings } = await import("./settings.mjs");
    const dir = await mkdtemp(join(tmpdir(), "pi-suggestions-processes-"));
    const children = [];
    const aborted = new Promise((_, reject) => {
      t.signal.addEventListener("abort", () => reject(t.signal.reason), { once: true });
    });
    try {
      const accountFile = join(dir, "settings.json");
      const account = '{"defaultModel":"foreground","promptSuggestionsEnabled":false}\n';
      await writeFile(accountFile, account);
      await writeSuggestionSettings(dir, { preferences: "initial", thinkingLevel: "low" });
      const spawn = (patch) => {
        const child = fork(fileURLToPath(import.meta.url), ["--settings-child", dir, JSON.stringify(patch)], {
          execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const messages = [];
        let wake;
        let output = "";
        child.stdout.on("data", (data) => { output += data; });
        child.stderr.on("data", (data) => { output += data; });
        const exited = once(child, "exit");
        child.on("message", (message) => {
          t.diagnostic(JSON.stringify(message));
          messages.push(message);
          wake?.();
        });
        const next = async (types) => {
          for (;;) {
            const index = messages.findIndex((message) => types.includes(message.type));
            if (index >= 0) return messages.splice(index, 1)[0];
            await Promise.race([
              new Promise((resolve) => { wake = resolve; }),
              exited.then(([code]) => { throw new Error(`Child exited before ${types}: ${code}\n${output}`); }),
              aborted,
            ]);
          }
        };
        const result = { child, exited, next, output: () => output };
        children.push(result);
        return result;
      };
      const first = spawn({ preferences: "new-preferences" });
      const second = spawn({ thinkingLevel: "high" });
      const ready = await Promise.all(children.map((child) => child.next(["ready"])));
      assert.notEqual(ready[0].pid, ready[1].pid);
      first.child.send({ type: "start" });
      await first.next(["read-ready"]);
      second.child.send({ type: "start" });
      const blocked = await second.next(["lock-busy", "read-ready"]);
      assert.equal(blocked.type, "lock-busy", "second process must not read a stale snapshot while first holds the read barrier");
      first.child.send({ type: "release-read" });
      await first.next(["saved"]);
      const secondRead = await second.next(["read-ready"]);
      assert.equal(secondRead.settings.preferences, "new-preferences");
      second.child.send({ type: "release-read" });
      await second.next(["saved"]);
      for (const child of children) {
        const [code, signal] = await child.exited;
        assert.equal(code, 0, child.output());
        assert.equal(signal, null);
      }
      const final = await readSuggestionSettings(dir);
      assert.equal(final.preferences, "new-preferences");
      assert.equal(final.thinkingLevel, "high");
      assert.equal(final.enabled, false);
      t.diagnostic(`final=${JSON.stringify(final)}`);
      // A normal save after contention also proves that both locks were released.
      await writeSuggestionSettings(dir, { enabled: true });
      assert.deepEqual(await readSuggestionSettings(dir), { ...final, enabled: true });
      assert.equal(await readFile(accountFile, "utf8"), account);
      assert.equal(fs.existsSync(join(dir, "prompt-suggestions.json.lock")), false);
      t.diagnostic("normal save succeeded; account settings unchanged; lock removed");
    } finally {
      await Promise.all(children.map(async ({ child, exited }) => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
      }));
      await rm(dir, { recursive: true, force: true });
      t.diagnostic(`fixture_removed=${!fs.existsSync(dir)}`);
    }
  });
}
