/** Scratch folders for tests that have no hook of their own: removed when the test process exits. */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = new Set<string>();

process.once("exit", () => {
  for (const dir of made) {
    // One folder still held (Windows) must not keep the others: the suite's runner counts what is left.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  }
});

/** Creates a folder under the temp directory and registers its removal at the end of the process. */
export function tempDirSync(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}

/** The asynchronous twin of `tempDirSync`. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}
