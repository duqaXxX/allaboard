/**
 * The Slack reply sink over Claude's recorded streams: the cases of `test/chat/slack/reply/sinks.test.ts`
 * that read a recording through the Claude back end's translator and vocabulary.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { TaskUpdate } from "../../../../src/chat/seam.ts";
import { type Block, blockText, contextBlock } from "../../../../src/chat/slack/reply/blocks.ts";
import { UpdateLimiter } from "../../../../src/chat/slack/reply/limiter.ts";
import { ReplySink } from "../../../../src/chat/slack/reply/sinks.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import type { Clock } from "../../../../src/clock.ts";
import { TurnRenderer } from "../../../../src/core/reply/renderer.ts";
import { CLAUDE_PREVIEWS } from "../../../support/claude-tools.ts";
import {
  BOT,
  CHANNEL,
  FakeClock,
  FakeSlack,
  OWNER,
  TEAM,
  THREAD,
} from "../../../support/fake-slack.ts";
import { golden, type Json, type JsonObject, sdkRecords } from "../../../support/fixtures.ts";
import { NAMES } from "../../../support/names.ts";
import { recordedEvents } from "../../../support/replay.ts";

let clocks: FakeClock[] = [];

beforeEach(() => {
  clocks = [];
});

/** A clock whose sleep is over at once and moves its own time: a limiter on it never holds a test. */
class SelfPacedClock implements Clock {
  now = 0;

  async sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    // Time always moves, as a real clock's does.
    const least = this.now + Number.EPSILON * Math.max(1, Math.abs(this.now));
    this.now = Math.max(this.now + seconds, seconds > 0 ? least : this.now);
  }

  time(): number {
    return this.now;
  }
}

function reply(slack: FakeSlack): ReplySink {
  const clock = new FakeClock();
  clocks.push(clock);
  return new ReplySink(slack, {
    channel: CHANNEL,
    threadTs: THREAD,
    teamId: TEAM,
    userId: OWNER,
    botUserId: BOT,
    limiter: new UpdateLimiter({ clock: new SelfPacedClock() }),
    previews: CLAUDE_PREVIEWS,
    clock,
    debounceSeconds: 0,
  });
}

async function _settled(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    for (const clock of clocks) await clock.advance(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type Maybe = Json | undefined;

/** `value[a][b]...`, a negative number counting from a list's end. */
function get(value: Maybe, ...path: (string | number)[]): Maybe {
  let here = value;
  for (const key of path) {
    if (Array.isArray(here) && typeof key === "number") here = here.at(key);
    else if (typeof here === "object" && here !== null && !Array.isArray(here)) {
      here = here[String(key)];
    } else return undefined;
  }
  return here;
}

function list(value: Maybe): JsonObject[] {
  assert.ok(Array.isArray(value), "not a list");
  return value.map((item) => {
    assert.ok(typeof item === "object" && item !== null && !Array.isArray(item), "not an object");
    return item;
  });
}

function str(value: Maybe): string {
  assert.equal(typeof value, "string");
  return value as string;
}

/** The only element of a list of one. */
function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1);
  return items[0] as T;
}

/** The last element. */
function _last<T>(items: readonly T[]): T {
  assert.ok(items.length > 0, "an empty list has no last element");
  return items.at(-1) as T;
}

/** Every chunk of every stream call, in order. */
function allChunks(slack: FakeSlack): JsonObject[] {
  return slack.apiCalls.flatMap((call) => ("chunks" in call.args ? list(call.args.chunks) : []));
}

