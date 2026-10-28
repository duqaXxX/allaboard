/** Every sentence the owner can read in the chat. English only; one place to review the wording. */
import type { AgentBackend } from "../agent/seam.ts";
import type { ChatProvider } from "../chat/seam.ts";
import { SETUP_SECTIONS, setupGuide } from "../version.ts";

/**
 * Fills a template's `{name}` fields: every template below keeps its `{name}` fields as written,
 * and a caller fills one with this. A field without a value throws.
 */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_field, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for the field {${name}}`);
    return String(value);
  });
}

/** The names a text takes from the agent and the chat the daemon runs with. */
export interface Names {
  /** The agent's name (`AgentBackend.name`). */
  readonly agent: string;
  /** Who writes the agent's replies (`AgentWords.author`). */
  readonly author: string;
  /** The command that opens the agent on the host (`AgentWords.command`). */
  readonly cli: string;
  /** The chat's name (`ChatProvider.name`). */
  readonly chat: string;
  /** Two of the agent's commands as the owner types them (`AgentWords.examples`). */
  readonly examples: string;
  /** The agent's commands that start a new session (`AgentWords.newSession`). */
  readonly newSession: readonly string[];
  /** The agent's command that logs in on the host (`AgentWords.login`); null when none. */
  readonly login: string | null;
  /** The agent's command that logs out on the host (`AgentWords.logout`); null when none. */
  readonly logout: string | null;
}

/**
 * A template that names the agent or the chat, with the fields `{agent}`, `{author}`, `{cli}`,
 * `{chat}`, `{examples}`, `{login}` and `{logout}`. It is no string, and it throws where one is
 * made of it: nothing can show it before `named` filled the names in.
 */
export class Named {
  readonly template: string;

  constructor(template: string) {
    this.template = template;
    Object.freeze(this);
  }

  toString(): never {
    throw new Error("a text that names the agent or the chat was shown before `named` filled it");
  }
}

function naming(template: string): Named {
  return new Named(template);
}

/**
 * `text` with the names filled in; its other `{name}` fields are left for `fill`. A text that
 * takes `{login}` or `{logout}` is never shown for an agent that has no such command: it throws.
 */
export function named(text: Named, names: Names): string {
  return text.template.replace(
    /\{(agent|author|cli|chat|examples|login|logout)\}/g,
    (_field, name: "agent" | "author" | "cli" | "chat" | "examples" | "login" | "logout") => {
      const value = names[name];
      if (value === null) throw new Error(`no name for the field {${name}}`);
      return value;
    },
  );
}

/** The names of an agent and a chat, as the two modules give them. */
export function namesOf(
  agent: Pick<AgentBackend, "name" | "words">,
  chat: Pick<ChatProvider, "name">,
): Names {
  return {
    agent: agent.name,
    author: agent.words.author,
    cli: agent.words.command,
    chat: chat.name,
    examples: agent.words.examples,
    newSession: agent.words.newSession,
    login: agent.words.login,
    logout: agent.words.logout,
  };
}

export const UNBOUND = naming(
  "This channel is not bound to a folder yet. Send `!bind` to choose one of the folders " +
    "{agent} trusts, or `!bind <folder>` with the folder's path relative to `{root}`, for " +
    "example `!bind my-project`. `!guide` explains how allaboard works.",
);
// The same notice for an agent that keeps no record of trust: every folder under the root is offered.
export const UNBOUND_ANY =
  "This channel is not bound to a folder yet. Send `!bind` to choose one of the folders " +
  "under `{root}`, or `!bind <folder>` with the folder's path relative to `{root}`, for " +
  "example `!bind my-project`. `!guide` explains how allaboard works.";
export const AUTH_FAILED = naming(
  "{agent} is not logged in on the host. On that machine, run `{cli}`, then `/{login}`. " +
    "The login is never done from {chat}.",
);
// The same for an agent with no command of its own that logs in.
export const AUTH_FAILED_NO_LOGIN = naming(
  "{agent} is not logged in on the host. Log in on that machine. " +
    "The login is never done from {chat}.",
);
export const LOGIN_ON_HOST = naming(
  "Log in on the host: on that machine, run `{cli}`, then `/{login}`. " +
    "The login is never done from {chat}.",
);
// `!name` for a command of the agent's terminal that a session from the chat does not offer
// (`AgentWords.notOffered`): answered by the daemon, so that no turn of the agent's is spent on it.
export const NOT_OFFERED = naming(
  "`!{command}` is a command of {agent} that a session started from {chat} does not offer.",
);
export const NOT_OFFERED_SEE = "What differs from the terminal: {link}";
export const LOGOUT_ON_HOST = naming(
  "Log out on the host: on that machine, run `{cli}`, then `/{logout}`. " +
    "It is never done from {chat}.",
);
export const DIRECTORY_MISSING =
  "The directory `{directory}` no longer exists. Restore it to keep using this thread, or, in " +
  "the channel, bind another folder with `!bind <path>` and send a new message to start a " +
  "session there.";
export const DIRECTORY_UNTRUSTED = naming(
  "{agent} has not been trusted in `{directory}`, so its hooks and settings would run " +
    "without asking. Open `{cli}` there in the terminal once and accept the trust dialog, then " +
    "send your message again.",
);
export const DIRECTORY_UNREADABLE =
  "macOS does not let allaboard read `{directory}`. Grant access in System Settings, " +
  `Privacy & Security, Full Disk Access (see ${setupGuide(SETUP_SECTIONS.protectedFolders)}).`;
export const SESSION_GONE = naming(
  "This thread's session no longer exists: {agent} deleted it or cannot find it. Send a " +
    "new message in the channel to start one.",
);
// Names no cause: the daemon keeps no record of a thread whose entry it dropped, so it cannot
// tell a thread that never held a session from one whose session may still be resumable.
export const NOT_A_SESSION =
  "This thread holds no session. In the channel, send a new message to start one, or " +
  "`!resume` to continue an earlier one.";
export const OPEN_TOP_LEVEL =
  "Opening a file belongs to one session: send `!open` inside its thread.";
// Shown only by a chat that cannot share a file into a thread.
export const OPEN_UNAVAILABLE = naming("{chat} cannot show a file here, so `!open` does nothing.");
export const TAG_TOP_LEVEL =
  "A tag belongs to one session: send `!tag <name>` or `!untag` inside its thread.";
// Shown only by a chat that cannot tag a thread.
export const TAG_UNAVAILABLE = naming(
  "{chat} cannot tag a thread here, so `!tag` and `!untag` do nothing.",
);
// The chat refused the tag: nothing changed, and the agent's tag was not asked for.
export const TAG_FAILED = naming(
  "{chat} refused the tag: `{error}`. The thread may show part of the change; `!untag` takes it away.",
);
// After the chat took the word: the agent's own tag is a second step that can fail alone.
export const TAG_AGENT_FAILED = naming(
  "{chat} shows the change, but {agent}'s own tag for this session did not change.",
);
export const DELETE_THREAD_TOP_LEVEL =
  "Deleting a thread belongs to one session: send `!delete-thread` inside its thread.";
// Shown only by a chat that cannot delete a thread.
export const DELETE_THREAD_UNAVAILABLE = naming(
  "{chat} cannot delete a thread here, so `!delete-thread` does nothing.",
);
// The same rule as the chat's index: a thread that works or waits is never deleted.
export const DELETE_THREAD_BUSY =
  "Not deleted: this thread is working or waiting for you. Send `!stop` first, then " +
  "`!delete-thread` again.";
export const WORD_IN_THREAD = "`!{word}` works in the channel, not inside a thread.";
// `!stop` typed in a thread that holds no session: it would have stopped the whole channel.
export const STOP_OUTSIDE_SESSION =
  "This thread holds no session. Send `!stop` in the channel to stop every session, or inside " +
  "a session's thread to stop that one.";
// Shown in a session's thread by a chat that suggests commands, when a `!word` is no command and
// nothing looks like it.
export const NO_SUCH_COMMAND =
  "No command looks like {word}: send `!` alone to list them all. To send it as text, put " +
  "anything before the `!`, as in `\\!important`.";
export const CLEAR_IN_THREAD =
  "One thread is one session: send a new message in the channel to start a new one.";
export const UPGRADE_NOTICE = naming(
  "allaboard now runs one {agent} session per thread. Send a new message in the " +
    "channel to start a session; reply in its thread to continue it. The session this channel " +
    "had is still in the folder: !resume brings it into a thread. Bypass is now set per " +
    "session: send !bypass on inside a thread.",
);
export const ERROR_REPLY = naming("{agent} reported an error: `{error}`");
export const ENDED = "_This reply ended before an answer: {reason}._";
export const ENDED_SHUTDOWN = "allaboard stopped";
// Crash repair: what a reply the daemon died in the middle of ends with.
export const STOPPED_BEFORE_ANSWER = "allaboard stopped before this answer.";
// Messages a restart or a failure dropped from the queue (S3): they get no reply of their own,
// one note names them. `{because}` is one of the two phrases below.
export const NOT_SENT_ONE = "1 message was not sent because {because}: send it again.";
export const NOT_SENT_MANY = "{count} messages were not sent because {because}: send them again.";
// Prompts Claude Code took into a running turn of its own (a report of a background task): no
// result of their own follows, so the reply of that turn says so at its end.
export const TAKEN_INTO_REPLY_ONE = naming(
  "{agent} took your message into this reply: send it again if it is not answered here.",
);
export const TAKEN_INTO_REPLY_MANY = naming(
  "{agent} took {count} messages into this reply: " +
    "send them again if they are not answered here.",
);
export const BECAUSE_RESTARTED = "allaboard restarted";
export const BECAUSE_SHUTDOWN = "allaboard stopped";
export const BECAUSE_STOPPED = naming("{agent} stopped");
export const BECAUSE_MOVED = "the session moved to the terminal";
// The line a reply ends with when `!terminal` took its turn to the terminal.
export const MOVED_TO_TERMINAL = "Moved to the terminal, which continues this turn.";
// The same, for work that had not reached the agent yet: nothing runs there for it.
export const MOVED_BEFORE_SENT = "Moved to the terminal.";
export const ENDED_RESTARTING = "allaboard is restarting; send your message again in a moment";
// Never shown: an idle close always finds nothing running, sent or queued to end with it.
export const ENDED_IDLE = "allaboard closed this idle session";
export const RESTARTING = "allaboard is restarting; send this again in a moment.";

// `!allaboard` and the update from the chat. A text that names the chat is `naming`;
// the link to the changelog is drawn by the chat (its markup), beside `UPDATE_WHAT_CHANGED`.
export const UPDATE_STATUS_NEWER =
  "allaboard {installed} · latest {latest}, checked {time} · `!allaboard update` installs it";
export const UPDATE_STATUS_CURRENT = "allaboard {installed} · the latest version, checked {time}";
export const UPDATE_STATUS_UNKNOWN =
  "allaboard {installed} · latest version unknown: {reason} at {time}";
// Why npm could not say, as the terminal's `allaboard update` words it.
export const UPDATE_WHY_NETWORK = "npm could not reach the registry";
export const UPDATE_WHY_PERMISSION = "npm may not read what it needs";
export const UPDATE_WHY_STATUS = "npm ended with status {status}";
export const UPDATE_OUTSIDE = naming("This copy updates outside {chat}: {reason}.");
export const UPDATE_REASON_NOT_GLOBAL = "it is not the copy `npm install -g` replaces ({path})";
export const UPDATE_REASON_LINK = "it is a link, not an install";
export const UPDATE_REASON_UNPUBLISHED = "its version {version} is not published on npm";
export const UPDATE_NOT_A_SERVICE = naming(
  "allaboard is not running as a service. `allaboard service install` in a terminal makes it one; " +
    "then it can update and restart from {chat}.",
);
export const UPDATE_OFFER = "Update allaboard {installed} → {latest}";
export const UPDATE_WHAT_CHANGED = "What changed";
export const UPDATE_DRAIN =
  "Running turns finish first, for up to 29 minutes, then allaboard restarts.";
export const UPDATE_SHARED_ONE = "Instance `{name}` runs the same copy and restarts too.";
export const UPDATE_SHARED_DEFAULT = "The default instance runs the same copy and restarts too.";
export const UPDATE_SHARED_MANY = "Instances {names} run the same copy and restart too.";
export const UPDATE_DEFAULT_INSTANCE = "the default instance";
export const UPDATE_BUTTON = "Update to {latest}";
export const UPDATE_LATEST = "allaboard {installed} is already the latest version.";
export const UPDATE_UNKNOWN =
  "The latest version is unknown: {reason}. `!allaboard update` tries again.";
export const UPDATE_NOTICE =
  "allaboard {latest} is available (this copy runs {installed}) · `!allaboard update` installs it";
// The line of the chat's own page: `UPDATE_HOME_AVAILABLE` with the link and the button, the
// dialog the button asks through, then the states of a click.
export const UPDATE_HOME_AVAILABLE = "allaboard {latest} is available, this copy runs {installed}";
export const UPDATE_CONFIRM_TITLE = "Update allaboard?";
export const UPDATE_CONFIRM_TEXT =
  "{installed} → {latest}. Running turns finish first, for up to 29 minutes, then allaboard " +
  "restarts.";
export const UPDATE_CONFIRM_YES = "Update";
export const UPDATE_CONFIRM_NO = "Cancel";
export const UPDATE_INSTALLING = "Installing allaboard {latest}…";
export const UPDATE_INSTALLED =
  "Installed allaboard {latest}. Restarting once running turns finish.";
export const UPDATE_UNDER_WAY = "An update to {version} is already under way.";
export const UPDATE_NEWER_SINCE =
  "Installing allaboard {latest}… {newer} came out since this message: `!allaboard update` " +
  "installs it after the restart.";
export const UPDATE_ALREADY_RUNS = "allaboard already runs {latest}.";
export const UPDATE_COPY_HOLDS =
  "The copy already holds {latest}; allaboard runs {installed} until it restarts: " +
  "`!allaboard restart`.";
// Another process holds the machine's update lock (another instance's click, or the terminal's
// `allaboard update`): whose it is and which version are not known.
export const UPDATE_ELSEWHERE = "An update of allaboard is already under way.";
export const UPDATE_DRAINING =
  "allaboard is restarting: send `!allaboard update` again once it is back.";
export const UPDATE_FAILED_PERMISSION =
  "The update failed: npm may not write to {folder}. allaboard keeps running {installed}. npm's " +
  "message is in the log, {log}.";
export const UPDATE_FAILED_NETWORK =
  "The update failed: npm could not reach the registry. allaboard keeps running {installed}; " +
  "`!allaboard update` tries again.";
export const UPDATE_FAILED_OTHER =
  "The update failed: npm ended with status {status}. allaboard keeps running {installed}. npm's " +
  "message is in the log, {log}.";
export const UPDATE_MISMATCH =
  "npm ended, but the copy now holds {found} instead of {latest}, so allaboard does not restart " +
  "and keeps running {installed}. In a terminal, `npm install -g allaboard@{installed}` puts back " +
  "the version that runs.";
export const UPDATE_UNREADABLE =
  "npm ended, but the copy's version cannot be read, so allaboard does not restart and keeps " +
  "running {installed}. In a terminal, `npm install -g allaboard@{installed}` repairs it.";
// The install went through and an instance on the same copy did not restart; the reason says
// what the service manager answered.
export const UPDATE_OTHER_FAILED =
  "Instance `{name}` did not restart: {reason}. `allaboard service restart --instance {name}` in " +
  "a terminal restarts it.";
export const UPDATE_OTHER_FAILED_DEFAULT =
  "The default instance did not restart: {reason}. `allaboard service restart` in a terminal " +
  "restarts it.";
export const UPDATE_OTHER_STATUS = "the service manager ended with status {status}";
export const UPDATE_OTHER_NO_MANAGER = "it has no service manager";
export const UPDATE_RESTART = "Restarting allaboard once running turns finish.";
// What the line above, or an update's "Installed", is rewritten into once the daemon is back
// (the next start reads the message from `state.json`).
export const UPDATE_RESTARTED = "allaboard restarted at {time}.";
export const UPDATE_DONE = "Updated to allaboard {version}.";
export const UPDATE_NOT_TAKEN =
  "allaboard restarted on {installed}, not on {asked}: the update did not take.";
// Under RESTARTING, and after a channel's `!status`, while a stop waits: one row per thread that
// holds it.
export const RESTART_WAITS_FOR = "It is waiting for:";
export const RESTART_WAITS_HEADER = `allaboard is restarting. ${RESTART_WAITS_FOR}`;
export const RESTART_WAIT_ROW = "• {channel}, {link}: {hold}";
export const RESTART_WAIT_SESSION = "Session"; // the link's label for a session with no title yet
export const RESTART_WAIT_STOP = "`!stop` in a thread ends the wait there.";
export const RESTART_WAITS_MORE = "…and {count} more.";
// In a channel's `!status`, a post every member reads: the threads of other channels are counted
// and not named.
export const RESTART_WAITS_ELSEWHERE = "{count} more in other channels.";
export const RESTART_HOLD_OWNER = "an approval or a question is waiting for you";
export const RESTART_HOLD_TURN = "a turn is running";
export const RESTART_HOLD_TASKS = "{counts} running";
// Ends by itself (`INJECTED_TURN_WAIT`): `!stop` has nothing to stop there.
export const RESTART_HOLD_REPORT = "a background task is about to report, within 30 seconds";
// The one form of a task started in the background, whatever its kind: the
// terminal's two lines for an agent it starts in the background, `**type**(description)` and
// `⎿ Backgrounded agent` without its key hints (captured on Claude Code 2.1.296, 2026-10-13),
// with words that fit every task under the name. `{model}` is the model an agent ran on when it
// is not the session's, a space and its name after the description as the terminal writes it
// (captured on Claude Code 2.1.300, 2026-10-15), and empty otherwise.
export const TASK_LAUNCHED = "**{name}**({description}){model}\n⎿ Running in background";
// The terminal's one line for several agents started in one message, with what each does under
// it as a tree (captured the same day: `2 background agents launched`), for every task.
export const TASKS_LAUNCHED = "**{n} background tasks launched**";
// The title of the card of a subagent's words, the terminal's header for them: `› Message from
// mechanical`, which `ctrl+o` opens on the report (captured 2026-10-24 on Claude Code 2.1.310).
// The card opens and closes as the chat draws it; the report is its body.
export const MESSAGE_FROM = "Message from {name}";
// How much of a subagent's words the message keeps.
export const MESSAGE_LIMIT = 1500;
// The terminal's words for a subagent that ended its turn while work it started in the background
// still runs: `Agent "<description>" is waiting on its own background work · 13s` (captured
// 2026-10-24 on Claude Code 2.1.310; the same words reach the model on 2.1.309).
export const AGENT_WAITING = "is waiting on its own background work";
export const TASKS_LAUNCHED_BRANCH = "├ {description}";
export const TASKS_LAUNCHED_LAST = "└ {description}";
export const PROMPT_IMAGE = "an image";
// A refusal in the reply: the agent's own words behind the mark, or the sentence built from
// what it said when it gave none; and the mark of what the refused attempt left in the reply.
export const REFUSED_MARK = "⚠️ ";
export const REFUSED_NO_FALLBACK =
  "{model} refused this request{category}; no other model answered.";
