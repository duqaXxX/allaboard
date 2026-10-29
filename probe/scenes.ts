/**
 * The scenes: each one causes the events a claim needs, through the daemon's own back end
 * (`ClaudeBackend`, `ClaudeSession`).
 *
 * Claude Code is real (the SDK's bundled CLI, the owner's login, Haiku); nothing of Slack is in
 * play, since an SDK release changes nothing on the Slack side. What a claim checks is what the
 * daemon receives: the session events the back end gives the core, and the few pure functions of
 * the daemon that turn them into what the owner would see (`preview`, `gitState`, `resumeBlocks`,
 * `promptFor`). A scene reads the raw SDK only where its claim is about a raw shape the back end
 * hides, and says so.
 *
 * Sessions take no setting source, so nothing of the owner's settings, hooks or permission rules
 * is in play, and each works in a temporary folder whose transcripts the run removes again.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID, type UUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  getSessionInfo,
  getSessionMessages,
  type query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend, type ClaudeStartOptions } from "../src/agent/claude/backend.ts";
import { CAPABILITIES } from "../src/agent/claude/capabilities.ts";
import { directorySessions, projectKey, projectsDir } from "../src/agent/claude/listing.ts";
import { recordPath } from "../src/agent/claude/record.ts";
import { rewindStart } from "../src/agent/claude/rewind.ts";
import { AsyncQueue, ClaudeSession } from "../src/agent/claude/session.ts";
import { TOOLS } from "../src/agent/claude/tools.ts";
import { Translator } from "../src/agent/claude/translate.ts";
import { locate } from "../src/agent/claude/trust.ts";
import type {
  AgentSession,
  PermissionAnswer,
  PermissionRequest,
  PromptContent,
  QuestionAnswer,
  QuestionRequest,
  Repository,
  RequestHandler,
  SessionEvent,
} from "../src/agent/seam.ts";
import { ResumeRefused, RewindRefused } from "../src/agent/seam.ts";
import { promptFor } from "../src/chat/slack/attachments.ts";
import { resumeBlocks } from "../src/chat/slack/resume.ts";
import * as slackTexts from "../src/chat/slack/texts.ts";
import { gitState } from "../src/core/footer.ts";
import { Previews, resuming } from "../src/core/reply/previews.ts";
import * as texts from "../src/core/texts.ts";
import { isRecord, records } from "../src/values.ts";
import { CLAIMS, type Observation, observation } from "./claims.ts";
import { notOffered, UNAVAILABLE } from "./commands.ts";
import { type Records, tappedQuery } from "./tap.ts";

// What the daemon draws a Claude session's tools with, as the daemon builds it.
const CLAUDE_PREVIEWS = new Previews(TOOLS);

// The model the fixture recorder uses: the cheapest that runs every scene. The alias, as the
// daemon's own sessions name a model.
export const PROBE_MODEL = "haiku";
const RESUME_THREAD = "1700000000.000200";
const TURN_LIMIT = 180_000;
const COUNT_TO = 2000;
// A turn is over once nothing has been said for this long: the one that follows a stopped task
// or an interrupt, which no event announces.
const QUIET_MS = 1500;
const QUIET_LIMIT = 60_000;
// How long the background wake scene waits for the turn a command's end opens.
const WAKE_LIMIT = 120_000;

export type Log = (line: string) => void;
type Seen = Record<string, Observation>;

/** A wait ran out: the machine was slow, or the network, and the scene learned nothing. */
export class ProbeTimeout extends Error {
  override readonly name = "TimeoutError";
}

/** The session ended while a scene waited on it. */
class SessionLost extends Error {
  override readonly name = "SessionLost";
}

/**
 * Failures of the machine the probe runs on, not of the SDK: a wait past its limit, the network
 * (a system error carries a code such as ECONNRESET). Such a scene learned nothing, so its claims
 * are UNPROVEN rather than BROKEN.
 */
export function isEnvironment(error: unknown): boolean {
  if (error instanceof ProbeTimeout) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9_]+$/.test(code);
}

// Each scene and the claims it observes: the one place a claim id meets its scene.
// `test/probe/probe.test.ts` checks that together they cover `CLAIMS` exactly.
export const SCENES: Readonly<Record<string, readonly string[]>> = {
  "plain session": ["L1", "L2", "L3", "L6"],
  "first turn": ["P1", "P2", "P3", "P17"],
  image: ["P4"],
  file: ["P5"],
  "bash and approval": ["P10", "P11"],
  previews: ["P13"],
  "background and stop": ["P12"],
  interrupt: ["P8"],
  resume: ["P6", "P7"],
  "model and effort resume": ["P15", "P16"],
  "setup model resume": ["P18"],
  "model command after setModel": ["P27", "P28"],
  bypass: ["P9"],
  "working folder": ["P14"],
  replay: ["P19"],
  "effort commands": ["P26"],
  goal: ["P20", "P33", "L9"],
  compact: ["P21", "P22"],
  "commands not offered": ["P23"],
  "computer use": ["P24"],
  "background wake": ["P25"],
  "config folder listing": ["P29"],
  "terminal form": ["P30", "L4", "L5", "L8"],
  "session tag": ["P31"],
  "generated title": ["P32"],
  "fork source": ["P43"],
  rewind: ["P44", "P45"],
  "folder trust": ["P34"],
  "stop hooks": ["P42"],
  "settings mode": ["P37"],
  "logged out": ["P39"],
  "api error": ["P40"],
  question: ["P36"],
  "ended subagent": ["P35"],
  "subagent hand-back": ["P41"],
};

/** `text` without any path of this machine, one line, cut to `limit` characters. */
function scrub(text: string, roots: readonly string[], limit = 160): string {
  let clean = text;
  for (const root of roots) clean = clean.split(root).join("<tmp>");
  clean = clean.split(homedir()).join("<home>").replace(/\s+/g, " ");
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function ofType<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

/** What was written in `events`: the pieces of the texts streamed and the texts sent whole. */
function writtenIn(events: readonly SessionEvent[]): string {
  return events
    .flatMap((event) => (event.type === "text" || event.type === "text_delta" ? [event.text] : []))
    .join("");
}

/** The numbers written one per line: a sentence that names a number does not count. */
export function counted(text: string): Set<number> {
  const numbers = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\d+$/.test(line.trim())) numbers.add(Number(line.trim()));
  }
  return numbers;
}

