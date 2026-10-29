import type { ModuleWords } from "../../module-setup.ts";

/**
 * What only the Claude module has, declared for `test/vocabulary.test.ts`: the vendor's name,
 * which shows in a package and a path. The SDK's own names are read from `docs/sdk-surface.md`
 * and the agent's commands from `AgentWords`, so none is listed twice.
 */
export const MODULE_WORDS: ModuleWords = {
  names: ["anthropic"],
  literals: [],
  patterns: [],
};