export const REFUSED_RETRACTED = "↩ Retracted: the {model} attempt above.";
// A message another of the owner's sessions sent this one, at its place in the reply.
export const PEER_MESSAGE = "📨 From another session:\n{text}";
export const COMPACTED = "Compacted the conversation: {before} → {after} tokens.";
export const COMPACTED_PLAIN = "Compacted the conversation.";
// A goal's lines in its reply, in the terminal's words (captured 2026-10-20, Claude Code 2.1.303).
export const GOAL_NOT_MET = "◯ Goal not yet met… continuing";
export const GOAL_ACHIEVED = "✔ Goal achieved";
export const GOAL_ACHIEVED_COUNTS = "✔ Goal achieved ({counts})";
// What the stop hooks said at a turn's end, in the terminal's words: `Ran 3 stop hooks`, the count
// in bold, then why one stopped the session, each refusal and each added context, in that order
// (captured 2026-10-27 on Claude Code 2.1.311; the same words in the CLI 2.1.310 the SDK bundles).
export const STOP_HOOKS_RAN = "Ran **{n}** stop {hooks}";
export const STOP_HOOK_STOPPED = "⎿ {reason}";
export const STOP_HOOK_ERROR = "⎿ Stop hook error: {error}";
export const STOP_HOOK_FEEDBACK = "⎿ Stop hook feedback: {context}";
// Each further line of what a hook said, under the first as the terminal indents it: spaces that
// do not break, so that the chat neither drops them nor reads a `- ` or a `#` after them as markup.
export const STOP_HOOK_MORE = "\u00a0\u00a0\u00a0{line}";
// Under `Stopped.`: a stop ends the turn, not the goal, which the next message resumes.
export const GOAL_STILL_ACTIVE = "◎ Goal still active: {condition}";
export const GOAL_STILL_ACTIVE_CLEAR = "◎ Goal still active: {condition} · `!{clear}` drops it";
export const NO_OUTPUT = naming("_Done. {agent} returned no text._");
export const BIND_OK =
  "Bound this channel to `{directory}`. The next message starts a new session there.";