/** A valid 1x1 red PNG, built here so the probe ships no binary file. */
export function onePixelPng(): Uint8Array {
  const chunk = (kind: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); // width
  header.writeUInt32BE(1, 4); // height
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, no interlace
  const pixels = deflateSync(Buffer.from([0, 0xff, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The owner's side: approves every tool and declines every question, and keeps what was asked. */
class Owner implements RequestHandler {
  readonly asked: PermissionRequest[] = [];

  async permission(request: PermissionRequest): Promise<PermissionAnswer> {
    this.asked.push(request);
    return { allow: true };
  }

  async question(_request: QuestionRequest): Promise<QuestionAnswer> {
    return { answered: false, message: "declined by the probe" };
  }
}

/** One turn: the prompt's id and every event from the send to the end of the turn. */
interface Turn {
  readonly id: string;
  readonly events: readonly SessionEvent[];
}

/** A session and everything it said, in order, with the waits a scene needs. */
export class Live {
  readonly session: ClaudeSession;
  readonly events: SessionEvent[] = [];
  ended = false;
  readonly #wake: (() => void)[] = [];

  constructor(session: ClaudeSession) {
    this.session = session;
    void (async () => {
      for await (const event of session.events) {
        this.events.push(event);
        this.#poke();
      }
      this.ended = true;
      this.#poke();
    })();
  }

  #poke(): void {
    for (const wake of this.#wake.splice(0)) wake();
  }

  /** Whether `done` held of the events from `from` on before `ms` passed or the session ended. */
  async until(
    from: number,
    done: (events: SessionEvent[]) => boolean,
    ms: number,
  ): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (done(this.events.slice(from))) return true;
      const left = deadline - Date.now();
      if (this.ended || left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Waits until nothing has been said for QUIET_MS, or QUIET_LIMIT has passed. */
  async quiet(): Promise<void> {
    const deadline = Date.now() + QUIET_LIMIT;
    for (;;) {
      const seen = this.events.length;
      await new Promise<void>((resolve) => setTimeout(resolve, QUIET_MS));
      if (this.events.length === seen || this.ended || Date.now() >= deadline) return;
    }
  }

  /**
   * Sends `content` once the session is quiet and returns the events up to the end of the owner's
   * turn it starts. Throws ProbeTimeout past TURN_LIMIT and SessionLost when the session ends.
   */
  async turn(content: PromptContent): Promise<Turn> {
    await this.quiet();
    const from = this.events.length;
    const id = randomUUID();
    await this.session.send({ id, content });
    const over = (events: SessionEvent[]) =>
      events.some((event) => event.type === "turn_ended" && event.startedBy === "owner");
    const done = await this.until(from, over, TURN_LIMIT);
    const events = this.events.slice(from);
    if (done) {
      const end = events.findIndex(
        (event) => event.type === "turn_ended" && event.startedBy === "owner",
      );
      return { id, events: events.slice(0, end + 1) };
    }
    if (this.ended) throw new SessionLost("the session ended during a turn");
    throw new ProbeTimeout("a turn did not end in time");
  }
}

/** Where the run stands: the back end, the folders and every session it opened. */
export class Stage {
  readonly log: Log;
  readonly root: string;
  readonly workdir: string;
  readonly models: string;
  readonly uploads: string;
  readonly home: string;
  readonly backend: ClaudeBackend;
  // Every session the run starts, the raw ones too, goes through it: its records feed the
  // comparison of shapes (`shapes.ts`).
  readonly query: typeof query;
  // The same records the tap copies for the comparison of shapes: a scene reads the slice it caused.
  readonly records: Records;
  readonly owner = new Owner();
  readonly lives: Live[] = [];
  main!: Live;

  constructor(log: Log, root: string, home: string, records: Records) {
    this.log = log;
    this.root = root;
    this.home = home;
    this.workdir = join(root, "work");
    this.models = join(root, "models");
    this.uploads = join(root, "uploads");
    this.records = records;
    this.query = tappedQuery(records);
    this.backend = new ClaudeBackend({ home, query: this.query });
  }

  options(folder: string, over: Partial<ClaudeStartOptions> = {}): ClaudeStartOptions {
    return {
      folder,
      resume: null,
      settingsSources: [],
      model: PROBE_MODEL,
      effort: null,
      ...over,
    };
  }

  /** Starts a session; rejects with ResumeRefused when Claude Code will not resume one. */
  async open(folder: string, over: Partial<ClaudeStartOptions> = {}): Promise<Live> {
    const live = new Live(await this.backend.start(this.options(folder, over), this.owner));
    this.lives.push(live);
    return live;
  }

  /** Permission requests received since `mark`, as their tool names. */
  askedSince(mark: number): string[] {
    return this.owner.asked.slice(mark).map((request) => request.toolName);
  }

  scrubbed(text: string, limit = 160): string {
    return scrub(text, [this.root], limit);
  }

  /** After a scene that raised: stop what it left running, so the next one starts on a quiet session. */
  async recover(): Promise<void> {
    try {
      await this.main.session.interrupt();
    } catch {
      // The session may be gone: the next scene says so.
    }
    await this.main.quiet();
  }
}

/**
 * What a scene that raised saw, per claim. It did cause its events and see them fail for a gesture
 * or model claim, unless the machine failed; for a limit claim it proves nothing, since a failed
 * capture must never read as a fallen limit.
 */
export function raised(claims: readonly string[], error: unknown, detail: string): Seen {
  const caused = !isEnvironment(error);
  return Object.fromEntries(
    claims.map((claim) => {
      const limit = CLAIMS.find((subject) => subject.id === claim)?.kind === "limit";
      return [claim, observation(caused && !limit, false, detail)];
    }),
  );
}

/**
 * Runs a scene. One that raises did cause its events and saw them fail, since a break in the SDK
 * most often shows as a call that rejects; a failure of the machine instead (a timeout, the
 * network) learned nothing. Its claims record which, with the error's name.
 */
async function attempt(name: string, s: Stage, scene: () => Promise<Seen>): Promise<Seen> {
  const claims = SCENES[name] ?? [];
  s.log(`scene: ${name}`);
  let seen: Seen;
  try {
    seen = await scene();
  } catch (error) {
    const named = error instanceof Error ? error.name : typeof error;
    const said = error instanceof Error ? ` ${s.scrubbed(error.message, 100)}` : "";
    const detail = `scene raised ${named}:${said}`;
    s.log(`scene ${name}: ${detail}`);
    await s.recover();
    return raised(claims, error, detail);
  }
  const unknown = Object.keys(seen).filter((claim) => !claims.includes(claim));
  if (unknown.length > 0) {
    throw new RangeError(
      `scene ${name} observed claims it does not own: ${unknown.sort().join(", ")}`,
    );
  }
  return seen;
}

/**
 * P17: the setup message is built from these fields, so each entry must carry the first two and
 * every entry that supports effort must list its levels. Read on the raw initialization result:
 * `info()` gives an entry with no `displayName` its `value` in its place, which would hide the
 * very absence this claim is about.
 */
export function modelsListed(models: readonly unknown[]): Observation {
  const entries = models.filter(isRecord);
  const named =
    entries.length > 0 &&
    entries.length === models.length &&
    entries.every((m) => m.value && m.displayName);
  const levels = entries
    .filter((m) => m.supportsEffort)
    .every((m) => Array.isArray(m.supportedEffortLevels) && m.supportedEffortLevels.length > 0);
  const detail =
    named && levels
      ? ""
      : `models: ${JSON.stringify(entries.slice(0, 2).map((m) => Object.keys(m).sort()))}`;
  // The fields an entry carries and the effort levels any entry lists: names, never a model's
  // identity, which every release changes.
  const fields = [...new Set(entries.flatMap((m) => Object.keys(m)))].sort();
  const listed = entries.flatMap((m) =>
    Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [],
  );
  return observation(true, named && levels, detail, {
    modelFields: fields,
    effortLevels: [...new Set(listed)].sort(),
  });
}

/** The raw initialization result's models: a Claude Code process started and asked, no prompt sent. */
async function rawModels(s: Stage): Promise<readonly unknown[]> {
  const input = new AsyncQueue<SDKUserMessage>();
  const raw = s.query({
    prompt: input,
    options: { cwd: s.workdir, settingSources: [], model: PROBE_MODEL },
  });
  try {
    const init: unknown = await raw.initializationResult();
    return isRecord(init) ? records(init.models) : [];
  } finally {
    input.end();
    raw.close();
  }
}

async function firstTurn(s: Stage, word: string): Promise<Seen> {
  const turn = await s.main.turn(
    `Remember this code word: ${word}. Reply with the single word: ready`,
  );
  // The session names itself when Claude Code answers its first prompt.
  const started = ofType(s.main.events, "session_started")[0];
  const ended = ofType(turn.events, "turn_ended")[0];
  const about = await s.main.session.info();
  const usage = await s.main.session.contextUsage();
  const status =
    about.models.length > 0 &&
    about.commands.length > 0 &&
    usage.model !== null &&
    usage.percentage !== null;
  return {
    P1: observation(
      true,
      (started?.agentVersion ?? null) !== null,
      `cli ${started?.agentVersion ?? "none"}`,
      // The version itself changes with every release: only its form is a fact.
      { versionReported: /^\d+\.\d+\.\d+/.test(started?.agentVersion ?? "") },
    ),
    P3: observation(true, (ended?.sessionId ?? null) !== null, ""),
    P2: observation(
      true,
      status,
      status
        ? ""
        : `${about.models.length} models, ${about.commands.length} commands, usage ${usage.model ?? "none"}`,
    ),
    P17: modelsListed(await rawModels(s)),
  };
}

async function imageTurn(s: Stage): Promise<Seen> {
  // In English: a model may answer in the language of the owner's settings, and none loads here.
  const content = promptFor(
    "Reply with one English word: what colour is this image?",
    [{ mediaType: "image/png", data: onePixelPng() }],
    [],
  );
  const turn = await s.main.turn(content);
  const reply = writtenIn(turn.events) || (ofType(turn.events, "turn_ended")[0]?.finalText ?? "");
  // The pixel is red: naming its colour shows Claude received the image. A reply alone does not,
  // since an error such as `API Error: 400` is a reply too.
  const named = /\bred\b/i.test(reply);
  return {
    P4: observation(true, named, named ? "" : s.scrubbed(reply, 80)),
  };
}

async function fileTurn(s: Stage): Promise<Seen> {
  const token = randomBytes(4).toString("hex");
  const path = join(s.uploads, "probe-note.txt");
  await writeFile(path, `${token}\n`);
  const turn = await s.main.turn(
    promptFor("Read the attached file and reply with its content only.", [], [path]),
  );
  const reply = writtenIn(turn.events) + (ofType(turn.events, "turn_ended")[0]?.finalText ?? "");
  const quoted = reply.includes(token);
  return { P5: observation(true, quoted, "") };
}

/**
 * P10: the card of a Bash call is built from the call's two events, and the line under it
 * (`$ <command>`, `commandLine`) from the `command` of its input.
 */
export function judgeShellCard(
  called: boolean,
  call: Extract<SessionEvent, { type: "call_started" }> | undefined,
  finished: boolean,
  detail: string,
): Observation {
  const line = call === undefined ? null : CLAUDE_PREVIEWS.commandLine(call.toolName, call.input);
  const shown = line !== null && line.includes("probe-ran.txt");
  const said =
    detail || (call !== undefined && finished && !shown ? "the call's input names no command" : "");
  return observation(called, call !== undefined && finished && shown, said);
}

async function bashTurn(s: Stage): Promise<Seen> {
  const mark = s.owner.asked.length;
  const marker = join(s.workdir, "probe-ran.txt");
  const turn = await s.main.turn(
    "Use the Bash tool to run exactly this command: echo ok > probe-ran.txt\nThen reply: done",
  );
  // A Bash call is known by the permission request the CLI sends for it, whatever its title;
  // its card is built from the call's two events.
  const asked = s.askedSince(mark);
  const called = asked.includes("Bash");
  const detail = called ? "" : `permission requests: ${asked.join(", ") || "none"}`;
  const bash = ofType(turn.events, "call_started").find((event) => event.toolName === "Bash");
  const finished = ofType(turn.events, "call_ended").some((event) => event.callId === bash?.callId);
  return {
    P10: judgeShellCard(called, bash, finished, detail),
    P11: observation(called, existsSync(marker), detail),
  };
}

async function previews(s: Stage): Promise<Seen> {
  const mark = s.owner.asked.length;
  const turn = await s.main.turn(
    "One tool call per step. 1) Use the Write tool to create preview.txt with the lines " +
      "alpha, beta and gamma. 2) Use the Edit tool on preview.txt to replace beta with delta. " +
      "Then reply: done",
  );
  const asked = s.askedSince(mark);
  const called = asked.includes("Write") && asked.includes("Edit");
  const names = new Map(
    ofType(turn.events, "call_started").map((event) => [event.callId, event.toolName]),
  );
  const shownBy = (tool: string) =>
    ofType(turn.events, "call_ended")
      .filter((event) => names.get(event.callId) === tool)
      .map((event) => CLAUDE_PREVIEWS.preview(tool, event.fileChange, s.workdir))
      .find((found) => found !== null) ?? null;
  const write = shownBy("Write");
  const edit = shownBy("Edit");
  // Both previews built: the shapes they read are still the measured ones.
  const shown =
    write?.title === "Write(preview.txt)" &&
    edit?.title === "Update(preview.txt)" &&
    write.summary.startsWith("Wrote 3 lines") &&
    edit.summary === "Added 1 line, removed 1 line";
  let detail = "";
  if (!called) detail = `permission requests: ${asked.join(", ")}`;
  else if (!shown) {
    // What the previews said instead: a changed wording or shape is visible at once.
    const other = [write, edit]
      .map((found) => (found ? `${found.title} ${found.summary}` : "no preview"))
      .join("; ");
    detail = `previews: ${s.scrubbed(other)}`;
  }
  return { P13: observation(called, shown, detail) };
}

async function backgroundStop(s: Stage): Promise<Seen> {
  const from = s.main.events.length;
  await s.main.turn(
    "Use the Bash tool with run_in_background set to true to run: tail -f /dev/null\n" +
      "Do not wait for it. Reply: started",
  );
  const startedTask = () =>
    ofType(s.main.events.slice(from), "task_started").find((event) => event.kind === "command");
  if (!(await s.main.until(from, () => startedTask() !== undefined, 20_000))) {
    return { P12: observation(false, false, "no background command started") };
  }
  const taskId = startedTask()?.taskId ?? "";
  const stopFrom = s.main.events.length;
  await s.main.session.stopTask(taskId);
  // The end is a notification or a terminal patch, whichever Claude Code sends first.
  const gone = await s.main.until(
    stopFrom,
    (events) =>
      events.some(
        (event) =>
          (event.type === "task_ended" && event.taskId === taskId) ||
          (event.type === "task_updated" && event.taskId === taskId && event.terminal),
      ),
    30_000,
  );
  return {
    P12: observation(true, gone, gone ? "" : "the task did not end within 30 s of the stop"),
  };
}

async function interrupt(s: Stage): Promise<Seen> {
  await s.main.quiet();
  const from = s.main.events.length;
  // Long enough that Haiku cannot finish it in the second or two a stop takes to arrive.
  await s.main.session.send({
    id: randomUUID(),
    content: `Without using any tool, reply with the numbers from 1 to ${COUNT_TO}, one per line, and nothing else.`,
  });
  const reached = await s.main.until(from, (events) => counted(writtenIn(events)).has(20), 60_000);
  if (!reached) {
    const start = s.scrubbed(writtenIn(s.main.events.slice(from)), 80);
    return { P8: observation(false, false, `the reply never reached 20: ${start}`) };
  }
  await s.main.session.interrupt();
  const ended = await s.main.until(
    from,
    (events) => events.some((event) => event.type === "turn_ended"),
    60_000,
  );
  const events = s.main.events.slice(from);
  const finished = counted(writtenIn(events)).has(COUNT_TO);
  const ending = ofType(events, "turn_ended")[0]?.ending;
  let detail = "";
  if (finished) detail = `the reply ran to ${COUNT_TO}: the interrupt did nothing`;
  else if (!ended) detail = "the turn did not end within 60 s of the stop";
  else if (ending !== "interrupted")
    detail = `the turn ended as ${ending ?? "none"}, not interrupted`;
  return {
    P8: observation(true, ended && !finished && ending === "interrupted", detail),
  };
}

async function resume(s: Stage, word: string, sessionId: string | null): Promise<Seen> {
  if (sessionId === null) return { P6: observation(false, false, "no session id stored") };
  const listed = await s.backend.listSessions(s.workdir);
  // The picker as the daemon builds it: the first turn's thread holds this session, so it takes
  // no row and is counted in the line under the list.
  const holding = new Set([sessionId]);
  const free = listed.filter((entry) => !holding.has(entry.id));
  const held = listed.length - free.length;
  const picker = JSON.stringify(resumeBlocks(s.workdir, free, held, new Date(), RESUME_THREAD));
  const countedLine =
    held === 1
      ? slackTexts.RESUME_OPEN_ONE
      : texts.fill(slackTexts.RESUME_OPEN_MANY, { count: held });
  const known = listed.some((entry) => entry.id === sessionId);
  const inPicker =
    held >= 1 && picker.includes(countedLine) && !picker.includes(sessionId.slice(0, 8));
  const seen: Seen = {
    P6: observation(true, known && inPicker, ""),
  };
  let resumed: Live;
  try {
    resumed = await s.open(s.workdir, { resume: sessionId });
  } catch (error) {
    if (error instanceof ResumeRefused)
      return { ...seen, P7: observation(false, false, "the resume was refused") };
    throw error;
  }
  const turn = await resumed.turn("What was the code word I gave you? Reply with the word only.");
  const reply = writtenIn(turn.events) + (ofType(turn.events, "turn_ended")[0]?.finalText ?? "");
  await resumed.session.close();
  const remembered = reply.includes(word);
  return { ...seen, P7: observation(true, remembered, "") };
}

/** The id of the session `events` belong to, from the turn that ended them. */
function sessionIdOf(events: readonly SessionEvent[]): string | null {
  return ofType(events, "turn_ended").at(-1)?.sessionId ?? null;
}

/** The model the live session reports before it has said anything: no token is spent asking. */
async function modelOf(live: Live): Promise<string> {
  return (await live.session.contextUsage()).model ?? "none";
}

/**
 * P15: a resumed session keeps the model set with `/model`. P16: it loses the effort set live
 * (`setEffort`, which the TypeScript back end applies with no reconnect), and `Options.effort`
 * restores it. A session starts on Claude Code's default model, which is not Haiku: the model is
 * set before any prompt is sent, and each resume is asked its model before it is sent one, so no
 * turn runs on another model than Haiku.
 */
async function modelEffortResume(s: Stage): Promise<Seen> {
  const first = await s.open(s.models, { model: null });
  const before = await modelOf(first);
  if (before.includes("haiku")) {
    await first.session.close();
    const detail = `the default model is already ${before}`;
    return { P15: observation(false, false, detail), P16: observation(false, false, detail) };
  }
  await first.turn("/model haiku");
  const chosen = await modelOf(first);
  if (!chosen.includes("haiku")) {
    return {
      P15: observation(true, false, `/model haiku left the session on ${chosen}`),
      P16: observation(false, false, "the model was not set"),
    };
  }
  await first.session.setEffort("low");
  const turn = await first.turn("Reply with the single word: ok");
  const live = ofType(turn.events, "effort_observed").at(-1)?.level ?? null;
  const sessionId = sessionIdOf(turn.events);
  await first.session.close();
  if (sessionId === null) {
    const detail = "no session id came";
    return { P15: observation(false, false, detail), P16: observation(false, false, detail) };
  }

  // The plain resume: no model and no effort passed.
  let plain: Live;
  try {
    plain = await s.open(s.models, { resume: sessionId, model: null });
  } catch (error) {
    if (!(error instanceof ResumeRefused)) throw error;
    const detail = "the resume was refused";
    return { P15: observation(false, false, detail), P16: observation(false, false, detail) };
  }
  const kept = await modelOf(plain);
  const modelKept = kept.includes("haiku");
  let lost: string | null = null;
  if (modelKept) {
    const plainTurn = await plain.turn("Reply with the single word: ok");
    lost = ofType(plainTurn.events, "effort_observed").at(-1)?.level ?? null;
  }
  await plain.session.close();
  const p15 = observation(true, modelKept, modelKept ? "" : `the resumed session reports ${kept}`);
  if (!modelKept)
    return {
      P15: p15,
      P16: observation(false, false, "no turn was sent on a model that is not Haiku"),
    };

  // The resume that passes the effort back.
  const restored = await s.open(s.models, { resume: sessionId, model: null, effort: "low" });
  const restoredTurn = await restored.turn("Reply with the single word: ok");
  const back = ofType(restoredTurn.events, "effort_observed").at(-1)?.level ?? null;
  await restored.session.close();

  const holds = live === "low" && lost !== "low" && back === "low";
  const detail = holds
    ? ""
    : `after setEffort: ${live ?? "none"}; after the plain resume: ${lost ?? "none"}; after the effort resume: ${back ?? "none"}`;
  return {
    P15: p15,
    // Only the level a plain resume falls back to can differ while the claim holds: the other
    // two are `low` whenever it does.
    P16: observation(true, holds, detail, { effortAfterPlainResume: lost }),
  };
}

/**
 * P18: a model set with `/model` (what the setup's Start does) survives a resume that passes
 * none. The session starts on the default model, so Haiku showing after the resume can only come
 * from the session's own record.
 */
async function setupModelResume(s: Stage): Promise<Seen> {
  const first = await s.open(s.models, { model: null });
  const before = await modelOf(first);
  if (before.includes("haiku")) {
    await first.session.close();
    return { P18: observation(false, false, `the default model is already ${before}`) };
  }
  await first.session.setModel(PROBE_MODEL);
  const chosen = await modelOf(first);
  if (!chosen.includes("haiku")) {
    await first.session.close();
    return { P18: observation(true, false, `setModel left the session on ${chosen}`) };
  }
  const turn = await first.turn("Reply with the single word: ok");
  const sessionId = sessionIdOf(turn.events);
  await first.session.close();
  if (sessionId === null) return { P18: observation(false, false, "no session id came") };
  let resumed: Live;
  try {
    resumed = await s.open(s.models, { resume: sessionId, model: null });
  } catch (error) {
    if (error instanceof ResumeRefused)
      return { P18: observation(false, false, "the resume was refused") };
    throw error;
  }
  const kept = await modelOf(resumed);
  await resumed.session.close();
  return {
    P18: observation(
      true,
      kept.includes("haiku"),
      kept.includes("haiku") ? "" : `the resumed session reports ${kept}`,
    ),
  };
}

/**
 * P27: after `setModel` to Haiku, a `/model` to the settings' alias is ignored and requests keep
 * running on Haiku. Unproven unless the startup model was not Haiku and had an alias
 * (`precondition`), `setModel` took (`applied`) and a request named its model.
 */
export function judgeModelOverride(
  precondition: boolean,
  startup: string,
  applied: boolean,
  ranOn: readonly string[],
): Observation {
  if (!precondition) {
    return observation(
      false,
      false,
      `no alias other than Haiku names the startup model ${startup}`,
    );
  }
  if (!applied) return observation(false, false, "setModel did not change the session's model");
  if (ranOn.length === 0) return observation(false, false, "the turn named no model");
  const holds = ranOn.every((model) => model.includes("haiku"));
  return observation(true, holds, holds ? "" : `the turn ran on ${ranOn.join(", ")}`);
}

/**
 * P27: with a model named in the project settings, after the SDK's `setModel()` a `/model` to that
 * model's alias leaves the next request on the `setModel` model. The daemon no longer calls
 * `setModel`, so the scene reads the raw SDK. The startup model, which is not Haiku, runs no
 * request: the two commands cost nothing and the one-word turn runs on Haiku while the limit
 * stands. P28 rides on the same run: the command is sent under a uuid of its own, as the daemon
 * sends it, and Claude Code ends its turn with a `command_lifecycle` `completed` naming it. P28
 * does not depend on P27's precondition: without it the command goes out alone and P27 is UNPROVEN.
 */
async function modelCommandAfterSetModel(s: Stage): Promise<Seen> {
  const input = new AsyncQueue<SDKUserMessage>();
  // The override shows through only for the model the settings name (measured 2026-10-16), so the
  // scene names one: a project settings file in a folder of its own, read alone.
  const cwd = join(s.workdir, "model-settings");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
  const raw = s.query({ prompt: input, options: { cwd, settingSources: ["project"] } });
  const say = (content: string, uuid?: UUID) =>
    input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      ...(uuid !== undefined && { uuid }),
    });
  const commandId = randomUUID();
  let completed = false;
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    raw.close();
  }, TURN_LIMIT);
  try {
    const init: unknown = await raw.initializationResult();
    const listed = isRecord(init) ? records(init.models) : [];
    const usage: unknown = await raw.getContextUsage();
    const startup = isRecord(usage) && typeof usage.model === "string" ? usage.model : "none";
    const alias = listed.find(
      (entry) => entry.value !== "default" && entry.resolvedModel === startup,
    )?.value;
    // P27 needs a startup model that is not Haiku and an alias that names it; P28 needs neither,
    // so the command goes out whatever the alias and the scene ends at its `completed` then.
    const precondition = !startup.includes("haiku") && typeof alias === "string";
    let applied = false;
    if (precondition) {
      await raw.setModel(PROBE_MODEL);
      // The control: a `setModel` that did nothing leaves the startup model, and the limit is
      // about a `/model` that undoes one that took.
      const after: unknown = await raw.getContextUsage();
      applied = isRecord(after) && typeof after.model === "string" && after.model.includes("haiku");
    }
    say(`/model ${typeof alias === "string" ? alias : "default"}`, commandId);
    let results = 0;
    const ranOn: string[] = [];
    try {
      for await (const record of raw) {
        const seen: unknown = record;
        if (!isRecord(seen)) continue;
        if (seen.type === "command_lifecycle" && seen.state === "completed") {
          completed ||= seen.command_uuid === commandId;
          if (!precondition && completed) break;
        }
        if (seen.type === "assistant" && results === 1 && isRecord(seen.message)) {
          if (typeof seen.message.model === "string") ranOn.push(seen.message.model);
        }
        if (seen.type !== "result" || !precondition) continue;
        results += 1;
        if (results === 2) break;
        say("Reply with the single word: ok");
      }
    } catch (error) {
      if (!late) throw error;
    }
    if (late) throw new ProbeTimeout("the turns did not end in time");
    const ended = observation(true, completed, completed ? "" : "no completed named the command");
    return { P27: judgeModelOverride(precondition, startup, applied, ranOn), P28: ended };
  } finally {
    clearTimeout(timer);
    input.end();
    raw.close();
  }
}

async function bypass(s: Stage): Promise<Seen> {
  const mode = CAPABILITIES.permissionModes;
  if (mode.bypass === null)
    return { P9: observation(false, false, "the back end has no bypass mode") };
  // The mode is the CLI's own: it shows only as a command that runs with no permission request.
  await s.main.session.setPermissionMode(mode.bypass);
  const mark = s.owner.asked.length;
  const marker = join(s.workdir, "bypass-ran.txt");
  let turn: Turn;
  try {
    turn = await s.main.turn(
      "Use the Bash tool to run exactly this command: echo ok > bypass-ran.txt\nThen reply: done",
    );
  } finally {
    await s.main.session.setPermissionMode(mode.default);
  }
  const called =
    ofType(turn.events, "call_started").some((event) => event.toolName === "Bash") &&
    existsSync(marker);
  const asked = s.askedSince(mark);
  return {
    P9: observation(
      called,
      asked.length === 0,
      asked.length > 0 ? `asked for ${asked.join(", ")}` : called ? "" : "no Bash call",
    ),
  };
}

/** Whether `path` is `base` or lies below it. */
function inside(base: string, path: string): boolean {
  const way = relative(base, path);
  return way !== ".." && !way.startsWith(`..${sep}`) && !isAbsolute(way);
}

function initRepo(path: string, branch: string): void {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  const made = spawnSync("git", ["init", "-q", "-b", branch, path], { env });
  if (made.status !== 0) throw new Error("git init failed");
}

async function workingFolder(s: Stage): Promise<Seen> {
  // Last: the session stays in the child folder, where the other scenes' files do not go.
  const app = join(s.workdir, "app");
  const branch = `probe-${randomBytes(3).toString("hex")}`;
  await mkdir(app);
  initRepo(app, branch);
  const turn = await s.main.turn(
    "Use the Bash tool to run exactly this command: cd app\nThen reply: done",
  );
  // A `cd` inside the working folder asks for no approval (measured 2026-09-27, 2.1.283): the
  // call shows on its card only.
  const called = ofType(turn.events, "call_started").some((event) => event.toolName === "Bash");
  const where = ofType(turn.events, "folder_changed").at(-1)?.folder ?? null;
  const moved = where !== null && (await realpath(where)) === (await realpath(app));
  // The probe's own folders stand for trusted ones: the owner's record of trusted folders knows
  // none of them, and the repository made above lies inside the session's folder.
  const here = await realpath(s.workdir);
  const repository = async (folder: string): Promise<Repository | null> => {
    try {
      const found = await locate(folder);
      return found !== null && inside(here, found.key) ? found : null;
    } catch {
      return null;
    }
  };
  const [shownBranch] = where === null ? [null] : await gitState(where, repository);
  const shown = shownBranch === branch;
  const detail = `folder moved: ${moved}, branch shown: ${shown}`;
  return {
    P14: observation(called, moved && shown, moved && shown ? "" : detail),
  };
}

async function replay(s: Stage): Promise<Seen> {
  const turn = await s.main.turn("Reply with the single word: ready");
  const echoed = turn.events.findIndex(
    (event) => event.type === "prompt_taken" && event.promptId === turn.id,
  );
  // Events keep the order of the records they come from, so the order here is the stream's.
  const streamed = turn.events.findIndex(
    (event) =>
      event.type === "message_started" ||
      event.type === "text_started" ||
      event.type === "text_delta",
  );
  if (echoed < 0) return { P19: observation(true, false, "no prompt_taken carried the uuid sent") };
  const early = streamed < 0 || echoed < streamed;
  return {
    P19: observation(
      true,
      early,
      early ? "" : "the replay came after the turn's first stream event",
    ),
  };
}

/**
 * P26: the result of `/effort` and of `/model` names the command in `local_command`, so the back
 * end says the level each set (`effort_changed`), and the PostModelSwitch hook before the result
 * of `/model` gives the model it switched to (`model_changed`). The scene crosses to Sonnet and
 * back, since `/model haiku` on a session already on Haiku may switch nothing. The session ends
 * on `auto`, the default it started with, and on the model it started on; no command costs a
 * token.
 */
async function effortCommands(s: Stage): Promise<Seen> {
  const levels: (string | null | undefined)[] = [];
  for (const command of ["/effort low", "/model haiku", "/effort auto"]) {
    const turn = await s.main.turn(command);
    const changed = ofType(turn.events, "effort_changed");
    levels.push(changed.length === 1 ? changed[0]?.level : undefined);
  }
  const holds = levels[0] === "low" && levels[1] === null && levels[2] === "auto";
  const detail = holds
    ? ""
    : `the level each command said: ${levels.map((l) => (l === undefined ? "no event" : String(l))).join(", ")}`;
  const models: (string | undefined)[] = [];
  for (const command of ["/model sonnet", "/model haiku"]) {
    const turn = await s.main.turn(command);
    const changed = ofType(turn.events, "model_changed");
    const before =
      turn.events.findIndex((event) => event.type === "model_changed") <
      turn.events.findIndex((event) => event.type === "turn_ended");
    models.push(changed.length === 1 && before ? changed[0]?.model : undefined);
  }
  const switched = models[0] !== undefined && models[1] !== undefined && models[0] !== models[1];
  const said = switched
    ? ""
    : `the model each command said: ${models.map((m) => m ?? "no event").join(", ")}`;
  return {
    P26: observation(true, holds && switched, [detail, said].filter(Boolean).join("; ")),
  };
}

async function goal(s: Stage): Promise<Seen> {
  // A goal met by its first turn, so the scene is one turn and leaves no goal behind.
  const condition = "Reply with the single word tick.";
  const line = `Goal set: ${condition}`;
  const recorded = s.records.length;
  const turn = await s.main.turn(`/goal ${condition}`);
  const first = turn.events.find((event) => event.type === "text" || event.type === "text_delta");
  const reply = writtenIn(turn.events);
  // The line is a message no `message_start` announced, which the back end gives whole.
  const opens = first?.type === "text" && first.text.startsWith(line);
  const once = reply.split("Goal set:").length === 2 && reply.length > line.length;
  const detail =
    opens && once ? "" : `opens with the line: ${opens}, once and with a reply: ${once}`;
  // The store's entries, which the back end turns into `goal_changed`.
  const goals = turn.events.flatMap((event) => (event.type === "goal_changed" ? [event.goal] : []));
  const ended = turn.events.findIndex((event) => event.type === "turn_ended");
  const last = turn.events.findLastIndex((event) => event.type === "goal_changed");
  const achieved = goals.at(-1);
  const counted =
    achieved?.state === "achieved" &&
    achieved.turns !== null &&
    achieved.durationMs !== null &&
    achieved.tokens !== null;
  const lifecycle =
    goals.map((change) => change.state).join(",") === "set,achieved" && counted && last < ended;
  const said = lifecycle
    ? ""
    : `goal changes: ${goals.map((change) => change.state).join(", ") || "none"}, counted: ${counted}, before the end: ${last < ended}`;
  return {
    P20: observation(true, opens && once, detail),
    P33: observation(opens, lifecycle, said),
    L9: judgeGoalStream(s.records.slice(recorded)),
  };
}

async function compact(s: Stage): Promise<Seen> {
  // Runs last of the session's scenes: the session it leaves holds a summary in place of them.
  const turn = await s.main.turn("/compact");
  const at = (type: SessionEvent["type"]) => turn.events.findIndex((event) => event.type === type);
  const boundary = at("compacted");
  const result = at("turn_ended");
  // The frames that start a reply: nothing of one comes before the boundary.
  const starts = turn.events.findIndex((event) =>
    ["message_started", "text_started", "text_delta", "text", "call_started"].includes(event.type),
  );
  const compacted = ofType(turn.events, "compacted")[0];
  const shown = boundary >= 0 && (starts < 0 || boundary < starts) && result > boundary;
  const announced = at("compaction_started") >= 0 && at("compaction_started") < boundary;
  return {
    P21: observation(
      true,
      shown,
      shown
        ? `tokens ${compacted?.tokensBefore ?? "none"} to ${compacted?.tokensAfter ?? "none"}`
        : `the turn's events: ${turn.events.map((event) => event.type).join(",")}`,
      // The token counts differ on every run: only that they were reported is a fact, and the
      // one the pass does not require.
      { tokensReported: compacted?.tokensBefore != null && compacted?.tokensAfter != null },
    ),
    P22: observation(true, announced, announced ? "" : "no compaction_started before the boundary"),
  };
}

/**
 * P23: every command the page lists as not offered got the refusal Claude Code gives (measured
 * 2026-10-09, Claude Code 2.1.292, kept by the scene). The control is the refusal itself: it
 * holds for at least one command, else the answers are a reworded refusal or a removed command and
 * prove nothing about the limits. A command with no answer at all proves nothing either. FELL only
 * for the commands whose answer differs while others still give the refusal.
 */
export function judgeNotOffered(answered: ReadonlyMap<string, string>): Observation {
  const silent = [...answered].filter(([, text]) => text.trim() === "").map(([name]) => `/${name}`);
  if (silent.length > 0) return observation(false, false, `no answer to ${silent.join(", ")}`);
  const offered = [...answered]
    .filter(([, text]) => !text.includes(UNAVAILABLE))
    .map(([name]) => `/${name}`);
  if (offered.length === answered.size) {
    return observation(false, false, "no command got the known refusal");
  }
  let detail = `${answered.size} commands sent`;
  if (offered.length > 0) detail += `; answered otherwise: ${offered.join(", ")}`;
  return observation(true, offered.length === 0, detail);
}

/** Sends every command the limits page lists as not offered, as the daemon sends a `!name`. */
async function commandsNotOffered(s: Stage): Promise<Seen> {
  const answered = new Map<string, string>();
  for (const name of notOffered()) {
    const turn = await s.main.turn(`/${name}`);
    answered.set(
      name,
      writtenIn(turn.events) + (ofType(turn.events, "turn_ended")[0]?.finalText ?? ""),
    );
  }
  // Each costs no tokens: Claude Code answers it itself.
  return { P23: judgeNotOffered(answered) };
}

/** The server a probe session declares and its folder's entry switches off: the scene's control. */
const CONTROL_SERVER = "control";

/** How long a session gets to register its servers before the list is read. */
const SERVERS_SETTLE_MS = 4000;

/**
 * What a session's servers say about computer use. The control is a server the session declares
 * and the folder's entry in `.claude.json` switches off: listed as `disabled`, it shows that entry
 * was read, so the absence of a computer-use server beside it is about computer use and not about
 * an entry nobody read.
 */
export function judgeComputerUse(
  servers: readonly { readonly name: string; readonly status: string }[],
): Observation {
  const listed =
    servers.map((server) => `${server.name} ${server.status}`).join(", ") || "no server";
  if (servers.find((server) => server.name === CONTROL_SERVER)?.status !== "disabled") {
    return observation(false, false, `the folder's entry was not read: ${listed}`);
  }
  const computer = servers.some((server) => /computer/i.test(server.name));
  return observation(true, !computer, computer ? `listed: ${listed}` : "", {
    servers: servers.map((server) => `${server.name} ${server.status}`).sort(),
  });
}

/**
 * Starts a session in a folder whose entry switches computer use on, and reads the servers it
 * lists; no prompt is sent. The entry sits in a temporary home given to the Claude Code process
 * (`HOME`), so the owner's `~/.claude.json` is neither read nor changed. The claim is about a raw
 * list the back end does not expose, which is why this scene reads the SDK itself.
 */
async function computerUse(s: Stage): Promise<Seen> {
  const home = join(s.root, "computer-use-home");
  const folder = join(s.root, "computer-use");
  await mkdir(home);
  await mkdir(folder);
  const entry = { enabledMcpServers: ["computer-use"], disabledMcpServers: [CONTROL_SERVER] };
  await writeFile(join(home, ".claude.json"), JSON.stringify({ projects: { [folder]: entry } }));
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  // It would send Claude Code to another folder for its configuration.
  delete env.CLAUDE_CONFIG_DIR;
  const input = new AsyncQueue<SDKUserMessage>();
  const raw = s.query({
    prompt: input,
    options: {
      cwd: folder,
      settingSources: [],
      model: PROBE_MODEL,
      env,
      mcpServers: { [CONTROL_SERVER]: { command: process.execPath, args: ["-e", ""] } },
    },
  });
  try {
    await raw.initializationResult();
    // Some servers register after the session starts: absence is read once they had time to.
    await new Promise<void>((resolve) => setTimeout(resolve, SERVERS_SETTLE_MS));
    return { P24: judgeComputerUse(await raw.mcpServerStatus()) };
  } finally {
    input.end();
    raw.close();
  }
}

/**
 * P25: what a raw stream says of the first turn Claude Code opened by itself, which a result
 * whose origin is `task-notification` closes. The claim holds while no user record of that
 * origin came in that turn, since such a record would carry the text that woke it (recorded
 * absent on Claude Code 2.1.300: `test/fixtures/sdk/background-forms.jsonl`). Unproven when no
 * such turn came.
 */
export function judgeWake(records: readonly unknown[]): Observation {
  let woke: string[] = [];
  for (const record of records) {
    if (!isRecord(record)) continue;
    const kind = isRecord(record.origin) ? record.origin.kind : null;
    if (record.type === "user" && kind === "task-notification") {
      woke.push(JSON.stringify(isRecord(record.message) ? record.message.content : null));
    }
    if (record.type !== "result") continue;
    if (kind === "task-notification") {
      const said = woke.length === 0;
      return observation(true, said, said ? "" : `a user record came first: ${woke[0]}`);
    }
    woke = []; // a turn of the owner's: what came in it opened none of Claude Code's own
  }
  return observation(false, false, "no turn opened by a task's notification");
}

/**
 * Runs a command in the background and reads the raw stream up to the turn its end opens. The
 * back end turns neither a user record of origin `task-notification` nor a result's origin into
 * an event of its own, which is why this scene reads the SDK itself. The session may run Bash
 * alone.
 */
async function backgroundWake(s: Stage): Promise<Seen> {
  const folder = join(s.root, "wake");
  await mkdir(folder);
  const input = new AsyncQueue<SDKUserMessage>();
  // The owner's login, as for every session of the probe; no setting source.
  const raw = s.query({
    prompt: input,
    options: {
      cwd: folder,
      settingSources: [],
      model: PROBE_MODEL,
      // As the daemon passes it (`src/agent/claude/session.ts`): Claude Code re-emits each
      // prompt it takes, a task's notification folded into a running turn included.
      extraArgs: { "replay-user-messages": null },
      canUseTool: async (toolName, toolInput) =>
        toolName === "Bash"
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: "the probe allows Bash alone" },
    },
  });
  const records: unknown[] = [];
  let late = false;
  // A turn that never comes learns nothing: the stream is closed, and the claim is unproven.
  const timer = setTimeout(() => {
    late = true;
    raw.close();
  }, WAKE_LIMIT);
  try {
    input.push({
      type: "user",
      message: {
        role: "user",
        content:
          "Use the Bash tool with run_in_background set to true to run `sleep 3; echo done`. " +
          "Then reply with the single word: started. When you are told the command finished, " +
          "reply with the single word: finished.",
      },
      parent_tool_use_id: null,
    });
    try {
      for await (const record of raw) {
        records.push(record);
        // Read as any record of Claude Code's is: unknown, narrowed where it is read.
        const seen: unknown = record;
        const origin = isRecord(seen) && isRecord(seen.origin) ? seen.origin.kind : null;
        if (record.type === "result" && origin === "task-notification") break;
      }
    } catch (error) {
      if (!late) throw error;
    }
    return { P25: judgeWake(records) };
  } finally {
    clearTimeout(timer);
    input.end();
    raw.close();
  }
}

