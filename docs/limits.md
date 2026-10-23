# Limits

What you can do with Claude Code in the terminal and cannot do, or do differently, when you
drive it from Slack through allaboard. Each limit is listed under whoever sets it, since
that says whether it can change: a limit of the Claude Agent SDK applies to any program that
drives Claude Code, a limit of Slack to any Slack app, and a choice of allaboard is this
project's own.

Each agent allaboard can drive has a section of its own, which lists every difference found
between a session started from Slack and the same agent in its terminal, the small ones too.
Claude Code is the only agent today. Elsewhere on the page, a limit that has an equivalent you
would not notice is left out. `!status`, `!help` and
`!resume` stand in for the terminal's `/status`, `/help` and `/resume`, `!stop` interrupts as
Esc does, and a command of Claude Code is typed with `!` in place of `/`. The limits of a
single command (how many folders `!bind` lists, how large a file `!open` shares) are in
[setup.md](setup.md), beside the command.

Where a limit may have a way around it, the last column names the issue that looks into it.

In the Agent SDK section, `Checked by` names the release probe's claims that check a row on every
new SDK release (`L1` to `L6`, `L8` and `L9` are limit claims of their own, `P23`, `P24`, `P25` and `P27` are
older claims that turned into limit claims), or says `by hand:` and why only a person can. A limit
claim that no longer holds does not block a release: the probe asks for this page to change
([CONTRIBUTING.md](../CONTRIBUTING.md)). `Rests on` names, in backticks, the SDK names (`Query.stopTask`,
`SDKTaskStartedMessage`) and the `/commands` that would show the limit lifted; the cell is empty
when nothing in the SDK would. The probe prints the row beside a new release's added or removed
name or command that matches it, as a candidate to look at.

## Limits of the Claude Agent SDK

This is the section of the Claude agent. allaboard drives Claude Code through the Claude Agent
SDK, which runs it without its interactive terminal. allaboard starts a session with Claude
Code's own system prompt and with the terminal's defaults for subagents and web searches, which
the SDK leaves out; what still differs is below. Claude Code also keeps some features for the
interactive terminal: it answers a command it does not offer there with
`/<name> isn't available in this environment.` allaboard answers `!name` for each command this
page lists as not offered itself, with what to do instead where there is something, and sends
Claude Code nothing; any other command is passed through as you type it.

The first rows are about how a session runs, the others about commands.