// An old thread's session keeps the folder it was created in; `{old}` names each of them
// (comma-separated, backticked).
export const BIND_OK_ELSEWHERE =
  "Bound this channel to `{directory}`. New messages start sessions there; existing threads " +
  "keep working in {old}, where their sessions live.";
export const BIND_UNAVAILABLE =
  "Bound this channel to `{directory}`, but no session can start there yet. {reason}";
// Shown, ephemeral, before every prompt in a thread whose folder differs from the channel's.
export const OLD_THREAD_FOLDER = naming(
  "This session works in `{old}`, the folder it was created in: {agent} resumes a session " +
    "only there. New messages in the channel use `{new}`.",
);
export const BIND_MISSING =
  "`{path}` does not exist. Give the path of an existing folder under `{root}`, for example " +
  "`!bind my-project`.";
export const BIND_FILE = "`{path}` is a file, not a folder.";
export const BIND_OUTSIDE =
  "`{path}` is outside `{root}`, the folder `!bind` binds under. Give its path relative to " +
  "that folder, for example `!bind my-project`.";
export const SESSION_CLOSED =
  "Nothing was done: this session closed while it ran (idle for a while, or the daemon " +
  "restarted). Send it again if it is still meant.";
export const BIND_LIST = naming("Folders under `{root}` that {agent} trusts:");
// The title of the list for an agent that keeps no record of trust: every folder is offered.
export const BIND_LIST_ANY = "Folders under `{root}`:";
export const BIND_EMPTY = naming(
  "No folder under `{root}` is trusted by {agent} yet. Open one in the terminal with " +
    "`{cli}` and accept the trust dialog, then send `!bind` again.",
);
export const BIND_ALREADY = "This channel is already bound to `{directory}`.";
export const BIND_BUSY =
  "Sessions are running in this channel: binding another folder now would cut their work. " +
  "Let them finish or send `!stop`, then bind again.";
