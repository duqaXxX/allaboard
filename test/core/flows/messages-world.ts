/**
 * What the tests of the message flow share: `buildFlows()` over the memory chat and a real
 * `SessionManager` driving a scripted agent, in a folder of its own. The owner and somebody else
 * act through the memory chat, which checks who acted before anything reaches the core; a test
 * may also hand `inbound.message` a message of its own, to slow the files down or to hold a
 * prompt back.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type {
  AgentBackend,
  Prompt,
  PromptContent,
  Repository,
  RequestHandler,
  StartOptions,
} from "../../../src/agent/seam.ts";
import {
  type ChatCapabilities,
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type InboundMessage,
  type ThreadRef,
} from "../../../src/chat/seam.ts";
import { buildFlows } from "../../../src/core/flows/flows.ts";
import type { FlowDeps } from "../../../src/core/flows/talk.ts";
import { Holds } from "../../../src/core/hold.ts";
import { Approvals } from "../../../src/core/requests.ts";
import { SessionManager } from "../../../src/core/sessions/manager.ts";
import { StateStore } from "../../../src/core/state.ts";
import { type Names, namesOf } from "../../../src/core/texts.ts";
import { Updates } from "../../../src/core/updates.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { type MemoryChat, memoryChat, OWNER } from "../../support/memory-chat.ts";
import { NO_SYNC } from "../../support/no-sync.ts";
import {
  PLAIN_CAPABILITIES,
  PLAIN_WORDS,
  PlainAgent,
  type PlainSession,
} from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/settle.ts";
import type { FakeUpdatesHost } from "../../support/updates.ts";

/** The names the texts take when the plain agent and the memory chat are the two modules. */
export const PLAIN_NAMES: Names = {
  agent: "Plain",
  author: "Plain",
  cli: "plain",
  chat: "Memory chat",
  examples: "`!echo hello`, `!count one two`",
  login: "signin",
  logout: "signout",
  newSession: ["restart"],
};

/** A plain agent that offers no command of its own. */
export class NoCommands extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, commands: false };
}

/**
 * A plain agent that keeps a record of trust, as Claude does: a session may start in every
 * folder, and the daemon's git may run in the repositories `trusted` names, by root; a folder
 * holding a `.git` entry and not named there is a repository still to trust.
 */
export class WithFolderTrust extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, folderTrust: true };
  override readonly words = { ...PLAIN_WORDS, trust: "cd {directory} && plain" };
  readonly trusted = new Set<string>();

  override folderTrusted = async (): Promise<boolean> => true;

  override trustedRepository = async (folder: string): Promise<Repository | null> =>
    this.trusted.has(folder) ? WithFolderTrust.#at(folder) : null;

  override untrustedRepository = async (folder: string): Promise<Repository | null> =>
    !this.trusted.has(folder) && existsSync(join(folder, ".git"))
      ? WithFolderTrust.#at(folder)
      : null;

  static #at(folder: string): Repository {
    return { root: folder, key: folder, gitDir: join(folder, ".git"), insideGitDir: false };
  }
}

/** A plain agent with a plan mode, as Claude has; the mode switch is recorded on the session. */
export class WithPlan extends PlainAgent {
  override readonly capabilities = {
    ...PLAIN_CAPABILITIES,
    permissionModes: { default: "standard", auto: null, bypass: "unrestricted", plan: "planning" },
  };
  readonly modes: string[] = [];

  override async start(options: StartOptions, requests: RequestHandler) {
    const session = await super.start(options, requests);
    session.setPermissionMode = async (mode) => {
      this.modes.push(mode);
    };
    return session;
  }
}

/** A plain agent with a mode that runs tools without asking, as Claude has. */
export class WithBypass extends PlainAgent {
  override readonly capabilities = {
    ...PLAIN_CAPABILITIES,
    permissionModes: { default: "standard", auto: null, bypass: "unrestricted", plan: null },
  };

