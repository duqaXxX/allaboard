/**
 * The tools the Claude back end serves a session in-process: one `allaboard` server per session,
 * one tool per action the core allowed (`DaemonActions`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAEMON_SERVER,
  daemonServer,
  daemonTools,
} from "../../../src/agent/claude/daemon-tools.ts";
import type { DaemonActions } from "../../../src/agent/seam.ts";

const SIGNAL = new AbortController().signal;

test("no member of the actions gives no tool and no server", () => {
  assert.deepEqual(daemonTools({}, SIGNAL), []);
  assert.equal(daemonServer({}, SIGNAL), undefined);
  assert.equal(daemonServer(undefined, SIGNAL), undefined);
});

test("share gives one deferred tool with a hint and no annotation", () => {
  const actions: DaemonActions = { share: async () => "done" };
  const [tool, ...others] = daemonTools(actions, SIGNAL);
  assert.deepEqual(others, []);
  assert.equal(tool?.name, "share_file");
  assert.ok(tool?.description.length);
  // Deferred behind tool search, and the permission flow is the agent's own (invariant 2).
  assert.equal(tool?.annotations, undefined);
  assert.equal(tool?._meta?.["anthropic/alwaysLoad"], undefined);
  assert.ok(tool?._meta?.["anthropic/searchHint"]);
  const server = daemonServer(actions, SIGNAL);
  assert.equal(server?.type, "sdk");
  assert.equal(server?.name, DAEMON_SERVER);
  assert.equal(DAEMON_SERVER, "allaboard");
});

test("the handler passes the path and the signal and returns the line as text", async () => {
  const seen: unknown[] = [];
  const actions: DaemonActions = {
    share: async (path, signal) => {
      seen.push(path, signal);
      return "shared it";
    },
  };
  const [tool] = daemonTools(actions, SIGNAL);
  const result = await tool?.handler({ path: "src/a.ts" }, {});
  assert.deepEqual(seen, ["src/a.ts", SIGNAL]);
  assert.deepEqual(result, { content: [{ type: "text", text: "shared it" }] });
});

test("a throw is an error result with a generic line, never the error's words", async () => {
  const actions: DaemonActions = {
    share: async () => {
      throw new Error("secret path /x/y");
    },
  };
  const [tool] = daemonTools(actions, SIGNAL);
  const result = await tool?.handler({ path: "a" }, {});
  assert.equal(result?.isError, true);
  const text = JSON.stringify(result);
  assert.ok(!text.includes("secret"));
  assert.equal(result?.content[0]?.type, "text");
});
