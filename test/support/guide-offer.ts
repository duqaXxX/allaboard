/** What `!guide` is told when the agent and the chat declare every capability, as Claude and Slack do. */
import type { GuideOffer } from "../../src/core/guide.ts";

export const EVERYTHING_OFFERED: GuideOffer = {
  folderTrust: true,
  models: true,
  efforts: true,
  bypass: true,
  plan: true,
  commands: true,
  questions: true,
  backgroundTasks: true,
  sessionListing: true,
  loadedContext: true,
  forks: true,
  fileUpload: true,
  diff: true,
  threadTags: true,
  threadDelete: true,
  shell: true,
  updates: true,
};