  override async start(options: StartOptions, requests: RequestHandler) {
    const session = await super.start(options, requests);
    // The plain session knows one mode; this agent takes the other too and runs no differently.
    session.setPermissionMode = async () => {};
    return session;
  }
}

/**
 * A plain agent that can tag a session, as Claude can: `tagCalls` holds the folder, the session
 * and the tag of each call, and `fails` makes every call reject.
 */
export class WithSessionTags extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, sessionTags: true };
  readonly tagCalls: Array<readonly [string, string, string | null]> = [];
  readonly #fails: boolean;

  constructor(fails = false) {
    super();
    this.#fails = fails;
  }

  async tagSession(folder: string, session: string, tag: string | null): Promise<void> {
    if (this.#fails) throw new Error("the transcript cannot be written");
    this.tagCalls.push([folder, session, tag]);
  }
}

/**
 * A plain agent that says what becomes of a goal (`goalChanged` steps) and drops one, as Claude
 * does: `cleared` counts the calls of its sessions' `clearGoal`, each on an idle session.
 */
export class WithGoals extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, goals: true };
  cleared = 0;

  override async start(options: StartOptions, requests: RequestHandler) {
    const session = await super.start(options, requests);
    session.clearGoal = async () => {
      this.cleared += 1;
    };
    return session;
  }
}

/**
 * A plain agent that can read a session's title, as Claude can: `title` is what it answers now
 * (null while it has none), `reads` counts the calls, `fails` makes the read reject and `hold` keeps it waiting.
 */
export class WithSessionTitle extends PlainAgent {
  override readonly capabilities = { ...PLAIN_CAPABILITIES, sessionTitles: true };
  title: string | null = null;
  fails = false;
  reads = 0;
  /** A promise that keeps the read waiting until it settles. */
  hold: Promise<void> | null = null;

  async sessionTitle(): Promise<string | null> {
    this.reads += 1;
    if (this.hold !== null) await this.hold;
    if (this.fails) throw new Error("the transcript cannot be read");
    return this.title;
  }
}

/**
 * What the memory chat is made into: a chat that can share a file, tag a thread, delete a thread,
 * or has reactions.
 */
interface Variant {
  readonly files: boolean;
  readonly reactions: boolean;
  /** Where a member of a thread the memory chat lacks records its call (`Room.stray`). */
  readonly stray: (call: string) => void;
  readonly openFails: boolean;
  readonly tags: boolean;
  readonly tagFails: boolean;
  readonly titles: boolean;
  readonly titleAttempts: { count: number };
  readonly root: FakeRoot;
  readonly titleFails: boolean | "permanent";
  readonly deletes: boolean;
}

/**
 * The root of a thread as a chat that can title it holds it: `text` is what the owner wrote,
 * `reads` counts the roots `titleThread` read, `readFails` makes that read reject, and `log` lists
 * `read`, `kept` (the callback finished) and `edit` in the order they came.
 */
export interface FakeRoot {
  text: string;
  /** The root was deleted while replies remain: the chat refuses it for good, as a tombstone. */
  gone: boolean;
  reads: number;
  readFails: boolean;
  readonly log: string[];
}

