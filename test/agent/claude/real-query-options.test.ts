/**
 * The options `ClaudeSession` builds, through the SDK's real `query()`: it refuses a pair it does
 * not support at the call (measured on 0.3.316, 2026-11-01), which a fake `query()` never does.
 * Aborted before the call: the bundled CLI starts and stops, no request reaches a model and no
 * login or token is needed. A fresh start only: a resume's options are not passed here.
 */
import { tmpdir } from "node:os";
import { test } from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type SessionConfig } from "../../../src/agent/claude/session.ts";

const CONFIG: SessionConfig = {
  folder: tmpdir(),
  resume: null,
  settingsSources: ["user", "project", "local"],
  model: null,
  effort: null,
  chrome: false,
};

test("the real query() takes the options a new thread's session is started with", async () => {
  const aborted = new AbortController();
  aborted.abort();
  // The constructor makes the call: a refusal throws here.
  const session = new ClaudeSession(
    CONFIG,
    (async () => ({})) as never,
    ((call: Parameters<typeof query>[0]) =>
      query({
        prompt: call.prompt,
        options: { ...call.options, abortController: aborted },
      })) as typeof query,
  );
  await session.close();
});
