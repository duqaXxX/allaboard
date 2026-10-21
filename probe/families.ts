/**
 * The probe's full recording: one scene per family of messages the release scenes
 * do not cause (a subagent, a question, a Monitor, a forked skill, `/clear` and `/usage`, an API
 * error), each on a session started as the daemon starts one, with no setting source. Their
 * streams feed the comparison of shapes (`shapes.ts`); nothing is written.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeBackend } from "../src/agent/claude/backend.ts";
import type {
  PermissionAnswer,
  QuestionAnswer,
  QuestionRequest,
  RequestHandler,
  SessionEvent,
} from "../src/agent/seam.ts";
import { isRecord } from "../src/values.ts";
import { forgetSessions, Live, type Log, PROBE_MODEL, ProbeTimeout } from "./scenes.ts";
import { FIXTURES, fixtureRecords, missing } from "./shapes.ts";
import { type Records, tappedQuery } from "./tap.ts";

/** One family's run: what its session read, and why it did not finish when it did not. */
export interface FamilyRun {
  readonly name: string;
  /** The fixtures that hold this family's messages, compared both ways with what it read. */
  readonly fixtures: readonly string[];
  readonly records: Records;
  readonly failed: string | null;
}

// The owner's claude.ai connectors would list in a session's `init` (env-vars reference, read
// 2026-10-20): they are the account's, not the SDK's shape.
const NO_CONNECTORS = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
// Families run side by side, a few at a time: the owner's plan answers 429 to many at once.
const AT_ONCE = 3;
const REPORT_LIMIT = 150_000;
const ONE_WORD = "Reply with the single word: ok";
const SKILL =
  "---\nname: list-files\ndescription: List the files in this folder\ncontext: fork\n---\n\n" +
  "Run `ls` with the Bash tool, then read notes.txt with the Read tool, and report both results in one sentence.\n";

/** Approves every tool and answers every question with its first option. */
class Answering implements RequestHandler {
  async permission(): Promise<PermissionAnswer> {
    return { allow: true };
  }

  async question(request: QuestionRequest): Promise<QuestionAnswer> {
    const answers = Object.fromEntries(
      request.questions.map((question) => {
        const first = question.options[0]?.label ?? "yes";
        return [question.text, question.multiSelect ? [first] : first];
      }),
    );
    return { answered: true, answers, notes: {} };
  }
}

interface Setup {
  readonly files?: Readonly<Record<string, string>>;
  readonly project?: boolean;
  /** Variables of the session's environment beyond the daemon's own. */
  readonly variables?: Readonly<Record<string, string>>;
  readonly configDir?: string;
}

interface Family {
  readonly name: string;
  readonly fixtures: readonly string[];
  /** What the family exists to cause, said as the report says what it did not. */
  readonly cause: string;
  caused(records: Records): boolean;
  run(open: (setup?: Setup) => Promise<Live>): Promise<void>;
}

/** Whether an assistant message of `records` calls the tool `name`. */
function called(records: Records, name: string): boolean {
  return records.some(
    (record) =>
      isRecord(record) &&
      record.type === "assistant" &&
      isRecord(record.message) &&
      Array.isArray(record.message.content) &&
      record.message.content.some(
        (block) => isRecord(block) && block.type === "tool_use" && block.name === name,
      ),
  );
}

function count(records: Records, type: string, subtype: string): number {
  return records.filter(
    (record) => isRecord(record) && record.type === type && record.subtype === subtype,
  ).length;
}

function agentTurns(events: readonly SessionEvent[]): number {
  return events.filter((event) => event.type === "turn_ended" && event.startedBy === "agent")
    .length;
}

/**
 * Sends `prompt`, then waits for a turn the agent opens by itself, a task's report, up to
 * REPORT_LIMIT. Throws when `required` and none came.
 */
async function withReport(live: Live, prompt: string, required: boolean): Promise<void> {
  const from = live.events.length;
  await live.turn([{ type: "text", text: prompt }]);
  const reported = await live.until(from, (events) => agentTurns(events) > 0, REPORT_LIMIT);
  if (required && !reported) throw new ProbeTimeout("no report turn came");
  await live.quiet();
}