function variant(
  inner: ChatProvider,
  how: Variant,
  opened: Array<readonly [ThreadRef, string, string]>,
  tagged: Array<readonly [ThreadRef, string | null]>,
  titled: Array<readonly [ThreadRef, string]>,
  deleted: ThreadRef[],
): ChatProvider {
  const capabilities: ChatCapabilities = {
    ...inner.capabilities,
    fileUpload: how.files || inner.capabilities.fileUpload,
    rootStatus: how.reactions,
    acknowledgement: how.reactions,
    threadTags: how.tags,
    threadTitles: how.titles,
    threadDelete: how.deletes,
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === "capabilities") return capabilities;
      // A chat with reactions has the members the memory chat leaves out; each records its call.
      if (property === "thread" && how.reactions) {
        return (ref: ThreadRef) => {
          const thread = target.thread(ref);
          const extra: Record<string, unknown> = {
            showStatus: async (status: string) => {
              how.stray(`showStatus ${status}`);
              return true;
            },
            clearStatus: async () => how.stray("clearStatus"),
            settleStatus: async () => how.stray("settleStatus"),
            acknowledge: async (message: string) => how.stray(`acknowledge ${message}`),
          };
          return new Proxy(thread, {
            get(inner, name) {
              if (typeof name === "string" && name in extra) return extra[name];
              const member = Reflect.get(inner, name, inner);
              return typeof member === "function" ? member.bind(inner) : member;
            },
          });
        };
      }
      // A chat with reactions marks a line about a session as its root is marked.
      if (property === "statusMark" && how.reactions) return (status: string) => `<${status}>`;
      if (property === "openFile" && how.files) {
        return async (ref: ThreadRef, folder: string, words: string) => {
          if (how.openFails) throw new Error("the file viewer is down");
          opened.push([ref, folder, words]);
        };
      }
      if (property === "tagThread" && how.tags) {
        return async (ref: ThreadRef, tag: string | null) => {
          if (how.tagFails) throw new ChatError("message_not_found");
          tagged.push([ref, tag]);
        };
      }
      if (property === "titleThread" && how.titles) {
        return async (
          ref: ThreadRef,
          title: string,
          keep?: (text: string) => void | Promise<void>,
        ) => {
          how.root.reads += 1;
          how.root.log.push("read");
          if (how.root.gone) throw new ChatError("thread_not_found", { permanent: true });
          if (how.root.readFails) throw new ChatError("ratelimited");
          if (keep !== undefined) {
            await keep(how.root.text);
            how.root.log.push("kept");
          }
          how.root.log.push("edit");
          if (how.titleFails === "permanent") {
            how.titleAttempts.count += 1;
            throw new ChatError("cant_update_message", { permanent: true });
          }
          if (how.titleFails) {
            how.titleAttempts.count += 1;
            throw new ChatError("ratelimited");
          }
          titled.push([ref, title]);
        };
      }
      if (property === "deleteThread" && how.deletes) {
        return async (ref: ThreadRef) => {
          deleted.push(ref);
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

export interface WorldOptions {
  /** The agent: the plain one by default. */
  readonly agent?: AgentBackend;
  /** The chat can share a file; `openFile` records its calls in `World.fileCalls`. */
  readonly files?: boolean;
  /** `openFile` rejects. */
  readonly openFails?: boolean;
  /** The chat can tag a thread; `tagThread` records its calls in `World.tagCalls`. */
  readonly tags?: boolean;
  /** `tagThread` rejects with a `ChatError`. */
  readonly tagFails?: boolean;
  /** The chat can title a thread; `titleThread` records its calls in `World.titleCalls`. */
  readonly titles?: boolean;
  /** What the owner wrote in the root before it is titled (`World.root.text`). */
  readonly rootText?: string;
  /** `titleThread` rejects with a `ChatError`; `"permanent"` marks it as one that cannot change. */
  readonly titleFails?: boolean | "permanent";
  /** The chat can delete a thread; `deleteThread` records its calls in `World.deleteCalls`. */
  readonly deletes?: boolean;
  /** The chat suggests commands for a `!word` that is none (`suggestCommands`). */
  readonly suggests?: boolean;
  /** The chat posts lists in a thread and shares files into it (`threadLists`, `ThreadChat.share`). */
  readonly diff?: boolean;
  /** With `diff`: the most bytes the chat takes as one shared file. */
  readonly fileLimit?: number;
  /** The chat has reactions: a word that took effect is marked on the owner's message. */
  readonly reactions?: boolean;
  /** The daemon can update itself, through this host (`World.updates`); absent, it cannot. */
  readonly host?: FakeUpdatesHost;
  /**
   * The folder and the chat of an earlier world, to play a restart of the daemon: `state.json`
   * and the messages are as that world left them. The folder is then the earlier world's to remove.
   */
  readonly restartOf?: MessagesWorld;
}

/** A message the test writes itself, as a provider would hand it over. */
export interface Own {
  readonly ref: ThreadRef;
  readonly id: string;
  readonly topLevel?: boolean;
  readonly text: string;
  readonly plain?: string;
  readonly literal?: boolean;
  readonly content?: () => Promise<PromptContent | null>;
}

export class MessagesWorld {
  readonly folder: string;
  readonly chat: MemoryChat;
  readonly agent: AgentBackend;
  readonly state: StateStore;
  readonly sessions: SessionManager;
  readonly channel: string;
  /** What the core hands the provider. */
  readonly inbound: ChatInbound;
  /** The stop of the daemon. */
  readonly stopping = new AbortController();
  readonly clock = new FakeClock();
  readonly provider: ChatProvider;
  /** Every `openFile` the chat was asked for: the thread, the folder, the words. */
  readonly fileCalls: Array<readonly [ThreadRef, string, string]> = [];
  /** Every `tagThread` the chat was asked for: the thread and the tag. */
  readonly tagCalls: Array<readonly [ThreadRef, string | null]> = [];
  /** Every `titleThread` the chat was asked for: the thread and the title. */
  readonly titleCalls: Array<readonly [ThreadRef, string]> = [];
  /** The thread's root as the chat holds it. */
  readonly root: FakeRoot;
  /** How many `titleThread` calls were refused. */
  get titleRefusals(): number {
    return this.#titleAttempts.count;
  }
  readonly #titleAttempts: { count: number };
  /** Every `deleteThread` the chat was asked for. */
  readonly deleteCalls: ThreadRef[] = [];
  /** Wall-clock seconds as the flows read them. */
  now = 1_780_000_000;
  /** The update of the daemon, when the world was given a host. */
  readonly updates: Updates | undefined;
  readonly #deps: FlowDeps;

  private constructor(
    folder: string,
    chat: MemoryChat,
    provider: ChatProvider,
    agent: AgentBackend,
    how: Variant,
    host: FakeUpdatesHost | undefined,
  ) {
    this.#titleAttempts = how.titleAttempts;
    this.root = how.root;
    this.folder = folder;
    this.chat = chat;
    this.agent = agent;
    this.channel = chat.openChannel("work");
    this.state = new StateStore(join(folder, "state.json"), { sync: NO_SYNC });
    this.state.bind(this.channel, folder);
    this.updates = host === undefined ? undefined : new Updates(host, { now: () => this.now });
    const names = namesOf(agent, provider);
    const approvals = new Approvals(names);
    const holds = new Holds();
    this.provider = variant(
      provider,
      how,
      this.fileCalls,
      this.tagCalls,
      this.titleCalls,
      this.deleteCalls,
    );
    this.sessions = new SessionManager({
      chat: this.provider,
      agent,
      state: this.state,
      approvals,
      holds,
      usage: null,
      clock: this.clock,
      ...(host === undefined ? {} : { updating: () => host.updateHeld() }),
    });
    this.#deps = {
      chat: this.provider,
      agent,
      sessions: this.sessions,
      state: this.state,
      approvals,
      holds,
      names,
      allowedRoot: folder,
      shellCommands: true,
      stopped: this.stopping.signal,
      now: () => this.now,
      ...(this.updates === undefined ? {} : { updates: this.updates }),
    };
    this.inbound = buildFlows(this.#deps).inbound;
  }

  /** A world over the memory chat, with the plain agent unless `options.agent` names another. */
  static async make(t: TestContext, options: WorldOptions = {}): Promise<MessagesWorld> {
    const earlier = options.restartOf;
    const folder =
      earlier?.folder ?? realpathSync(mkdtempSync(join(tmpdir(), "allaboard-messages-")));
    const chat =
      earlier?.chat ??
      memoryChat({
        suggestions: options.suggests ?? false,
        lists: options.diff ?? false,
        files: options.diff ?? false,
        ...(options.fileLimit !== undefined && { fileLimit: options.fileLimit }),
      });
    const provider = await chat.build({
      variables: {},
      allowedRoot: folder,
      scratchDir: join(folder, "scratch"),
      clock: { sleep: async () => {}, time: () => 1_780_000_000 },
      steady: { sleep: async () => {}, time: () => 1_780_000_000 },
      core: () => {
        throw new Error("the memory chat never reads the core");
      },
    });
    const attempts = { count: 0 };
    const world = new MessagesWorld(
      folder,
      chat,
      provider,
      options.agent ?? new PlainAgent(),
      {
        files: options.files ?? false,
        reactions: options.reactions ?? false,
        stray: (call) => chat.stray(call),
        openFails: options.openFails ?? false,
        tags: options.tags ?? false,
        tagFails: options.tagFails ?? false,
        titles: options.titles ?? false,
        titleAttempts: attempts,
        root: {
          text: options.rootText ?? "the owner's words",
          gone: false,
          reads: 0,
          readFails: false,
          log: [],
        },
        titleFails: options.titleFails ?? false,
        deletes: options.deletes ?? false,
      },
      options.host,
    );
    await world.provider.start(world.inbound);
    t.after(async () => {
      await world.sessions.closeAll();
      await world.provider.stop();
      if (earlier === undefined) rmSync(folder, { recursive: true, force: true });
    });
    return world;
  }

  /** The owner writes `text` in the channel, or inside `thread`. */
  says(text: string, thread?: string) {
    return this.chat
      .as(OWNER)
      .says(this.channel, text, thread === undefined ? undefined : { thread });
  }

  /** The owner's message handed to the flow as the test wrote it. */
  send(own: Own): Promise<void> {
    return this.inbound.message({
      ref: own.ref,
      id: own.id,
      topLevel: own.topLevel ?? false,
      text: own.text,
      plain: own.plain ?? own.text,
      literal: own.literal ?? false,
      content: own.content ?? (async () => own.text),
    } satisfies InboundMessage);
  }

  /** Lets what is ready run, and what it starts. */
  async settle(rounds = 30): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      await settledTurn();
    }
  }

  /** Waits until a thread (`ref`, or any) has an open request of `type` and returns it. */
  async asked(type: string, ref?: ThreadRef) {
    for (let round = 0; round < 200; round += 1) {
      const found = this.chat
        .requests()
        .find((r) => (ref === undefined || r.ref.thread === ref.thread) && r.request.type === type);
      if (found !== undefined) return found;
      await settledTurn();
    }
    throw new Error(`no ${type} request was asked`);
  }

  /** The owner presses Start on the setup asked in `ref`. */
  async start(ref: ThreadRef, bypass = false): Promise<void> {
    const open = await this.asked("setup", ref);
    await this.chat.as(OWNER).answers(open.requestId, {
      type: "setup",
      selection: { model: "default", effort: "default", bypass },
    });
  }

  /**
   * The owner's first message of a new thread, its setup answered: the thread, once the prompt
   * reached the agent.
   */
  async opened(prompt = "first"): Promise<ThreadRef> {
    const sending = this.says(prompt);
    const { ref } = await this.asked("setup");
    await this.start(ref);
    await sending;
    await this.settle();
    return ref;
  }

  /** What `ref` shows, as text. */
  shown(ref: ThreadRef): readonly string[] {
    return this.chat.texts(ref.channel, ref.thread);
  }

  /** What the channel's main view shows, as text. */
  inChannel(): readonly string[] {
    return this.chat.texts(this.channel);
  }

  /** The session the agent started for the n-th time. */
  agentSession(index = 0): PlainSession {
    const session = (this.agent as PlainAgent).sessions[index];
    if (session === undefined) throw new Error(`no agent session ${index}`);
    return session;
  }

  /** The prompts the agent got, as text, over every session, once what is queued was sent. */
  async prompts(): Promise<string[]> {
    await this.settle(10);
    return (this.agent as PlainAgent).sessions.flatMap((s) => s.prompts.map(textOf));
  }
}

function textOf(prompt: Prompt): string {
  const { content } = prompt;
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