/**
 * P29: the SDK's listing reads the folder `CLAUDE_CONFIG_DIR` names from the process environment,
 * the only way it takes one (`ListSessionsOptions` has no such option, sdk.d.ts 0.3.301). A
 * session cannot show it: a fresh folder has no login. So a transcript of the shape Claude Code
 * writes is placed in a folder of its own and listed with the variable pointing there, which
 * needs no token. The variable is put back whatever happens, since the scenes after this one
 * start sessions that inherit the environment.
 */
export async function configFolderListing(root: string): Promise<Seen> {
  const config = join(root, "login");
  const project = join(root, "listed");
  await mkdir(project);
  const folder = join(config, "projects", await projectKey(project));
  await mkdir(folder, { recursive: true });
  const id = randomUUID();
  const line = {
    type: "user",
    timestamp: "2026-10-17T10:00:00.000Z",
    sessionId: id,
    uuid: randomUUID(),
    parentUuid: null,
    message: { role: "user", content: "a question" },
  };
  await writeFile(join(folder, `${id}.jsonl`), `${JSON.stringify(line)}\n`);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const found = await directorySessions(project);
    const listed = found.some((entry) => entry.id === id);
    return {
      P29: observation(true, listed, listed ? "" : `${found.length} sessions listed`),
    };
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

/**
 * P31: the SDK's `tagSession` (through the back end's `tagSession`) writes a tag into a session's
 * transcript and clears it, and `getSessionInfo` reads each state back. Like P29 it needs no
 * login: a transcript of the shape Claude Code writes is placed in a folder of its own, with
 * `CLAUDE_CONFIG_DIR` pointing there, put back whatever happens.
 */
export async function sessionTag(root: string): Promise<Seen> {
  const config = join(root, "tag-login");
  const project = join(root, "tagged");
  await mkdir(project);
  const folder = join(config, "projects", await projectKey(project));
  await mkdir(folder, { recursive: true });
  const id = randomUUID();
  const line = {
    type: "user",
    timestamp: "2026-10-19T10:00:00.000Z",
    sessionId: id,
    uuid: randomUUID(),
    parentUuid: null,
    message: { role: "user", content: "a question" },
  };
  await writeFile(join(folder, `${id}.jsonl`), `${JSON.stringify(line)}\n`);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const backend = new ClaudeBackend();
    const tagOf = async () => (await getSessionInfo(id, { dir: project }))?.tag;
    const read: Array<string | undefined> = [];
    await backend.tagSession(project, id, "probe-a");
    read.push(await tagOf());
    await backend.tagSession(project, id, "probe-b");
    read.push(await tagOf());
    await backend.tagSession(project, id, null);
    read.push(await tagOf());
    const held = read[0] === "probe-a" && read[1] === "probe-b" && read[2] === undefined;
    return {
      P31: observation(true, held, held ? "" : `read back ${JSON.stringify(read)}`),
    };
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

// The value the scene gives `BASH_DEFAULT_TIMEOUT_MS`: 90 minutes, one no default of Claude Code's
// is, so a Bash tool that states it was told it.
const BASH_TIMEOUT_MS = "5400000";
// How long the request's record gets to reach the capture folder after the turn ended.
const CAPTURE_LIMIT = 15_000;

interface Tool {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly input_schema?: unknown;
}

/**
 * P30: what the first main-loop request of a session started as the daemon starts it says of the
 * terminal-parity options (`SYSTEM_PROMPT`, `TERMINAL_DEFAULTS`, `TOOL_CONFIG` and the owner's
 * `BASH_DEFAULT_TIMEOUT_MS` of `src/agent/claude/session.ts`). The body is the Messages API
 * request Claude Code wrote with `OTEL_LOG_RAW_API_BODIES=file:<dir>` (Claude Code 2.1.302):
 * `system` is a list of text blocks and `tools` a list of `{ name, description, input_schema }`.
 * It holds when the system prompt has the sections of the `claude_code` preset the SDK's minimal
 * prompt lacks, the Agent tool has no `run_in_background` (fork mode), the Bash tool's
 * description states `timeout` as its default, and the AskUserQuestion tool's description has the
 * "Preview feature:" section, which Claude Code adds only with a `previewFormat` (measured
 * 2026-10-20, Claude Code 2.1.304). Nothing is caused when the body has no system
 * prompt or no Agent or Bash tool: the request is not the one the claim is about.
 */
export function judgeTerminalForm(body: unknown, timeout: string): Observation {
  if (!isRecord(body) || !Array.isArray(body.system) || !Array.isArray(body.tools)) {
    return observation(false, false, "the request has no system prompt or no tools");
  }
  const system = body.system
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
  const tools = body.tools.filter(isRecord) as Tool[];
  const agent = tools.find((tool) => tool.name === "Agent");
  const bash = tools.find((tool) => tool.name === "Bash");
  if (!agent || !bash) {
    return observation(false, false, `tools listed: ${tools.map((tool) => tool.name).join(", ")}`);
  }
  const failed: string[] = [];
  const sections = ["# Session-specific guidance", "# Context management"];
  if (!sections.every((heading) => system.includes(heading))) {
    failed.push(`system prompt of ${system.length} characters lacks the preset's sections`);
  }
  const properties = isRecord(agent.input_schema) ? agent.input_schema.properties : null;
  if (!isRecord(properties) || "run_in_background" in properties) {
    failed.push("the Agent tool offers run_in_background (fork mode is off)");
  }
  const stated = /default (\d+)/.exec(typeof bash.description === "string" ? bash.description : "");
  if (stated?.[1] !== timeout) {
    failed.push(`the Bash tool states a default of ${stated?.[1] ?? "none"}, not ${timeout}`);
  }
  const question = tools.find((tool) => tool.name === "AskUserQuestion");
  if (!question) {
    failed.push("no AskUserQuestion tool");
  } else if (!String(question.description ?? "").includes("Preview feature:")) {
    failed.push("the AskUserQuestion tool says nothing of previews");
  }
  return observation(true, failed.length === 0, failed.join("; "));
}

// The sections of the `claude_code` preset the SDK's minimal prompt lacks: their presence shows a
// request is the one the system-prompt limits are about.
const PRESET_SECTIONS = ["# Session-specific guidance", "# Context management"];
// The identity lines (measured 2026-10-21, Claude Code 2.1.304: the SDK's in a session's request,
// the terminal's in `docs/limits.md`, read 2026-10-20).
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
// The terminal's hint line and the line beside it, which a session's prompt keeps (measured
// 2026-10-21, Claude Code 2.1.304, in the CLI's own text and in a session's request).
const BANG_HINT = "type `! <command>`";
const BANG_NEIGHBOUR = "When the user types `/<skill-name>`";
// The three skills on artifacts and the agent on Claude Code, which the terminal lists.
const ARTIFACT_SKILLS = ["artifact-design", "artifact-diagramming", "artifact-capabilities"];
const GUIDE_AGENT = "claude-code-guide";
// The terminal's summary instructions and the SDK's (measured 2026-10-21, Claude Code 2.1.304).
const TERMINAL_SUMMARY = "2000 words or fewer";
const SDK_SUMMARY = "Primary Request and Intent";

/**
 * L1: the Bash tool's description states the three time limits `docs/limits.md` gives: a
 * foreground default of 120000 ms, a background default of 1800000 ms, and that a command is
 * stopped at that limit (measured 2026-10-21, Claude Code 2.1.304: "`timeout` is in milliseconds:
 * default 120000, max 600000 for a foreground command", "(default 1800000, max 7200000); at that
 * limit it is stopped and you are re-invoked"). The description is the control: unproven unless it
 * still has the sentence on `timeout` and `run_in_background` and both numbers parse. It FELL only
 * when a parsed number differs from the measured one; a reworded sentence, the stop included, is
 * unproven (the terminal's wording was not measured, so its appearance cannot be the signal).
 */
export function judgeBashLimits(description: unknown): Observation {
  const text = typeof description === "string" ? description : "";
  if (!text.includes("`timeout` is in milliseconds") || !text.includes("run_in_background")) {
    return observation(false, false, "the Bash description has no sentence on its timeout");
  }
  const foreground = /`timeout` is in milliseconds: default (\d+)/.exec(text)?.[1];
  const background = /in the background \(default (\d+)/.exec(text)?.[1];
  // A number that does not parse is a sentence worded another way, which says nothing of the limit.
  if (foreground === undefined || background === undefined) {
    return observation(false, false, "a time limit of the Bash description does not parse");
  }
  if (foreground !== "120000" || background !== "1800000") {
    return observation(
      true,
      false,
      `foreground default ${foreground}, background default ${background}`,
    );
  }
  // Both numbers are the measured ones: only the stop is left, and a stop worded another way is a
  // reworded tool, not a command that outlives its limit.
  const stopped = text.includes("at that limit it is stopped");
  return observation(
    stopped,
    stopped,
    stopped ? "" : "the sentence on the stop at the limit is gone",
  );
}

/**
 * L2: no `session_state_changed` record in a turn of a session started without the variable that
 * asks for it (measured 2026-10-21, SDK 0.3.304: none without, one with). The control is the turn
 * itself: an initialization message and a result.
 */
export function judgeStateEvents(records: readonly unknown[]): Observation {
  const rows = records.filter(isRecord);
  const init = rows.some((row) => row.type === "system" && row.subtype === "init");
  if (!init || !rows.some((row) => row.type === "result")) {
    return observation(false, false, "the turn gave no initialization message or no result");
  }
  const states = rows.filter(
    (row) => row.type === "system" && row.subtype === "session_state_changed",
  ).length;
  return observation(true, states === 0, states === 0 ? "" : `${states} session_state_changed`);
}

/**
 * L3: the tools a session lists (the initialization message, deferred ones included) hold no
 * `Artifact`, `SendFeedback` or `EndConversation`. The control is a list that holds `Bash`,
 * `Skill` and `ToolSearch`.
 */
export function judgeToolList(tools: readonly string[]): Observation {
  if (!["Bash", "Skill", "ToolSearch"].every((name) => tools.includes(name))) {
    return observation(false, false, `tools listed: ${tools.join(", ")}`);
  }
  const offered = ["Artifact", "SendFeedback", "EndConversation"].filter((name) =>
    tools.includes(name),
  );
  return observation(true, offered.length === 0, offered.length === 0 ? "" : `listed: ${offered}`);
}

/**
 * L4: the system prompt does not carry the terminal's identity line. Unproven unless it has the
 * preset's sections and one of the two known lines: a reworded line proves nothing.
 */
export function judgeIdentity(system: string): Observation {
  const sdk = system.includes(SDK_IDENTITY);
  const cli = system.includes(CLI_IDENTITY);
  if (!PRESET_SECTIONS.every((heading) => system.includes(heading)) || (!sdk && !cli)) {
    return observation(false, false, "the system prompt has no known identity line");
  }
  return observation(true, !cli, cli ? "the system prompt says it is Claude Code's CLI" : "");
}

/**
 * L5: the system prompt does not suggest typing `! <command>`. The control is the line beside the
 * hint in the terminal's prompt, which a session keeps: unproven unless it is there.
 */
export function judgeBangHint(system: string): Observation {
  if (!system.includes(BANG_NEIGHBOUR) || !PRESET_SECTIONS.every((h) => system.includes(h))) {
    return observation(false, false, "the system prompt lacks the lines around the hint");
  }
  const hinted = system.includes(BANG_HINT);
  return observation(true, !hinted, hinted ? "the system prompt suggests `! <command>`" : "");
}

/**
 * L6: the agents and skills a session lists hold neither the agent on Claude Code nor the skills
 * on artifacts. The control is a list that holds a general-purpose agent and some skill.
 */
export function judgeAgentsAndSkills(
  agents: readonly string[],
  skills: readonly string[],
): Observation {
  if (!agents.includes("general-purpose") || skills.length === 0) {
    return observation(false, false, `agents: ${agents.join(", ")}; ${skills.length} skills`);
  }
  const offered = [GUIDE_AGENT, ...ARTIFACT_SKILLS].filter(
    (name) => agents.includes(name) || skills.includes(name),
  );
  return observation(true, offered.length === 0, offered.length === 0 ? "" : `listed: ${offered}`);
}

/**
 * L8: the instructions of the request a `/compact` sends are the SDK's long form, not the
 * terminal's "2000 words or fewer". Unproven unless the text is a summary request in one of the
 * two forms; null is no such request.
 */
export function judgeCompactionForm(instructions: string | null): Observation {
  const text = instructions ?? "";
  const terminal = text.includes(TERMINAL_SUMMARY);
  if (!text.includes("<summary>") || (!terminal && !text.includes(SDK_SUMMARY))) {
    return observation(false, false, "no request carried the summary instructions");
  }
  return observation(
    true,
    !terminal,
    terminal ? "the instructions are the terminal's short form" : "",
  );
}

/**
 * L9: no `active_goal` record in the stream of a `/goal` turn (measured 2026-10-20, SDK 0.3.304:
 * 0 in three runs). The control is the turn: a result, and the command's own `Goal set:` line.
 */
export function judgeGoalStream(records: readonly unknown[]): Observation {
  const rows = records.filter(isRecord);
  const said = rows.some((row) => JSON.stringify(row).includes("Goal set:"));
  if (!said || !rows.some((row) => row.type === "result")) {
    return observation(false, false, "the turn gave no goal line or no result");
  }
  const active = rows.filter((row) => row.type === "active_goal").length;
  return observation(true, active === 0, active === 0 ? "" : `${active} active_goal records`);
}

/** The records of a capture folder's index, in the order written; empty before the first. */
async function captured(folder: string): Promise<{ source: unknown; body: unknown }[]> {
  const out: { source: unknown; body: unknown }[] = [];
  try {
    const lines = (await readFile(join(folder, "index.jsonl"), "utf8")).split("\n");
    for (const line of lines.filter((text) => text.trim() !== "")) {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry) || typeof entry.request_file !== "string") continue;
      const body: unknown = JSON.parse(
        await readFile(join(folder, basename(entry.request_file)), "utf8"),
      );
      out.push({ source: entry.query_source, body });
    }
  } catch {
    // The record is not written yet.
  }
  return out;
}

/** Polls `captured` until `pick` finds a request or CAPTURE_LIMIT passes (then null). */
async function awaited<T>(
  folder: string,
  pick: (requests: { source: unknown; body: unknown }[]) => T | null,
): Promise<T | null> {
  const deadline = Date.now() + CAPTURE_LIMIT;
  for (;;) {
    const found = pick(await captured(folder));
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

/** The main-loop request of a capture folder (`query_source` sdk), once its record is written. */
async function mainRequest(folder: string): Promise<unknown> {
  const found = await awaited(
    folder,
    (requests) => requests.find((r) => r.source === "sdk") ?? null,
  );
  if (found === null) throw new ProbeTimeout("no main request was captured");
  return found.body;
}

/** The system prompt of a request body, its text blocks joined. */
function systemOf(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.system)) return "";
  return body.system
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

/** The text of a request's last message, whether its content is a string or text blocks. */
function lastMessage(body: unknown): string {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const last: unknown = messages.at(-1);
  const content = isRecord(last) ? last.content : null;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
        .join("\n")
    : "";
}

/**
 * Starts a session through a back end of its own, as the daemon builds one with the owner's
 * variables, and reads the first request it sent. `OTEL_LOG_RAW_API_BODIES` reaches Claude Code
 * through the same `variables` as the owner's `BASH_DEFAULT_TIMEOUT_MS`; the capture needs no
 * telemetry setting (measured 2026-10-19, Claude Code 2.1.302). The folder is removed again
 * whatever happens, since the bodies hold the owner's own instructions.
 * `CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR` shows in no request, so it stays a check by hand.
 *
 * The same request answers L4 and L5 (the identity line, the hint on `!`). A `/compact` as the
 * second turn answers L8: the request that follows it carries the summary instructions, which
 * compaction of one turn accepts (measured 2026-10-21, Claude Code 2.1.304). That turn can fail
 * without costing P30 its result, and a failure leaves L8 unproven.
 */
async function terminalForm(s: Stage): Promise<Seen> {
  const capture = join(s.root, "capture");
  const folder = join(s.root, "terminal-form");
  await mkdir(capture);
  await mkdir(folder);
  const backend = new ClaudeBackend({
    home: s.home,
    variables: {
      BASH_DEFAULT_TIMEOUT_MS: BASH_TIMEOUT_MS,
      OTEL_LOG_RAW_API_BODIES: `file:${capture}`,
    },
  });
  try {
    const live = new Live(await backend.start(s.options(folder), s.owner));
    s.lives.push(live);
    await live.turn("Reply with the single word: ok");
    const main = await mainRequest(capture);
    const system = systemOf(main);
    const seen: Seen = {
      P30: judgeTerminalForm(main, BASH_TIMEOUT_MS),
      L4: judgeIdentity(system),
      L5: judgeBangHint(system),
    };
    try {
      await live.turn("/compact");
      // Claude Code tags the request of a compaction `query_source` compact (measured 2026-10-21,
      // Claude Code 2.1.304); the text markers of the judge are its control.
      const instructions = await awaited(capture, (requests) => {
        const texts = requests
          .filter((r) => r.source === "compact")
          .map((r) => lastMessage(r.body));
        return texts.find((text) => text.includes("<summary>")) ?? null;
      });
      seen.L8 = judgeCompactionForm(instructions);
    } catch (error) {
      seen.L8 = observation(false, false, `the /compact turn raised ${(error as Error).name}`);
    }
    return seen;
  } finally {
    await rm(capture, { recursive: true, force: true });
  }
}

/**
 * The scene of the limits that need a session with none of the daemon's variables: a session
 * started by the back end with `BASH_DEFAULT_TIMEOUT_MS` out of the environment gives its first
 * request (L1), and a raw session with the state variable out of it gives a turn's records, the
 * tools, agents and skills of its initialization message (L2, L3, L6). Both
 * variables are put back whatever happens, since the scenes after this one start sessions that
 * inherit the environment.
 */
export async function plainSession(s: Stage): Promise<Seen> {
  const names = ["BASH_DEFAULT_TIMEOUT_MS", "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS"] as const;
  const kept = names.map((name) => process.env[name]);
  for (const name of names) delete process.env[name];
  try {
    const capture = join(s.root, "plain-capture");
    const folder = join(s.root, "plain-session");
    await mkdir(capture);
    await mkdir(folder);
    let bash: unknown = null;
    try {
      const backend = new ClaudeBackend({
        home: s.home,
        variables: { OTEL_LOG_RAW_API_BODIES: `file:${capture}` },
      });
      const live = new Live(await backend.start(s.options(folder), s.owner));
      s.lives.push(live);
      await live.turn("Reply with the single word: ok");
      const main = await mainRequest(capture);
      const tools = isRecord(main) && Array.isArray(main.tools) ? main.tools.filter(isRecord) : [];
      bash = (tools as Tool[]).find((tool) => tool.name === "Bash")?.description;
    } finally {
      await rm(capture, { recursive: true, force: true });
    }
    const input = new AsyncQueue<SDKUserMessage>();
    const raw = s.query({
      prompt: input,
      options: { cwd: folder, settingSources: [], model: PROBE_MODEL },
    });
    const rows: unknown[] = [];
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      raw.close();
    }, TURN_LIMIT);
    try {
      input.push({
        type: "user",
        message: { role: "user", content: "Reply with the single word: ok" },
        parent_tool_use_id: null,
      });
      try {
        for await (const record of raw) {
          rows.push(record);
          if (record.type === "result") break;
        }
      } catch (error) {
        if (!late) throw error;
      }
      if (late) throw new ProbeTimeout("the turn did not end in time");
    } finally {
      clearTimeout(timer);
      input.end();
      raw.close();
    }
    const init = rows
      .filter(isRecord)
      .find((row) => row.type === "system" && row.subtype === "init");
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return {
      L1: judgeBashLimits(bash),
      L2: judgeStateEvents(rows),
      L3: judgeToolList(strings(init?.tools)),
      L6: judgeAgentsAndSkills(strings(init?.agents), strings(init?.skills)),
    };
  } finally {
    names.forEach((name, at) => {
      const value = kept[at];
      if (value !== undefined) process.env[name] = value;
    });
  }
}

