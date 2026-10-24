/**
 * What the probe claims about an `@anthropic-ai/claude-agent-sdk` release, and how an observation
 * becomes an outcome.
 *
 * The rules follow seedeep's upgrade guard: presence is conclusive, absence is not. A gesture claim
 * is one the probe causes itself, so once its event happened, the behaviour's absence is proof of a
 * break (BROKEN); if the event itself did not happen, nothing was learned (UNPROVEN). A model claim
 * needs Claude to act, so its failure proves nothing and is never reported as broken. A limit claim
 * holds while a limit of `docs/limits.md` holds: when it does not, the release is not broken, the
 * limit FELL, and the page changes. A limit claim never certifies and never blocks.
 */

export type Kind = "gesture" | "model" | "limit";
export type Outcome = "HOLDS" | "BROKEN" | "UNPROVEN" | "RETIRED" | "FELL";

export interface Claim {
  readonly id: string;
  readonly kind: Kind;
  readonly text: string;
  /** Where to look when it breaks: `<file>#<export>` or `<file>#<class>.<member>`. */
  readonly guards: string;
  /** What to do in Slack to check it by hand when the probe could not prove it. */
  readonly how: string;
  /** The measurement, with date and version, that shows Claude Code no longer offers the event. */
  readonly retired: string | null;
}

/** One fact a claim rests on: a name, a count, a flag, a fixed answer, a record type. */
export type Fact =
  | string
  | number
  | boolean
  | null
  | readonly Fact[]
  | { readonly [key: string]: Fact };

/** What a claim saw, as facts by name; it is kept per release (`verdicts.ts`). */
export type Facts = { readonly [key: string]: Fact };

/**
 * `caused`: the event happened. `holds`: the behaviour the claim names was there. `seen`: the
 * facts it rests on, content-free and the same on every run of one release: names, counts of what
 * the probe itself sent, field sets, booleans, the fixed text of an answer. Never conversation
 * content, a path, an id, a time, a model's words, a token count or a cost. `{}` when the claim
 * rests on nothing but its pass.
 */
export interface Observation {
  readonly caused: boolean;
  readonly holds: boolean;
  readonly detail: string;
  readonly seen: Facts;
}

export interface Result {
  readonly claim: Claim;
  readonly outcome: Outcome;
  readonly detail: string;
  /** The facts of the observation, kept for a HOLDS only; `{}` for any other outcome. */
  readonly seen: Facts;
}

/** A claim; throws unless its id reads P or L and a number and its kind is gesture, model or limit. */
export function claim(
  id: string,
  kind: Kind,
  text: string,
  guards: string,
  how: string,
  retired: string | null = null,
): Claim {
  if (!/^[PL][1-9]\d*$/.test(id)) {
    throw new RangeError(`a claim id reads P or L and a number, not ${id}`);
  }
  if (kind !== "gesture" && kind !== "model" && kind !== "limit") {
    throw new RangeError(`claim ${id}: kind ${kind} is neither gesture, model nor limit`);
  }
  return Object.freeze({ id, kind, text, guards, how, retired });
}

/** What a scene saw; throws when it says a behaviour held although its event never happened. */
export function observation(
  caused: boolean,
  holds: boolean,
  detail = "",
  seen: Facts = {},
): Observation {
  if (holds && !caused)
    throw new RangeError("a behaviour cannot hold when its event never happened");
  return Object.freeze({ caused, holds, detail, seen });
}

/** An outcome of a claim; only a gesture claim is BROKEN and only a limit claim FELL, whoever builds it. */
export function result(subject: Claim, outcome: Outcome, detail: string, seen: Facts = {}): Result {
  // The rule the whole probe rests on, kept by the type rather than by `evaluate` alone.
  if (outcome === "BROKEN" && subject.kind !== "gesture") {
    throw new RangeError(`claim ${subject.id} is a ${subject.kind} claim: it is never BROKEN`);
  }
  if (outcome === "FELL" && subject.kind !== "limit") {
    throw new RangeError(`claim ${subject.id} is a ${subject.kind} claim: only a limit FELL`);
  }
  return Object.freeze({ claim: subject, outcome, detail, seen });
}