export const BYPASS_TOP_LEVEL =
  "Bypass belongs to one session: send `!bypass on` inside its thread.";
// True with the setup on screen and without it (after a stop, a restart or a Cancel).
// Shown only by an agent with no mode that skips permission requests.
export const BYPASS_UNAVAILABLE = naming(
  "{agent} has no mode that runs tools without asking, so there is no bypass to switch.",
);
export const BYPASS_BEFORE_START =
  "This session has not started yet: tick Bypass in its setup and press Start. " +
  "If no setup is shown, send a message here first.";
export const BYPASS_ON_THREAD =
  "Bypass is on in this session: every tool runs without asking, until `!bypass off`. " +
  "It survives a restart.";
// Says nothing about what is asked: that is the mode the owner's own settings give.
export const BYPASS_OFF_THREAD = naming(
  "Bypass is off in this session: {agent} follows your permission settings again.",
);
export const PLAN_TOP_LEVEL =
  "Plan mode is set per thread: start a thread with a first message, then send `!plan` on its own inside it, and your request after.";
export const PLAN_TAKES_NO_TEXT =
  "`!plan` takes no text: send `!plan` on its own inside a thread, then your request as a separate message.";
// Shown only by an agent with no plan mode.
export const PLAN_UNAVAILABLE = naming("{agent} has no plan mode.");
export const PLAN_BEFORE_START =
  "This thread has no session yet: send a first message, then `!plan`, then your request.";
