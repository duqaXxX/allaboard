import type { ModelInfo } from "../agent/seam.ts";
import { DEFAULT } from "./setup.ts";

/**
 * How the agent's own model list names the model with this full id: its display name, or the id
 * itself when the list does not hold it. The `default` entry is skipped, since it stands for
 * whichever model the agent picks and not for one of its own.
 */
export function modelName(models: readonly ModelInfo[], id: string): string {
  const listed = models.find((m) => m.value !== DEFAULT && m.resolvedModel === id);
  return listed === undefined ? id : listed.displayName;
}

/**
 * How the list names the model a setting gives as an alias the list holds by value (`opus`) or
 * as a full id; the setting itself when the list holds neither.
 */
export function settingName(models: readonly ModelInfo[], setting: string): string {
  const listed = models.find((m) => m.value !== DEFAULT && m.value === setting);
  return listed === undefined ? modelName(models, setting) : listed.displayName;
}