// The guards are the TypeScript back end's symbols that read what a claim names: the daemon's
// own code is where a break shows. The claims about the Agent SDK's own symbols name its
// symbols, such as the initialization result and `Options.effort`.
export const CLAIMS: readonly Claim[] = [
  claim(
    "P1",
    "gesture",
    "a session starts and its init message names the CLI version",
    "src/agent/claude/translate.ts#Translator.translate",
    "send any message in a bound channel; `!status` shows the Claude Code version",
  ),
  claim(
    "P2",
    "gesture",
    "`!status` reads the initialization result and the context usage",
    "src/agent/claude/session.ts#ClaudeSession.info",
    "send `!status`; it lists the model and a `Context:` line",
  ),
  claim(
    "P3",
    "gesture",
    "a text prompt gets a result whose session id is stored",
    "src/agent/claude/translate.ts#Translator.translate",
    "send a message; the reply closes with its footer",
  ),
  claim(
    "P4",
    "gesture",
    "an image prompt reaches Claude, which names the colour of the pixel",
    "src/agent/claude/prompt.ts#userMessage",
    "attach a screenshot and ask what it shows",
  ),
  claim(
    "P5",
    "model",
    "Claude reads an attached text file and quotes it",
    "src/chat/slack/attachments.ts#promptFor",
    "attach a small text file and ask what it says",
  ),
  claim(
    "P6",
    "gesture",
    "`!resume` knows the session: held by its thread, it is counted under the list",
    "src/agent/claude/listing.ts#directorySessions",
    "send `!resume`; the line under the list counts the session open in its own thread",
  ),
  claim(
    "P7",
    "gesture",
    "a resumed session remembers what was said before it",
    "src/agent/claude/backend.ts#ClaudeBackend.start",
    "press Resume on an older session and ask what you were talking about",
  ),
  claim(
    "P8",
    "gesture",
    "`!stop` interrupts a running turn and its reply ends",
    "src/agent/claude/session.ts#ClaudeSession.interrupt",
    "ask for a long answer and send `!stop` while it writes",
  ),
  claim(
    "P9",
    "model",
    "with `!bypass on`, a Bash call runs without asking",
    "src/agent/claude/session.ts#ClaudeSession.setPermissionMode",
    "send `!bypass on`, ask Claude to run a command: no Approve button; then `!bypass off`",
  ),
  claim(
    "P10",
    "model",
    "a Bash call shows its task card in the reply",
    "src/agent/claude/translate.ts#Translator.translate",
    "ask Claude to run `echo hello` with Bash",
  ),
  claim(
    "P11",
    "model",
    "a Bash call asks for approval, and an approved call runs",
    "src/agent/claude/requests.ts#toRequest",
    "with bypass off, ask Claude to run a command; press Approve",
  ),
  claim(
    "P12",
    "model",
    "`!stop` ends a background command",
    "src/agent/claude/session.ts#ClaudeSession.stopTask",
    "ask Claude to run `tail -f` on a file in the background, then send `!stop`",
  ),
  claim(
    "P13",
    "model",
    "a Write and an Edit show the terminal's preview (undocumented tool_use_result)",
    "src/agent/claude/translate.ts#fileChange",
    "ask Claude to create a file and then edit it; each call shows as one container, titled " +
      "with its line, and no card",
  ),
  claim(
    "P14",
    "model",
    "a hook's `cwd` follows a `cd`, so the footer shows the branch of a trusted repo there",
    "src/agent/claude/hooks.ts#postToolUseHookEvents",
    "bind a folder holding a repo you trusted in Claude Code one level down, ask Claude to " +
      "`cd` into it; the footer shows the repo's branch",
  ),
  claim(
    "P15",
    "gesture",
    "a resumed session keeps the model set with `/model`",
    "src/agent/claude/backend.ts#ClaudeBackend.start",
    "in a thread, send `!model sonnet`, let the session idle-close or restart the daemon, " +
      "send a message; `!status` shows the model",
  ),
  claim(
    "P16",
    "gesture",
    "a resumed session loses the effort set with `setEffort`, and `Options.effort` restores it",
    "src/agent/claude/session.ts#ClaudeSession.setEffort",
    "in a thread, send `!effort low`, restart the daemon, send a message; the footer shows `low`",
  ),
  claim(
    "P17",
    "gesture",
    "the initialization result lists models with `value`, `displayName` and " +
      "`supportedEffortLevels`",
    "src/agent/claude/info.ts#agentInfo",
    "send a message at the top level of a bound channel; its thread offers Model and Effort " +
      "with the CLI's own names",
  ),
  claim(
    "P18",
    "gesture",
    "a resumed session keeps the model the setup set with `/model`",
    "src/agent/claude/session.ts#ClaudeSession.setModel",
    "at the top level, pick a model in the setup and press Start, restart the daemon, reply " +
      "in the thread; `!status` shows the model",
  ),
  claim(
    "P19",
    "gesture",
    "a prompt sent under a uuid is re-emitted with it (`--replay-user-messages`), before the " +
      "first stream event of its turn",
    "src/agent/claude/translate.ts#Translator.promptSent",
    "send a message while Claude Code reports a background task, as `docs/features.md` " +
      "describes: the reply ends with the note, or the session answers it in a turn of its own",
  ),
  claim(
    "P20",
    "gesture",
    "the reply to `/goal` opens with the command's `Goal set:` line: an assistant message " +
      "whose `message_id` no `message_start` event announced",
    "src/agent/claude/translate.ts#Translator.translate",
    "send `!goal reply with the single word tick`; the reply opens with `Goal set:` and the " +
      "condition, then Claude's text, written once",
  ),
  claim(
    "P21",
    "gesture",
    "the reply to `/compact` is the compaction's line: its `compact_boundary` comes before " +
      "every frame of its turn that starts one, and a result follows it",
    "src/agent/claude/translate.ts#Translator.translate",
    "send `!compact` in a thread with a few turns; the reply is `Compacted the " +
      "conversation:` and the tokens before and after",
  ),
  claim(
    "P22",
    "gesture",
    "`/compact` opens with a `status` system message that says `compacting`: the thread's " +
      "status line reads `Compacting conversation…` while it runs",
    "src/agent/claude/translate.ts#Translator.translate",
    "send `!compact` in a thread with a few turns; the line under the thread reads " +
      "`Compacting conversation…` until the reply appears",
  ),
  claim(
    "P23",
    "limit",
    "each command `docs/limits.md` lists as not offered to a session is answered `isn't " +
      "available in this environment`",
    "src/core/commands.ts#parseBang",
    "send `!rewind` in a thread; the reply is `/rewind isn't available in this " +
      "environment.` A command that answers anything else is no longer a limit: take its " +
      "row out of `docs/limits.md` and say so in the issue it names",
  ),
  claim(
    "P24",
    "limit",
    "a session whose folder has computer use switched on lists no computer-use server, as " +
      "`docs/limits.md` says",
    "src/agent/claude/translate.ts#Translator.translate",
    "in a folder where `/mcp` has computer use on, ask in a thread to open an app: Claude has no " +
      "computer-use tool. If it does, the limit is gone: take its row out of `docs/limits.md`, " +
      "say so in the issue it names, and see what Slack shows for a screenshot in a result",
  ),
  claim(
    "P25",
    "limit",
    "a turn Claude Code opens by itself on a task's notification brings nothing that says what " +
      "woke it: no user record of origin `task-notification` comes before its result, as " +
      "`docs/limits.md` says",
    "src/core/sessions/session.ts#ThreadSession.openingTarget",
    "in a thread, ask Claude to watch `echo tick; sleep 600` with the Monitor tool; the reply of " +
      "the turn the line `tick` opens is Claude's text alone, with no line before it. If the " +
      "SDK now says what woke the turn, the limit is gone: take its row out of `docs/limits.md` " +
      "and say so in the issue it names",
  ),
  claim(
    "P26",
    "gesture",
    "the result of `/effort` and of `/model` names the command in `local_command`, and its text " +
      "says the level a command set, so the back end can tell the core; the PostModelSwitch hook " +
      "of `/model` gives `to_model` before that result",
    "src/agent/claude/translate.ts#effortChanged",
    "in a thread, send `!effort low`; the footer shows `low`, then `!effort auto`; it shows `auto`; " +
      "send `!model opus`: the footer shows `Opus 5.5` at once, not the model before it",
  ),
  claim(
    "P27",
    "limit",
    "with a model named in the project settings, after `setModel()` on the query a `/model` to " +
      "that model's alias is acknowledged and the next request still runs on the `setModel` " +
      "model, as `docs/limits.md` says",
    "src/agent/claude/session.ts#ClaudeSession.setModel",
    "the scene calls the SDK's `setModel` itself, since the daemon does not. If the request now " +
      "runs on the startup model the limit is gone: take its row out of `docs/limits.md` and say " +
      "so in the issue it names",
  ),
  claim(
    "P28",
    "gesture",
    "a `/model` sent under a uuid ends its turn with a `command_lifecycle` record in the state " +
      "`completed` whose `command_uuid` is that uuid",
    "src/agent/claude/session.ts#ClaudeSession.setModel",
    "the daemon hides the command's turn up to that record and the first prompt waits for its " +
      "result: with the record gone, set a model in the setup and press Start, then reply in the " +
      "thread: the reply never shows. Read `docs/sdk-surface.md` for the rows that name it",
  ),
  claim(
    "P29",
    "gesture",
    "with `CLAUDE_CONFIG_DIR` set in the daemon's process, the SDK's `listSessions({ dir })` " +
      "lists a transcript written under `<folder>/projects/<project key>/<id>.jsonl`",
    "src/agent/claude/module.ts#claudeAgent",
    "this scene needs no login: it writes a transcript of its own. If it fails, an instance with " +
      "`CLAUDE_CONFIG_DIR` in its `.env` lists no session in `!resume` and in the Home tab's " +
      "session list: read `docs/sdk-surface.md` for the row that names the variable, and look for an " +
      "option of `ListSessionsOptions` that names the folder, which would replace the write the " +
      "module makes into `process.env`",
  ),
  claim(
    "P30",
    "gesture",
    "a session started as the daemon starts it works under the terminal's form: its first " +
      "request carries the `claude_code` preset's system prompt, an Agent tool with no " +
      "`run_in_background` (fork mode), a Bash tool whose default timeout is the " +
      "`BASH_DEFAULT_TIMEOUT_MS` the owner set, and an AskUserQuestion tool told to give each " +
      "option a preview",
    "src/agent/claude/session.ts#ClaudeSession",
    "the scene reads the request Claude Code wrote with `OTEL_LOG_RAW_API_BODIES`. " +
      "`CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR` shows in no request, so check it by hand: " +
      "`docs/features.md` row of the terminal's form. If the scene fails, a thread starts " +
      "with the SDK's minimal prompt, subagents choose their own mode, the owner's timeout " +
      "is ignored, or questions come without previews: compare with the terminal's real request as `CLAUDE.md` says",
  ),
  claim(
    "P31",
    "gesture",
    "the SDK's `tagSession(id, tag, { dir })` sets, changes and clears the tag of a session: " +
      "`getSessionInfo` reads back each tag, and `undefined` once it is cleared",
    "src/agent/claude/backend.ts#ClaudeBackend.tagSession",
    "this scene needs no login: it writes a transcript of its own. If it fails, `!tag` and " +
      "`!untag` leave the agent's own tag as it was: the chat shows the tag and the owner is " +
      "told the agent's did not change. Read `docs/sdk-surface.md` for the row that names " +
      "`tagSession`",
  ),
  claim(
    "P32",
    "gesture",
    "Claude Code writes a title for a session of its own, and `getSessionInfo().customTitle` holds " +
      "it with no `/rename` sent, within three turns: the declaration calls that field the " +
      "`/rename` title only",
    "src/agent/claude/backend.ts#ClaudeBackend.sessionTitle",
    "the scene runs up to three Haiku turns and reads the title through the back end. Nothing is " +
      "proved when Claude Code wrote none in three turns (UNPROVEN). If it fails, the thread's " +
      "first message is never replaced by a title and `!status` has no `Title:` line: read " +
      "`docs/sdk-surface.md` for the row that names `customTitle`, and look for the `ai-title` " +
      "entry in a transcript",
  ),
  claim(
    "P33",
    "gesture",
    "a `/goal` reaches the session store as `goal_status` entries: the goal set, then achieved " +
      "with whole `iterations`, `durationMs` and `tokens`, both before the turn's result",
    "src/agent/claude/goals.ts#goalChange",
    "send `!goal reply with the single word tick`; the reply ends with `✔ Goal achieved (…)` " +
      "before its footer. If it fails, the reply shows no goal line and `!stop` never says a " +
      "goal is still active: read `docs/sdk-surface.md` for the rows under `SessionStoreEntry`, " +
      "and look for the `goal_status` attachments in a transcript",
  ),
  claim(
    "P34",
    "gesture",
    "Claude Code honours the record the daemon's trust gate reads: in a folder whose " +
      "`projects[path].hasTrustDialogAccepted` is not true it ignores the project settings' " +
      "permission rules and says `this workspace has not been trusted`, and in a trusted one it " +
      "does not",
    "src/agent/claude/trust.ts#locate",
    "bind a folder you never trusted in the terminal; the daemon refuses it. If the probe " +
      "fails, trust a folder with a rule in its `.claude/settings.json`, start a session there " +
      "and read the process's stderr for `has not been trusted`",
  ),
  claim(
    "P35",
    "model",
    "a message to a subagent that has ended is answered `Resuming agent <id>` with the first " +
      "seven characters of the id the `SendMessage` call names, as the line the reply draws",
    "src/core/reply/previews.ts#resuming",
    "ask for a subagent, wait for it to end, then ask Claude to send it another message; the " +
      "reply shows `Resuming agent <id>` and no card for the `SendMessage` call",
  ),
  claim(
    "P36",
    "model",
    "an `AskUserQuestion` call reaches the permission callback with its options, and the answer " +
      "given in `updatedInput` is the call's result",
    "src/agent/claude/requests.ts#questionResult",
    "ask Claude to put a question with two options to you; the form shows both, and Claude " +
      "repeats the one you picked",
  ),
  claim(
    "P37",
    "gesture",
    "the mode a settings file names as `permissions.defaultMode` is the `current_permission_mode` " +
      "of the initialization result, where the file is the user settings of `CLAUDE_CONFIG_DIR`",
    "src/agent/claude/info.ts#agentInfo",
    "set a default mode in the settings of the Claude Code login, start a thread with bypass " +
      "off and send `!status`; its `Mode:` line names that mode",
  ),
  claim(
    "P39",
    "gesture",
    "a session whose configuration folder holds no login ends its turn with an assistant " +
      "message of error `authentication_failed`, which the back end reads as an authentication " +
      "failure, and an error result",
    "src/agent/claude/translate.ts#Translator.translate",
    "log out of Claude Code on the host and send a message in a thread; the reply gives the " +
      "login instructions",
  ),
  claim(
    "P40",
    "gesture",
    "a turn on a model the API refuses ends with an assistant message of the failure that the " +
      "back end reads as an agent error with its text, and an error result",
    "src/agent/claude/translate.ts#Translator.translate",
    "send a message to a thread on a model your account cannot use; the reply shows Claude " +
      "Code's sentence about it, not a bare error",
  ),
  claim(
    "P41",
    "gesture",
    "a background subagent's end gives the back end a report in bypass mode (the summary is its " +
      "last words) and in auto mode (the summary is a note and the hand-back carries the words), " +
      "and a subagent whose own background task still runs is seen running at its notification",
    "src/agent/claude/translate.ts#Translator.translate",
    "in a thread with bypass off on Sonnet in auto mode, ask for a background subagent that " +
      'starts `sleep 20` in the background and ends at once; the thread shows `Agent "..." is ' +
      "waiting on its own background work`, then its end line and its words card",
  ),
  claim(
    "L1",
    "limit",
    "the Bash tool of a session started as the daemon starts it, with no `BASH_DEFAULT_TIMEOUT_MS`, " +
      "states a foreground default of 120000 ms, a background default of 1800000 ms and that a " +
      "command is stopped at that limit, as `docs/limits.md` says",
    "src/agent/claude/session.ts#ClaudeSession",
    "the scene reads the Bash tool's description in the first request, with the variable unset. " +
      "If it fails, ask Claude in a thread what the Bash tool says of its time limits, and leave " +
      "a command running in the background for 40 minutes: if it outlives 30, the limit is gone",
  ),
  claim(
    "L2",
    "limit",
    "a session started without `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` yields no " +
      "`session_state_changed` record, as `docs/limits.md` says",
    "src/agent/claude/session.ts#ClaudeSession",
    "the scene runs one turn with the variable unset and reads the records. If it fails, the " +
      "SDK says when a session runs with no variable: `Working…` may need no variable",
  ),
  claim(
    "L3",
    "limit",
    "a session lists no `Artifact`, `SendFeedback` or `EndConversation` tool, as " +
      "`docs/limits.md` says",
    "src/agent/claude/session.ts#ClaudeSession",
    "the scene reads the tool names of the initialization message. If it fails, ask Claude in a " +
      "thread which of the three tools it has; the limit's row is the one to change",
  ),
  claim(
    "L4",
    "limit",
    "the system prompt of a session started as the daemon starts it tells Claude who it is with " +
      "the SDK's line, not the terminal's, as `docs/limits.md` says",
    "src/agent/claude/session.ts#ClaudeSession",
    "the scene reads the first request. Nothing is proved when the request holds neither line. " +
      "If it fails, ask Claude in a thread who it is: the row on how Claude is told who it is " +
      "changes",
  ),
  claim(
    "L5",
    "limit",
    "the system prompt of a session started as the daemon starts it does not suggest typing " +
      "`! <command>`, as `docs/limits.md` says",
    "src/agent/claude/session.ts#ClaudeSession",
    "the scene reads the first request. If it fails, Claude may now tell you to type `! <command>`, " +
      "which in Slack starts a command of the daemon: decide what `!` should do",
  ),
  claim(
    "L6",
    "limit",
    "a session lists no `claude-code-guide` agent and none of the three skills on artifacts, as " +
      "`docs/limits.md` says",
    "src/agent/claude/session.ts#ClaudeSession",
    "the scene reads the agents and skills of the initialization message. If it fails, ask " +
      "Claude in a thread which agents and skills it has",
  ),
  claim(
    "L8",
    "limit",
    "`/compact` in a session started as the daemon starts it asks for the SDK's summary (nine " +
      "numbered sections), not the terminal's short one, as `docs/limits.md` says",
    "src/agent/claude/translate.ts#Translator.translate",
    "the scene reads the request that follows a `/compact`. Nothing is proved when no request " +
      "carries the instructions. If it fails, send `!compact` and read the summary Claude Code " +
      "writes: the row on how a conversation is summarized changes",
  ),
  claim(
    "L9",
    "limit",
    "the stream of a `/goal` turn carries no `active_goal` record, as `docs/limits.md` says",
    "src/agent/claude/goals.ts#goalChange",
    "the scene reads the raw records of the goal scene. If it fails, the SDK now says what " +
      "becomes of a goal in its stream: the row on a goal still active after a stop changes, " +
      "and issue 113 can use it",
  ),
];