// Plan mode ends with the plan's approval, `!plan off`, or a `!bypass` word (which sets a mode).
export const PLAN_ON_THREAD = naming(
  "Plan mode is on in this session: {agent} plans first and asks you to approve the plan. " +
    "`!plan off` leaves it, and so does `!bypass on` or `!bypass off`.",
);
export const PLAN_OFF_THREAD = "Plan mode is off in this session.";
export const STOPPED = "Stopped the current turn.";
// An answered question, as the terminal keeps it in the transcript.
export const ANSWERED = naming("User answered {author}'s questions:");
// Slack drops plain spaces at the start of a line; no-break spaces stay and make the indent.
export const NESTED = `${"\u00a0".repeat(4)}⎿ `;
export const STOPPED_CHANNEL = "Stopped what was running in this channel.";
// The thread's status line while a restart waits for background tasks only, and the same after
// the app's name. Never a message: it would notify and stay in the thread after the restart.
export const RESTART_WAITS = "Restart waits for {counts} · !stop ends {them} now";
export const RESTART_WAITS_STATUS = "is waiting to restart: {counts} still running";
// The same as a message, only where Slack refuses the app a thread status.
export const RESTART_WAITS_MESSAGE =
  "allaboard is restarting once these background tasks end: {counts}. `!stop` ends them now.";
export const NOTHING_TO_STOP = "Nothing is running in this channel.";
// Both answers to `!stop` in a thread are posts that stay: an ephemeral line is gone on reload.
export const STOPPED_THREAD = "Stopped.";
export const NOTHING_TO_STOP_THREAD = "Nothing is running in this session.";
// The same-folder hold: two sessions in one folder at once.
export const HOLD_QUESTION = "Another session is working in this folder: {link}. Send anyway?";
export const HOLD_UNPOSTED = naming(
  "allaboard could not show this question in {chat}, so the message was not sent. Send it again.",
);
export const HOLD_GONE =
  "This question is no longer open: it was already answered, or allaboard restarted.";
export const NOT_SENT = "Not sent.";
export const SHELL_EXITED = "✓ exit 0 · {seconds}";
export const SHELL_FAILED = "✗ exit {code} · {seconds}";
export const SHELL_TIMED_OUT = "✗ timed out after {seconds}";
export const SHELL_SIGNALLED = "✗ ended by {signal} · {seconds}";
export const SHELL_STOPPED = "Stopped after {seconds}.";
export const SHELL_NOT_STARTED = "✗ the command could not start:";
export const SHELL_LINES_LEFT_OUT = "… {count} lines above not shown";
export const SHELL_OFF = "Shell commands are turned off for this instance (`ALLABOARD_SHELL`).";
export const SHELL_UNAVAILABLE = naming("{agent} cannot be told of a shell command you run.");
export const SHELL_TITLE = "Run this command?";
// The session is open in a terminal on the host (`flows/terminal.ts`). `{command}` is the line
// that reopens it there, which the chat shows as a command.
export const TERMINAL_OPEN_TITLE = "This session is also open in a terminal";
export const TERMINAL_OPEN =
  "⚠️ This session is also open in a terminal. If you send this here, that terminal will not " +
  "see it: before writing there, close it and run {command} again.";
export const TERMINAL_BUSY_TITLE = "This session is running a turn in a terminal";
export const TERMINAL_BUSY =
  "⏳ This session is running a turn in a terminal. Your message waits here until that turn ends.";
export const TERMINAL_MOVE_TITLE = "Move this session to the terminal?";
export const TERMINAL_MOVE = "⚠️ Moving to the terminal stops what still runs here: {running}.";
export const TERMINAL_SENT = "Sent here.";
export const TERMINAL_TURN_ENDED = "The terminal's turn ended.";
export const TERMINAL_MOVED = "Moved to the terminal.";
export const TERMINAL_NOT_MOVED = "Not moved.";
// `!terminal`'s answers. `{command}` is the line to run, shown as a command.
export const TERMINAL_TOP_LEVEL =
  "`!terminal` works inside a session's thread, not in the channel.";
export const TERMINAL_NOT_STARTED = "This session has not started yet: send it a message first.";
export const TERMINAL_CUT = naming(
  "Stopped here. The terminal continues this turn by itself: the command that was running is " +
    "stopped, and {author} runs it again there.\n{command}",
);
export const TERMINAL_IDLE = "Continue in the terminal with:\n{command}";
export const TERMINAL_WAIT =
  "A turn is running here: wait for its end, or `!stop` it, then continue in the terminal " +
  "with:\n{command}";
// A turn the owner ran in the terminal, shown in the thread before the reply to his next message.
export const TERMINAL_TURN = "🖥 In the terminal:\n› {prompt}\n\n{reply}";
export const TERMINAL_TURN_UNANSWERED = "🖥 In the terminal:\n› {prompt}";
// A turn moved with `!terminal`, which the terminal went on with by itself.
export const TERMINAL_TURN_WENT_ON = "🖥 In the terminal, the turn went on:\n\n{reply}";
export const SHELL_OUTSIDE_SESSION = "`!!` runs a shell command inside a session's thread.";
export const SHELL_FIRST_PROMPT =
  "Send this session its first prompt before a shell command: it starts with its setup.";