/** `work` or a ProbeTimeout past SETTINGS_LIMIT: a session that never answers must not hang the run. */
const SETTINGS_LIMIT = 60_000;
async function within<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProbeTimeout(`${what} did not come in time`)),
      SETTINGS_LIMIT,
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * P37: the mode a session reports at its start. The control is a session whose settings file
 * names no mode: it reports `default`, so the mode of the other came from its file and not from
 * a default of the release.
 */
export function judgeSettingsMode(unset: unknown, set: unknown): Observation {
  if (unset !== "default") {
    return observation(
      false,
      false,
      `the session with no mode in its settings reported ${String(unset)}`,
    );
  }
  return observation(
    true,
    set === SETTINGS_MODE,
    set === SETTINGS_MODE ? "" : `reported ${String(set)}`,
  );
}

/** The mode the settings file of the P37 scene names, one the release does not start in. */
const SETTINGS_MODE = "acceptEdits";

/**
 * The mode a session reports at its start when the user settings of its configuration folder
 * name one, and when they name none. No prompt is sent. `HOME` and `CLAUDE_CONFIG_DIR` point to
 * folders of this run, so neither the owner's settings nor their login is read.
 */
async function settingsMode(s: Stage): Promise<Seen> {
  const modes: unknown[] = [];
  for (const [name, mode] of [
    ["unset", null],
    ["set", SETTINGS_MODE],
  ] as const) {
    const home = join(s.root, `mode-${name}-home`);
    const config = join(s.root, `mode-${name}-config`);
    const folder = join(s.root, `mode-${name}`);
    for (const path of [home, config, folder]) await mkdir(path);
    await writeFile(join(home, ".claude.json"), "{}");
    await writeFile(
      join(config, "settings.json"),
      JSON.stringify(mode === null ? {} : { permissions: { defaultMode: mode } }),
    );
    const input = new AsyncQueue<SDKUserMessage>();
    const raw = s.query({
      prompt: input,
      options: {
        cwd: folder,
        settingSources: ["user"],
        model: PROBE_MODEL,
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config },
      },
    });
    try {
      // Not in the SDK's type: the daemon reads it from the untyped answer too (`agentInfo`).
      const init: unknown = await within(raw.initializationResult(), "the initialization result");
      modes.push(isRecord(init) ? init.current_permission_mode : null);
    } finally {
      input.end();
      raw.close();
    }
  }
  return { P37: judgeSettingsMode(modes[0], modes[1]) };
}

