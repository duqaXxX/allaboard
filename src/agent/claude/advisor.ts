/**
 * The advisor a session works with: Claude Code's `advisorModel` setting, which `/advisor` writes
 * to the owner's user settings and every running session reloads (measured 2026-10-28, Claude
 * Code 2.1.312), so it is read again each time it is shown.
 */
import { resolveSettings as sdkResolveSettings } from "@anthropic-ai/claude-agent-sdk";
import type { SettingsSource } from "../seam.ts";

/** The SDK's `resolveSettings` as this module calls it: a test passes a fake. */
export type ResolveSettings = (options: {
  cwd: string;
  settingSources: SettingsSource[];
}) => Promise<{ effective: { advisorModel?: string; env?: Record<string, string> } }>;

// "`CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` makes the command unavailable", and the setting "can't
// turn it back on" (advisor page and settings reference, read 2026-10-28). The values read as on
// are those of Claude Code's own test of a variable (`sdk.mjs` 0.3.312).
const DISABLE = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * The advisor model set for a session in `folder` with `sources`, as the settings name it; null
 * when none is set or `env` (the session's environment, under the settings' own `env`) turns
 * the tool off. Whether the model ranks high enough to advise the main one is not known here.
 */
export async function advisorModel(
  folder: string,
  sources: readonly SettingsSource[],
  env: Readonly<Record<string, string | undefined>>,
  resolve: ResolveSettings = sdkResolveSettings,
): Promise<string | null> {
  const { effective } = await resolve({ cwd: folder, settingSources: [...sources] });
  const disabled = effective.env?.[DISABLE] ?? env[DISABLE];
  if (disabled !== undefined && TRUTHY.has(disabled.trim().toLowerCase())) return null;
  const model = effective.advisorModel;
  return typeof model === "string" && model !== "" ? model : null;
}
