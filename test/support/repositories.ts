/**
 * A folder's repository as an agent that trusts every folder would hand it to the core: the
 * nearest folder at or above it that holds a `.git` directory. It knows no worktree, no gitfile
 * and no bare layout; the tests of those are the Claude module's (`test/agent/claude/`).
 */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Repository } from "../../src/agent/seam.ts";

/** The repository holding `directory`, null outside git and for a folder that is not there. */
export async function repositoryAt(directory: string): Promise<Repository | null> {
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return null;
  for (let folder = directory; ; folder = dirname(folder)) {
    const entry = join(folder, ".git");
    try {
      if (statSync(entry).isDirectory()) {
        return { root: folder, key: folder, gitDir: entry, insideGitDir: false };
      }
    } catch {
      // No entry here: look in the parent.
    }
    if (dirname(folder) === folder) return null;
  }
}