/** What Claude Code's stderr says of a folder that the record of trust does not hold. */
const UNTRUSTED_NOTICE = "this workspace has not been trusted";

/**
 * P34: the stderr of a session in a folder the record trusts and in one it does not. Both folders
 * hold project settings with a `permissions.allow` rule, which Claude Code ignores, and says so,
 * where the folder has no `hasTrustDialogAccepted` of its own (measured 2.1.304, 2026-10-21). The
 * control is the untrusted folder saying it: without it the notice is not Claude Code's to give.
 */
export function judgeTrust(trusted: readonly string[], untrusted: readonly string[]): Observation {
  const told = (lines: readonly string[]) => lines.some((line) => line.includes(UNTRUSTED_NOTICE));
  if (!told(untrusted)) {
    return observation(false, false, "the untrusted folder drew no notice about its settings");
  }
  return observation(
    true,
    !told(trusted),
    told(trusted) ? "the trusted folder drew the notice" : "",
  );
}

/**
 * P42: a session in a folder of its own whose project Stop hook says, at the turn's three ends, a
 * refusal, an added context, then a stop with its reason; each but the stop sends the turn on. The
 * turn is one Haiku turn of three short answers.
 */
async function stopHooks(s: Stage): Promise<Seen> {
  const cwd = join(s.workdir, "stop-hooks");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  const count = join(cwd, "stops");
  const said = [
    '{"decision":"block","reason":"say OSPREY"}',
    '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"say EGRET"}}',
    '{"continue":false,"stopReason":"enough birds"}',
  ];
  const hook = join(cwd, "stop-hook.sh");
  await writeFile(
    hook,
    [
      "#!/bin/sh",
      `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${count}'`,
      ...said.map((output, at) => `[ "$n" = ${at + 1} ] && printf '%s' '${output}'`),
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: hook }] }] } }),
  );
  const live = await s.open(cwd, { settingsSources: ["project"] });
  const turn = await live.turn("Reply with the single word HERON and nothing else.");
  const ran = ofType(turn.events, "stop_hooks_ran");
  const ended = turn.events.findIndex((event) => event.type === "turn_ended");
  const last = turn.events.findLastIndex((event) => event.type === "stop_hooks_ran");
  const shape = ran.map((event) => [event.hooks, event.stopReason, event.errors, event.context]);
  const expected = [
    [1, null, ["say OSPREY"], []],
    [1, null, [], ["say EGRET"]],
    [1, "enough birds", [], []],
  ];
  const holds = JSON.stringify(shape) === JSON.stringify(expected) && last < ended;
  const detail = holds
    ? ""
    : `the stop hooks said: ${s.scrubbed(JSON.stringify(shape), 400)}, before the end: ${last < ended}`;
  return { P42: observation(ran.length > 0, holds, detail) };
}

