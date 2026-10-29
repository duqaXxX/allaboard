/** ThreadTitle over a state file and a chat and an agent that are a few functions each. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentBackend } from "../../../src/agent/seam.ts";
import { ChatError, type ChatProvider } from "../../../src/chat/seam.ts";
import { logger, ThreadTitle } from "../../../src/core/sessions/title.ts";
import { StateStore } from "../../../src/core/state.ts";

const CHANNEL = "chan-1";
const THREAD = "thread-1";

type Keep = ((text: string) => void | Promise<void>) | undefined;

function setup(
  t: { mock: { method: (...args: never[]) => unknown } },
  titleThread: (title: string, keep: Keep) => Promise<void>,
  options: { title?: () => Promise<string | null> } = {},
) {
  (t.mock.method as (o: object, m: string, f: () => void) => unknown)(logger, "warning", () => {});
  const dir = mkdtempSync(join(tmpdir(), "allaboard-title-"));
  const state = new StateStore(join(dir, "state.json"));
  state.bind(CHANNEL, dir);
  state.openThread(CHANNEL, THREAD, "session-1");
  const agent = {
    capabilities: { sessionTitles: true },
    sessionTitle: options.title ?? (async () => "Fix the footer"),
  } as unknown as AgentBackend;
  const chat = {
    capabilities: { threadTitles: true },
    titleThread: async (_ref: unknown, title: string, keep: Keep) => titleThread(title, keep),
  } as unknown as ChatProvider;
  let stopped = false;
  const make = () => new ThreadTitle({ agent, chat, state }, CHANNEL, THREAD, dir, () => stopped);
  return {
    state,
    make,
    stop: () => {
      stopped = true;
    },
  };
}

test("a second session object reading an already titled root keeps nothing over the first", async (t) => {
  let calls = 0;
  let firstKept = () => {};
  const afterFirst = new Promise<void>((resolve) => {
    firstKept = resolve;
  });
  const world = setup(t, async (_title, keep) => {
    calls += 1;
    // Both are handed `keep`: the state held no prompt when each was asked. The chat runs them
    // one after another: the first reads the owner's words, the second the title it wrote.
    if (calls === 1) {
      await keep?.("the owner's words");
      firstKept();
    } else {
      await afterFirst;
      await keep?.("Fix the footer");
    }
  });
  await Promise.all([world.make().refresh(), world.make().refresh()]);
  assert.equal(calls, 2);
  assert.equal(world.state.thread(CHANNEL, THREAD)?.rootPrompt, "the owner's words");
});

test("an edit refused for good after the words were kept clears them: the root still holds them", async (t) => {
  const world = setup(t, async (_title, keep) => {
    await keep?.("the owner's words");
    throw new ChatError("cant_update_message", { permanent: true });
  });
  await world.make().refresh();
  assert.equal(world.state.thread(CHANNEL, THREAD)?.rootPrompt, null);
});

test("a transient refusal after the words were kept keeps them", async (t) => {
  const world = setup(t, async (_title, keep) => {
    await keep?.("the owner's words");
    throw new ChatError("ratelimited");
  });
  await world.make().refresh();
  assert.equal(world.state.thread(CHANNEL, THREAD)?.rootPrompt, "the owner's words");
});

test("a permanent refusal that came before keep clears nothing that was stored earlier", async (t) => {
  const world = setup(t, async () => {
    throw new ChatError("thread_not_found", { permanent: true });
  });
  world.state.setRootPrompt(CHANNEL, THREAD, "earlier words");
  await world.make().refresh();
  assert.equal(world.state.thread(CHANNEL, THREAD)?.rootPrompt, "earlier words");
});

test("a title read that resolves after the stop touches neither the chat nor the state", async (t) => {
  let asked = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const world = setup(
    t,
    async (_title, keep) => {
      asked += 1;
      await keep?.("words");
    },
    {
      title: async () => {
        await gate;
        return "Fix the footer";
      },
    },
  );
  const refreshing = world.make().refresh();
  await new Promise((resolve) => setImmediate(resolve));
  world.stop();
  release();
  await refreshing;
  assert.equal(asked, 0, "no call to the chat");
  assert.equal(world.state.thread(CHANNEL, THREAD)?.rootPrompt, null, "no write");
});

test("a refresh that rejects does not stop the later ones", async (t) => {
  let calls = 0;
  const world = setup(t, async () => {});
  // Clearing the kept words after a refusal for good writes the state file, which can throw (a
  // full disk): the chain of refreshes must not stay rejected and skip every later one.
  let broken = true;
  const clear = world.state.clearRootPrompt.bind(world.state);
  t.mock.method(world.state, "clearRootPrompt", (channel: string, thread: string) => {
    if (broken) throw new Error("disk");
    clear(channel, thread);
  });
  const titles = ["First", "Second"];
  const title = new ThreadTitle(
    {
      agent: {
        capabilities: { sessionTitles: true },
        sessionTitle: async () => titles.shift() ?? null,
      } as unknown as AgentBackend,
      chat: {
        capabilities: { threadTitles: true },
        titleThread: async (_ref: unknown, _title: string, keep: Keep) => {
          calls += 1;
          if (calls === 1) {
            await keep?.("the owner's words");
            throw new ChatError("edit_window_closed", { permanent: true });
          }
        },
      } as unknown as ChatProvider,
      state: world.state,
    },
    CHANNEL,
    THREAD,
    "/work",
  );
  await title.refresh();
  broken = false;
  await title.refresh();
  assert.equal(calls, 2, "the second refresh still reached the chat");
});
