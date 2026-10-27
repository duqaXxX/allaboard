/**
 * `!terminal` while a `!!` command runs: the command is stopped with the move, and no process
 * of the daemon's takes the session back when it ends (found by review, 2026-10-27).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

test("!terminal while a !! command runs leaves no daemon process on the session", async (t) => {
  const world = World.make(t, { shell: true });
  await world.start();
  world.script(say("Hello."));
  const thread = await world.open("hello");
  await world.ended(thread);
  const startsBefore = world.entry.built.flatMap((a) => a.sessions).length;

  const sending = world.owner.says(world.channel, "!!sleep 2; echo done", { thread });
  const asked = await world.request("shell", thread);
  world.script(say("Saw the shell output."));
  await world.owner.answers(asked.requestId, { type: "shell", run: true });
  await sending;
  await new Promise((r) => setTimeout(r, 300)); // the command is running now
  await world.owner.says(world.channel, "!terminal", { thread });
  await new Promise((r) => setTimeout(r, 300));
  const afterMove = world.shown(thread).slice();
  const processesAtMove = world.entry.built.flatMap((a) => a.sessions);
  await new Promise((r) => setTimeout(r, 3000)); // the command ends
  const processes = world.entry.built.flatMap((a) => a.sessions);
  assert.equal(processesAtMove.length, startsBefore, "the move starts no process");
  assert.equal(processes.length, startsBefore, "the command's end starts none either");
  assert.equal(
    processes.filter((s) => !s.closed).length,
    0,
    "no daemon process holds the session after the move",
  );
  assert.ok(
    afterMove.some((line) => line.startsWith("Continue in the terminal with:")),
    afterMove.join("\n"),
  );
  await world.finish();
});