/**
 * Two sessions with no login, so no token is spent, against one record of trust in the place the
 * daemon reads it (`recordPath`): the folder it trusts, and the one it names as not trusted.
 */
async function folderTrust(s: Stage): Promise<Seen> {
  const home = join(s.root, "trust-home");
  const config = join(s.root, "trust-config");
  await mkdir(home);
  await mkdir(config);
  const folders = { trusted: join(s.root, "trust-yes"), untrusted: join(s.root, "trust-no") };
  const projects: Record<string, { hasTrustDialogAccepted: boolean }> = {};
  for (const [name, folder] of Object.entries(folders)) {
    await mkdir(join(folder, ".claude"), { recursive: true });
    await writeFile(
      join(folder, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(echo:*)"] } }),
    );
    projects[folder] = { hasTrustDialogAccepted: name === "trusted" };
  }
  await writeFile(recordPath(home, config), JSON.stringify({ projects }));
  const env = loggedOutEnv(home, config);
  const heard = {
    trusted: (await rawTurn(s, folders.trusted, env, ["project", "local"])).stderr,
    untrusted: (await rawTurn(s, folders.untrusted, env, ["project", "local"])).stderr,
  };
  return { P34: judgeTrust(heard.trusted, heard.untrusted) };
}

/** The variables that would log a session in without a login in its configuration folder. */
const LOGIN_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_PROFILE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
];

/**
 * The environment of a session that has no login: `HOME`, `CLAUDE_CONFIG_DIR` and
 * `XDG_CONFIG_HOME` point into this run's folders, and no variable that carries a login, a
 * credential file descriptor included, reaches it.
 */
function loggedOutEnv(home: string, config: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  for (const name of Object.keys(env)) {
    if (LOGIN_VARIABLES.includes(name) || name.endsWith("_FILE_DESCRIPTOR")) delete env[name];
  }
  return env;
}

/**
 * P39: what the back end reads from the records of a turn that had no login. The control is the
 * turn itself: a result that is not an error means the session was logged in after all (a
 * login that reached it from the machine), and nothing is learned.
 */
export function judgeLoggedOut(rows: readonly unknown[]): Observation {
  const result = rows.filter(isRecord).find((row) => row.type === "result");
  if (result?.is_error !== true) {
    return observation(
      false,
      false,
      "the turn ended without an error: a login reached the session",
    );
  }
  const translator = new Translator();
  const errors = rows
    .flatMap((row) => translator.translate(row))
    .filter((e) => e.type === "agent_error");
  const found = errors.some((e) => e.kind === "authentication" && e.text !== "");
  return observation(
    true,
    found,
    found ? "" : `agent errors read: ${errors.map((e) => e.category).join(", ") || "none"}`,
  );
}

/**
 * Starts a session whose configuration folder is empty, in a home of its own and with no login
 * variable, and sends one prompt. A session with no login answers at once, so no token is spent.
 */
async function loggedOut(s: Stage): Promise<Seen> {
  const home = join(s.root, "logged-out-home");
  const config = join(s.root, "logged-out-config");
  const folder = join(s.root, "logged-out");
  for (const path of [home, config, folder]) await mkdir(path);
  await writeFile(join(home, ".claude.json"), "{}");
  const { rows } = await rawTurn(s, folder, loggedOutEnv(home, config));
  return { P39: judgeLoggedOut(rows) };
}

/**
 * The records of one turn of a raw session, up to its result, and what its process wrote to
 * stderr; throws ProbeTimeout past TURN_LIMIT.
 */