// Session setup: asked once per top-level message, before the first prompt of a new session.
export const SETUP_FALLBACK = "Set up this session";
// The line that replaces the setup's controls once the owner started the session.
export const SETUP_SUMMARY = "Model: {model} · Effort: {effort} · Bypass: {bypass}";
export const SETUP_EFFORT_DEFAULT = "Default";
/** The effort the footer shows for a model a turn reported takes none. */
export const EFFORT_NOT_SUPPORTED = "not supported";
export const STATUS = "Directory: `{directory}`\nSession: `{session}`";
// The session's title, when the agent has one, and the root as the owner wrote it before the daemon
// titled it (`rootPrompt`). `quote` is that text, each line marked as quoted.
export const STATUS_TITLE = "Title: {title}";
export const STATUS_PROMPT = "Prompt:\n{quote}";
export const STATUS_STATE = naming("Mode: `{mode}`\n{agent}: `{version}`\nNow: {activity}");
// The line between the two once the thread has a session id. Claude Code leaves a
// session created through the Agent SDK out of the terminal's picker; a fork made in the
// terminal gets an id of its own and a row there (sessions reference, read 2026-10-04; the
// picker listing such a fork measured on CLI 2.1.282). `claude --resume <id>` finds a session
// from any folder since 2.1.223 (same reference): the `cd` chooses where the fork works and
// whose picker lists it. `directory` arrives quoted for the shell, and `command` as a code
// span, or escaped as plain text when it holds a backtick.
export const STATUS_TERMINAL = "Terminal: {command}";
// Under it, while a turn or background work runs here: the terminal would branch the session.
export const STATUS_TERMINAL_TURN =
  "⚠️ A turn is running here: writing in the terminal before it ends splits the session.";
export const STATUS_TERMINAL_TURN_MOVE =
  "⚠️ A turn is running here: writing in the terminal before it ends splits the session. " +
  "`!terminal` moves it there now.";
export const STATUS_TERMINAL_BACKGROUND =
  "⚠️ {counts} still running here: writing in the terminal before it ends splits the session.";
// The repositories below a session's folder that the agent's record of trust does not cover
//: the daemon's own git runs in none of them, and only the agent gives that trust,
// in a terminal. Said after `!bind` and in a thread's `!status`; one line per repository below.
export const UNTRUSTED_REPOSITORIES = naming(
  "{agent} has not trusted these repositories yet, so the footer and `!open` show no git " +
    "changes in them. Before you trust one, read its settings and hooks for {agent}: they run " +
    "without asking once it is trusted. To trust it, run its line in the terminal and accept " +
    "the trust dialog:",
);
export const UNTRUSTED_MORE = "…and {count} more.";
export const ACTIVITY_IDLE = "idle";
export const VERSION_PENDING = "started, version shown after the first turn";
export const STATUS_BACKGROUND = "Background: `{counts}`";
// The loop card's label for a run, and the one message that says the loop is over.
export const LOOP_RUN = "Scheduled run · {cadence} · run {run}";
export const LOOP_RUN_MANY = "Scheduled run · run {run}";
// `{runs}` is ` · 1 run` or ` · 14 runs`, and nothing when no run was shown.
export const LOOP_ENDED = "Scheduled loop ended{runs}";
// Said when no job believed is recurring: a one-shot reminder is restored on resume and a
// self-paced loop's pending wakeup is not, and the two cannot be told apart.
export const LOOP_STOPPED = new Named(
  "Scheduled task stopped with the session: {agent} may restore it with your next message",
);
export const LOOP_PAUSED =
  "Scheduled loop paused{runs}: it resumes with your next message in this thread";
export const STATUS_LOOP = "Loop `{cadence}`: {prompt}";
export const STATUS_WORKING = "Working in: `{directory}`";
// The count `!status` adds to a session's row.
export const RUNNING = "⏳ {counts}";
// Slack's status line under a thread's last message. A client shows the
// loading message: `THREAD_WORKING` while a prompt of the owner's is owed its answer and while
// the agent says it works.
// `STILL_RUNNING` is the terminal's words for a task that outlives its turn (`· 1 shell still
// running`, Claude Code 2.1.287, read 2026-10-02), and the title of the list of what still runs,
// with no hourglass: an emoji draws large and grey in a status line (seen on desktop,
// 2026-10-02). `THREAD_WORKING_STATUS` says the same
// after the app's name, which is what a client that draws `<app name> <status>` shows
// (measured 2026-10-02, desktop and iOS).
export const THREAD_WORKING = "Working…";
// The terminal's words while it compacts (`Compacting conversation`, read in the CLI 2.1.292).
export const THREAD_COMPACTING = "Compacting conversation…";
export const THREAD_COMPACTING_STATUS = "is compacting the conversation…";
export const STILL_RUNNING = "{counts} still running";
export const THREAD_WORKING_STATUS = "is working…";
export const ACTIVITY_BUSY = "running a turn, {queued} queued";
// `!status` sent to the channel (top-level, or a thread that holds no session): the channel's
// folder, then one line per live session, each with a link to its thread.
export const STATUS_CHANNEL_HEADER = "Directory: `{directory}`";
export const STATUS_CHANNEL_EMPTY = "No session in this channel.";
// The threads past `STATUS_ROWS`, the oldest by their last message.
export const STATUS_CHANNEL_MORE = "+{count} older, not listed";
export const STATUS_CHANNEL_ROW = "{link}: {activity}";
// With a chat that marks a root with its status: the same mark leads the row, in place of the word.
export const STATUS_CHANNEL_MARKED_ROW = "{mark} {link}{since}";
export const STATUS_CHANNEL_WAITING = "waiting for you";
export const STATUS_CHANNEL_BUSY = "busy";
export const STATUS_CHANNEL_IDLE = "idle";
// After `idle`, how long ago the session's last message was written, when that is known.
export const STATUS_CHANNEL_SINCE = " · {ago}";
export const STATUS_CHANNEL_SESSION = "Session"; // the link's label for a session with no title yet
export const STATUS_CHANNEL_BYPASS = " · ⚡ bypass";
export const STATUS_CHANNEL_PLAN = " · ⏸ plan";
export const STATUS_CHANNEL_FOLDER = " · folder `{directory}`";
export const STATUS_CHANNEL_LINK_FALLBACK = "thread `{thread_ts}`";
export const HELP_OWN = "**allaboard**";
export const HELP_RULE =
  "A message that starts with `!` is a command, in code or bold too. To send it as text, put " +
  "anything before the `!`, as in `\\!goal`.";
