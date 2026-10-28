import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackend } from "../../../src/agent/seam.ts";
import { trustedBy } from "../../../src/core/sessions/directory.ts";

/** Only what `trustedBy` reads of a back end. */
function agent(folderTrust: boolean, folderTrusted?: (folder: string) => Promise<boolean>) {
  return { capabilities: { folderTrust }, folderTrusted } as unknown as AgentBackend;
}

test("an agent with no record of trust trusts every folder", async () => {
  assert.equal(await trustedBy(agent(false))("/work"), true);
});

test("an agent that keeps a record answers for each folder", async () => {
  const trusted = trustedBy(agent(true, async (folder) => folder === "/work"));
  assert.equal(await trusted("/work"), true);
  assert.equal(await trusted("/other"), false);
});

test("an agent that declares a record but no lookup trusts no folder", async () => {
  assert.equal(await trustedBy(agent(true))("/work"), false);
});
