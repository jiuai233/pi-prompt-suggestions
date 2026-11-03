import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";

export const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const suggestionThreadPath = (agentDir, sessionId) => join(agentDir, "prompt-suggestions", "threads", `${fingerprint(sessionId)}.json`);

/** Only the same prediction thread is serialized, never the global settings file. */
export async function withSuggestionThread(agentDir, sessionId, run, signal = AbortSignal.timeout(20_000)) {
  const file = suggestionThreadPath(agentDir, sessionId);
  await mkdir(join(agentDir, "prompt-suggestions", "threads"), { recursive: true });
  let compromised;
  let release;
  // proper-lockfile's built-in retry cannot be aborted; use the caller's lifetime instead.
  for (;;) {
    signal.throwIfAborted();
    try {
      release = await lockfile.lock(file, {
        realpath: false, stale: 60_000, update: 10_000,
        onCompromised(error) { compromised = error; },
      });
      break;
    } catch (error) {
      if (error.code !== "ELOCKED") throw error;
      await delay(100, undefined, { signal });
    }
  }
  try {
    let state;
    try { state = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return await run(state, async (next, isCurrent = () => true) => {
      if (compromised) throw compromised;
      if (!isCurrent()) return;
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
        if (compromised) throw compromised;
        if (!isCurrent()) return;
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
      }
    });
  } finally { if (!compromised) await release(); }
}