test("an edit and a write show as the terminal shows them", async () => {
  // edit-write.jsonl (CLI 2.1.286): Write a new file, Read, a failed Edit, an Edit, a Write over
  // the file. The terminal showed each Edit and Write whole, with its sentence and its lines.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const renderer = new TurnRenderer(sink, NAMES, CLAUDE_PREVIEWS, "/home/dev/project");
  for (const event of recordedEvents("edit-write")) await renderer.feed(event);
  await renderer.close();
  const chunks = allChunks(slack);
  // Each one that ended well is a container alone; no card ever named it.
  const cards = chunks.filter((c) => c.type === "task_update");
  assert.deepEqual(
    cards.map((c) => str(c.title)).filter((t) => t.startsWith("Write") || t.startsWith("Update(")),
    [],
  );
  assert.deepEqual(
    cards.filter((c) => str(c.title).startsWith("Edit")).map((c) => [c.title, c.status]),
    [["Edit: /home/dev/project/notes.txt", "error"]],
  );
  const shown = chunks.filter((c) => c.type === "blocks").flatMap((c) => list(c.blocks));
  assert.deepEqual(
    shown.map((b) => b.type),
    ["container", "container", "container"],
  );
  assert.deepEqual(
    shown.map((b) => [get(b, "title", "text"), get(b, "subtitle", "text")]),
    [
      ["Write(new.txt)", "Wrote 15 lines to new.txt"],
      ["Update(notes.txt)", "Added 1 line, removed 1 line"],
      ["Write(notes.txt)", "Added 2 lines, removed 3 lines"],
    ],
  );
  const [newFile, ...diffs] = shown;
  assert.deepEqual(
    diffs.map((d) => blockText(d as unknown as Block)),
    [
      "    1 alpha\n-\u{1f7e5} 2 beta\n+\u{1f7e9} 2 gamma\n    3 delta",
      "-\u{1f7e5} 1 alpha\n-\u{1f7e5} 2 gamma\n-\u{1f7e5} 3 delta\n" +
        "+\u{1f7e9} 1 one\n+\u{1f7e9} 2 two",
    ],
  );
  const lines = blockText(newFile as unknown as Block).split("\n");
  assert.deepEqual(lines.slice(0, 2), [" 1 1", " 2 2"]);
  assert.equal(lines.at(-1), "… +5 lines");
});

test("an answered question shows in the reply where it was answered", async () => {
  // ask-answered.jsonl (CLI 2.1.286). The terminal keeps `User answered Claude's questions:`
  // and a line per answer where the question was asked, before what Claude says next.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const renderer = new TurnRenderer(sink, NAMES, CLAUDE_PREVIEWS, "/home/dev/project");
  // The answers the owner gave, as Claude Code echoed them in the result of the call: the
  // session holds them itself, and no event carries them.
  const echoed = sdkRecords("ask-answered").find(
    (record) => record.type === "user" && record.tool_use_result !== undefined,
  )?.tool_use_result;
  let call: { callId: string; questions: { text: string }[] } | null = null;
  for (const event of recordedEvents("ask-answered")) {
    if (event.type === "call_started") {
      const questions = list(event.input.questions as Json).map((q) => ({ text: str(q.question) }));
      call = { callId: event.callId, questions };
    }
    if (event.type === "call_ended" && call !== null) {
      // The session hands the answers over once the owner gave them, before the result.
      const answers = get(echoed, "answers");
      assert.ok(typeof answers === "object" && answers !== null && !Array.isArray(answers));
      assert.ok(
        renderer.answered(
          call.callId,
          call.questions,
          answers as Record<string, string | string[]>,
        ),
      );
    }
    await renderer.feed(event);
  }
  await renderer.close();
  assert.deepEqual(slack.messageCards()[0] ?? [], []); // the record is no card
  const chunks = allChunks(slack);
  const kinds = chunks.map((c) => c.type);
  const answers = only(chunks.filter((c) => c.type === "blocks"));
  assert.deepEqual(answers.blocks, [
    contextBlock(
      `✓ User answered Claude's questions:\n` +
        `${slackTexts.NESTED}· Which color do you prefer? → Blue\n` +
        `${slackTexts.NESTED}· Do you also like green? → Yes, Only in spring`,
    ),
  ]);
  // Claude's next words come after the answers, in the same message.
  assert.ok(kinds.slice(kinds.indexOf("blocks") + 1).includes("markdown_text"));
});

test("a subagent card counts its calls from a recorded turn", async () => {
  // subagent-foreground.jsonl (CLI 2.1.286): the agent's task ends before the Agent call's
  // result. The sink is given the calls the renderer makes for the recording (the reply golden),
  // up to the turn's end.
  const slack = new FakeSlack();
  const sink = reply(slack);
  const whole = get(golden("reply", "subagent-foreground"), "whole", "calls");
  for (const call of list(whole)) {
    if (call.call === "text") {
      await sink.text(str(call.markdown), {
        notice: call.notice === true,
        ending: call.ending === true,
      });
    } else if (call.call === "task") {
      await sink.task(call.update as unknown as TaskUpdate);
    } else if (call.call === "finish") {
      await sink.finish(list(call.closing) as unknown as TaskUpdate[]);
      break;
    }
  }
  const cards = slack.messageCards()[0] ?? [];
  const card = only(cards.filter((c) => str(c.title).startsWith("Agent: ")));
  assert.ok(str(card.title).endsWith(" · 1 call") && card.status === "complete");
});
