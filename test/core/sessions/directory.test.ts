import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBackend, Repository } from "../../../src/agent/seam.ts";
import { trustedBy, verdictBy } from "../../../src/core/sessions/directory.ts";

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

/** A back end that keeps a record of trust, with the two lookups `verdictBy` reads. */
function trusting(
  untrusted: (folder: string) => Promise<Repository | null>,
  trusted: (folder: string) => Promise<Repository | null> = async () => null,
) {
  return {
    capabilities: { folderTrust: true },
    trustedRepository: trusted,
    untrustedRepository: untrusted,
  } as unknown as AgentBackend;
}

const REPOSITORY: Repository = {
  root: "/work",
  key: "/work",
  gitDir: "/work/.git",
  insideGitDir: false,
};

test("the verdict is untrusted where only the trust is missing", async () => {
  const verdict = await verdictBy(trusting(async () => REPOSITORY))("/work");
  assert.deepEqual(verdict, { untrusted: REPOSITORY });
});

test("a repository with no git dir is never reported as not trusted", async () => {
  const bare = { ...REPOSITORY, gitDir: null };
  assert.equal(await verdictBy(trusting(async () => bare))("/work"), null);
});

test("a trust lookup that throws reads as no verdict", async () => {
  const failing = trusting(async () => {
    throw new Error("lookup failed");
  });
  assert.equal(await verdictBy(failing)("/work"), null);
});

test("an agent with no record of trust never gives a verdict", async () => {
  const none = { capabilities: { folderTrust: false } } as unknown as AgentBackend;
  assert.equal(await verdictBy(none)("/work"), null);
});