export const HELP_WORDS: readonly Named[] = [
  "`!guide` how allaboard works, in a few lines; in the channel or inside a thread",
  "`!help [text]` this list, or only the lines that contain the text; in the channel or " +
    "inside a thread",
  "`!status` in the channel: every session's state; inside a thread: that session's " +
    "directory, mode and the footer's values",
  "`!stop` in the channel: every running session, its background tasks and its pending " +
    "approvals; inside a thread: only that session",
  "`!terminal` move this session to a terminal on the host: a running turn goes on there by " +
    "itself; inside a thread, refused in the channel",
  "`!bind [folder]` the folders {agent} trusts, or bind this channel to one, its path " +
    "relative to the allowed root; in the channel, refused inside a thread",
  "`!bypass on|off` run every tool without asking, until `!bypass off`; it survives a " +
    "restart; inside a thread, refused in the channel",
  "`!plan [off]` plan before acting: {agent} proposes a plan and asks you to approve it; " +
    "`!plan off` leaves plan mode; this session only, it does not survive a restart; inside a " +
    "thread, refused in the channel",
  "`!resume [session]` this directory's sessions, or resume one by id or name in the " +
    "thread of your `!resume` message; in the channel, refused inside a thread",
  "`!open [file]` share a file of the session's folder into the thread, where {chat} opens it in " +
    "its file viewer: a picker alone, or a path or part of a name; inside a thread, refused in " +
    "the channel",
  "`!tag <name>` mark this session's thread with a tag, 1 to 40 letters, digits, `.`, `_` or " +
    "`-`: {chat} shows it on the thread's first message and keeps the thread at hand, and " +
    "{agent} gets it on the session; inside a thread, refused in the channel",
  "`!untag` take the tag and the mark away, with or without the tag's name after it; inside a " +
    "thread, refused in the channel",
  "`!delete-thread` delete every message of this session's thread from {chat}, once you confirm; " +
    "the session stays in {agent} and `!resume` lists it again; refused while the thread works " +
    "or waits for you; inside a thread, refused in the channel",
  "`!! <command>` run a shell command in the session's folder, as the terminal's `!` does, " +
    "once you click Run; {agent} gets the command and its output and answers; inside a " +
    "thread, refused in the channel",
  "`!allaboard [update|restart]` the version that runs and the latest one; `update` offers the " +
    "latest and installs it on your click, `restart` restarts allaboard, both once running turns " +
    "finish; `update` and `restart` in the channel, refused inside a thread",
].map(naming);
// The words for an agent that keeps no record of trust: only the `!bind` line differs.
const HELP_BIND_ANY = naming(
  "`!bind [folder]` the folders under the allowed root, or bind this channel to one, its " +
    "path relative to that root; in the channel, refused inside a thread",
);
export const HELP_WORDS_ANY: readonly Named[] = HELP_WORDS.map((word) =>
  word.template.startsWith("`!bind ") ? HELP_BIND_ANY : word,
);
export const HELP_NO_MATCH = "No command matches `{query}`.";
export const HELP_AGENT = naming(
  "\n**{agent}** (this session, now). Any other `!name args` runs that command; " +
    "these words above come first.",
);
export const HELP_UNBOUND = naming(
  "\n{agent}'s own commands are listed inside a session's thread.",
);
export const DENY_MESSAGE = naming("The owner denied this from {chat}.");
export const SKIP_MESSAGE = "The owner dismissed the question without answering.";
export const APPROVAL_UNPOSTED = naming(
  "allaboard could not show this request in {chat}, so nobody approved it.",
);
export const APPROVAL_GONE =
  "This request is no longer pending: the turn ended or allaboard restarted.";
export const RESUME_LIST = "Sessions in `{directory}`, newest first:";
// Shown only by an agent that keeps no list of its sessions.
export const RESUME_UNLISTED = naming(
  "{agent} keeps no list of its sessions, so `!resume` has nothing to pick from.",
);
// Two processes on one session share its file and not its conversation (measured 2026-10-03,
// SDK 0.2.163 beside a host CLI 2.1.288 process): each keeps the session as it loaded
// it plus its own turns, and a later resume continues one of the two branches.
export const RESUME_OK =
  "Resumed **{title}**: your next message continues it. If it is open in a terminal, close it " +
  "there first: while it is open in both, neither sees the other's messages, and a later " +
  "resume keeps only one side's.";
export const RESUME_NONE =
  "No session in `{directory}` has the id or name `{target}`: `!resume` lists them.";
export const RESUME_AMBIGUOUS =
  "More than one session in `{directory}` is named or starts with `{target}`: pick one from " +
  "`!resume`.";
export const RESUME_STALE = "This list is out of date: send `!resume` again for a current one.";
export const RESUME_GONE =
  "That session is not in this channel's directory any more: `!resume` lists them.";
export const RESUME_HELD =
  "This thread already holds a session: send `!resume` again in the channel to pick another.";
// What the list is rewritten to after a Resume click, only when it cannot be deleted.
export const RESUME_LISTED = "Resumed {title} in {link}.";
// A session held by any thread of any channel is never resumed a second time; `{link}` is the
// holding thread's permalink (a plain fallback when Slack would not give one).
export const RESUME_ELSEWHERE = "This session is already open in another thread: {link}.";
// `!guide`: how to use the bot, in the owner's words, as parts that `src/core/guide.ts` chooses
// among and joins: a part appears only when the agent and the chat serve what it describes.
// `test/core/commands.test.ts` fails when a word of the daemon is missing from the whole; keep
// the tone plain and every line true of the current behaviour.
export const GUIDE_INTRO = naming(
  "**allaboard**\n" +
    "This channel runs {agent} on your Mac, in one folder, and answers you alone. One {chat} " +
    "thread is one {agent} session: a top-level message starts a new one, and a reply inside its " +
    "thread continues it, even days later.",
);
export const GUIDE_START = "**Get started**";
export const GUIDE_BIND_TRUSTED = naming(
  "1. `!bind` lists the folders {agent} trusts, with a Bind button each; `!bind <folder>` " +
    "binds one by its path relative to your allowed root: `!bind my-project`. {agent} must trust " +
    "that folder first: open `{cli}` there once in the terminal and accept. `!bind` works only as a " +
    "top-level message in the channel.",
);
export const GUIDE_BIND_ANY =
  "1. `!bind` lists the folders under your allowed root, with a Bind button each; " +
  "`!bind <folder>` binds one by its path relative to your allowed root: `!bind my-project`. " +
  "`!bind` works only as a top-level message in the channel.";
