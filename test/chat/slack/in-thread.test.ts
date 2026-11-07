/**
 * `postInThread`: a post into a thread whose first message is gone lands in the channel instead
 * (measured 2026-11-07, #221: `ok: true` with no `thread_ts` on the message). The post is deleted
 * at once and the call fails as `gone`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebClient } from "@slack/web-api";
import { ChatError } from "../../../src/chat/seam.ts";
import { postInThread } from "../../../src/chat/slack/notice.ts";
import { setLevel, setWriter } from "../../../src/log.ts";
import { rejected } from "../../support/fake-slack.ts";

interface Calls {
  readonly deleted: Array<{ channel: string; ts: string }>;
}

/** What `conversations.replies` does for the root: `thread_not_found`, a tombstone-free root, or a failure. */
type Root = "gone" | "there" | "fails";

function client(
  answer: Record<string, unknown>,
  deleteFails = false,
  root: Root = "gone",
): [WebClient, Calls] {
  const calls: Calls = { deleted: [] };
  const slack = {
    conversations: {
      replies: async () => {
        if (root === "gone") throw rejected("thread_not_found");
        if (root === "fails") throw new Error("boom");
        return { ok: true, messages: [{ ts: "1.0" }] };
      },
    },
    chat: {
      postMessage: async () => ({ ok: true, ...answer }),
      delete: async (args: { channel: string; ts: string }) => {
        calls.deleted.push(args);
        if (deleteFails) throw new Error("message_not_found");
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  return [slack, calls];
}

const ARGS = { channel: "C1", thread_ts: "1.0", text: "hi" };

test("a post that Slack placed in the thread is returned as it came", async () => {
  const [slack, calls] = client({ ts: "2.0", message: { thread_ts: "1.0" } });
  const posted = await postInThread(slack, ARGS);
  assert.equal(posted.ts, "2.0");
  assert.deepEqual(calls.deleted, []);
});

test("a post that landed outside the thread is deleted and fails as gone", async () => {
  const [slack, calls] = client({ ts: "2.0", message: { type: "message" } });
  const failure = await postInThread(slack, ARGS).catch((error: unknown) => error);
  assert.ok(failure instanceof ChatError);
  assert.equal(failure.failure, "gone");
  assert.equal(failure.permanent, true);
  assert.equal(failure.name, "thread_gone");
  assert.deepEqual(calls.deleted, [{ channel: "C1", ts: "2.0" }]);
});

test("a failed delete of the stray post is logged, and the call still fails as gone", async (t) => {
  const lines: string[] = [];
  const previous = setWriter((line) => lines.push(line));
  t.after(() => setWriter(previous));
  setLevel("WARNING");
  const [slack] = client({ ts: "2.0", message: {} }, true);
  const failure = await postInThread(slack, ARGS).catch((error: unknown) => error);
  assert.ok(failure instanceof ChatError);
  assert.equal(failure.failure, "gone");
  assert.ok(lines.some((line) => line.includes("stray")));
});

test("a post with no thread_ts is kept when the root is there or the lookup fails", async (t) => {
  const lines: string[] = [];
  const previous = setWriter((line) => lines.push(line));
  t.after(() => setWriter(previous));
  setLevel("WARNING");
  for (const root of ["there", "fails"] as const) {
    const [slack, calls] = client({ ts: "2.0", message: {} }, false, root);
    const posted = await postInThread(slack, ARGS);
    assert.equal(posted.ts, "2.0", root);
    assert.deepEqual(calls.deleted, [], root);
  }
  assert.equal(lines.filter((line) => line.includes("kept")).length, 2);
});
