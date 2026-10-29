/**
 * Step 12 of the scenario the memory chat carries: `!rewind` in a session's thread. The owner
 * lists the prompts, picks the first, restores the conversation and the code, and the replies he
 * went back over stay in the thread folded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";
import { say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

test("!rewind goes back to the first prompt: code and conversation, the replies folded", async (t) => {
  const world = World.make(t, { rewind: true });
  await world.start();
  world.store.writeFile(world.folder, "notes.txt", "one");
  world.script(say("Done the first."));
  const thread = await world.open("write the first note");
  await world.ended(thread);
  world.store.writeFile(world.folder, "notes.txt", "two");
  world.script(say("Done the second."));
  await world.owner.says(world.channel, "change it", { thread });
  await world.ended(thread, 2);

  await world.owner.says(world.channel, "!rewind", { thread });
  const [points] = world.chat.threadLists();
  assert.equal(points?.list.type, "rewind-points");
  assert.ok(points);
  // Newest first: the oldest prompt is the list's last.
  const first = points.list.type === "rewind-points" ? points.list.points.at(-1)?.id : undefined;
  assert.ok(first);
  assert.equal(await world.owner.picksPoint(points.message, first), true);

  const [actions] = world.chat.threadLists();
  assert.equal(actions?.list.type, "rewind-actions");
  assert.ok(actions);
  assert.equal(await world.owner.picksAction(actions.message, "both"), true);
  await world.until(
    () => world.chat.messages(world.channel, thread).filter((m) => m.inside !== null).length === 2,
    "both replies folded",
  );

  assert.equal(world.store.file(world.folder, "notes.txt"), "one");
  assert.equal(world.plain.starts.at(-1)?.rewindTo, first);
  const kept = world.chat.messages(world.channel, thread).filter((m) => m.inside !== null);
  assert.deepEqual(
    kept.map((m) => m.text),
    [texts.REWOUND_TITLE, texts.REWOUND_TITLE],
  );
  assert.ok(world.shown(thread).includes("write the first note"), "the prompt is posted again");
  assert.deepEqual(
    world.prompts(),
    ["write the first note", "change it"],
    "the rewind sent the agent no prompt",
  );
  await world.finish();
});

test("!rewind in a world whose agent cannot go back is not offered", async (t) => {
  const world = World.make(t);
  await world.start();
  world.script(say("Hello."));
  const thread = await world.open("hello");
  await world.ended(thread);
  await world.owner.says(world.channel, "!rewind", { thread });
  assert.deepEqual(world.chat.threadLists(), []);
  await world.finish();
});