export const GUIDE_FIRST_MESSAGE = naming(
  "2. Write a message in the channel: it opens a session, and its reply appears in a thread of its " +
    "own, growing as {author} works, with a line for each tool it uses. Reply inside that thread to " +
    "continue the same session. Attach images or files to a message: {author} sees a JPEG, PNG, GIF or " +
    "WebP image directly (other image types are refused) and reads a text, code, PDF, JSON, XML, YAML " +
    "or notebook file from a copy saved on this Mac; other files are refused.",
);
// Step 3 holds what the setup asks for; `{choices}` is the items on offer, joined as a list.
export const GUIDE_SETUP =
  "3. Before that first message is sent, the thread asks for {choices}; **Start** sends your " +
  "message with those choices, and `!stop` cancels it instead.";
export const GUIDE_SETUP_MODEL = "the **Model**";
export const GUIDE_SETUP_EFFORT = naming("the **Effort** (`Default` leaves {agent}'s own choice)");
export const GUIDE_SETUP_BYPASS = "**Bypass permissions**";
export const GUIDE_COMMANDS = naming(
  "**Commands**\n" +
    "{agent}'s commands start with `!` instead of `/`: {examples}. They run inside " +
    "a session's thread, where `!help` lists every command that session offers, and `!help <text>` " +
    "filters the list; typed in the channel, `!help` lists allaboard's own words instead.",
);
// Joined to the guide's commands section, with `{names}` the agent's new-session commands.
export const GUIDE_NEW_SESSION =
  "{names} is refused inside a thread (one thread is one session): start a " +
  "fresh session with a new top-level message instead.";
export const GUIDE_APPROVALS = "**Approvals**";
export const GUIDE_APPROVALS_AND_QUESTIONS = "**Approvals and questions**";
export const GUIDE_PERMISSION = naming(
  "When {agent} asks permission, the request shows what will run, with **Approve** and " +
    "**Deny**; a very long one shows its start and its end and says how much it leaves out.",
);
export const GUIDE_QUESTION = naming(
  "A question from {author} comes with **Answer**, which opens a short form, and **Skip**.",
);
// The Sessions section, sentence by sentence: `guide.ts` leaves out the tasks and the resume ones.
export const GUIDE_SESSIONS_STATUS =
  "**Sessions**\n" +
  "`!status` typed in the channel lists the folder and every session still live, each linked to " +
  "its thread; inside a thread it shows that session's directory, mode and the footer's values. " +
  "`!stop` typed in the channel stops every running session";
export const GUIDE_SESSIONS_TASKS = " and its background tasks";
export const GUIDE_SESSIONS_STOP = "; inside a thread it stops only that one.";
export const GUIDE_SESSIONS_RESUME =
  "`!resume`, typed in the channel only, lists this folder's twenty " +
  "newest sessions, from the terminal too, each with the start of its id and a **Resume** button; " +
  "`!resume <id>` (that start is enough), or `!resume <title>` for a session that has one, resumes " +
  "it in the thread of your `!resume` message.";
export const GUIDE_SESSIONS_TERMINAL =
  "To continue a session in the terminal, run the `Terminal:` command `!status` shows in its " +
  "thread, or send `!terminal` there, which moves a running turn too. Write from one side at a " +
  "time: a terminal left open does not see what you write here, and is reopened before you " +
  "write there again.";
export const GUIDE_FILES = naming(
  "**Files**\n" +
    "`!open`, sent inside a session's thread, offers the files changed in that session and a search " +
    "over the folder's files; choosing one shares it into the thread, where {chat} opens it in its " +
    "file viewer, with Markdown rendered. `!open <path>` opens that file, and `!open <words>` the file " +
    "whose path contains them, or lists the files that do. The search reads the folder from disk and " +
    "leaves out what `.gitignore` excludes inside a git repository. A file over 1 MB is not opened.",
);
export const GUIDE_BYPASS = naming(
  "**Bypass**\n" +
    "`!bypass on`, sent inside a session's thread, lets {agent} run every tool without asking in " +
    "that session, until `!bypass off`; a restart of allaboard keeps it. The footer shows ⚡ " +
    "bypass while it is on.",
);
export const GUIDE_PLAN = naming(
  "**Plan mode**\n" +
    "`!plan`, sent inside a session's thread, makes {agent} plan before it acts: it proposes a plan " +
    "and asks you to approve it. `!plan off` leaves plan mode, and so does `!bypass on` or " +
    "`!bypass off`. It belongs to the running session: a restart of allaboard or an idle close " +
    "puts the session back in its normal mode.",
);
export const GUIDE_TAGS = naming(
  "**Tags**\n" +
    "`!tag <name>`, sent inside a session's thread, marks it: {chat} shows `[name]` at the start " +
    "of the thread's first message and keeps the thread at hand, and where {agent} can tag a " +
    "session it gets the same tag. The name is 1 to 40 letters, digits, `.`, `_` or `-`; a new " +
    "`!tag` replaces the old one. `!untag` takes the tag and the mark away. A thread whose " +
    "session has not started yet is marked in {chat} alone.",
);
export const GUIDE_SHELL = naming(
  "**Shell commands**\n" +
    "`!!command`, sent inside a session's thread, is the terminal's `!command`: allaboard shows " +
    "it with **Run** and **Cancel**, then runs it with Bash in the session's folder and shows " +
    "its output; {agent} gets the command and its output, and answers. `!stop` stops a command " +
    "that runs.",
);
export const GUIDE_DELETE = naming(
  "**Deleting a thread**\n" +
    "`!delete-thread`, sent inside a session's thread, asks you to confirm, then deletes every " +
    "message of the thread from {chat}, yours and the bot's. The session stays in {agent}: " +
    "`!resume` lists it again. A thread that is working or waiting for you is not deleted: " +
    "`!stop` it first.",
);
// Joined to the guide only where allaboard can update itself (`GuideOffer.updates`).
export const GUIDE_UPDATES =
  "**Updates**\n" +
  "`!allaboard` shows the version that runs and the latest one. `!allaboard update`, typed in the " +
  "channel, offers the latest version with a button that installs it: running turns finish " +
  "first, then allaboard restarts on the new version. `!allaboard restart` restarts it without " +
  "installing anything. Both work only while allaboard runs as a service.";
export const GUIDE_END = "`!guide` shows this text again.";
