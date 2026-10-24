/**
 * Step 10 of the scenario the memory chat carries: `!!command` in a session's thread. The owner
 * confirms it, the daemon runs it with a real Bash in the session's folder, and the agent is told
 * of the run and answers it in the same reply. Cancel, `!stop`, the instance's switch, an agent
 * that cannot be told and the channel itself each send nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DRAIN_POLL_SECONDS } from "../../src/core/sessions/constants.ts";
import * as texts from "../../src/core/texts.ts";
import { named } from "../../src/core/texts.ts";
import { plainShellPrompt, say } from "../support/plain-agent.ts";
import { NAMES, World } from "./world.ts";

const POSIX_ONLY = { skip: process.platform === "win32" };

/** A session's thread whose first prompt has had its answer. */
async function session(world: World): Promise<string> {
  world.script(say("Hello."));
  const thread = await world.open("hello");
  await world.ended(thread);
  return thread;
}

test(
  "a confirmed shell command runs in the folder and the agent answers its output",
  POSIX_ONLY,
  async (t) => {
    const world = World.make(t, { shell: true });
    await world.start();
    const thread = await session(world);

    const sending = world.owner.says(world.channel, "!!pwd && echo hi", { thread });
    const asked = await world.request("shell", thread);
    assert.deepEqual(asked.request, {
      type: "shell",
      requestId: asked.requestId,
      command: "pwd && echo hi",
      folder: world.folder,
    });
    assert.equal(asked.title, texts.SHELL_TITLE);
    // Nothing ran and nothing reached the agent before the click.
    assert.deepEqual(world.prompts(), ["hello"]);

    world.script(say("It printed hi."));
    assert.equal(await world.owner.answers(asked.requestId, { type: "shell", run: true }), true);
    await sending;
    await world.ended(thread, 2);
    const told = world.prompts().at(-1) as string;
    assert.equal(
      told,
      plainShellPrompt({
        command: "pwd && echo hi",
        stdout: `${world.folder}\nhi\n`,
        stderr: "",
        exitCode: 0,
        signal: null,
        lines: 1,
        end: "exited",
        seconds: 0,
      }),
    );
    // One reply: the run first, then the agent's answer to it.
    const reply = world.shown(thread).at(-1) as string;
    assert.match(reply, /^✓ exit 0 · \d+\.\d s\n```\n\$ pwd && echo hi\n/);
    assert.ok(reply.includes(`${world.folder}\nhi\n\`\`\`\n\nIt printed hi.`), reply);
    assert.deepEqual(world.chat.requests(), []);
    await world.finish();
  },
);

test("Cancel runs nothing and tells the owner", POSIX_ONLY, async (t) => {
  const world = World.make(t, { shell: true });
  await world.start();
  const thread = await session(world);

  const sending = world.owner.says(world.channel, `!!touch "${world.folder}/ran"`, { thread });
  const asked = await world.request("shell", thread);
  assert.equal(await world.owner.answers(asked.requestId, { type: "shell", run: false }), true);
  await sending;
  await world.settle();
  assert.equal(world.shown(thread).at(-1), texts.NOT_SENT);
  assert.deepEqual(world.prompts(), ["hello"]);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(`${world.folder}/ran`), false);
  await world.finish();
});

test("!stop ends a running command and the agent is told nothing", POSIX_ONLY, async (t) => {
  const world = World.make(t, { shell: true });
  await world.start();
  const thread = await session(world);

  const { existsSync } = await import("node:fs");
  const command = "echo started; touch .started; sleep 30";
  const sending = world.owner.says(world.channel, `!!${command}`, { thread });
  const asked = await world.request("shell", thread);
  await world.owner.answers(asked.requestId, { type: "shell", run: true });
  await sending;
  // Bash runs in real time: the stop is sent once the command is under way.
  while (!existsSync(`${world.folder}/.started`)) await new Promise((r) => setTimeout(r, 10));
  await world.owner.says(world.channel, "!stop", { thread });
  await world.until(
    () => world.shown(thread).some((text) => text.startsWith("Stopped after")),
    "the stopped run",
  );
  const stopped = world.shown(thread).find((text) => text.startsWith("Stopped after")) as string;
  assert.ok(stopped.includes(`$ ${command}\nstarted\n`), stopped);
  assert.deepEqual(world.prompts(), ["hello"]);
  await world.finish();
});

