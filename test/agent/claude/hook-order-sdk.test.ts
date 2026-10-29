/**
 * The order of a hook's events against the stream's records, through the SDK's own `query()`
 * rather than the fake of `session.test.ts`: the SDK runs a hook callback from the loop that
 * queues the records (`readMessages`, `sdk.mjs` 0.3.312) and does not await it, so the order
 * `ClaudeSession` keeps rests on how quickly its pump takes queued records. A release of the SDK
 * that changes that scheduling fails here. Claude Code is a fake process
 * (`spawnClaudeCodeProcess`) that answers the start and writes a recorded turn (`tools.jsonl`)
 * with the Stop hook's request (`stop-hook.json`) before the turn's result.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { type SpawnedProcess, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSession, type QueryFunction } from "../../../src/agent/claude/session.ts";
import type { SessionEvent } from "../../../src/agent/seam.ts";
import { type JsonObject, sdkJson, sdkRecords } from "../../support/fixtures.ts";

const TOOLS = sdkRecords("tools");
const STOP = sdkJson("stop-hook") as JsonObject;
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** A Claude Code process that answers every control request and writes `turn` after a prompt. */
class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  constructor(turn: (stdout: PassThrough) => void) {
    super();
    let written = false;
    createInterface({ input: this.stdin }).on("line", (text) => {
      const message = JSON.parse(text) as JsonObject;
      if (message.type === "control_request") {
        const response = {
          commands: [],
          models: [],
          agents: [],
          output_style: "default",
          available_output_styles: [],
          account: {},
        };
        this.stdout.write(
          line({
            type: "control_response",
            response: { subtype: "success", request_id: message.request_id, response },
          }),
        );
      }
      if (message.type === "user" && !written) {
        written = true;
        setTimeout(() => turn(this.stdout), 20);
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.stdout.end();
    this.emit("exit", 0, null);
    return true;
  }
}

/** The types of the events of one turn, a Stop hook's request written as `write` lays it out. */
async function turnWith(
  write: (stdout: PassThrough, records: string, hook: string, result: string) => void,
): Promise<string[]> {
  const hook = line({
    type: "control_request",
    request_id: "req-hook",
    request: { subtype: "hook_callback", callback_id: "hook_0", input: STOP, tool_use_id: null },
  });
  const records = TOOLS.slice(0, -1).map(line).join("");
  const result = line(TOOLS.at(-1));
  const query: QueryFunction = (params) =>
    sdkQuery({
      ...params,
      options: {
        ...params.options,
        spawnClaudeCodeProcess: () =>
          new FakeProcess((stdout) =>
            write(stdout, records, hook, result),
          ) as unknown as SpawnedProcess,
      },
    });
  const session = new ClaudeSession(
    {
      folder: "/srv/alice/app",
      resume: null,
      settingsSources: [],
      model: null,
      effort: null,
      chrome: false,
    },
    {
      permission: async () => ({ allow: true }),
      question: async () => ({ answered: false, message: "skipped" }),
    },
    query,
  );
  try {
    await session.send({ id: "00000000-0000-4000-8000-0000000000b1", content: "Say ok" });
    const types: string[] = [];
    for await (const event of session.events as AsyncIterable<SessionEvent>) {
      types.push(event.type);
      if (event.type === "turn_ended") break;
    }
    return types;
  } finally {
    await session.close();
  }
}

for (const [layout, write] of [
  [
    "in the same chunk as the records",
    (stdout: PassThrough, records: string, hook: string, result: string) => {
      stdout.write(records + hook + result);
    },
  ],
  [
    "in a chunk of its own right after them",
    (stdout: PassThrough, records: string, hook: string, result: string) => {
      stdout.write(records);
      stdout.write(hook);
      stdout.write(result);
    },
  ],
] as const) {
  test(`a Stop hook's events come after the records before it, its request ${layout}`, {
    timeout: 20_000,
  }, async () => {
    const types = await turnWith(write);
    assert.ok(types.includes("effort_observed"));
    assert.ok(
      types.indexOf("effort_observed") > types.lastIndexOf("message_ended"),
      types.join(" "),
    );
  });
}