/** Answers every request with `status` and the error body of that type: no retry, no tokens. */
async function failingApi(status: number, type: string): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const counting = path.endsWith("/count_tokens");
      response.writeHead(counting ? 200 : status, { "content-type": "application/json" });
      response.end(
        counting
          ? '{"input_tokens": 10}'
          : JSON.stringify({ type: "error", error: { type, message: `Synthetic ${type}.` } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** One session against a stub that refuses with `status`; a made-up key and an empty login. */
async function apiError(
  open: (setup?: Setup) => Promise<Live>,
  status: number,
  type: string,
  empty: string,
): Promise<void> {
  const { server, url } = await failingApi(status, type);
  try {
    const key = `sk-${"ant"}-${"x".repeat(40)}`;
    const live = await open({
      configDir: empty,
      variables: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: key },
    });
    try {
      await live.turn([{ type: "text", text: ONE_WORD }]);
    } finally {
      // Before the stub goes: a request after it would be retried against a closed port.
      await live.session.close();
    }
  } finally {
    server.close();
  }
}

export const FAMILIES: readonly Family[] = [
  {
    name: "subagent",
    fixtures: ["subagent", "subagent-handback"],
    cause: "an Agent call",
    caused: (records) => called(records, "Agent"),
    // Every subagent of the daemon's sessions runs in the background (`CLAUDE_CODE_FORK_SUBAGENT`):
    // its result comes in a report turn.
    run: async (open) =>
      withReport(
        await open({ files: { "notes.txt": "alpha\n" } }),
        "Use the Agent tool with the general-purpose subagent to run `ls` with Bash and report " +
          "the result. Do not run any tool yourself.",
        true,
      ),
  },
  {
    name: "ask",
    fixtures: ["ask", "ask-answered"],
    cause: "an AskUserQuestion call",
    caused: (records) => called(records, "AskUserQuestion"),
    run: async (open) => {
      const live = await open();
      await live.turn([
        {
          type: "text",
          text:
            "Before anything else, use the AskUserQuestion tool to ask me which colour I prefer, " +
            "with the options red and blue, and whether I also like green (multi-select: yes, " +
            "no). Then reply with one short sentence.",
        },
      ]);
    },
  },
  {
    name: "monitor",
    fixtures: ["monitor-ended-in-turn"],
    cause: "a Monitor call",
    caused: (records) => called(records, "Monitor"),
    // The Monitor may end inside the turn, as in its fixture: no report is owed.
    run: async (open) =>
      withReport(
        await open(),
        "Use the Monitor tool to watch the output of `for i in 1 2 3; do echo tick $i; sleep 1; " +
          "done`, then reply with the single word: watching. When it has ended, say so in one " +
          "sentence.",
        false,
      ),
  },
  {
    name: "skill-fork",
    fixtures: ["skill-fork"],
    cause: "a Skill call",
    caused: (records) => called(records, "Skill"),
    run: async (open) => {
      const files = { "notes.txt": "alpha\n", ".claude/skills/list-files/SKILL.md": SKILL };
      await withReport(
        await open({ files, project: true }),
        "Use the Skill tool to run the list-files skill.",
        false,
      );
    },
  },
  {
    name: "commands",
    fixtures: ["clear", "usage"],
    cause: "a second init, after `/clear`",
    caused: (records) => count(records, "system", "init") >= 2,
    run: async (open) => {
      const live = await open();
      await live.turn([{ type: "text", text: ONE_WORD }]);
      await live.turn([{ type: "text", text: "/clear" }]);
      await live.turn([{ type: "text", text: "/usage" }]);
    },
  },
  {
    name: "api-error",
    fixtures: ["api-error-400"],
    cause: "an error result",
    caused: (records) =>
      records.some((record) => isRecord(record) && record.type === "result" && record.is_error),
    // Only a status Claude Code does not retry: on 2.1.304 a 401 is retried ten times and ends,
    // three minutes later, on a refused connection (measured 2026-10-20).
    run: async (open) => {
      const empty = await mkdtemp(join(tmpdir(), "allaboard-login-"));
      try {
        await apiError(open, 400, "invalid_request_error", empty);
      } finally {
        await rm(empty, { recursive: true, force: true });
      }
    },
  },
];

async function runFamily(family: Family, root: string, home: string, log: Log): Promise<FamilyRun> {
  const records: Records = [];
  const lives: Live[] = [];
  const open = async (setup: Setup = {}): Promise<Live> => {
    const folder = join(root, `${family.name}-${randomUUID().slice(0, 8)}`);
    await mkdir(folder);
    for (const [name, text] of Object.entries(setup.files ?? {})) {
      await mkdir(dirname(join(folder, name)), { recursive: true });
      await writeFile(join(folder, name), text);
    }
    const backend = new ClaudeBackend({
      home,
      query: tappedQuery(records),
      variables: { ...NO_CONNECTORS, ...setup.variables },
      ...(setup.configDir !== undefined && { configDir: setup.configDir }),
    });
    const session = await backend.start(
      {
        folder,
        resume: null,
        settingsSources: setup.project ? ["project"] : [],
        model: PROBE_MODEL,
        effort: null,
      },
      new Answering(),
    );
    const live = new Live(session);
    lives.push(live);
    return live;
  };
  log(`family: ${family.name}`);
  let failed: string | null = null;
  try {
    await family.run(open);
    if (!family.caused(records)) failed = `did not cause ${family.cause}`;
  } catch (error) {
    // The message may name the run's temporary folders: they are cut out.
    failed =
      error instanceof Error
        ? `raised ${error.name}: ${error.message.replaceAll(root, "<run>").slice(0, 160)}`
        : typeof error;
  } finally {
    for (const live of lives) await live.session.close().catch(() => undefined);
  }
  if (failed !== null) log(`family ${family.name}: ${failed}`);
  return { name: family.name, fixtures: family.fixtures, records, failed };
}

/** Runs every family, `AT_ONCE` at a time, and returns what each read. */
export async function runFamilies(log: Log, families = FAMILIES): Promise<FamilyRun[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "allaboard-families-")));
  try {
    // The owner's own `~/.claude.json` is not read: Chrome stays off, as in the scenes.
    const home = join(root, "home");
    await mkdir(home);
    await writeFile(join(home, ".claude.json"), "{}");
    const runs: FamilyRun[] = [];
    const queue = [...families];
    const worker = async (): Promise<void> => {
      for (let family = queue.shift(); family; family = queue.shift()) {
        runs.push(await runFamily(family, root, home, log));
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
    return families.map((family) => runs.find((run) => run.name === family.name) as FamilyRun);
  } finally {
    await forgetSessions(root, log);
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * What a run's sessions say they cost, in dollars of API usage: per session the last
 * `total_cost_usd` of its results, which counts the whole session. On the owner's plan it is
 * usage of the plan, not a charge.
 */
export function costOf(records: Records): number {
  const bySession = new Map<string, number>();
  for (const record of records) {
    if (!isRecord(record) || record.type !== "result") continue;
    const cost = typeof record.total_cost_usd === "number" ? record.total_cost_usd : 0;
    const session = String(record.session_id ?? "");
    bySession.set(session, Math.max(bySession.get(session) ?? 0, cost));
  }
  return [...bySession.values()].reduce((sum, cost) => sum + cost, 0);
}

/** The families' runs as the probe prints them: what each read, and what it did not produce. */
export function familiesReport(runs: readonly FamilyRun[], folder = FIXTURES): string {
  const total = runs.reduce((sum, run) => sum + costOf(run.records), 0);
  const lines = [`Full recording: ${runs.length} families, $${total.toFixed(3)} of API usage.`];
  for (const run of runs) {
    if (run.failed !== null) {
      lines.push(`  ${run.name}: ${run.failed}; the next run records it again`);
      continue;
    }
    const gone = missing(run.records, fixtureRecords(folder, run.fixtures));
    lines.push(
      `  ${run.name}: ${run.records.length} messages, $${costOf(run.records).toFixed(3)}; ${gone.length} paths of ${run.fixtures.join(", ")} not produced`,
    );
    for (const { kind, path } of gone) lines.push(`    - ${kind} ${path}`);
  }
  return lines.join("\n");
}