test(
  "a restart that begins while a command runs lets it end and sends it nowhere",
  POSIX_ONLY,
  async (t) => {
    const world = World.make(t, { shell: true });
    await world.start();
    const thread = await session(world);
    const { existsSync } = await import("node:fs");
    const command = "touch .started; sleep 0.5; echo done";
    const sending = world.owner.says(world.channel, `!!${command}`, { thread });
    const asked = await world.request("shell", thread);
    await world.owner.answers(asked.requestId, { type: "shell", run: true });
    await sending;
    while (!existsSync(`${world.folder}/.started`)) await new Promise((r) => setTimeout(r, 10));
    // The stop waits for the running command, which counts as a turn of the owner's.
    let stopped = false;
    const stopping = world.stop("SIGTERM").then(() => {
      stopped = true;
    });
    // The command ends in real time, half a second after it started.
    await new Promise((resolve) => setTimeout(resolve, 800));
    await world.until(
      () => world.shown(thread).some((text) => text.includes("not sent")),
      "the note",
    );
    // The drain polls the sessions on the daemon's clock.
    for (let poll = 0; poll < 20 && !stopped; poll += 1) {
      await world.clock.advance(DRAIN_POLL_SECONDS);
      await world.settle();
    }
    await stopping;
    assert.deepEqual(world.prompts(), ["hello"]);
    const shown = world.shown(thread).join("\n");
    assert.match(shown, new RegExp(`"!!${command}" \\(✓ exit 0 · `), shown);
    await world.finish();
  },
);

test("a prompt sent after a shell command waits for it", POSIX_ONLY, async (t) => {
  const world = World.make(t, { shell: true });
  await world.start();
  const thread = await session(world);

  const shell = world.owner.says(world.channel, "!!echo first", { thread });
  const asked = await world.request("shell", thread);
  const prompt = world.owner.says(world.channel, "second", { thread });
  await world.settle();
  assert.deepEqual(world.prompts(), ["hello"]);
  world.script(say("Ran it."));
  world.script(say("Second."));
  await world.owner.answers(asked.requestId, { type: "shell", run: true });
  await shell;
  await prompt;
  await world.ended(thread, 3);
  assert.deepEqual(world.prompts().slice(1), [
    plainShellPrompt({
      command: "echo first",
      stdout: "first\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      lines: 1,
      end: "exited",
      seconds: 0,
    }),
    "second",
  ]);
  await world.finish();
});

test("an instance that turned shell commands off asks nothing and runs nothing", async (t) => {
  const world = World.make(t, { shell: true, env: ["ALLABOARD_SHELL=off"] });
  await world.start();
  const thread = await session(world);
  await world.owner.says(world.channel, "!!echo hi", { thread });
  await world.settle();
  assert.equal(world.shown(thread).at(-1), texts.SHELL_OFF);
  assert.deepEqual(world.chat.requests(), []);
  assert.deepEqual(world.prompts(), ["hello"]);
  await world.finish();
});

test("an agent that cannot be told of a shell command is not offered one", async (t) => {
  const world = World.make(t);
  await world.start();
  const thread = await session(world);
  await world.owner.says(world.channel, "!!echo hi", { thread });
  await world.settle();
  assert.equal(world.shown(thread).at(-1), named(texts.SHELL_UNAVAILABLE, NAMES));
  assert.deepEqual(world.chat.requests(), []);
  await world.finish();
});

test("in the channel a shell command is refused: it needs a session's thread", async (t) => {
  const world = World.make(t, { shell: true });
  await world.start();
  await world.owner.says(world.channel, "!!echo hi");
  await world.settle();
  // A post in the channel, as the other words of one session answer there.
  assert.ok(world.chat.texts(world.channel).includes(texts.SHELL_OUTSIDE_SESSION));
  assert.deepEqual(world.chat.requests(), []);
  assert.deepEqual(world.prompts(), []);
  await world.finish();
});