if (new Set(CLAIMS.map((c) => c.id)).size !== CLAIMS.length) {
  throw new RangeError("two claims share an id");
}

/** The outcome of `subject` given what its scene saw (null: the scene never ran). */
export function evaluate(subject: Claim, seen: Observation | null | undefined): Result {
  if (subject.retired !== null) return result(subject, "RETIRED", subject.retired);
  if (seen === null || seen === undefined || !seen.caused) {
    return result(subject, "UNPROVEN", seen ? seen.detail : "not attempted");
  }
  if (seen.holds) return result(subject, "HOLDS", seen.detail, seen.seen);
  if (subject.kind === "limit") return result(subject, "FELL", seen.detail);
  return result(subject, subject.kind === "gesture" ? "BROKEN" : "UNPROVEN", seen.detail);
}

/** Every gesture claim holds or is retired: a run that proved nothing certifies nothing. */
export function canCertify(results: readonly Result[]): boolean {
  return results
    .filter((r) => r.claim.kind === "gesture")
    .every((r) => r.outcome === "HOLDS" || r.outcome === "RETIRED");
}

export function broken(results: readonly Result[]): boolean {
  return results.some((r) => r.outcome === "BROKEN");
}

/** What to test by hand: the claims the run could not prove, and where a break would be. */
export function checklist(results: readonly Result[]): string {
  const open = results.filter((r) => r.outcome === "UNPROVEN" || r.outcome === "BROKEN");
  if (open.length === 0) return "";
  const lines = ["Test these by hand in Slack; the probe could not prove them:", ""];
  for (const r of open) {
    lines.push(
      `  [ ] ${r.claim.id} ${r.claim.kind.padEnd(7)} ${r.claim.text}`,
      `      how: ${r.claim.how}`,
      `      if it fails, look at ${r.claim.guards}`,
    );
  }
  return lines.join("\n");
}

export interface Certificate {
  readonly cli: string;
  readonly date: string;
  readonly holds: string[];
  readonly open: string[];
  readonly retired: string[];
  /** The limit claims that no longer hold; absent from an entry with none. */
  readonly fell?: string[];
}

/** The entry `certified-versions.json` keeps for a release: ids and versions, no content. */
export function certificate(
  results: readonly Result[],
  cliVersion: string,
  date: string,
): Certificate {
  const ids = (outcome: Outcome) =>
    results.filter((r) => r.outcome === outcome).map((r) => r.claim.id);
  const fell = ids("FELL");
  return {
    cli: cliVersion,
    date,
    holds: ids("HOLDS"),
    open: ids("UNPROVEN"),
    retired: ids("RETIRED"),
    ...(fell.length > 0 && { fell }),
  };
}