async function rawTurn(
  s: Stage,
  folder: string,
  env: Record<string, string | undefined>,
  settingSources: ("project" | "local")[] = [],
): Promise<{ rows: unknown[]; stderr: string[] }> {
  const input = new AsyncQueue<SDKUserMessage>();
  const stderr: string[] = [];
  const raw = s.query({
    prompt: input,
    options: {
      cwd: folder,
      settingSources,
      model: PROBE_MODEL,
      env,
      stderr: (line) => stderr.push(line),
    },
  });
  const rows: unknown[] = [];
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    raw.close();
  }, TURN_LIMIT);
  try {
    input.push({
      type: "user",
      message: { role: "user", content: "Reply with the single word: ok" },
      parent_tool_use_id: null,
    });
    try {
      for await (const record of raw) {
        rows.push(record);
        if (record.type === "result") break;
      }
    } catch (error) {
      if (!late) throw error;
    }
    if (late) throw new ProbeTimeout("the turn did not end in time");
  } finally {
    clearTimeout(timer);
    input.end();
    raw.close();
  }
  return { rows, stderr };
}

/** A model name no account has, so the API refuses it (404 `model_not_found`, measured 2.1.304). */
const REFUSED_MODEL = "no-such-model-xyz";

/**
 * P40: the events of a turn the API refused. The control is the refusal itself: a turn that ends
 * with neither an error nor an agent error was not refused, and nothing is learned.
 */
export function judgeApiError(events: readonly SessionEvent[]): Observation {
  const errors = ofType(events, "agent_error");
  const ended = ofType(events, "turn_ended").at(-1);
  if (errors.length === 0 && ended?.ending !== "error") {
    return observation(false, false, "the API did not refuse the model");
  }
  const said = errors.find((e) => e.text !== "");
  const ok = said !== undefined && ended?.ending === "error";
  return observation(
    true,
    ok,
    ok ? "" : `agent errors: ${errors.length}, ending: ${ended?.ending}`,
    {
      category: said?.category ?? null,
    },
  );
}

/** One prompt on a model the API refuses; it costs no tokens, the request fails at the API. */
async function apiError(s: Stage): Promise<Seen> {
  const folder = join(s.root, "api-error");
  await mkdir(folder);
  // A release that checks the name itself refuses the open or ends the session: the API was
  // never asked, so nothing is learned (a ProbeTimeout is the machine's and passes on).
  try {
    const live = await s.open(folder, { model: REFUSED_MODEL });
    const turn = await live.turn("Reply with the single word: ok");
    return { P40: judgeApiError(turn.events) };
  } catch (error) {
    if (error instanceof ProbeTimeout) throw error;
    return {
      P40: observation(false, false, "the model name was refused before the API was asked"),
    };
  }
}

/** The owner that answers every question with its first option, and keeps what it was asked. */
class Answerer extends Owner {
  readonly questions: QuestionRequest[] = [];

  override async question(request: QuestionRequest): Promise<QuestionAnswer> {
    this.questions.push(request);
    const answers: Record<string, string> = {};
    for (const question of request.questions) {
      const [first] = question.options;
      if (first !== undefined) answers[question.text] = first.label;
    }
    return { answered: true, answers, notes: {} };
  }
}

/**
 * P36: the question that reached the owner and what the call returned. It holds while the
 * options came whole (two at least, each with a label) and the call's result quotes the first
 * option, the answer the owner gave. The control is the question reaching the owner and its
 * call ending: Claude may not ask at all.
 */
export function judgeQuestion(
  asked: readonly QuestionRequest[],
  events: readonly SessionEvent[],
): Observation {
  const request = asked[0];
  const ended = ofType(events, "call_ended").find((event) => event.callId === request?.callId);
  if (request === undefined || ended === undefined) {
    return observation(false, false, "Claude put no question, or the call did not end");
  }
  const question = request.questions[0];
  const labels = question?.options.map((option) => option.label) ?? [];
  const given = labels[0] ?? "";
  const whole = labels.length >= 2 && labels.every((label) => label !== "");
  // The tool's own sentence quotes the pair as `"<question>"="<answer>"` (measured 2.1.304).
  const pair = `"${question?.text ?? ""}"="${given}"`;
  const returned = !ended.isError && (ended.output ?? "").includes(pair);
  return observation(
    true,
    whole && returned,
    whole && returned ? "" : `options: ${labels.length}, result quotes the answer: ${returned}`,
  );
}

async function question(s: Stage): Promise<Seen> {
  const folder = join(s.root, "question");
  await mkdir(folder);
  const owner = new Answerer();
  const live = new Live(await s.backend.start(s.options(folder), owner));
  s.lives.push(live);
  const turn = await live.turn(
    "Use the AskUserQuestion tool to ask me which colour I prefer, with exactly two options labelled Teal and Amber. After my answer, reply with one sentence that names the colour I chose.",
  );
  return { P36: judgeQuestion(owner.questions, turn.events) };
}

/**
 * P35: a `SendMessage` call to a subagent that had ended, and the call's result. It holds when
 * the result carries the words the reply draws for it: `Resuming agent` and the first characters
 * of the id the call names (`resuming`). The control is such a call: Claude may not send one,
 * or send it to a subagent still running.
 */
export function judgeResumed(events: readonly SessionEvent[]): Observation {
  const ended = new Map<string, number>();
  events.forEach((event, at) => {
    // The first end counts: a resumed agent ends again after the message.
    if (event.type === "task_ended" && !ended.has(event.taskId)) ended.set(event.taskId, at);
  });
  const sent = events.flatMap((event, at) =>
    event.type === "call_started" &&
    event.toolName === "SendMessage" &&
    typeof event.input.to === "string"
      ? [{ callId: event.callId, to: event.input.to, at }]
      : [],
  );
  const call = sent.find((one) => (ended.get(one.to) ?? Number.POSITIVE_INFINITY) < one.at);
  const result = ofType(events, "call_ended").find((event) => event.callId === call?.callId);
  if (call === undefined || result === undefined) {
    return observation(false, false, "no message was sent to a subagent that had ended");
  }
  const words = resuming(call.to).replace(/^\S+ /, "");
  const said = (result.output ?? "").includes(words);
  return observation(
    true,
    said && !result.isError,
    said ? "" : "the result does not say the agent resumes",
  );
}

/** How long the P35 scene waits for its subagent to end. */
const ENDED_LIMIT = 90_000;

async function endedSubagent(s: Stage): Promise<Seen> {
  const folder = join(s.root, "ended-subagent");
  await mkdir(folder);
  const live = await s.open(folder);
  await live.turn(
    "Use the Agent tool to start a subagent with the prompt: Reply with the single word READY. Then reply: done",
  );
  // The message goes to a subagent that has ended: wait for its end, bounded.
  await live.until(0, (events) => events.some((event) => event.type === "task_ended"), ENDED_LIMIT);
  await live.quiet();
  // The id is the task's own, which the tool names its recipient by (measured 2.1.304).
  const agent = ofType(live.events, "task_started").find((event) => event.kind === "subagent");
  await live.turn(
    `Use the SendMessage tool to send the message 'Reply with the single word AGAIN' to the subagent you started, whose id is ${agent?.taskId ?? "unknown"}. Then reply: done`,
  );
  return { P35: judgeResumed(live.events) };
}

/** What one notification of a background subagent's end said, content-free. */
export type HandbackNotice = {
  /** `note` when the summary is Claude Code's note about the hand-back, else `words`. */
  readonly form: "note" | "words";
  /** The record's undocumented `handback`, when a string. */
  readonly handback: string | null;
  /** Whether `handback_report.text` is a non-empty string. */
  readonly reportText: boolean;
  /** How many tasks the subagent started were still running at this notification. */
  readonly running: number;
};

/** The first background subagent of the events, the tasks it started and its notifications. */
export interface HandbackFacts {
  /** How many tasks the subagent started in the background. */
  readonly started: number;
  /** Whether the subagent's task has ended and none of those tasks still runs. */
  readonly settled: boolean;
  readonly notifications: readonly HandbackNotice[];
  /** Whether the back end read a report from the subagent's last end. */
  readonly lastReport: boolean;
  /** Whether the back end read one of its ends as a report handed back (`reportSent`). */
  readonly sent: boolean;
}

/**
 * The pair P41 records for one mode: the form of the summary and the tasks the subagent still
 * ran at each of its notifications. The fixed words of the note are the name of the tool the
 * note points to (`SubagentHandback`, measured 2026-10-24 on 2.1.309 in auto mode; bypass mode
 * gave the agent's last words as the summary). `handback` and `handback_report` are not in
 * `sdk.d.ts` 0.3.310. The records and the events are two views of one stream, so the n-th
 * notification of the subagent is the n-th `task_ended` event of its task; a notification the
 * back end did not turn into an event counts the tasks as the events end.
 */
export function handbackFacts(
  events: readonly SessionEvent[],
  raw: readonly unknown[],
): HandbackFacts {
  const agent = ofType(events, "task_started").find(
    (event) => event.kind === "subagent" && event.background === true,
  );
  if (agent === undefined) {
    return { started: 0, settled: false, notifications: [], lastReport: false, sent: false };
  }
  const children = events.flatMap((event, at) =>
    event.type === "task_started" &&
    event.parentTaskId === agent.taskId &&
    event.background === true
      ? [{ id: event.taskId, at }]
      : [],
  );
  const endings = events.flatMap((event, at) =>
    event.type === "task_ended" ? [{ id: event.taskId, at, event }] : [],
  );
  const own = endings.filter((ending) => ending.id === agent.taskId);
  const notices = raw
    .filter(isRecord)
    .filter(
      (record) =>
        record.type === "system" &&
        record.subtype === "task_notification" &&
        record.task_id === agent.taskId,
    );
  const notifications = notices.map((record, n): HandbackNotice => {
    const at = own[n]?.at ?? events.length;
    const running = children.filter(
      (child) => child.at < at && !endings.some((end) => end.id === child.id && end.at < at),
    ).length;
    const report = isRecord(record.handback_report) ? record.handback_report.text : null;
    return {
      form:
        typeof record.summary === "string" && record.summary.includes("SubagentHandback")
          ? "note"
          : "words",
      handback: typeof record.handback === "string" ? record.handback : null,
      reportText: typeof report === "string" && report !== "",
      running,
    };
  });
  // The agent's own end after every task it started: a subagent that waited on its task is
  // notified again once that task has ended, and that notification is the one P41 needs.
  const last = own.at(-1)?.at ?? -1;
  const settled =
    own.length > 0 &&
    children.every((child) => endings.some((end) => end.id === child.id && end.at < last));
  return {
    started: children.length,
    settled,
    notifications,
    lastReport: (own.at(-1)?.event.report ?? null) !== null,
    sent: own.some((ending) => ending.event.reportSent),
  };
}

/** Why a mode did not give P41 what it needs, or null when it did. */
function handbackGap(mode: string, facts: HandbackFacts): string | null {
  if (facts.notifications.length === 0) return `${mode}: no notification of a background subagent`;
  if (facts.started === 0) return `${mode}: the subagent started no background task`;
  // The waiting the terminal draws needs a notification with the agent's own task running: one
  // that came only after its task had ended shows the end, never the wait.
  if (facts.notifications.every((notice) => notice.running === 0)) {
    return `${mode}: the subagent's own task had ended at every notification`;
  }
  return null;
}

/**
 * P41: a background subagent's end in two modes, the summary's form and the tasks it still ran
 * at each notification. It holds when the last notification gives the back end's `task_ended` a
 * report in both modes, and when in auto mode a notification marks it sent (`reportSent`). It is
 * caused only when each mode saw a notification while the subagent's own task still ran.
 */
export function judgeHandback(facts: {
  readonly bypass: HandbackFacts;
  readonly auto: HandbackFacts;
}): Observation {
  const gap = handbackGap("bypass", facts.bypass) ?? handbackGap("auto", facts.auto);
  if (gap !== null) return observation(false, false, gap);
  const seen = { bypass: facts.bypass.notifications, auto: facts.auto.notifications };
  const detail = !facts.bypass.lastReport
    ? "bypass: the last end carries no report"
    : !facts.auto.lastReport
      ? "auto: the last end carries no report"
      : !facts.auto.sent
        ? "auto: no notification reached the back end as a sent report"
        : "";
  return observation(true, detail === "", detail, seen);
}

/** How long the P41 scene waits for a mode's subagent and its task to end. */
const HANDBACK_LIMIT = 120_000;

/**
 * One mode of P41: a session in `mode` (a refused change means the mode was not caused) asks
 * for a background subagent that starts `sleep 20` in the background and ends at once.
 */
async function handbackMode(
  s: Stage,
  name: "bypass" | "auto",
  model: string,
): Promise<HandbackFacts | string> {
  const word = CAPABILITIES.permissionModes[name];
  if (word === null) return `${name}: the back end has no such mode`;
  const folder = join(s.root, `handback-${name}`);
  await mkdir(folder);
  const live = await s.open(folder, { model });
  try {
    await live.session.setPermissionMode(word);
  } catch (error) {
    return `${name}: the mode was refused (${s.scrubbed(error instanceof Error ? error.message : String(error), 80)})`;
  }
  const mark = s.records.length;
  const from = live.events.length;
  await live.turn(
    "Use the Agent tool with run_in_background set to true to start a subagent whose prompt tells it: " +
      "start `sleep 20` with the Bash tool and run_in_background set to true, then end at once " +
      "replying `started`. Then reply: done",
  );
  const settled = await live.until(
    from,
    (events) => handbackFacts(events, s.records.slice(mark)).settled,
    HANDBACK_LIMIT,
  );
  // Facts from a mode cut short would read as a change of Claude Code's.
  if (!settled)
    return `${name}: the subagent had not ended after its task in ${HANDBACK_LIMIT / 1000} s`;
  await live.quiet();
  return handbackFacts(live.events.slice(from), s.records.slice(mark));
}