| What differs | In the terminal | From Slack | Checked by | Looked into | Rests on |
|---|---|---|---|---|---|
| A command left running in the background | Runs until it ends | Stopped after 30 minutes, or after the time Claude asked for, 2 hours at most; Claude is told and can start it again. `BASH_DEFAULT_TIMEOUT_MS` in `.env` replaces the 30 minutes, and the 2 hours when it is longer, up to 24.8 days ([setup.md](setup.md)) | `L1` | none |  |
| How long Claude Code waits for a command in the foreground | 2 minutes by default | The same, unless `BASH_DEFAULT_TIMEOUT_MS` is set: its value replaces the 2 minutes too | `L1` | none |  |
| Publishing a page as an artifact | The `Artifact` tool | Not offered: the Agent SDK turns it off, and its documentation names no way to turn it on (read 2026-10-20) | `L3` | none |  |
| A model set by the program that drives Claude Code, then `/model` to the model your settings name | No program sets the model: you change it by typing the model command | After the SDK's `setModel`, a `/model` to the model your settings name (`model` in a settings file the session reads) is acknowledged and ignored: the command answers `Set model to <name>` and requests keep running on the model `setModel` set. A `/model` to any other model works, and so does one when no settings file names a model (measured 2026-10-16, SDK 0.3.301, Claude Code 2.1.301). allaboard does not call `setModel`: the setup's model is set by typing `/model <model>` into the session, so no override is left and your own `/model` works as in the terminal. The thread shows nothing of that command, but the session holds it: the model sees it (measured 2026-10-16 on Claude Code 2.1.301, SDK 0.3.301) and it enters the session's transcript, so a terminal `--resume` of the session lists `/model <model>` and `Set model to <name>`. `!stop` while it runs ends the setup and the session, and the message is not sent. A probe claim checks the SDK's behaviour on each release | `P27` | none |  |
| The sign that Claude is working | A spinner with a word while a turn runs, and `Waiting for 1 background agent to finish` between two turns that report | `Working…` under the thread while Claude Code says it is running: every turn, and the whole wait for a subagent left in the background, with no words of its own for that wait. A session is started with `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` for this, which a terminal session is not | `L2` | none |  |
| A subagent that starts subagents in the background | Waits for them | Does not wait: one that ends later reports to the main conversation | by hand: Claude's own documented statement, and it needs a model to nest agents | none | `SDKTaskStartedMessage` |
| A goal still set after a stop | `◎ /goal active (12s)` stays under the prompt after Esc, with the time since the goal was set | `Stopped.` is followed once by `◎ Goal still active: <condition>`; nothing stays on screen and no time is counted. The SDK says what becomes of a goal only through the transcript it mirrors to a session store, and a resumed session says nothing of its goal until the next check, so after a restart of allaboard a `!stop` says nothing of a goal set before it (measured 2026-10-20, SDK 0.3.304, Claude Code 2.1.303 in the terminal) | `L9` | none |  |
| A subagent that is continued | `Resuming agent <id>` | A small grey line, `⎿ Resuming agent <id>`, where the message was sent in the reply, for an agent that has ended and that this run of the daemon saw start. After a restart of the daemon, and for a message to an agent that still runs, the card of the call that continues it, with a launch line under that call's name in the first case | by hand: needs Claude to continue an ended agent, and Slack's drawing | none | `SDKTaskStartedMessage` |
| The end line of a task | Text of the conversation behind a coloured dot | Small and grey behind `✓` or `✗` | by hand: how Slack draws it | none | `SDKTaskNotificationMessage` |
| A subagent that is stopped | `Agent "<description>" was stopped by Claude`, or `by user`, with a mark of a third colour | `✓ Agent "<description>" stopped` when Claude stops it; no line when you stop the thread with `!stop` | by hand: needs Claude to stop an agent, and Slack's drawing | none | `SDKTaskNotificationMessage`, `Query.stopTask` |
| A command while it runs | Its description, and under it the command and its seconds, counted every second: `$ sleep 20 (8s)` | The description as the title of the run's card, followed by `· 30s` once the command has run 30 seconds, refreshed every 30 seconds while the reply's stream lives (280 seconds); past that the seconds change only when the message is rewritten for another reason. The command is under the card when it is expanded, with those of the run's other commands, while the run goes on: once it has ended and the message is rewritten by an edit, the card holds the counts alone and the command lines are gone (a card the stream carried keeps them) | by hand: Slack's 280 s stream and edit rules | none | `SDKToolProgressMessage` |
| The counts of a run | A command is counted by what it does: `Listed 1 directory`, `Searched for 2 patterns` | Every command is `Ran 1 shell command` | by hand: the daemon's own choice | none | `SDKToolUseSummaryMessage` |
| The calls of a run, one by one | `ctrl+o` opens each call with its output | Not shown | by hand: not shown by design | [#21](https://github.com/duqaXxX/allaboard/issues/21) |  |
| Several tasks started in the background by one message, one of which waits for an approval | The line of the ones already running is written at once | It is written when the last one has started, or when the reply writes anything else | by hand: the daemon's ordering and a model's choice | none | `SDKTaskStartedMessage` |
| What a subagent was asked | `ctrl+o` shows its prompt under the launch line | Not shown | by hand: not shown by design | [#21](https://github.com/duqaXxX/allaboard/issues/21) | `SDKTaskStartedMessage` |
| A task started in the background | Words of its tool: `Monitor(<description>)` then `⎿ Monitor started · task <id> · timeout 1800s`; `⎿ Backgrounded agent` under a subagent | One form for every kind of task: its name and description, then `⎿ Running in background`; no task id, no timeout | by hand: the daemon's one form | none | `SDKTaskStartedMessage`, `SDKTaskProgressMessage`, `SDKBackgroundTasksChangedMessage` |
| A job Claude Code scheduled (`/loop 5m <prompt>`, a cron the model created) | The prompt runs on its schedule while the session is open | Runs are told from the owner's turns by the list of jobs alone, since Claude Code marks a run nowhere. A run is one card per session that each run rewrites: `Scheduled run · <cadence> · run N · 22:18` (the time of the latest run) with one job, `Scheduled run · run N · 22:18` with several (a run names no job), then the run's final words and the footer of an ordinary reply with the run's own data, and no tool calls. The card shows only the latest run, its final words and its footer: earlier runs are not kept anywhere in the thread. This is the project's own choice. A run that arrives while a message of yours is queued is taken for that message's turn, and so is a run that Claude Code folds your message into: the answer then comes in a reply of its own, not on the card. A turn is also never taken for a run when a message of yours was replayed since the last turn, a background task runs, or a report was given up on, so such a run shows as an ordinary reply. The jobs and the run count are known from the first turn's end after a start of the daemon, so after a restart a run that comes first is an ordinary reply and the card counts from 1. A self-paced `/loop` (no interval) was not measured: Claude Code's documentation shows its pending wakeup as a one-shot task, and whether the Stop hook lists it is unknown, so it may or may not appear in `!status` and on the card. When the last job is deleted or the 7 days pass, one message says `Scheduled loop ended · N runs`. When the daemon restarts or stops, `!stop` ends the process, or the process is lost, while a recurring job is believed, one message says `Scheduled loop paused · N runs: it resumes with your next message in this thread` (`· N runs` is left out when no run was shown) and `!status` lists no loop until it reports one again. Claude Code's scheduled tasks documentation (read 2026-10-23) says a resumed session restores its tasks "except recurring tasks that have expired and one-shot tasks whose scheduled time has passed. A self-paced /loop isn't restored": what the daemon says follows the believed jobs: a recurring one gives the paused message; jobs that are all one-shot give `Scheduled task stopped with the session: Claude Code may restore it with your next message`, because a pending one-shot reminder is restored and a self-paced loop's pending wakeup is not, and the daemon cannot tell them apart; a list the agent emptied or the 7 days expired gives `Scheduled loop ended · N runs`. A job still ends after 7 days | by hand: needs a live `/loop`, and a self-paced one was not measured | [#3](https://github.com/duqaXxX/allaboard/issues/3) | `StopHookInput`, `SessionCronSummary` |
| A scheduled run whose prompt hands work to a background subagent | The report comes in the conversation, in order | Each run's report is an ordinary reply, not the card, and notifies. The card holds the run's own words only. Not routed into the card: a follow-up looks into it | by hand: needs a live `/loop` whose prompt starts a background agent | [#49](https://github.com/duqaXxX/allaboard/issues/49) | `SDKTaskNotificationMessage` |
| A turn Claude Code opens by itself with no task's end to report, such as one a Monitor's event opens | What woke it, on a line of its own: `Monitor event: <the line the script printed> · <description>` | Claude Code's text alone, with no line before it: the SDK yields nothing of what woke a turn it opens while idle, and replays that prompt only when the event comes while a turn runs | `P25` | none |  |
| The counts of a run that searched for tools | `ToolSearch` is not counted | Every tool is counted by its name, `ToolSearch` too | by hand: the daemon's counting choice | none | `SDKToolUseSummaryMessage` |
| How Claude is told who it is | `You are Claude Code, Anthropic's official CLI for Claude.` | `You are a Claude agent, built on Anthropic's Claude Agent SDK.`: Claude Code gives this line to every session that is not interactive and adds nothing to the preset's prompt (request read 2026-10-20, Claude Code 2.1.304, SDK 0.3.304) | `L4` | none |  |
| How a conversation is summarized when it is compacted | A short summary, at most 2,000 words, in `<summary>` tags | A longer one in nine numbered sections (Primary Request and Intent, and so on): Claude Code asks an SDK session for another summary than the terminal's, by a flag of its own that no option sets (measured 2026-10-20, Claude Code 2.1.304: 1,515 characters of instructions against 6,361) | `L8` | none |  |
| The files Claude had read, after a compaction | Claude Code reads again some of the files the session had read (`CLAUDE.md`, a file it opened with Read) and adds them after the summary | Nothing is added after the summary; why was not found (measured 2026-10-20, Claude Code 2.1.304) | by hand: needs Claude to read a file first, and that is a model's choice | none | `SDKCompactBoundaryMessage` |
| What the Bash tool tells Claude of a command left in the background | That Claude is told when it ends, and should not poll its output | That it is stopped at its time limit, with the limit's value (the row above on that limit) | `L1` | none |  |
| Sending feedback to Anthropic, ending a conversation | The `SendFeedback` and `EndConversation` tools | Not offered | `L3` | none |  |
| The agent that answers questions about Claude Code, the skills on artifacts | `claude-code-guide` and three skills | Not listed | `L6` | none |  |
| Running a shell command yourself | Claude may suggest that you type `! <command>` | Claude is not told of it, and in Slack `!` starts a command | `L5` | none |  |
| Go back to an earlier point of the conversation or of the code | `/rewind` | Not offered | `P23` | [#13](https://github.com/duqaXxX/allaboard/issues/13) | `/rewind`, `Query.rewindFiles` |
| Plan before any edit | `/plan`, or the mode switch on the keyboard | `/plan` is not offered; `!plan` inside a thread does the same by the SDK's permission mode switch, and `!plan off` leaves it. Plan mode lasts for the running session only: it does not survive a restart of allaboard or an idle close, and the session reopens in the mode your settings give (a session put in plan and resumed after a restart came back in that mode, not in plan: measured twice on 2026-10-22, SDK 0.3.304, Claude Code 2.1.304). `!bypass on` or `!bypass off` sent during plan mode ends it. Approving the plan restores the mode from before it (measured 2026-10-20, SDK 0.3.303) | `P23` | none | `/plan` |
| Branch the conversation, or ask a side question | `/branch`, `/fork`, `/subtask`, `/btw`, `/background` | Not offered | `P23` | [#4](https://github.com/duqaXxX/allaboard/issues/4) | `/branch`, `/fork`, `/subtask`, `/btw`, `/background` |
| Move a running session to another working directory | `/cd` | Not offered: the SDK fixes a session's working directory when it starts, so a thread works in the folder its channel was bound to (the command is refused, measured 2026-10-20 on Claude Code 2.1.303) | `P23` | none | `/cd` |
| Review the changes, export or copy a reply | `/diff`, `/export`, `/copy` | Not offered; ask Claude for the diff, and copy from Slack | `P23` | [#14](https://github.com/duqaXxX/allaboard/issues/14) | `/diff`, `/export`, `/copy` |
| Open the panels that manage a session | `/permissions`, `/memory`, `/hooks`, `/skills`, `/tasks`, `/sandbox` | Not offered; the settings you made in the terminal apply | `P23` | [#15](https://github.com/duqaXxX/allaboard/issues/15) | `/permissions`, `/memory`, `/hooks`, `/skills`, `/tasks`, `/sandbox` |
| Let Claude use the apps on your screen | Computer use, a server built into Claude Code | Not available: Claude Code offers it in an interactive session only | `P24` | [#16](https://github.com/duqaXxX/allaboard/issues/16) |  |
| Dictate a message | `/voice`, from the microphone | Not offered; an audio clip is the closest thing, below | `P23` | none | `/voice` |
| Text a refused request wrote before the fallback model answered | When a model refuses and Claude Code retries on another, the terminal removes the messages it retracted | A reply only grows, so the text and the cards the refused attempt had already written stay, and a line after the warning says `↩ Retracted: the <model> attempt above.`. The warning is Claude Code's own sentence, quoted; the daemon does not tell which of the retracted messages is which, so nothing is marked in place. The sentence is the notice's `content`, shown as Claude Code wrote it. A fallback of a fork or a side question that is told while the thread is idle, with no prompt sent and no report awaited, shows nothing | by hand: a refusal cannot be provoked on demand | none | `SDKModelRefusalFallbackMessage` |

The rows on how a session runs were measured on 2026-10-13 with Claude Code 2.1.296 and the
TypeScript SDK 0.3.296. The first request of an interactive session and of a session started
with allaboard's options, in the same folder, with the same prompt and model, were written to
disk with `OTEL_LOG_RAW_API_BODIES` and compared. The model, the thinking and effort settings,
the CLAUDE.md block, the five sections of the system prompt and 12 of the 14 tools were
identical. Three lines of the system prompt differed (who Claude is, the hint on `!`, the note
on `EndConversation`), two tools differed (the rows on commands and on questions), and the
terminal sent two tools more. The time limits are the ones the `Bash` tool states to Claude,
read with and without the variable. The line on who Claude is, in the table, is the one a
session the daemon started quoted when asked. A command of 40 minutes left in the background of two
sessions of the SDK was stopped after 30 minutes in the one without the variable and ran to its
end in the one with `BASH_DEFAULT_TIMEOUT_MS=14400000`. That a subagent does not wait for the subagents it started
is Claude Code's own statement ([sub-agents](https://code.claude.com/docs/en/sub-agents)), and
was not run.

The rows on a task started in the background and on a turn Claude Code opens by itself were
measured on 2026-10-15 with Claude Code 2.1.300 and the TypeScript SDK 0.3.300, in one session
started with allaboard's options (`replay-user-messages` included) and Haiku 5.5: a Monitor whose
script printed two lines and was stopped with `TaskStop`, a command and a subagent, both in the
background. The Monitor's first line came while the owner's turn still ran: Claude Code took it
into that turn and replayed the prompt that carries it, a `<task-notification>` text the SDK
does not document. Claude Code then opened three turns by itself, for the Monitor's second line
and for the two ends. No `user` record came before any of the three: only each turn's `result`
says, in its `origin`, that a task's notification opened it, and the one the Monitor's line
opened carries no `runId`. The release
probe sends a command to the background on every new SDK and checks that this still holds (claim
P25). The terminal's lines are those of a session run side by side with the daemon the same day.

The rows on commands were measured on 2026-10-09 with Claude Code 2.1.292 and again on
2026-10-10 with 2.1.294, and sent
again by the release probe on every new SDK (see [CONTRIBUTING.md](../CONTRIBUTING.md)); the
pinned SDK bundles Claude Code 2.1.304. Claude
Code's commands reference lists 119 built-in commands; a session started through the SDK is
offered 50 of them. Twenty-two of the others were each sent as allaboard sends a command:
the nineteen of the table, `/status`, `/help` and `/chrome`. Each got the answer quoted above,
at no cost in tokens. All twenty-two were sent again through the TypeScript SDK 0.3.296 (Claude
Code 2.1.296) on 2026-10-12, with the same answer, and the nineteen of the table through 0.3.300
(Claude Code 2.1.300) on 2026-10-14, 0.3.301 (Claude Code 2.1.301) on 2026-10-15, 0.3.302
(Claude Code 2.1.302) on 2026-10-18, 0.3.303 (Claude Code 2.1.303) on 2026-10-19 and 0.3.304
(Claude Code 2.1.304) on 2026-10-20.
Computer use was absent from the session's servers although it was switched on for the folder,
on the Python SDK 0.2.164 (Claude Code 2.1.292, 2026-10-09) and again on the TypeScript SDK
0.3.296 (Claude Code 2.1.296, 2026-10-12), 0.3.300 (Claude Code 2.1.300, 2026-10-14), 0.3.301
(Claude Code 2.1.301, 2026-10-15), 0.3.302 (Claude Code 2.1.302, 2026-10-18), 0.3.303
(Claude Code 2.1.303, 2026-10-19) and 0.3.304 (Claude Code 2.1.304, 2026-10-20). The
same session started with `--chrome` listed
Claude in Chrome as connected, which is a different server.

For some rows the SDK has a way of its own, which allaboard does not use: a program can
rewind the files of a session to an earlier message and resume a session as a fork. The first
was run with the TypeScript SDK 0.3.303 (Claude Code 2.1.303) on 2026-10-20, and its issue holds
the measurement. The SDK's permission mode switch to `plan` is what `!plan` uses.

## Limits of Slack

| What differs | In the terminal | From Slack | Looked into |
|---|---|---|---|
| Speaking a message | Dictation writes your words as you speak | You send an audio clip and choose **Generate transcript** on it: Slack writes no transcript by itself | none |
| The language of what you said | The `language` setting decides | Slack picks the language it hears, clip by clip, and nothing lets an app choose it | [#17](https://github.com/duqaXxX/allaboard/issues/17) |
| Being told that Claude waits for your approval | The request appears where you work | A push to your phone does not come for every request. With iOS locked and Slack open in a browser (2026-09-29), a turn that asked two or three times brought no push for any of them. Slack gives an app no way to ask for one | [#1](https://github.com/duqaXxX/allaboard/issues/1) |
| The list of what still runs, once you opened it | A line under the prompt counts the tasks and changes by itself (`· 1 shell still running`) | The list is one card, under the thread's last reply once it rests, and on no reply while that one is still written. A card you opened closes again after you leave the channel or scroll far away from it. A background subagent's line shows its step, and a background command's line shows no output, since the SDK has no public way to read it while the command runs | [#21](https://github.com/duqaXxX/allaboard/issues/21) |
| A run of calls that has ended, while the reply goes on | A grey line of counts, with no mark | A card titled with the counts and a check mark until the reply ends; a run with shell commands also lists them under the card, folded. A card leaves the reply only by an edit of its message, and Slack refuses to edit a message while its stream is open (`streaming_state_conflict`, docs.slack.dev/reference/methods/chat.update, read 2026-10-18); a card's details only grow, since Slack appends each update's to what the card holds (measured 2026-10-01). The `hide_title` a stream may set on a card is stored and changes nothing on Slack's desktop app (measured 2026-10-19) | none |
| Moving between a question's tabs | The terminal moves between the tabs at any time | A Slack modal has two footer buttons and at most three stacked views (docs.slack.dev/surfaces/modals, read 2026-10-16), so the form goes forward page by page to a review page, and back to a question with **Edit** on that page | none |
| Completing a command as you type | The terminal completes `/mo` to `/model` as you type | In a session's thread, a `!word` that is no command gets a message only you see with a field holding what you typed and the commands it could mean as buttons; Enter in the field, or the Send button under it, runs its text. No Slack app can complete or prefill the composer: slash commands created by developers cannot be invoked in message threads (docs.slack.dev, implementing slash commands, read 2026-10-21), and deep links accept no text (docs.slack.dev, deep linking, read 2026-10-21) | none |
| A conversation older than 90 days | The whole conversation stays in the terminal and in `/resume` | On Slack's free plan, messages and files older than 90 days are hidden, and data older than one year is deleted (slack.com help, articles 27204752526611 and 115002422943, read 2026-10-08). Slack hides the thread's messages and nothing else: allaboard deletes no Claude Code session, which stays on your Mac for as long as Claude Code keeps it (`cleanupPeriodDays`, 30 days of inactivity by default). Once allaboard no longer holds the thread, `!resume` continues the session in a new one. What Slack answers an app about a hidden message, and so whether allaboard forgets a thread whose first message is hidden, is not measured | [#6](https://github.com/duqaXxX/allaboard/issues/6) |

Of three clips spoken in Italian in a workspace set to English (Slack free plan, iOS app,
2026-10-09), Slack first wrote one in Italian and two as English words that were not what was
said. Later reads of the same clips gave Italian, and what changed in between is not known. The
transcript is what reaches Claude, so read it under the clip before you rely on the answer.

## Done on the machine, not from Slack

These need the terminal on the machine that runs the sessions, once or now and then. Away from
it they cannot be done.

| What | Why | Looked into |
|---|---|---|
| Logging Claude Code in or out | `claude` and `/login` on the machine. `!login` and `!logout` answer with that pointer | none |
| Configuring Claude Code: adding an MCP server or signing in to one, turning a plugin on, changing its settings | Done in the terminal, with `claude mcp`, `claude plugin`, `/mcp` or `/config`; allaboard offers no way of its own. A session started from Slack loads the result from your Claude Code settings. Signing in from Slack would carry an authorization code through a Slack message | none |
| Trusting a folder or a repository you have not used before | Claude Code shows its trust dialog in the terminal only. A session starts only in a trusted folder, and the footer, `!status` and `!open` read git only in a repository trusted by itself, one inside a trusted folder too | none |
| Updating allaboard when it is a checkout, a link, a build in another prefix, or a daemon no service runs | `!allaboard` says why. The update from Slack replaces the copy `npm install -g` replaces, with a version npm publishes, and the daemon stops to do it, which only a service starts again (`allaboard service install`). A copy of any other kind is updated in the terminal | none |

## Choices of allaboard

| What | In the terminal | With allaboard | Looked into |
|---|---|---|---|
| Who can use it | Whoever sits at the machine | One Slack user, in private channels that hold that user and the bot, in a workspace with no other member | none |
| Where it runs | macOS, Linux and Windows | macOS, as a LaunchAgent in your login session | [#7](https://github.com/duqaXxX/allaboard/issues/7) |
| Permission modes | Every mode Claude Code has | Bypass on or off for a thread; any other mode is the one your Claude Code settings start in | [#12](https://github.com/duqaXxX/allaboard/issues/12) |
| More working directories for a session | `/add-dir` | Not offered, though the SDK could (`Options.additionalDirectories` at the start, `Query.applyFlagSettings` while it runs): a thread works in the folder its channel was bound to | none |
| The commands a session finds | Every folder of your shell's `PATH` | The folders of `node`, of npm's global `bin` and of `claude`, as `allaboard service install` found them, then `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`: a folder your shell's profile adds, such as `~/.cargo/bin`, is not there | none |
| How many running tasks are listed | A line under the prompt counts every task | The card lists 6 of them, then `+N more`; its title counts all | none |
| Notes on an answer | The terminal offers Notes only on a question whose options have previews (measured 2026-10-16, Claude Code 2.1.301) | The form offers a Notes field on any question once a real option is chosen, not for an answer typed under Other alone | none |
| A goal when you stop a whole channel | No channels: Esc stops one session and keeps its goal | `!stop` in the channel drops the goal of every session whose Claude Code process is open, with its own `/goal clear`, which nothing in the threads shows. A session closed after an hour with nothing to do is not started again for it, and keeps its goal until you write there | none |
| Stopping background work | Esc interrupts the turn that runs. Stopping a background subagent from `/tasks` leaves the agent alive: it opens a turn of its own and reacts, and may go on (observed by the maintainer on 2026-10-18) | `!stop` with no turn running and a background task alive, or one that has just ended and whose report turn has not started, closes the agent's process, which ends every background command and agent and any work they would have continued. The next message resumes the same session, and the agent may mention the tasks that were cut (measured 2026-10-18, Claude Code 2.1.302). The resumed process's own word on those tasks is not shown, and the same holds for a task cut by a forced restart of the daemon. | none |

## Not checked

- A session that runs for hours. Its first request and the one after a compaction were compared
  with the terminal's (the rows above). Claude Code's own source shows no check on the kind of
  session for the reminders a later request can carry (the date, the to-do list, recalled
  memories), but a long session, one that crosses midnight and the reminders some models get
  were not measured.
- The 47 commands Claude Code does not offer to an SDK session and that are not named above were
  not sent one by one. Most are outside daily use (themes, key bindings, installers).
- A command that is offered can still open a dialog in the terminal (`/config`, `/mcp`,
  `/agents`): what each does from Slack was not tried with the TypeScript SDK allaboard is built
  on. The issue holds an earlier measurement
  ([#15](https://github.com/duqaXxX/allaboard/issues/15)).
- A reply that stays on a phone as its stream drew it. Seen twice on iOS, on 2026-10-08 and on
  2026-10-12, while desktop showed the whole reply: the first time it stopped 34 seconds into a
  turn of 116 and showed neither its text nor its footer; the second time it had its text and
  missed the footer and the line that folds the calls. Opening the thread again does not load
  it, nor does restarting the app. Resetting the app's cache does (in the Slack app:
  Preferences, then "Debug & reset cache"). What makes the app miss the end of a reply is not
  known ([#9](https://github.com/duqaXxX/allaboard/issues/9)).
- A different Claude Code under a running session when an update replaces allaboard's copy. Measured
  on 2026-10-17 (SDK 0.3.301 on both sides): a session kept its process, ran a 40-second command
  across the replacement and worked after it. The versions used in the measurement pinned the same SDK,
  so the new copy had the same Claude Code; the first update between two different ones is the
  proof that the update works.
- Whether Slack notifies for the message only you see that tells of a new version (an ephemeral
  message), and how the update line on the Home tab looks on desktop and on iOS.
- A thread older than 90 days on Slack's free plan, where older messages are hidden (Slack's help
  pages, read 2026-10-08). What allaboard does when the first message of a thread is hidden has
  not been measured ([#6](https://github.com/duqaXxX/allaboard/issues/6)).
- The daemon has never run on a Linux or a Windows host. Its tests run on both in CI, apart from
  the ones that need symlinks, FIFOs, POSIX modes, a POSIX lock or bash, and on Windows from those
  that need a trailing space or a `*` in a file name or a shell script as `git`
  ([#7](https://github.com/duqaXxX/allaboard/issues/7)).
