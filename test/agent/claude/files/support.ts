/** The repository lookups of the Claude module's file tests, over its own trust record. */

import { locate, Unkeyed } from "../../../../src/agent/claude/trust.ts";
import type { Repository } from "../../../../src/agent/seam.ts";

export * from "../../../support/files.ts";

/** The repository holding `path`, as the daemon's own lookup finds it. */
export async function repository(path: string): Promise<Repository> {
  const found = await locate(path);
  if (found === null) throw new Error(`no repository at ${path}`);
  return found;
}

/** `trustedRepository` for a test about something else: every repository counts as trusted. */
export async function anyRepository(directory: string): Promise<Repository | null> {
  try {
    return await locate(directory);
  } catch (error) {
    if (error instanceof Unkeyed) return null;
    throw error;
  }
}