async function subagentHandback(s: Stage): Promise<Seen> {
  const bypass = await handbackMode(s, "bypass", PROBE_MODEL);
  // Auto mode is refused on the haiku alias (measured 2026-10-08) and works on sonnet.
  const auto = await handbackMode(s, "auto", "sonnet");
  const missing = [bypass, auto].filter((one) => typeof one === "string");
  if (typeof bypass === "string" || typeof auto === "string") {
    return { P41: observation(false, false, missing.join("; ")) };
  }
  return {
    P41: judgeHandback({ bypass, auto }),
  };
}

// How many turns the generated-title scene gives Claude Code to write a title, and how long it
// waits after each for the title to reach the transcript.
const TITLE_TURNS = 3;
const TITLE_SETTLE_MS = 5_000;
// How long the copy's transcript is read for its `<fork-source>` note after its first turn.
const FORK_NOTE_MS = 10_000;

/**
 * P32: Claude Code writes a title for a session of its own (the `ai-title` entry of the
 * transcript), and `getSessionInfo().customTitle` holds it with no `/rename` sent, although the
 * declaration calls that field the `/rename` title only. Measured on 2026-10-20 (Claude Code
 * 2.1.302, SDK 0.3.302): the title is usually there after the first turn, sometimes only after the
 * third. The scene runs up to `TITLE_TURNS` turns and reads the title through the back end's
 * `sessionTitle`. Nothing is caused when no title came in that many turns: the scene learned
 * nothing about the field.
 */
async function generatedTitle(s: Stage): Promise<Seen> {
  const folder = join(s.root, "generated-title");
  await mkdir(folder);
  const live = new Live(await s.backend.start(s.options(folder), s.owner));
  s.lives.push(live);
  const prompts = [
    "Reply with the single word: ok",
    "Reply with the single word: again",
    "Reply with the single word: done",
  ];
  for (const prompt of prompts.slice(0, TITLE_TURNS)) {
    await live.turn(prompt);
    const id = sessionIdOf(live.events);
    if (id === null) return { P32: observation(false, false, "the session reported no id") };
    const deadline = Date.now() + TITLE_SETTLE_MS;
    for (;;) {
      const title = await s.backend.sessionTitle(folder, id);
      if (title) return { P32: observation(true, true, "") };
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  return {
    P32: observation(false, false, `Claude Code wrote no title in ${TITLE_TURNS} turns`),
  };
}

/**
 * P43: a copy (`forkSession`) started with `forkOf`, which the back end passes as
 * `CLAUDE_CODE_RESUME_SOURCE_ALIVE`, while the original keeps a background command running, is
 * told by Claude Code that it was forked from a session still running: a `<fork-source>` note in
 * its transcript, after its first turn (measured on 2026-10-28, Claude Code 2.1.312). The control
 * is the copy's own turn: a copy that never answered proves nothing about the variable.
 */
async function forkSourceAlive(s: Stage): Promise<Seen> {
  const folder = join(s.root, "fork-source");
  await mkdir(folder);
  const original = await s.open(folder);
  await original.turn(
    "Run `sleep 90` with the Bash tool in the background (run_in_background true), then reply with the single word: started",
  );
  const id = sessionIdOf(original.events);
  if (id === null) return { P43: observation(false, false, "the original reported no id") };
  const copy = await s.backend.forkSession(folder, id, null);
  const at = new Date().toISOString();
  const forked = await s.open(folder, { resume: copy, forkOf: { session: id, at } });
  await forked.turn("Reply with the single word: ok");
  if (sessionIdOf(forked.events) === null) {
    return { P43: observation(false, false, "the copy did not answer") };
  }
  const deadline = Date.now() + FORK_NOTE_MS;
  for (;;) {
    const messages = await getSessionMessages(copy, { dir: folder });
    if (JSON.stringify(messages).includes("<fork-source>"))
      return { P43: observation(true, true, "") };
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return { P43: observation(true, false, "the copy's transcript holds no <fork-source> note") };
}

/**
 * P44: a session started as the daemon starts it (`enableFileCheckpointing`) can put its files
 * back: after two Write turns, a dry run to the second prompt lists the file that turn created,
 * and the real run removes it and keeps the first turn's file (recorded on 2026-10-29, Claude Code
 * 2.1.312). The control is the two files existing before the restore.
 */
async function fileCheckpoints(s: Stage): Promise<Seen> {
  const folder = join(s.root, "rewind-files");
  await mkdir(folder);
  const live = await s.open(folder);
  await live.turn("Using the Write tool, create a.txt containing exactly: one");
  const second = await live.turn("Using the Write tool, create b.txt containing exactly: two");
  const a = join(folder, "a.txt");
  const b = join(folder, "b.txt");
  if (!existsSync(a) || !existsSync(b)) {
    return { P44: observation(false, false, "Claude wrote no file in two turns") };
  }
  const dry = await live.session.restoreFiles(second.id, true);
  const lists = dry.possible && dry.files.some((file) => basename(file) === "b.txt");
  const real = await live.session.restoreFiles(second.id, false);
  const held = lists && real.possible && !existsSync(b) && existsSync(a);
  return {
    P44: observation(true, held, held ? "" : "the restore did not take b.txt away", {
      preview: lists,
      restored: real.possible,
    }),
  };
}

/**
 * P45: the cut the back end makes for `rewindTo`. Two turns each give a codeword; the session is
 * closed and started again with `rewindTo` the second prompt (which the back end guards with
 * `resumeDropsTurn`); asked for the codewords it names the first alone, under the same session
 * id. A range of two turns under the same guard is refused with `RewindRefused`. The control is
 * the answer of the cut session.
 */
async function conversationCut(s: Stage): Promise<Seen> {
  const folder = join(s.root, "rewind-cut");
  await mkdir(folder);
  const first = await s.open(folder);
  await first.turn("Remember the codeword alphaword. Reply with the single word: ok");
  const second = await first.turn(
    "Remember the codeword bravoword. Reply with the single word: ok",
  );
  const id = sessionIdOf(first.events);
  if (id === null) return { P45: observation(false, false, "the session reported no id") };
  await first.session.close();
  const cut = await s.open(folder, { resume: id, rewindTo: second.id });
  const asked = await cut.turn(
    "List every codeword I asked you to remember, comma separated, nothing else.",
  );
  const answer = ofType(asked.events, "text")
    .map((event) => event.text)
    .join(" ")
    .toLowerCase();
  if (answer.trim() === "")
    return { P45: observation(false, false, "the cut session said nothing") };
  const sameId = sessionIdOf(cut.events) === id;
  const dropped = answer.includes("alphaword") && !answer.includes("bravoword");
  await cut.session.close();

  // A range of two turns under the guard of one is refused (recorded on 2026-10-29).
  const wide = await s.open(folder, { resume: id });
  await wide.turn("Remember the codeword charlieword. Reply with the single word: ok");
  await wide.turn("Remember the codeword deltaword. Reply with the single word: ok");
  await wide.session.close();
  const points = await s.backend.prompts(folder, id);
  const kept = points.at(0);
  const dropsFirstTwo = points.at(1);
  if (kept === undefined || dropsFirstTwo === undefined) {
    return { P45: observation(false, false, "the conversation lost its prompts") };
  }
  const messages = await getSessionMessages(id, { dir: folder });
  const start = rewindStart(messages, dropsFirstTwo.id);
  let refused = false;
  if (start !== null) {
    try {
      const guarded = new ClaudeSession(
        {
          ...s.options(folder, { resume: id }),
          settingsSources: [],
          chrome: false,
          resumeSessionAt: start.at,
          resumeDropsTurn: dropsFirstTwo.id,
        },
        s.owner,
      );
      await guarded.ready();
      await guarded.close();
    } catch (error) {
      refused = error instanceof RewindRefused;
    }
  }
  const held = sameId && dropped && refused;
  return {
    P45: observation(true, held, held ? "" : "the cut or the refusal was not as measured", {
      sameId,
      dropped,
      refused,
    }),
  };
}

/**
 * Removes the transcripts the probe's sessions left under Claude Code's projects folder: only
 * the folders whose name holds this run's random temporary folder. Anything else is left alone.
 */
export async function forgetSessions(root: string, log: Log): Promise<void> {
  const projects = projectsDir();
  const mine = basename(root);
  let removed = 0;
  try {
    for (const entry of await readdir(projects)) {
      if (entry.includes(mine)) {
        await rm(join(projects, entry), { recursive: true, force: true });
        removed += 1;
      }
    }
  } catch {
    // No projects folder: no transcripts.
  }
  log(`removed ${removed} transcript folders`);
}

/**
 * Runs every scene on a fresh back end and returns what each claim's scene saw. Every record
 * Claude Code wrote is appended to `records`.
 */
export async function runScenes(log: Log, records: Records = []): Promise<Seen> {
  const seen: Seen = {};
  const root = await realpath(await mkdtemp(join(tmpdir(), "allaboard-probe-")));
  try {
    // The owner's own `~/.claude.json` is not read: Chrome stays off for these sessions.
    const home = join(root, "home");
    await mkdir(home);
    await writeFile(join(home, ".claude.json"), "{}");
    const s = new Stage(log, root, home, records);
    for (const folder of [s.workdir, s.models, s.uploads]) await mkdir(folder);
    const word = randomBytes(3).toString("hex");
    try {
      s.main = await s.open(s.workdir);
      Object.assign(seen, await attempt("plain session", s, () => plainSession(s)));
      Object.assign(seen, await attempt("first turn", s, () => firstTurn(s, word)));
      const sessionId = sessionIdOf(s.main.events);
      Object.assign(seen, await attempt("image", s, () => imageTurn(s)));
      Object.assign(seen, await attempt("file", s, () => fileTurn(s)));
      Object.assign(seen, await attempt("bash and approval", s, () => bashTurn(s)));
      Object.assign(seen, await attempt("previews", s, () => previews(s)));
      Object.assign(seen, await attempt("background and stop", s, () => backgroundStop(s)));
      Object.assign(seen, await attempt("interrupt", s, () => interrupt(s)));
      Object.assign(seen, await attempt("resume", s, () => resume(s, word, sessionId)));
      Object.assign(seen, await attempt("model and effort resume", s, () => modelEffortResume(s)));
      Object.assign(seen, await attempt("setup model resume", s, () => setupModelResume(s)));
      Object.assign(
        seen,
        await attempt("model command after setModel", s, () => modelCommandAfterSetModel(s)),
      );
      Object.assign(seen, await attempt("bypass", s, () => bypass(s)));
      Object.assign(seen, await attempt("working folder", s, () => workingFolder(s)));
      Object.assign(seen, await attempt("replay", s, () => replay(s)));
      Object.assign(seen, await attempt("effort commands", s, () => effortCommands(s)));
      Object.assign(seen, await attempt("goal", s, () => goal(s)));
      Object.assign(seen, await attempt("compact", s, () => compact(s)));
      Object.assign(seen, await attempt("commands not offered", s, () => commandsNotOffered(s)));
      Object.assign(seen, await attempt("computer use", s, () => computerUse(s)));
      Object.assign(seen, await attempt("background wake", s, () => backgroundWake(s)));
      Object.assign(
        seen,
        await attempt("config folder listing", s, () => configFolderListing(s.root)),
      );
      Object.assign(seen, await attempt("terminal form", s, () => terminalForm(s)));
      Object.assign(seen, await attempt("session tag", s, () => sessionTag(s.root)));
      Object.assign(seen, await attempt("generated title", s, () => generatedTitle(s)));
      Object.assign(seen, await attempt("fork source", s, () => forkSourceAlive(s)));
      Object.assign(
        seen,
        await attempt("rewind", s, async () => ({
          ...(await fileCheckpoints(s)),
          ...(await conversationCut(s)),
        })),
      );
      Object.assign(seen, await attempt("folder trust", s, () => folderTrust(s)));
      Object.assign(seen, await attempt("stop hooks", s, () => stopHooks(s)));
      Object.assign(seen, await attempt("settings mode", s, () => settingsMode(s)));
      Object.assign(seen, await attempt("logged out", s, () => loggedOut(s)));
      Object.assign(seen, await attempt("api error", s, () => apiError(s)));
      Object.assign(seen, await attempt("question", s, () => question(s)));
      Object.assign(seen, await attempt("ended subagent", s, () => endedSubagent(s)));
      Object.assign(seen, await attempt("subagent hand-back", s, () => subagentHandback(s)));
    } finally {
      await Promise.allSettled(s.lives.map((live) => live.session.close()));
      await forgetSessions(root, log);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return seen;
}
