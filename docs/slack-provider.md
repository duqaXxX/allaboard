# The Slack provider

How the Slack provider (`src/chat/slack/`) draws the chat seam: how it writes a reply to Slack,
serves `!open`, publishes the session index on the app's Home tab, and handles what Slack sends.
The core, the two seams, the sessions and the state file are in
[architecture.md](architecture.md), which also defines the terms used here. A note of the form
`measured: "..."` names a row of
[Measured platform behaviour](#measured-platform-behaviour) below, or of the table of the same name in
[architecture.md](architecture.md#measured-platform-behaviour) when the observation is about the SDK or
Claude Code.

## Writing to Slack

The Slack provider's `ReplySink` (in `sinks`, the implementation of the chat seam's reply) writes
each reply as a native Slack stream inside the session's own thread, below the message that asked for it (`chat.startStream` with chunks, addressed to the owner's user
and team). The stream starts with Claude's first content, its first text or the card of the first
tool when a turn opens with one, and never with a placeholder. It grows with `chat.appendStream` at
most once every `sinks.DEBOUNCE_SECONDS` per reply, and each append draws from one shared
`UpdateLimiter` (in `limiter`, an option of the Slack provider, `SlackChatOptions`), as does every
`chat.update`: a token bucket that paces writes evenly at 40 per 60 seconds plus a burst of 5, worst
case 45 in one window, under the documented floor of `chat.update` (Tier 3, 50 or more a minute, per
app), so several busy threads together stay under the app's own budget instead of racing through it
and then freezing until it resets. A write that waited `limiter.UPDATE_WAIT_LOGGED_SECONDS` or more
for its turn is logged with the time it waited, which is what tells whether the budget ever held
back what the owner sees.

Text reaches Slack as markdown, where `<!here>`, `<!channel>`, `<!everyone>`, `<!subteam^…>` and
`<@…>` are stored as mentions and notify as typed ones do; a backslash before them stops none. The
sink writes a zero-width space after the `<` of each (`escape.quietMentions`), in every text part,
the daemon's lines included since some carry Claude's words, and inside code too: Slack pairs
backticks where CommonMark would not, and a reply split across messages can start one inside a
fence, so the sink does not try to tell code apart. The text reads the same; a sequence copied out
of a code block carries the invisible space. `<#C…>` is a channel link, which notifies nobody, and
is left as written. Words still arriving that may become a sequence (`<`, `<!he`) wait for what
follows; when the part closes they get the space all the same. A new file's preview
(`blocks.previewBlocks`) and a session's title in a link (`escape.markdownEscape`) get the space
too.

A fenced code block indented under a list item, as CommonMark writes it, is stored by Slack as the
item's plain text, its lines run together. The sink moves such a block to the start of the line
(`markdown.codeOutOfLists`), with the item's lines after it, and puts a blank line before the item
that follows: Slack then stores the block as code and the list goes on from the next number. A
line still arriving waits while it may turn into a fence or an item.

### Retries and writes in flight

The retries of a Slack call are the daemon's own policy, in `clients`. Both clients are built with
the library's retries switched off (`clients.SENT_ONCE`), and the policy is applied around the
client's `apiCall`:

| Failure | What is sent again |
|---|---|
| Slack rate limited the call (HTTP 429) | every method, after the `Retry-After` Slack gave, up to `clients.RATE_LIMIT_RETRIES` (3) times and while the call's pauses add up to no more than `clients.RATE_LIMIT_WAIT_SECONDS` (60, the jitter left out): a rate limited call never ran. A pause that would pass the 60 seconds is not taken and the call is thrown as rate limited, since a reply's calls are sent holding its lock and a `!stop` waits for it. A 429 with no valid `Retry-After` is not sent again. Once the daemon stops, a rate limited call is not sent again either, and the pause of one that waits ends (`ClientOptions.stopped`): the call is thrown as rate limited. Each rate limit is logged with its method, the `Retry-After` Slack gave and which send of the call it answered, never the call's arguments |
| the connection failed before an answer (a reset, a refused or unreachable host), or Slack answered with HTTP 500 or 503 (`clients.SERVER_ERROR_STATUSES`) | once, after a backoff pause, while no retry of the call was made yet. `clients.sharedClient` does so for every method. `clients.repliesClient`, the one replies are written with, does so for every method but the four of `clients.CREATING_METHODS`, `chat.postMessage` and the three stream calls: they are not idempotent, and a reset can come after Slack applied the call; whether a 500 or a 503 can was not measured, and they are left out for those too |
| anything else | never: an error Slack answered with, any other HTTP status, and the client's own timeout (`clients.REQUEST_TIMEOUT_MS`, 30 seconds), since a timed out call may have run |

For the four creating calls the sink reads the thread back and adopts what landed
(`ReplySink.adopt`). The library's `files.uploadV2` is passed through untouched: the two Slack
methods it calls come back through `apiCall` and are retried there, one by one.

A write to Slack that has begun always runs to its end. A pass of the sink (`ReplySink.flush`) takes
the reply's lock, brings every message to the model and ends the reply if it has ended; once asked
for it is never cancelled, and the next pass queues behind it. The Slack client cannot abort a call
in flight, and a call given up after Slack took it would lose a message's ts or post an ending
twice. What can be cancelled is a wait outside a pass: the debounce before a write, the pause before
the end's one retry, the stream's 280 seconds, and a caller's own wait for a pass. `finish`,
`closeOut`, `waitLanded` and `settle` take an `AbortSignal`: aborting it rejects that call and
leaves the pass running. `ReplySink.settle` then waits for what is in flight.

### Order, runs of calls and cards

An answered question lists each answer under a line that starts with `NESTED` (`src/chat/slack/texts.ts`):
four no-break spaces then `⎿`, since Slack drops the plain spaces at the start of a line.

Within a reply, writes happen in the order things happen. Claude's text goes as `markdown_text`
chunks. Tools go as `task_update` chunks, each a card Slack updates in place by its id.

A run of calls, the calls between two pieces of text, shares one card (`Fold` in
`src/chat/slack/reply/fold.ts`, fed by `ReplySink.task`: the folding is the Slack provider's own, since
it rests on a card Slack updates in place), as the terminal draws one line for a run (captured on Claude Code 2.1.296).
While a call of the run runs, the card is titled with it: the last call started that still runs,
by the tool's name and its first argument, or by its description for a command
(`Previews.described`). Calls that run at the same time show one at a time, and nothing shows of
the calls before. With no call running, the card holds the counts of what ended, in the
terminal's words where the terminal has words (`Previews.folded`:
`Ran 2 shell commands, read 1 file`): a comma between two counts, a capital on the first, no
mark, and a failed command counted with the others. The card carries no `output`, and no
`details` but one line per command of the run, `$ <command>` (`Previews.commandLine`): Slack
appends both fields to what a card already holds (measured: "Card text is appended"), so each
command adds its line, and a card that is reused keeps the rest of its text in its title.

While a command runs, its title ends with its seconds once it has run
`sinks.RUNNING_REFRESH_SECONDS` (30): `Pinging localhost · 30s`, then `· 1m 0s`, as the
terminal's line reads (captured on Claude Code 2.1.301), counted from `TaskUpdate.startedAt`.
While the stream lives the sink writes the title again every 30 seconds, an append that replaces
the title alone; once the stream has stopped no write is made for the seconds, and they move only
when the message is written again for another reason, since a `chat.update` writes the whole
message.

A call with a view of its own has a card of its own, keyed by its call id, and ends the run: a
subagent the call waits for, whose title counts its calls and whose `details` say what it is doing
now, a
stopped call, and a failed call of any tool but a command (`Previews.failsCounted`), whose card
says why. A subagent in the background has no card: the core writes its launch line as text
of the reply (`TurnRenderer`, `Previews.launched`). A message that continues a subagent that has
ended (`Previews.continued`) has no card either: the core writes `⎿ Resuming agent <id>` as a line
about the work, with the first 7 characters of the id, as the terminal does
(`previews.resuming`). A call that
turns into one of these keeps the run's card when it was the run's only call. An `Edit` or a `Write` that
ended well also ends the run, and has no card: its preview is all that shows it.

A line about the work, which the core marks `aside` (a task's end line), is a `context` block too,
with the `block_id` `aside-` and the place of its text (`blocks.asideBlock`). A stream carries
it as the same block in a `blocks` chunk, so the line keeps its size when the update that follows
the stream's stop writes the message again.

Once the reply's body has ended, a run that lists commands keeps its card, titled with the
counts, so that it still opens on them as the terminal's `ctrl+o` opens a folded run; its
`details` are written whole, as a message written by edit is (`blocks.cardFields`). Any other run
reads as one line of counts in a `context` block (`Read 3 files`), as the terminal folds a run
that ended (`TaskUpdate.folded`, `ReplySink.cardBlocks`). A stream cannot replace what it showed,
so the line is written by the `chat.update` that follows the stream's stop (`ReplySink.end`),
which never notifies. The reply has ended with the stop: an update that fails is tried once more with the next
write, and the cards stay if that fails too.

The renderer keeps a call of a tool the agent previews (`ToolVocabulary.previews`) from the sink until its result
arrives, since a stream cannot take back the card a running call would get. While the call runs the
reply shows nothing for it; a call that waits for approval has the approval's message. One that
ended well is a `blocks` chunk with no card (`Previews.preview`): a collapsible, full-width
`container` block (`blocks.previewContainers`), closed until the owner opens it, whose title is the
call's line (`Update(notes.txt)`), in code style through `rich_text_title` with the plain `title` as
the fallback, and whose subtitle is the sentence (`Added 1 line, removed 1 line`). Inside a diff's
container is the whole numbered diff in a rich text preformatted element with the language `diff`,
which Slack desktop colours; each changed line also carries a red or green square after its sign,
since Slack mobile colours nothing. A new file's container holds its first 10 lines and
`… +N lines`. A body longer than `blocks.MESSAGE_LIMIT` continues in a second container with the
same title; both sit in one message when it is written by update, and in the next message when it is
streamed or posted. One that failed joins its run as a call that ended, with the reason in its
title; one that was stopped has a card of its own; one whose preview has no lines (an empty new
file) has a card that says the sentence. A card the sink already drew for the call stays
(`Tool.cardless`), and the diff under it is then titled with the sentence alone. An answered
`AskUserQuestion` is held until it ends (`ToolVocabulary.askers`) and shows its answers as a record
(`Preview.record`, always with `Preview.plain`): one `context` block of words whose first line is
the title behind `texts.RECORD_MARK` (`✓ `), with no card and no gap under the heading. The
request message rewritten by `requests.answeredBlocks` has the same first line. Its lines come from the questions and answers the daemon sent back, so they depend on no
undocumented field. The preview is built from the event's `FileChange`, which the back end reads
from the `tool_use_result` of the `user` record (`translate.fileChange`). The SDK types that field
as `unknown` and does not document it; any shape other than the one measured gives no `FileChange`
and the call shows its generic card, and the release probe's claim P13 checks the shape on each new
SDK.

### The stream and the 280 seconds

The stream stays open until the reply ends, or the reply rests, or until `sinks.STREAM_SECONDS`
(280 seconds) after it started, whichever comes first. Slack closes a stream 5 minutes after
`chat.startStream` (measured: "Stream lifetime"), and the daemon stops it a little earlier itself.

- **The reply ends first.** `ReplySink.closeOut` stops the stream with `chat.stopStream`, with no
  footer: the footer is the session's, and comes once the session has ended (see "The footer,
  once"). The stop is the one notification.
- **The reply rests first.** A turn that ends with a background task still running or still to be
  reported leaves its reply waiting. `ThreadSession.closeReply` then calls `Reply.rest`: the next
  pass stops the stream with no footer (the stop is the one notification, and creates no
  message, so it takes no lock of the thread's places), and the
  message goes on by `chat.update`, silently, as after the 280 seconds. A running card is rewritten
  in the same pass. The reply counts as at rest from then on (`finish` ran, `rest` was
  called and its last message is no stream; `rest` itself triggers the placement), so the list of
  what still runs can show under it. The session has not ended, so the reply shows no footer.
  The report grows the message by edit, `finish` runs again, and the reply rests again or ends as
  below: the ending is posted and cut out of the message it grew in. A stop that
  fails leaves the stream open, text given meanwhile goes on to it, and the next pass tries again, which a try after `FINAL_RETRY_SECONDS` starts when nothing else changes.
  A reply that only finished, with no `rest` and no landed end, is not at rest: its end follows
  at once and may fail.
- **A request is posted first.** `SlackThread.ask` calls `ThreadPlaces.beforeRequest` before it
  posts any request (an approval, a question, a `!!` command's confirmation, the setup form, the
  same-folder hold, a question about a terminal that holds the session). It awaits `ReplySink.beforeRequest` on every reply of the thread whose end
  has not landed, with the places' lock free. The setup form and the hold are posted before the
  session's first turn, so normally no reply is open and the call does nothing. A sink acts only
  when its last message is a stream that is open, or a first stream is owed; it then cancels the
  debounce, writes what the renderer has given it, stops the stream (`ReplySink.stopMidReply`,
  the same move as `expire`) and only then returns, so the stop lands before the request's
  `chat.postMessage`. A reply at rest, or already ending, is left alone, its own debounce and
  retry kept. Slack for iOS hides the text of a stream that is still open once a message lands
  below it (measured: "Stream text under a later message on iOS"), and shows it again when the
  stream stops. The reply then goes on as after the 280 seconds: by `chat.update`, and its end
  posts the ending as a new message. The stop is a notification of its own: a request under a
  streaming reply costs two pushes when the owner is away from the thread (the stop, the request)
  where it cost one, plus the ending; one when he is watching.
- **280 seconds pass first.** `ReplySink.expire` stops the stream (Slack pushes on the stop, the
  first notification) and the same message keeps growing with `chat.update`, which never notifies
  (measured: "Update after stop is silent"). Each update writes the whole message from the
  renderer's model as `markdown` blocks and `task_card` blocks (a run of calls keeps its card
  until the body ends), with a short `text`, since a `chat.update` whose `text` is long fails
  `msg_too_long`. The end posts the reply's ending as a new message, the second notification
  (`ReplySink.end`): the text Claude wrote after its last call, whole, with whatever follows it.
  Its `text`, the banner, is the first paragraph of that text as plain text
  (`markdown.bannerText`), so the notification says how the work ended, the stream's own stop having
  said how it began. The ending is a whole part of the renderer's model, never a cut inside one
  (`ReplySink.endingCursor`), so no list or heading is split. It is posted first, then a silent
  update takes it out of the message it grew in: a failed post leaves the reply as it was, a failed
  update leaves the text twice, and in both cases the end has not landed and the one retry follows.
  When the message holds no such text, or nothing of the answer would stay before it (an answer that
  is text alone), nothing is moved and the end posts nothing yet: its closing message
  (`ReplySink.writeClosing`) is posted with the session's footer, all it holds, once the session
  has ended, and that post is the notification. Its banner is the start of Claude's answer, never a
  line of the daemon's. The end counts as landed once the body is written. When anything was
  written in the thread since the end (a message of the owner's, a line of the daemon's such as
  `Stopped.`, another reply), nothing is posted and the footer goes under the body by an edit:
  the places learn the position of the notices, requests and lines the thread object posts
  (`ThreadPlaces.posted`, `ThreadPlaces.newestAt`). A file `!open` uploads into the thread is not
  among them: `files.uploadV2` names no message, and the owner's `!open` before it already
  counts. A reply whose closing message was put off and
  that does not hold the session's latest work never posts it, and its end does not notify: the
  end of the session notifies on the reply that does. When the footer cannot be built, the
  closing message is not posted either.
  A turn cut short (the Claude Code process was lost, another error ended it, or the
  daemon restarted or closed the session) gets the footer like any end of the session, drawn after
  its replies have ended with what can be read of the session, and the agent is not asked for the
  context usage then (`ThreadSession.showFooterIfEnded`). `ThreadSession.abandon` writes a line on how the
  reply ended (`Claude Code reported an error: …`, `This reply ended before an answer: …`). When
  Claude wrote text after its last call, that line follows the text into the new message, whose
  banner is still the start of the text. When there is no such text to move, the line itself is the
  ending that moves, with whatever follows it, and is the banner. A process lost while no turn is
  active is told by what the session still owed: a reply that waited for a background task of its
  own gets the same line, which counts as text since it rested, so its ending is posted as above,
  and the root shows ❌; a session with nothing running
  and nothing waiting gets no line and keeps the reaction it had, since its last reply ended well
  and the next message connects a new process. The sink keeps it as a part of its own
  (`ReplySink.text` with `ending`, fed by `TurnRenderer.feedEnding`), so a notice written just
  before it stays in the reply, and a card that closes after it moves under it. No other line of the
  daemon's moves. When a full message pushed the line, or the note under it, into a
  continuation, that message rang when it was posted and is the ending as it stands
  (`ReplySink.opensOnEnding`): no closing message follows. A line that does not fit the room left in
  a message is cut there, as any text is, and the continuation then rings with the rest of it.
- **Something sits below.** A reply ends where it is when another reply's message sits below its
  last message (`Reply.overtaken`), or when it rested, a message of the owner's sits below it and
  no text of Claude's was written to it since it rested (`ReplySink.leftBehind`): it ends in that
  message by a silent edit (`ReplySink.end`), or on the stream's stop while it is still a stream,
  and nothing is posted, since a new message would land under the other reply, or repeat the old
  text as the newest in the thread. A task's end line or a card update is not such
  text; a report's text is. A reply with another reply below it opens no continuation either:
  what does not fit the message is cut, as a card's text is, and a warning is logged once. A reply
  that is still writing its turn when the owner writes posts its ending, unless it then rests and
  gets no text before it ends; one that rested and then got a report posts its ending as above.
  `SlackChat` keeps one `ThreadPlaces` (`reply/places.ts`) per channel and thread, shared by every
  `SlackThread` of it and in memory only. A `SlackThread` takes it at its first reply and gives it
  back at its close; it lives while one is open, and after the last give-back while a reply is
  registered with it, so a reply let go of by an owner message is still found by the next one. A
  `ReplySink` registers with it when it is built and
  tells it where its last message moved; the listener tells it the `ts` of every message the owner
  wrote in the thread (`SlackChat.ownerPosted`), also one the prompt filter drops. A reply is let
  go of once its end has landed and an owner message sits below it, or the `SlackThread` that
  opened it closed, its end landed or not; the highest position of a reply let go of stays in the
  places, so the answers do not change when it goes. A `SlackThread` lets go only of the replies
  it opened. The places
  hold a lock for the creation of a message of any reply of the thread (a stream's start, a
  continuation, an ending, a closing message) and for the end's decision to create one, so that
  two replies cannot each decide on the other's absence. A restart forgets the places: the
  messages written before it are unknown and a footer they show stays where it is. A continuation
  planned before the reply was overtaken and not yet posted is dropped.
- **The footer, once.** The session decides it and names the reply it goes under: the one its
  latest work wrote into (`ThreadSession.showFooterIfEnded`, once the session has ended
  everything, and at a forced end). `ReplySink.showFooter` writes it at once and answers whether
  it landed; a reply keeps the first footer drawn on it. It goes under the reply's last message by a silent edit, or, when the end put its
  closing message off, it is all that message holds, in the post that notifies (see "280 seconds
  pass first"). Its line is a context block with `verbatim` on (`blocks.footerBlock`): by
  default Slack turns the account's email into a `mailto:` link when the message is posted
  (measured on desktop, 2026-10-27), and `verbatim` keeps the text as written while its bold
  marks and its `<!date>` still draw. A reply whose end did not land takes none. A footer stays on its reply: a later
  end of the session draws its own under a newer reply. A closing message that held only the list
  is deleted with `chat.delete` when the list leaves it; the reply stays ended and no second
  closing message is posted. A footer drawn on such a reply later goes under its last body
  message. A delete that Slack refuses is logged, leaves the card where it is and is tried once
  more after `sinks.FINAL_RETRY_SECONDS`; `message_not_found` counts as deleted. A write after the
  end that fails is tried once more the same way.

### Message limits and continuation

Slack holds a message to 12,000 characters and 50 blocks or task cards (measured: "Message limits");
the daemon stops at `blocks.MESSAGE_LIMIT` (11,000) and `blocks.BLOCKS_LIMIT` (45), which leave room
for a preview that arrives after its card and for the footer. Slack translates Claude's text into a
`header` per heading, a `table` per table, a `divider` per rule and `rich_text` for each run between
them, and holds a post and an update to 50 of those; a stream is not held to it, the update after
its stop is (measured: "Block cap after a stream stops"). `markdown.markdownStarts` counts a text
that way for a stream's plan, a post and an update alike, and `markdown.markdownCut` cuts it at a
block's start, before a heading that would end the message. While the reply is being written, a
write of its last message that Slack still refuses with `no more than 50 items allowed` halves the
message's room and is tried again (`ReplySink.tighten`), so the rest goes on in a new message; the
writes of the reply's end are not split. A reply past `blocks.MESSAGE_LIMIT` or
`blocks.BLOCKS_LIMIT` continues in a new message, a new stream while the first one still streams,
else a post. Every message a reply adds notifies once. A stream and a post count the text of a
collapsed container toward those 12,000 characters; `chat.update` does not (measured: "Container
text on update"). A message written by update therefore counts a container as one block and no
characters (`ReplySink.weight`), so a stopped message holds several large diffs where a stream would
have continued. A continuation is posted with the characters a post takes, then brought to what an
update takes by a `chat.update` of the same message (`ReplySink.postStep`). An update refused for
content that held a container is tried once more with the containers counted, as a post counts them
(`containersCounted`, kept for the message): what fits is written, and the rest goes on in a new
message, or is cut with the preview note when the span is fixed.

### When a reply ends

A reply whose turn has ended while a task of it still runs, or still waits on a turn Claude Code
starts to report it, rests; it ends once none does. A task the turn started that has a card keeps it open
and updating in place, `ReplySink.finish` ends only the body, and `ThreadSession.stillOwed` decides
whether `Reply.rest` (still owed) or `ReplySink.closeOut` runs (the CLI can suppress the report's notification, so past
`constants.INJECTED_TURN_WAIT` `ThreadSession.expireUnreported` gives up on it). A report turn renders
into one reply only when several tasks end together; `ThreadSession.sweepClosedOut`, run after
every turn and after `ThreadSession.expireInjectedTurn`, ends every other reply left eligible. A
turn Claude Code starts on its own to report a background task renders into the reply of the
first of the ended tasks (then of the task the agent named) whose reply is still tracked, not
ended and the last thing in the thread (`ThreadSession.openingTarget`, `Reply.last`). When none
is, and also when the turn names no task (a Monitor's event), the report goes into the thread's
last reply if that one is at rest: its turn ended, it still owes a task or a report (tracked,
not ended) and nothing sits below it (`ThreadSession.restingLast`). The report keeps its end
lines, so it reads in order, and that reply rests again or ends as usual. Only with no such
reply (the last thing in the thread is a message of the owner's, or the last reply has ended)
does the report get a reply of its own at the bottom (`ThreadSession.newReply`). While a task
of a reply that is no longer last still runs or waits for its report, the last reply rests
instead of ending (`ThreadSession.stillOwed`), so that report has it to render into; the wait
ends as any other, by the report or by `ThreadSession.expireUnreported`, and a message of the
owner's below the last reply releases it. The footer of
the session's end goes under the reply that holds the latest work (see "The footer, once"). A reply that ends with a message of the owner's or another reply below it (`Reply.last`)
because no report came is logged at INFO.

A background subagent can hand its report back before, or without, a turn of that kind (measured
2026-10-10 on Claude Code 2.1.294 and 2.1.296 with the owner's setting sources loaded, recorded in
`test/fixtures/sdk/subagent-handback.jsonl`). Its last call is a tool named `SubagentHandback`;
the report reaches the main agent as a `user` record whose `origin` is a peer that names the task
(`SDKMessageOrigin`, `senderTaskId`), and the agent answers it in a turn of its own; the task's
notification then gets a turn that does nothing, an `init` and a `result` with `num_turns` 0 and
no text. The back end says the first as the event `report_started` with the task's id, and the
second as a `turn_ended` whose `steps` is 0. On `report_started` the session takes the turn that
follows as the report of that task whatever prompt waits (`ThreadSession.whoseTurn`) and renders
it in the reply that shows the task, also when the task ended inside the turn that started it and
is tracked nowhere (`ThreadSession.showing`); with no end line to open it, the report follows the
reply's text with no line of the daemon's between. A turn that did nothing and has nothing to say
(no end line, no held task event) opens no reply, and ends the wait for a report as a report turn
would (`ThreadSession.saidNothing`, `ThreadSession.nothingReported`). With an end line waiting, it
is the turn that writes that line, as before.

What happens to a prompt the owner sends while a turn runs, and how a turn takes one in, is under
[Sessions](architecture.md#sessions) ([A prompt taken into a running turn](architecture.md#a-prompt-taken-into-a-running-turn)).

### A reply cut short

`!stop`, a restart, an error that cuts a turn, an idle close and `SessionGone` end the reply through
the same path, at once: the stream stops and, for `!stop`, the stopped command's card, and that
stop is the notification (`ThreadSession.stopTaskReplies` for the tasks' replies). The footer
follows by an edit, on the reply the stop or the error ended, once everything has ended. A
stream whose last append has an unknown outcome (a reset, a timeout) is told nothing more: it is
stopped and the message goes on by `chat.update` from the model. An append Slack refuses as too long
(`msg_too_long`) would be refused again, so `ReplySink.streamStep` stops the stream at once and
writes the message by `chat.update`; the end then posts the reply's ending, as for a
reply past `sinks.STREAM_SECONDS`. The text of a message's cards counts toward the cap of a streamed
message, by a formula Slack does not document (measured: "Card text cap"). Slack adds the `details`
and the `output` of every `task_update` to what the card holds, so a stream is sent only the lines a
card lacks (`blocks.cardAddition`), and `ReplySink.planCard` counts each card toward
`blocks.MESSAGE_LIMIT`: its title, the text it was sent, and a fixed cost per card, per text and per
line, set from that measurement. A new card that does not fit opens the next message; a card already
in a full message gains no more lines of `details`, and still gets its `output`. The count is an
estimate of what Slack stores, so a refusal remains possible; it is logged with the sizes the plan
knew and no content. When Slack refuses an update of any message for its content, the change is
dropped and the message shows less than the model: unless a later update of it passes, the reply's
end counts as not landed and the root shows ❌. The update that only folds the cards of a stream sent
all of its span is the exception, since nothing of the reply is missing. The thread shows the
footer of each end of the session once, under the reply that held the session's latest work then
(see "The footer, once"); the list of what still runs sits on the lowest reply of the whole
thread once it rests (see "The list of what still runs"). A card left `in_progress` in a stopped message
is stored as an error until it is updated (measured: "Open card stored as error"), so every end
closes its cards first.

### The list of what still runs

While a subagent or a background command runs, one `task_card` lists it, above the footer's
divider, in the thread's last reply once it rests.

- It sits on the lowest reply of the whole thread, when its turn has ended and its last message is
  no stream. A newer reply takes it off the older one as soon as it has a message and shows it
  once it rests, so the card never sits between two replies (seen on Slack desktop, 2026-10-15;
  `ThreadPlaces.place`, `ThreadPlaces.opens`, `ReplySink.unlist`).
- The card has the `block_id` and `task_id` `running-list` for its whole life, the title the core
  made (`2 agents · 1 shell still running`) and up to `blocks.RUNNING_LIST_LINES` lines, one per
  task, then `+N more`. A subagent that has made a call ends its line with its duration and its
  call count and has a second line with the call it is at (`blocks.runningListBlock`).
- Every write of it is an edit and notifies nobody. A stream's stop carries no card, so the edit
  that follows it adds the card; a write that failed is tried again after
  `sinks.FINAL_RETRY_SECONDS` (`ReplySink.assign`).
- A message that shows the list stays among the open replies (`ReplySink.keepsOpen`), and
  `repair.endReply` takes the block off after a crash; on a message that only the list kept open
  it writes no note.
- A card of a subagent's words (`TaskUpdate.message`) shows its output, its body, also once
  complete (`blocks.cardFields`); a call's card keeps its result to itself.
- Slack keeps a `task_card` with a fixed `block_id` open across `chat.update` (measured
  2026-10-12, Slack desktop; the client version was not recorded), and a `task_card` inside a
  `container` is refused. A preview's `container` keeps one as well, `preview-<call id>-<piece>-<n>`
  (`blocks.previewContainers`), from its stream through every edit: one with no `block_id` gets a
  new one from Slack at each edit and closes on desktop and iOS, one with a fixed id stays open
  (measured 2026-10-26). Every card of a call or a run keeps one
  too, `task-<task_id>` (`blocks.cardBlockId`), which is the id Slack stores a streamed card under: a
  card the owner opened stays open from its stream through every edit of its message, where an
  edit with no `block_id` closed it on desktop (measured 2026-10-25; on iOS a card opens in a
  sheet, which an edit left open either way). What else was measured, and what was not, is in
  the doc comment of `blocks.runningListBlock`.

### The loop card

A scheduled run is drawn on one message per thread, which `SlackThread.showLoop` posts the first
time and rewrites with `chat.update` on every later run, so a run notifies nobody. The message is
a context block with the label the core made and the time of the run (`Scheduled run · every
minute · run 14 · 22:18`, the time drawn as the reply footer draws `done 22:18`, by Slack's own
date formatting, `slackTime` in `src/chat/slack/footer.ts`), then a markdown block with the run's
final words, mentions quieted as in a reply, then a divider and the reply footer (`formatFooter`)
with the data of the run, in a context block. Past 3,000 characters the card keeps the end of the
words, after a leading `…`: the end of a run is what it concluded. The footer is rewritten with
the card on every run, so it is an edit and no push. A run with no words keeps the label alone,
since a markdown block's text may not be empty; a footer that says nothing is left out. The
writes of one thread's card run one after the other, and the rewrite takes the shared limiter. A
write that fails (the card was deleted by hand) forgets the card, and the next run posts a new
one. The card takes the thread's places as a reply does (`ThreadPlaces`), so the owner's messages
below it are seen: `SlackThread.loopCardLast` is true while no message the places know of is newer
than the card.

`SlackThread.endLoop` posts the loop's last line (`Scheduled loop ended · 14 runs`, or the paused
or stopped line the core chose) as a new context message, after the card's last write, so it is
the newest message of the thread and its one push. It also forgets the card: a later run posts a
new one. The card's id is kept in memory only, so after a restart the next run posts a new card
too. How the card looks on desktop and iOS has not been checked.

### Pushes and threads

Slack's push behaviour is what makes this shape: a stream in a thread the owner started notifies
once, when it stops, with its first text as the banner, and never when it starts (measured: "Push on
stream stop"; Slack's reference says nothing on it). Every write while Claude works is silent. An
open stream cannot be deleted (measured: "Open stream cannot be deleted"), which is why a reply
never starts as a placeholder that a later write replaces.

`chat.startStream` works only inside a thread and answers `invalid_thread_ts` without `thread_ts`
(measured: "Stream needs a thread"), which the thread model satisfies. A write Slack refuses, or
cannot receive because the network is down, is sent again with the whole reply at the next write; it
never stops the Claude Code session. Every message the daemon posts turns link and media previews
off (`unfurl_links`, `unfurl_media`), so a link in Claude's text is never fetched by Slack on its
own. The end has no next write to fix it: when Slack refuses the content of a message of the end
that is not posted yet, a continuation or the reply's ending (`invalid_blocks`, `msg_too_long` and
the like, `errors.REFUSED_CONTENT`, not a rate limit), that message is posted once more as plain
text (`ReplySink.writePlain`), and the reply goes on to the next messages. A message that already
shows something is never replaced by a plainer one. An end that fails for any other reason (the
network, or a rate limit the client has already retried, or stopped retrying at the daemon's
stop) is tried once more after
`sinks.FINAL_RETRY_SECONDS`; until it lands, `ThreadSession` shows no ✅
(`ThreadSession.trackLanding`), shows ❌ if the retry fails too, and keeps the persisted status so
the next start's repair still finds the reply.


A reply in a thread leaves its channel as read in the sidebar: Slack marks a channel unread only
for a top-level message of someone else's, and a reply, a mention or a reaction in a thread, an
edit and the owner's own messages all leave it as read (measured on a dev app on 2026-10-22).
Once a session's work ends, `channel-line.ChannelLine` posts one line at the top level, `✅ Done:`
or `❌ Failed:` and a link to the thread named by its root's first line (`channel-line.lineLabel`): the
session's title once the root shows one, else the owner's first words. The work ends when the
core asks `SlackThread.showStatus` for done or error with `notify` (`seam.StatusOptions`): a change
from working or waiting, never one the owner's own act made (`!stop`, a hold he cancelled), and
once per end however many ways the session reaches it (`status.endsWork`). A close that cuts work
short (a restart, a stop of the daemon) is such an end. The crash repair at a start asks the same
for a root a crash left working or waiting, unless its ❌ was asked for before the crash. The link is the permalink
of the thread's last reply, which Slack opens the thread on, or of its root while it has none (or once
Slack no longer has that reply): the rule of the session index's Open, through the same
`home.threadFacts`. When the agent asks
the owner for an approval or an answer, the thread gets the same line with `✋ Waiting:`, posted
from `SlackThread.ask` once each request is in the thread, its link the permalink of that request.
A request is deleted once it is answered or stale, and Slack answers the link of a deleted
message with a dialog, "We're unable to open this link". When `SlackThread.withdraw` deletes the
request a line links, `ChannelLine.withdrawn` edits that line to link the thread's root, its word
unchanged.

The line starts with `Status:`. While a thread of the channel waits for the owner's answer to
the agent (its root waits with an approval or a question open, `channel-line.lineThread` through
`asksOwner`; a root waiting on the setup form, a `!!` command's confirmation, the same-folder
hold or a question about a terminal is taken for working), the line names the one that has waited longest and counts the others
(`Status: ✋ Waiting: A · +2`), whatever the event that posted it: the push's `text` names the
event itself (`Status: Done: B · +1`), and a thread that waits is never hidden by another's end.
Only a wait names a thread among several, since only a wait asks something of the owner: with
none waiting and threads at work, the line counts them and names none
(`Status: ⏳ Working: 2 threads`); with none at work either, it names the thread whose work ended last, linked. A root Slack no longer has
(`thread_not_found`, or the tombstone left over the replies of a deleted root) is left out; one
Slack did not answer for this time is still counted. Between the posts that tell the owner the
line follows `state.json`, the source of the session index: each change
`StateStore.onSessionsChange` announces (a status, an end, an open request, a removed thread)
reaches `SlackChat.index`, which hands it to the Home tab and to `ChannelLine.refresh`, and each
changed thread's root is read again. The line is then edited, never posted, to the waiting thread
or to its own thread's word (`channel-line.rootKind`: `⏳ Working:` once the owner answered and
the work goes on, `✅ Done:` after his own `!stop`), linked by the root but while it waits on the
request it opens; a change that leaves it as it was writes nothing. When its own thread leaves
`state.json` (deleted, or pruned) and nothing waits, the line is deleted. Each line carries the
thread it names, its word and its mention in its metadata's payload (ids, no content), so after a
start the first refresh takes over the line an earlier run left and brings it to the threads'
status; a line with no such payload stays as it is until the next post. The mention stays, and an
edit pushes nothing. The setup form, a `!!` command's confirmation, the same-folder hold and a question about a
terminal post no line: they answer what the owner has just written in the thread.

The line mentions nobody. With `SLACK_MENTION_OWNER=on` (`SlackChatOptions.mentionOwner`) the
thread tells the owner, since a push from the thread opens the thread and one from the channel
opens the channel. `SlackThread.ask` puts his mention in the `text` alone of each request that
waits on him, an approval or a question, whose heading is then a rich text block; at the end of
the work `SlackThread.showStatus` (done or error, with `notify`) has `ThreadPlaces.tell` ask the
newest reply (`ReplySink.tell`) to write its last message again, the same blocks, with the mention
added to its `text`, once; with no reply to carry it, a line of its own (the root's mark and word,
rich text) is posted in the thread. Measured on 2026-10-26 on iOS, phone locked, Slack desktop
closed, channel on **Just mentions**, the owner's **Thread replies** notifications off, one run
each: an invisible `text` mention pushed beside a rich text block, a streamed message, and a
request whose heading was rich text, never beside a section heading or a context block alone; an
edit that adds the mention pushed, at once after a stream's stop and 2 minutes after it; a tap
opened the thread; a `text` with no blocks would remove the message's blocks (chat.update
reference, read 2026-10-26). Slack holds a phone's pushes while the owner is active on desktop.
The line's `text` escapes the root's words (`escape.mrkdwnEscape`),
since a mention sequence there notifies. An answer leaves the line as it is. Whichever its
word and its thread, each new line replaces the last: `ChannelLine` deletes the line it posted
before, so the channel holds one such line at most, shows bold and opens at the bottom. The line
is found again by its message metadata (`channel-line.LINE_EVENT`): the one this run posted is
remembered per channel, and after a start the channel's latest `channel-line.HISTORY_LIMIT`
messages are read for any an earlier run left. The changes of one
channel run one at a time, an old line a delete failed for is deleted at the next change, and a
failure is logged and changes nothing else. The root may get its title after the line read it
(the line and the title are both asked at a turn's end, and the agent may write the title a
moment later), and `!rename` changes it: the text each title edit leaves on a root
(`tag.RootEditor.title`) reaches `channel-line.ChannelLine.retitle`, which names the thread from
it through `channel-line.lineLabel` and edits the line this run posted when it names that thread.
A line an earlier run posted keeps its words until the next one replaces it. An edit leaves the
channel as read and rings nothing.
## Opening a file

`!open` shares a file of a session's folder into its thread, where Slack shows it in its own file
viewer. The word reaches the provider as `ChatProvider.openFile`, which `words.wordFlow` calls with
the session's folder and the words typed after `!open`; a chat that declares no `fileUpload`
answers `texts.OPEN_UNAVAILABLE` instead. The core decides what is offered and which paths are safe
to read (`src/core/files/`, described in [Files offered by `!open`](architecture.md#files-offered-by-open));
the provider draws the picker and the modal and uploads the file. The mechanism of each step is in
the doc comments of the symbols named here.

- **The picker.** `!open` alone posts a message with one button (`modal.pickerBlocks`);
  `!open <words>` with several matches posts the count and the same button, carrying the words.
  `Open.onOpenChoose` checks the owner, the workspace and the channel (`Answers.admitted`), takes
  the folder from the thread's own entry in `state.json` (`Open.threadFolder`), never the
  channel's, and opens the modal with `views.open`. The click's `trigger_id` lives 3 seconds, so
  the rows are waited for `modal.OPEN_WAIT` (1 second) after the click; when they are not ready the
  modal opens with a line that says the files are being listed, and an update fills it.
- **The modal.** `modal.modalView` builds a search field that sends an event for each character
  and, when there are rows, a radio group of at most `modal.ROW_LIMIT` (10) options: the file name
  (shortened in its middle past 75 characters), its folder as the description, its path as the
  value; a path over 150 characters gets no row. The thread travels in `private_metadata`
  (`modal.Target`) and comes back untrusted: each handler resolves it to the folder of that
  thread's own session.
- **Typing.** `Open.onOpenQuery` checks the owner and the workspace alone, with no call to Slack
  for the channel, and calls `Open.updateModal`. The updates of one modal are written in the order
  of the events (`modal.ModalUpdates`), and one made stale while it waited is never sent. A
  rejection by Slack is logged by its error code and dropped.
- **Open.** `Open.onOpenSubmit` answers Slack first, without a call to it: with no row chosen an
  error on the radio block (on the search field when there are no rows), else a plain
  acknowledgement that closes the modal. A row counts only when it is among the options of the
  submitted view's own radio block (`modal.chosenIn`).
- **Reading and uploading.** The row's value is untrusted input: `read.readOpenable` of the core
  resolves it, holds it to the folder, opens it once and reads at most `read.SNIPPET_LIMIT`
  (1 MB, Slack's limit for a snippet); an empty file is refused (`texts.OPEN_EMPTY`), and any other
  failure is a `read.NotAFile` the owner reads as `texts.OPEN_NOT_A_FILE`. `read.uploadFile` sends
  the bytes with `files.uploadV2` (`files:write`): the basename as the name, the path from the
  folder as the title, and nothing posted on success.

## Lists in a thread

`!diff` and `!rewind` post a list in the session's thread, and `!diff` shares a file when one of
its controls is used. The core decides what is listed and what a control does
([Changed files of `!diff`](architecture.md#changed-files-of-diff),
[Going back with `!rewind`](architecture.md#going-back-with-rewind));
the provider declares `threadLists` and draws.

- **Drawing.** `SlackThread.offer` posts `lists.diffBlocks` with `chat.postMessage`, or, given the
  message of an earlier list, draws it again with `chat.update` under the app's budget. The blocks
  are one context line (the title), a `static_select` of the views when there is more than one,
  one section per file with a **Diff** button, and a context line counting the rest past
  `lists.DIFF_ROWS` (45 files, so that the message stays within Block Kit's 50 blocks). A binary
  file has no button. A button's value is `[session, view, path]` as JSON and a view option's
  `[session, view]`; one over the element's limit (2,000 and 150 characters) is left out: a row
  with no button, a list with no selector.
- **Hearing.** `ThreadLists.onDiffFile` and `onDiffView` acknowledge, check the owner and the
  workspace and the thread (`Answers.admitted`), read the value, which is untrusted, and call
  `ChatInbound.picked` with a `diff-file` or `diff-view` pick. A value of another shape reaches
  nothing. The core checks the session of the pick against the thread's own.
- **The rewind lists.** `lists.listBlocks` draws the prompts of `!rewind` as one context line and
  a `static_select` of the newest `lists.REWIND_POINTS` (100, the select's limit), each option
  its first words (75 characters) and the value `[session, prompt]`; a prompt whose value is over
  150 characters is left out. The actions at a prompt are buttons whose value is `[session,
  prompt, action]`, the code one with its counts (`2 files, +3 −1`). `ThreadLists.onRewindPoint`
  and `onRewindAction` acknowledge, check the owner, the workspace and the thread, read the value,
  and refuse an action that is none of the four words, before `ChatInbound.picked` is called.
- **Folding.** `SlackThread.fold` (`fold.foldMessage`, with `messageFold`) reads the message back
  with `conversations.replies` (`oldest` and `latest` its own ts, `inclusive`, `limit` 1), turns
  its blocks into text (`markdown`, `section`, `header`, `context`, `rich_text` and `task_card`
  title, details and output) and rewrites it with `chat.update` as one `task_card` with status
  `complete`, the title the core gave and the text as its `details`, under the fixed block id
  `task-folded-<ts>` that keeps an opened card open across an edit. Text past `CARD_TEXT_LIMIT`
  (2,900 characters) is cut with a marker. A message that cannot be read or rewritten answers
  false, and the core says how many were not marked. `Reply.posted` (`ReplySink.posted`) gives
  the messages of a reply, its closing message included. Not measured: whether `chat.update`
  replaces a message that was a native stream, and Slack's real limit for a card's `details`.
- **Sharing.** `SlackThread.share` uploads the bytes with `files.uploadV2` through
  `read.shareFile`, the name and title the core gave; `uploadFile` of `!open` is the same call with
  the basename and path of a file of the folder. Slack's error code becomes the `ChatError` the
  core puts in its line (`missing_scope`, for one). The size is held before that: `SlackChat.fileLimit` is `read.SNIPPET_LIMIT`, and the core collects no more than that from git
  and shares nothing larger (`texts.DIFF_FILE_TOO_LARGE`).

## The session index

`Home` (in `home`) publishes the owner's Home tab with `views.publish`, which takes no scope and
needs no event from the owner. It always publishes to the configured owner's user id. The page is
the Slack provider's: `ChatProvider.index` is present, `main` asks
it to refresh when `state.json`'s sessions change, and `Home` reads the core through the port
(`CorePort.state`, `CorePort.agent`) alone. It does not check the agent's `sessionListing` capability: it calls `AgentBackend.listSessions` through the port (`HomeAgent`) for the titles of the threads it lists. At start the daemon asks it for the first page (`Home.request`) and `ChannelLine.refresh` takes over each channel's line an earlier run left. Its Refresh control asks the core's cleanup of `state.json` (`CorePort.cleanup`).

`Home.publish` reads the bound channels (`StateStore.channels`) and asks Slack for each one's name
once per run (`conversations.info`); a channel Slack no longer has is left out with its threads. It
then builds one row per thread of those channels that holds a session id (`StateStore.threads`). The
title comes from Claude Code: the listing `Home` is given (its `sessionsOf` option, the back end's
`AgentBackend.listSessions`) lists each folder once, and a session it does not list yet shows
`Session` and the start of its id. The rest comes from Slack: `conversations.replies` with the
root's `ts` and `limit=1` returns the root alone, and `home.threadFacts` reads its `reply_count`,
its `latest_reply` and, among its `reactions`, the status one, and `tag.rootMarks` its tag and
whether it is pinned (`pinned_to`). A row is dated by the last reply, or
by the root while it has none, and the rows are ordered by that date. The status is a reaction
name: the one `reply.status.REACTIONS` draws for the word in `ThreadState.ended` when it is set,
for the word in `ThreadState.status` otherwise, and the reaction read from the root for a thread
that has neither (one that ended before the daemon kept it). A root that shows 🔄 while a stop
waits for its thread is listed as working, since that word is the one stored. `ended`
and `status` are both set only for an answer that never reached Slack, where the root shows ❌ and
`status` stays for crash repair. A root is read again only for a thread a state write touched since
the last read, which every turn does at its start and at its end (`StateStore.onSessionsChange`
names the threads it changed). Each row also needs a permalink (`chat.getPermalink`) for its
**Open** link: the one of the thread's last reply, whose `ts` is the root's `latest_reply`, or the
root's own while the thread has no reply. Slack opens a thread on the reply its permalink names
(measured: "Permalink opens on the reply"; the method's reference gives the link's form and says
nothing of the scroll). The last reply is the last message of the thread, the owner's included. The
link is kept per thread with that `ts` and asked again only when the `ts` changed, so a reply costs
one call. It carries a query (`?thread_ts=…&cid=…`), written into the page with `&` escaped as
mrkdwn takes it. `home.THREADS_AT_ONCE` threads are asked about at a time.

A root returned as a tombstone (`channels.isTombstone`) is gone too: the page leaves the thread out, as it does for an answer in `errors.GONE`. Only three answers are final, the ones in `errors.GONE`: `channel_not_found`, `message_not_found` and
`thread_not_found`. The channel or the thread is then left out, a thread until a state write touches
it again and a channel for the rest of the run. Any other failure (a rate limit, a server error, the
network, a root in a shape that cannot be read) is no answer: nothing is kept from it, what was read
before stands, and the page is tried again after `home.RETRY_SECONDS`. When Slack answered about no
channel at all, nothing is published, so the page that is there stays.

`home.homeView` lays the rows out. Under the controls, each channel is a group: a header with the
channel and a **New thread** link button (the `slack://channel` deep link), then two blocks per
session: a section with the title, and a context line with the status word, the number of replies,
the time of the last reply as Slack's own `{ago}` date token, which the client renders, so the age
stays right between two publishes, and an **Open** link to the thread. A context line holding
`home.SPACER` leaves a blank row between two sessions of a channel. With no filter chosen every
bound channel is a group, the ones with sessions first by their newest, each cut to
`home.PER_CHANNEL` cards with a **Show all** button; with a channel, a status, a tag or a search
chosen (`home.narrowed`), only the channels with a match, uncut. The period applies either way and
leaves that shape alone: a channel whose sessions are all older keeps its header and says
`texts.HOME_NO_MATCH`. A pinned session is shown first in its channel, newest first among the
pinned, whatever the period, and the cut to `home.PER_CHANNEL` counts the others alone; **Show all**
counts every session that matches. The channel, the status, the tag and the search still apply to
a pinned session. The details line of a card starts with `:pushpin:` for a pinned session and the
tag as an inline-code `[name]` for a tagged one (a name that satisfies `commands.TAG_NAME` holds no
character mrkdwn reads as markup), then the status word and the rest. A Home view holds 100 blocks and a session takes up to `home.CARD_BLOCKS` of
them: the page stops before the cap, and ends with `texts.HOME_MORE` when that leaves a session out.
The channel menu holds `All channels` and at most `home.CHANNEL_OPTIONS` (99) channels, so that it stays
within Slack's 100 options for a select menu. The tag menu (`home.TAG_ACTION`) is built the same way
from the tags the rows carry, sorted, with `texts.HOME_ALL_TAGS` first; it is on the page only once
a row has a tag or a tag is chosen, and a tag chosen that no row carries stays on it.

Under the header the page carries the update line when the core has one (`CorePort.updates`,
`UpdatesPage.line`, asked at each publish; none for a copy that does not update). It is a section.
While a newer version is on offer it holds `texts.UPDATE_HOME_AVAILABLE`, a link to what the
version changed and an **Update to** button (`home.HOME_UPDATE_ACTION`) with a `confirm` object:
this page shows no message that says what changes first, so Slack's own dialog does (title
`texts.UPDATE_CONFIRM_TITLE`, text `texts.UPDATE_CONFIRM_TEXT`, buttons `texts.UPDATE_CONFIRM_YES`
and `texts.UPDATE_CONFIRM_NO`). The dialog's limits are 100 characters for the title, 300 for the
text and 30 for each button (confirmation dialog object reference, docs.slack.dev, read
2026-10-17); the strings are cut to them. While the update installs or waits to restart the line
says so (`texts.UPDATE_INSTALLING`, `texts.UPDATE_INSTALLED`) and has no button; after a failure it
holds the failure's sentence and the button again. The core calls `Updates.onChange` after a
check and at each phase, which the daemon turns into `Home.request`, so the line follows an
update without an event from the owner. It counts in the 100 blocks like any other.

The filters are a `home.HomeFilter` kept in memory: channel, status, period, tag and a search on the
title. The period starts on the last 48 hours; the others start unset. The two blocks that hold the
controls take an id that follows the chosen filter: Slack keeps what a control shows for as long as
its block keeps its id, so a page built with another choice (after a restart, after **Show all**)
must change it for the controls to show that choice. Every use of a control reaches a listener of
`HomeControls` as a `block_actions` payload, checked on its own for the owner and the workspace (a
Home tab payload names no channel). A filter's payload carries the state of every control in
`view.state.values`, which `home.readFilter` reads by action id and turns into the filter; a status,
a date or a tag the page never offered keeps the current one (a tag is offered when it satisfies
`commands.TAG_NAME`). **Show all** carries its channel, and
`Home.publish` drops a chosen channel that is not bound or that Slack no longer has, and a chosen
tag that no root carries any more (unless a root Slack gave no answer about may still carry it). `Home.choose`
then publishes at once. The **New thread** link button is followed by Slack itself and still sends
its click, which is acknowledged and not read; a session's **Open** is a link in text and sends
nothing.

When the core has a cleanup (`CorePort.cleanup`, `CleanupPage.request`; read at each publish through
the `cleanup` option) the same row carries a **Refresh** button (`home.REFRESH_ACTION`), and the header
line is a section whatever the token; with neither button the header stays a context line. The
click reaches `HomeControls.onHomeRefresh`, which acknowledges it, checks the owner and the
workspace like every Home control and calls `Home.refresh`. `Home.refresh` asks the core's cleanup
for a pass and waits for it (a pass that fails is logged and the page is written anyway), then
publishes with every name and root it holds marked to be read again (`conversations.info`,
`conversations.replies`); a read that gets no answer leaves what was read before on the page, and
`channel_not_found` takes the channel off it. A permalink is asked again only when its message's
`ts` changed. There is no capability
for it in `ChatCapabilities`: the core offers the cleanup, and a provider with no Refresh simply
does not draw it. The row counts in the 100 blocks.

`StateStore.onSessionsChange` calls `Home.request` after a write that changed what the page shows,
with the threads the write touched: a channel bound for the first time, a thread added or removed, a
session id, a root's reaction. A write that changes anything else (a reply's bookkeeping, a request,
bypass, effort, a rebind) does not. `Home.request` returns at once and publishes after
`home.DEBOUNCE_SECONDS`, so the burst of reaction changes one turn makes costs one publish; a change
that lands during a publish is followed by another. Publishes run one at a time, each built after
the one before it landed, so a filter just chosen is never replaced by an older page. On a stop,
`Home.close` runs after every session has closed and publishes what was still owed, giving up after
`home.CLOSE_SECONDS`.

### Edit mode and Delete

With the owner's user token configured (`SLACK_USER_TOKEN`, in `Config.chatVariables`),
`module.ownerClient` checks once with `auth.test` that the token is the owner's own in the bot's
workspace, and `module.deleter` builds a `ThreadDeleter` (in `delete`) on that client;
`assemble` (`src/chat/slack/module.ts`) hands its `delete` and `clean` to `Home`. Any other token
stops the start with a `ConfigError`. The header line is then a section and the row under it, an
actions block (`home.CONTROLS_BLOCK`), carries an **Edit** button (`home.EDIT_ACTION`), first in the
row; without the token the row holds no Edit button. `Home.edit` keeps the mode in memory and publishes. It keeps
the filters the page had on entering and puts them back on leaving, so one chosen inside edit mode
(**Show all** on the channel being cleaned) does not outlast it. In edit mode a channel's header has
no **New thread**, and the title row of each session whose status is not `working` or
`waiting for you` carries a `danger` button (`home.DELETE_ACTION`) with a `confirm` dialog that
names the thread, cut to the dialog's 300 characters. Slack sends the click only after the owner
confirmed. The listener checks the owner and the workspace, like every Home control, and
`Home.delete` acts only in edit mode. It publishes at once with the thread marked
(`HomeRow.deleting`): the row reads `texts.HOME_DELETING` in place of its status and has no button,
a section under the header counts the threads on their way (`texts.HOME_DELETING_ONE` or
`texts.HOME_DELETING_MANY`), and the channel's header counts its own
(`texts.HOME_CHANNEL_DELETING_ONE` or `texts.HOME_CHANNEL_DELETING_MANY`), since such a row can be
one a channel does not show. A second click on a thread already being deleted does nothing, and the
page is published again when the delete ended. What a delete or a clean-up that did not end has to
say is kept per thread or channel (`Home.notices`), so one's result does not erase another's: each
is a context line under the header that names its thread or channel, the latest `home.NOTICES_SHOWN`
of them, until the same one is tried again or edit mode is entered or left.

`ThreadDeleter.delete` acts only on a thread `state.json` holds. It asks `SessionManager.release`,
which answers false for a thread whose session is working or waits for the owner. Otherwise it holds
the thread, closes its live session (the test the idle close makes, as silent) and waits for the
teardown. While a thread is held `SessionManager.get` answers null for it, so a message sent in a
thread that is being deleted builds no session from the entry `state.json` still has and is answered
`texts.NOT_A_SESSION`; `!resume` refuses it too (`SessionManager.held`). `SessionManager.free` ends
the hold when the delete ended, either way.

The deleter then reads the thread page by page (`conversations.replies`, cursor pagination) and
deletes its replies with `chat.delete`: the bot's own with the bot token, every other with the
owner's. It reads the thread again after each pass and deletes the root only once a read shows no
reply left, so a message that arrived meanwhile goes too and no reply is left under a deleted root.
`message_not_found` counts as deleted. `cant_delete_message` (a message that is neither the owner's
nor the bot's, or a workspace that does not let the owner delete) is counted and the delete goes on:
with any such message the root stays, the thread stays in `state.json`, and the page says
`texts.HOME_DELETE_REFUSED` with the count. `chat.delete` is Tier 3 and both clients send a rate
limited call again, which is where a delete's time goes; threads are deleted one at a time, so two
deletes never spend each other's retries. Only a thread emptied to its root and past it is dropped
from `state.json` (`StateStore.removeThread`). Any other failure stops the delete and leaves the
thread where it is, with `texts.HOME_DELETE_FAILED` (or `texts.HOME_DELETE_BUSY` for a thread in
use); the same click later continues with what is left. The Claude Code session and its transcript
are not touched.

### Clean up

In edit mode a channel's header carries a button (`home.CLEAN_ACTION`) with a `confirm` dialog that
says what it deletes; `Home.clean` acts only in edit mode and on a bound channel, marks the channel
(its header reads `texts.HOME_CHANNEL_CLEANING`, a section under the page's header
`texts.HOME_CLEANING_ONE`), and publishes before and after. `ThreadDeleter.clean` reads the channel
page by page (`conversations.history`, cursor pagination) and takes the owner's and the bot's
messages that carry no `subtype`, are no reply of a thread, and that `state.json` does not hold as a
thread. One that carries `thread_ts` is taken only when `conversations.replies` on it, with
`limit=1`, returns its root with no `reply_count`: a thread taken for a leftover would lose its
root, so no answer, or one with no root, keeps the message. Each is deleted with its author's token,
as a thread's messages are. It shares the deleter's lock, so one clean-up or delete runs at a time.
A message Slack refuses to delete (`cant_delete_message`) is counted and the rest still goes
(`texts.HOME_CLEAN_REFUSED`); any other failure stops the clean-up with `texts.HOME_CLEAN_FAILED`,
and the same click later deletes what is left.

`Home.publish` never throws. `not_enabled` (the Home tab is off in the Slack app's settings) is
logged once and ends the publishing for that run; any other failure is logged by its error code and
tried again after `home.RETRY_SECONDS`.

### Deleting a thread from inside it

`!delete-thread` reaches the provider as `SlackChat.deleteThread`, which exists, with the
capability `threadDelete`, only when `module.deleter` built a `delete.ThreadDeleter` from the
owner's token: the same deleter the Home tab's Delete calls, so both ways share one path and one
rule (`SessionManager.release` refuses a thread in use). The core refuses a thread whose session
works or waits (`ThreadSession.inUse`) before anything is shown.

The question is an ephemeral message under the owner's word (`DeleteThread.ask`), built by
`delete-thread.deleteThreadBlocks` from the Home tab's own texts, with two buttons and no value. A
click on an ephemeral message carries `response_url` and a `container` with `is_ephemeral`,
`channel_id` and `thread_ts`, and no `message` (measured 2026-10-19 on bolt 5.1.0): the handlers
read the thread from the container (`wire.clickThread`) and check the owner and the channel
(`Answers.admitted`). Both buttons take the question away with Bolt's `respond` and
`delete_original`, the only two listeners that use `respond`: `chat.update` cannot edit an ephemeral
message (method reference, read 2026-10-19), and a question rewritten instead stayed in the
channel's view once its thread was deleted, until a reload (measured 2026-10-19, iOS). A failed
`respond` is logged and the delete goes on. `Delete thread` then calls the deleter, which answers
why a thread is still there as a `delete.DeleteRefusal`: the Home tab and the thread each word it
for themselves (`texts.THREAD_DELETE_REFUSED`, `texts.THREAD_DELETE_FAILED` in the
thread). A thread still there asks the Home to read its root again and tells the owner its line. A
question left from a run that had the owner's token, clicked after a restart without it, stays and
answers `texts.DELETE_THREAD_UNAVAILABLE`.

### Suggesting a command

A `!word` typed in a session's thread that is no command of allaboard's or of the session reaches
the provider as `SlackChat.suggestCommands` (capability `commandSuggestions`, always declared). The
core has connected the session, ranked the candidates (`commands.rankCandidates`) and sent nothing
to Claude Code. It decides before the setup and the same-folder hold when the session is connected
or never ran (the setup connects it before the hold anyway); a session that ran and was closed is
asked the hold first, so that a Cancel starts no process, and suggested for once connected.
Nothing is suggested at the top level of the channel: there the word reaches Claude Code as
before.
`Suggestions.show` (`app/suggest.ts`) posts an ephemeral message under the owner's word, built by
`suggest.suggestionBlocks`: an `input` block with a `plain_text_input` whose `initial_value` is
exactly the typed text (a text past 3000 characters, the limit of an initial value, is not put
in the field, which then says so in its placeholder: sent from there it would arrive cut) and whose
`dispatch_action_config` fires on `on_enter_pressed`, an `actions` block with the Send button,
then one `section` per candidate with a button that shows the command and the arguments typed (cut at 75 characters). For `!` alone
(`CommandSuggestion.all`) allaboard's words are rows and the session's commands one
`static_select`, since a message holds 50 blocks: past 100 commands, the limit of a select's
`options`, they go in `option_groups` of 100, each named by its first and last command (250 in
three groups were accepted on 2026-10-21). The words a thread refuses
(`!bind`, `!resume`, `!allaboard`) are not offered.

The typed message rides in the field's `block_id` (`suggest:<ts>|<n>`), which is new on every post
so that Slack shows the new `initial_value` and not what was typed before. The candidates stay in
memory, 20 suggestions at most, under a random id that the buttons carry in their `value` as
`<id>:<index>`; a restart forgets them, and a pick then says so (`texts.SUGGEST_EXPIRED`). The
four listeners (`suggest_edit`, `suggest_send`, `suggest_pick`, `suggest_menu`) read the thread
from the container, as `!delete-thread` does. A text field and a button cannot share a row in
Block Kit, so Send sits in an `actions` block right under the field.

- `onEdit` (Enter): checks the owner and the workspace before anything (`Answers.fromOwner`),
  takes its place among the thread's messages (`ThreadOrder.enter`, as the `message` listener
  does), checks the channel, marks the field's block id as used (a second Enter on it, which
  waits for its place behind the first, does nothing; a refused channel leaves it unused),
  takes the suggestion away with `respond({ delete_original: true })` and hands the field's text
  to `ChatInbound.message` as an `InboundMessage` of the thread with the typed message's id,
  `topLevel` false and `literal` false, so the core reads it as a typed word. The text is the
  field's raw value: it is not run through `slackUnescape`. An empty field does nothing.
- `onSend` (the Send button): the same path as `onEdit`, one field's block id marked for both, so
  an Enter and a Send on one field hand its text over once. The button's `value` is the field's
  block id, and the text is the field's entry in the click's `state.values`, which carries what
  the owner typed whether or not they pressed Enter (seen on 2026-10-21, desktop). A click with no
  text for the field does nothing.
- `onPick` (a button, and the menu through the same handler): checks the owner, the workspace and
  the channel, takes the message away and posts a new one with the picked command in the field. A
  rewrite through `response_url` with `replace_original` showed the new message in the channel too
  (seen 2026-10-21, desktop), which is why `Respond` allows `delete_original` alone.

### Tagging a thread

`!tag` and `!untag` reach the provider as `SlackChat.tagThread`, which exists, with the capability
`threadTags`, only when `module.canTag` found the owner's token (`module.ownerClient`) holding
the user scope `pins:write`. The module builds one `tag.RootEditor` from the bot client and the
owner's whenever the owner's token exists; tags use it only with that scope, and titles (below)
need no more than `chat:write`.
`ownerClient` reads the token's scopes from `response_metadata.scopes` of its `auth.test`, which
`@slack/web-api` fills from the `X-OAuth-Scopes` header. A token without the scope, or one for which
Slack reports none, gets no tagger and one warning in the log; the thread deleter, which needs
`chat:write` alone, is built either way. The first message of a thread is the owner's,
and `chat.update` changes only messages posted by the authenticated user (method reference, read
2026-10-19), so `RootEditor.tag` reads the root with the bot (`conversations.replies`, `limit=1`,
the message whose `ts` is the thread) and writes with the owner: `chat.update`, then `pins.add` or
`pins.remove`, the latter only for a root that carried a tag, so that a pin the owner made by hand
on an untagged root stays. A step that would change nothing is skipped (a root already tagged as
asked sends no edit, a pinned root is not pinned again), and `already_pinned`, `not_pinned` and `no_pin` are not
failures (`pins.add` and `pins.remove` references, read 2026-10-19). Any other refusal rejects with
a `ChatError` named by Slack's code, which `Talk.replyOnFailure` shows the owner, and the steps
after it do not run.

The tag lives in the root's own blocks and nowhere else. `tag.retaggedBlocks` takes off a leading
tag, a `text` element in code style (`style.code` alone) whose text is `[name]` for a name that
satisfies `commands.TAG_NAME` plus a following element that is exactly a space, and puts the new
one first in the first `rich_text_section` of the first `rich_text` block. When taking a tag off
leaves that section empty (the tag had a section of its own) the section goes, and the block with it
when nothing else is in it, so a tag and an untag give back the blocks the root had. A root with no
`rich_text` block gets a block of its own, one that starts with a list or a code block gets a
section for the tag before it, and a root with no blocks at all is edited through its `text`
alone (`tag.retaggedText`, the same prefix in backticks). `tag.rootMarks` reads the tag and the pin
(`pinned_to`) back from a root, which is what the Home tab does. Text the owner wrote that starts
with such a code span and a space reads as a tag.

The edit reaches the daemon as a `message_changed` event, which the message guards (`src/chat/slack/app/guards.ts`) drop, so no prompt is
sent. After a call, whether it ended or was refused, `SlackChat.tagThread` asks the Home tab to
read that root again (`SessionIndex.refresh`).

### Titling a thread

`SlackChat.titleThread` exists, with the capability `threadTitles`, whenever the owner's token
exists (`SlackChatOptions.roots`): the edit is a `chat.update` with `chat:write` alone, so a token
without `pins:write` titles but does not tag. The core calls it at the end of a turn with the
session's title and, while the core has kept nothing yet, a `keep` callback.
`RootEditor.title` reads the root as `tag` does and rewrites it whole, through
`tag.retitledBlocks` and `tag.retitledText`; the owner's words leave the root, which is
irreversible, and the core keeps their text in `state.json`.

`RootEditor.title` does the whole replacement in one task queued with the other edits of the root:
it reads the root once (`conversations.replies`), hands `keep` the root's `text` field converted
with `app/messages.slackUnescape`, the conversion an inbound message goes through on its way to the
agent (entities unescaped, `<url|label>` turned to `label (url)`; mentions and Slack's own `*bold*`
marks stay as sent), with the tag left out, waits for `keep`, and only then edits. When `keep`
throws, nothing is edited. A root read back as a tombstone is refused with `thread_not_found`, for good, before `keep` or any edit. A read or an edit refused with `message_not_found`, `thread_not_found`,
`channel_not_found`, `not_in_channel`, `missing_scope`, `edit_window_closed` or
`cant_update_message` rejects with a `ChatError` whose `permanent` is true.

The root becomes one `rich_text` block with one `rich_text_section`: the tag's two elements when
`tag.rootMarks` reads a tag on the root, then a bold `text` element holding the title. The block
keeps the `block_id` of the root's first `rich_text` block, so that a root already reading so
compares equal and nothing is sent. The text fallback is `` `[tag]` *title* `` or `*title*`, with
`&`, `<` and `>` of the title escaped (`mrkdwnEscape`). A title with line breaks is made one line
first. A root with no blocks is edited through its `text`. Files attached to the root are not
preserved on purpose, and what `chat.update` does to one has not been measured. `!tag` and
`!untag` work on a titled root as on any other: the tag goes before the title, and an untag leaves
the title.

Every edit of a root, a tag or a title, queues behind the earlier one of the same channel and
thread inside `RootEditor`, since each reads the message and writes it back whole and two
overlapping would lose the earlier change. A failed edit does not hold back the next. A refusal that
cannot change (`edit_window_closed`, `cant_update_message`, `message_not_found`,
`thread_not_found`) rejects with a `ChatError` whose `permanent` is true, so the core does not offer
the same title again; any other refusal is retried at the next turn. `titleThread` does nothing once the provider is stopping. Like
`tagThread`, it asks the Home tab to read the root again whether it ended or was
refused.

The owner's words that `!status` shows (`ChatProvider.escape` as `words`) are left as written: its
markdown block draws the owner's mentions as mentions and their code as code (an entity or a
backslash escape would show literally inside a code span, measured 2026-10-20), and `!status`
is a message only the owner sees, which never pushes, so a mention in it reaches no one.

### A deleted first message

Two shapes of the `message` event say a message was deleted, both seen on 2026-10-20 when the
owner's user token deleted roots (`guards.deletedTs` reads them): `message_deleted`, whose
`deleted_ts` is the message that went (reference: docs.slack.dev/reference/events/message/
message_deleted, read 2026-10-20), for a root with no replies and for the last reply deleted
afterwards; and a hidden `message_changed` whose inner `message.subtype` is `tombstone`, with
`message.ts` the root, for a root deleted while replies remain (the reference page of
`message_changed` does not name the subtype, so it is measured only). After the last reply is
deleted a `message_deleted` for the root follows, and `conversations.replies` answers
`thread_not_found`. An edit of a root, the daemon's own title or tag included, is a
`message_changed` with no tombstone and is still dropped.

The listener is its own (`app.buildApp`), because `guards.isPromptMessage` stays closed to every
subtype but a person's message. No field of either event names who deleted the message. The listener checks three things
instead: the envelope's `team_id` against the workspace read at startup; that the deleted message
was the owner's, from `previous_message.user` (`guards.deletedAuthor`; measured on 2026-10-20, 4
rounds: the root's author in both shapes, a bot reply's author for a reply, and for the removal of a
tombstone a `previous_message.subtype` of `tombstone`, which is dropped; the tombstone's own
`message.user` is a Slack system user and is never read); and that the `ts` is a thread
`state.json` keeps. The author check proves whose message was deleted, not who deleted it, because
Slack's event does not say; this may be revisited. It then
calls `ChatInbound.rootGone`, and asks the Home tab to read the thread again only when its entry
survived (a turn runs, and the cleanup forgets it later), since forgetting the entry asks it
already. The kept-thread check comes before the author check, so the deletion of the daemon's own
message and the removal of a tombstone are dropped without a log line. A deletion event from
another workspace, for a message that is no kept thread, or with no channel, changes nothing. The
replies the daemon wrote stay in Slack. `message.groups` already delivers both shapes, so the
manifest needs no new event.

## Slack handlers

A Slack listener does five things in this order: it acknowledges, checks who acted, reads the
payload, calls the core through `ChatInbound`, and draws what the core asks to be drawn.
`app.buildApp` builds the Bolt app and registers one listener per inbound path: `message` events,
the deleted-first-message listener (below, "A deleted first message"), the `file_change` event (below, "An audio clip"), the Approve, Deny, Answer and Skip buttons, the
question form's Next and Submit, the same-folder hold's two buttons, a shell command's Run and Cancel, the setup's Model select and
Start (its Effort select and Bypass checkbox are only acknowledged, since Start reads every
control), the Bind and Resume buttons of the two lists, the Diff button and the view selector of a list in a thread, the Update button of the update offer, `!open`'s Choose a file button with its
modal's search field and Open, and the session index's controls (its filters, Show all, Edit, Refresh, Delete,
Clean up and Update, and its New thread link button, which is only acknowledged). The listeners are methods
of the classes of `src/chat/slack/app/` (`Requests`, `Open`, `ResumeBind`, `Clips`,
`HomeControls`), which share `Answers`: the checks, where an answer goes, and how a failure is told.
The app registers no slash command.

### The message listener

The `message` listener is the one that keeps an order. It checks the owner and the workspace
first, with nothing awaited (`Answers.fromOwner`), so that an event from anyone else takes no
place and reaches no Slack call. Then it takes its place among the messages of its thread
(`ThreadOrder.enter`, keyed by channel and thread, before its first await), waits for the places
taken before it, runs the channel check (`Answers.channelAllowed`) inside it and calls
`ChatInbound.message`, or `Clips.takeClip` for a clip, which ends the stretch: the place is left
on that call's return, before the core's work on the message ends, so a later message never waits
for a turn, a download or a setup the owner has not answered. A refused check leaves the place too.
Threads do not wait for each other, and a thread's entry is dropped when its last place is left.
A later message of a thread waits for the checks of the messages before it. A check is two calls,
each bounded by the client's 30 seconds (`clients.REQUEST_TIMEOUT_MS`), so about 60 seconds per
message ahead with no network, plus the pause of the one connection retry and up to 60 seconds of `Retry-After`
Slack sends; a message with none ahead waits for nothing. Other threads are not affected.
The buttons and forms keep no such order: each names the message it answers.

A clip whose transcript is in the file's `vtt` is the exception: `Clips.takeClip` hands it over after the download of that file, and a typed reply sent after it can be handed over first.

| The owner | The listener reads | The core decides |
|---|---|---|
| writes a message, a word included | an `InboundMessage` (`messages.inboundMessage`) | `ChatInbound.message`: `messages.messages`, which hands a word to `words.wordFlow` |
| answers a request: Approve, Deny, Skip, the question form, the hold's two buttons, Run and Cancel, the setup's Start | an `OwnerAnswer` | `ChatInbound.answer`: `answers.answersFlow` |
| uses a row of a list: Bind, Resume | a `ListPick` | `ChatInbound.picked`: `lists.lists`, over `bind.binding` and `resume.resuming` |

What stays in the provider is drawing and what only the provider has: the Model select's redraw of
the setup message, the question form's pages, `!open`, the Home tab's controls and the clips.
 Bolt acknowledges an event before its listener runs, and a
click's listener acknowledges first; each then checks the owner, the workspace and the channel
itself; a control of the session index, and a character typed in `!open`'s modal, come with no
channel and check the owner and the workspace. Answer, on a question, opens its form
(`Requests.onQuestionOpen`) after the owner and workspace check alone, since the click's
`trigger_id` lives 3 seconds and the channel check makes two calls to Slack; the channel is checked
once the form is open, and a refused channel replaces the form with the reason
(`requests.refusedView`), since Slack lets an app close a modal only in answer to a submission.
The update carries the hash the form opened with; when the owner closed the form or moved on in
it meanwhile, the reason goes to the thread as a line only the owner sees. The
form shows the owner alone what the request already shows. In the question form every field reports its change as a `block_actions` payload
(`Requests.onQuestionLive`: an option, a box, Other, Notes) and updates the draft. A change of
the choice (`onQuestionChoice`) also redraws the form with one `views.update` that carries the
hash of the view it came from: Other is the last option, its text field shows only while Other
is chosen, and Notes only while a real option is chosen (not for Other alone). Typing in Other or in Notes
(`onQuestionTyping`) redraws nothing. A block keeps its `block_id` while it stays on screen,
because Slack keeps an input's value while its `block_id` and `action_id` stay. A `hash_conflict`
or `not_found` is logged and ignored: Submit reads the state as it stands. What the owner filled
stays in the provider's memory (`Requests.drafts`) and the view's `private_metadata` holds the
request's ids, the form's generation and its page. Only the newest form of a request is valid:
every Answer (`Requests.onQuestionOpen`) opens a new generation from the draft, an older form's
changes and its Edit are ignored, and its Next or Submit answers `texts.QUESTION_STALE` as a field
error (on the review page, as the whole form replaced by that sentence) and sends nothing. A form an earlier version opened has no generation, or carries a whole draft
beside the ids: it is read for the ids and the generation, so once its request is gone
`texts.APPROVAL_GONE` answers (checked first), and while the request is open it is stale. The same owner and
workspace check applies, and the channel is checked at Submit. The Edit buttons of the review page
(`question_edit_{n}`, one listener, `Requests.onQuestionEdit`) check the owner and the workspace
before anything else, act only from the newest form while it shows the review page, never reach
the core, and when Slack refuses their `views.update` (`hash_conflict`, `not_found`) log a warning
and put the draft back as it was, unless Submit answers sent it meanwhile. Next, Review and
Submit answers go through `Requests.onQuestionSubmit`: before the review was reached Next moves
to the next page, and on the last page, and on every page after the review, `Review` goes to the
review page when every question has an answer, else to the first one without. The question form's Next, Review and Submit answer Slack after checks that make no network call, since a missing answer can only be shown in
that answer, and Submit checks the channel before the answer reaches the core. A
failure after the checks reaches the owner as a line of its own (`Talk.replyOnFailure` for what a
flow does, `Answers.replyOnFailure` for what a listener does itself): a post in the thread for a
prompt, where a word's failure goes for a word. A listener that throws past that
is logged by the error's name. A link Slack made from a typed address (`<url|label>`, `<url>`)
reaches Claude Code as typed; a link the owner named reaches it as `label (url)`, so the address is
not lost; a mention stays in Slack's form (`<@U…>`), since naming the user would need a scope the
app does not have (`messages.slackUnescape`).

### Audio clips

An audio clip: a message whose one file Slack shows as audio (`media_display_type`) is held instead
of being sent (`voice.clip`, `Clips.takeClip`), since Claude Code takes no audio and the daemon
transcribes nothing. Slack writes a clip's transcript when asked for it and sends `file_change`
while it does (measured: "Clip transcript"). That event names a file and no user or channel, so its
listener (`Clips.onFileChange`) acts only on a file id the owner's own message left waiting, reads
the file with `files.info`, and checks the owner, the workspace and the channel again on what Slack
returns before anything is sent. When `transcription.status` is `complete`, the text (the preview,
or the file's `vtt` when Slack cut the preview, `voice.vttText`) goes through the same path as a
typed message, so the setup, the holds and the notices apply as they do to text, with one
difference: a transcript is never read as a word of the daemon or as a command, so what Slack heard
cannot change the permission mode. A clip that a typed message could not follow (a thread with no
session, an unbound channel, a file somebody else uploaded) is refused when it comes, before any
wait. A clip waits `voice.WAIT_SECONDS`, in memory only.

### Routing a message

A message is routed by the message flow, by whether it is a reply in an existing thread:
`messages.messages` reads `SessionManager.get` for a reply (null for a thread that holds no
session), and always null for a top-level one (`thread_ts == ts` in Slack's payload, `topLevel` in
the `InboundMessage`), even in a channel that is bound. `commands.parseBang` reads a message
starting with `!` (none for one carrying files or spoken, which is always a prompt: the message is
`literal`). The listener hands over the event's `text` and what `messages.unformatted` makes of it
(`InboundMessage.plain`), and `messages.messages` reads the `text` first, then the other. Slack puts the formatting marks in `text` (a backtick before the `!` of a message in inline
code) and sends the same message in the `rich_text` block of its composer, as `text` elements whose
`style` says how they look. `messages.unformatted` reads one thing in that block, the run the
message opens with, in a `rich_text_section` or a `rich_text_preformatted` part. When the run starts
with `!` and the text reads as marks, that run, then the same marks closing the run or the message,
it returns the text without those marks: the arguments stay as the owner sent them, with their own
formatting and links. Anything else returns nothing and the message stays a prompt: a quote, a list,
a message that opens with another element, and a message with no composer block, where nothing tells
a mark from a character the owner typed. The word ends at any whitespace, so a line break after it
separates the arguments as a space does. The words: `help`, `guide`, `bind`, `bypass`, `status`,
`stop` and `resume` and `open` are the daemon's own words (`commands.Word`), dispatched in
`words.wordFlow` by whether the lookup above found a session: `!resume` works only at the top
level, refused inside any thread (`texts.WORD_IN_THREAD`), and `!bind` is refused the same way in a
thread that holds a session, and with a folder in a thread that holds none; a bare `!bind` at the
top level or in a thread with no session lists the folders; `!bypass` only inside a thread,
refused at the top level (`texts.BYPASS_TOP_LEVEL`), and so is `!open` (`texts.OPEN_TOP_LEVEL`);
`!guide` answers the same either way; `!help`, `!status` and `!stop` answer both, but with different
content: `!help` lists only the daemon's words at the top level and a session's own commands too
inside its thread, except `clear`, which a thread refuses (`commands.refusedInThread`); `!status`
lists the channel's threads that hold a session at the top level and one session's own values inside its thread;
`!stop` stops every session of the channel at the top level and one session inside its thread.
`!clear` is not a word of its own: it is an ordinary `Passthrough` that `messages.isClear` catches
only inside a thread, refused there (`texts.CLEAR_IN_THREAD`, one thread is one session), under each
of the agent's new-session names (`AgentWords.newSession`: for Claude Code `clear`, `reset` and
`new`, known before a rebuilt session has started), and any other alias the session's own command list gives `clear` (the
initialization result carries each command's aliases; measured: "Initialization result"). At the top
level it opens a new session like any other message, and reaches Claude Code as `/clear` if the
freshly started session offers that command. `!login` and `!logout` (`AgentWords.login` and `AgentWords.logout`) are `Passthrough`s the daemon
never sends (`commands.hostOnly`): they act on the host's own login, which the daemon and every
session run on, so `messages.messages` answers with `texts.LOGIN_ON_HOST` or
`texts.LOGOUT_ON_HOST` before any session is opened, in the channel or, inside a session's thread,
for the owner alone. Any other `!name args` is a `Passthrough` too: sent as `/name args` when the
session offers `name`; inside a session's thread a name it does not list is suggested for (see
"Suggesting a command"), except an alias it lists, which is sent as the text itself, as is any name
at the top level. A top-level
message with no existing thread opens a new session (`SessionManager.open`); a message in a thread
that holds no session and is not a daemon word gets `texts.NOT_A_SESSION`, with nowhere to send it.

### Resuming a session

`!resume` stands in for Claude Code's interactive `/resume`, which an SDK session does not offer:
`resume` lists the directory's sessions from the back end's listing (`AgentBackend.listSessions`,
the SDK's `listSessions`) with the columns of the terminal's picker (name or title, time since the
last activity, git branch, size), the first 8 characters of the session id and a Resume button each,
or matches `!resume <id or name>`. The terminal's picker shows no id; the list shows its start
because `!resume` takes a full id or any start of one at least 8 characters long
(`resume.ID_PREFIX_MIN`; the list shows `resume.ID_SHOWN` of them). A session a thread already holds takes no row, and a line under the rows counts
them. The list is posted in the channel, and each button carries the session id and the ts of the
`!resume` message (`resume.parseResumeValue`). A Resume click or a typed `!resume <id or name>`
(`resume.resuming`) opens the chosen session in the thread of that message
(`SessionManager.resume`), with a fresh thread entry: bypass never chosen (the folder's own mode)
and no `/effort` level, whatever the session had before. It is refused, with no `await` between the
checks and the `resume` call they guard so nothing can change in between, when that thread already
holds a session (`texts.RESUME_HELD`: a resume is never a swap), when another thread already holds
the chosen session (`texts.RESUME_ELSEWHERE`, with a link to it: one session lives in one thread),
or when the channel was bound to another folder while the chosen session was read from the old one
(`texts.RESUME_GONE`); it never waits on, or touches, any other thread of the channel.

### Updating allaboard

`!allaboard update` typed in a channel makes the core offer the latest version
(`ChannelChat.offer` with an `OwnerList` of type `update`). The Slack provider posts it at the top
level of the channel (`update.updateBlocks`): a section whose text is the core's title
(`texts.UPDATE_OFFER`) followed by a link to what the version changed (`texts.UPDATE_WHAT_CHANGED`),
with an **Update to** button as its accessory; then a context line, `texts.UPDATE_DRAIN`, and, when
other instances run the same copy, one more that names them (`UpdatesPage`'s `sharedCopyLine`). The
offer's section has the `block_id` `update`. The button (`update.UPDATE_ACTION`) carries the version
it installs as its value and asks for no dialog, since the message shows the change.

A click reaches `ResumeBind.onUpdate`, which acknowledges, takes the owner and the workspace from
the payload, runs the two checks every button runs (`Answers.admitted`: the owner from the
workspace read at startup, then the channel as Slack describes it now) and only then tells the core
through `ChatInbound.picked` with the channel, the version in the button's value and the `ts` of the
message as `list`. The value is untrusted like any other: the core installs it only when it is newer
than the version that runs. The Home tab's button (`home.HOME_UPDATE_ACTION`) reaches
`HomeControls.onHomeUpdate`, which checks the owner and the workspace as every Home control does
(its payload names no channel) and tells the core with a `channel` and a `list` of null: a page has
no message to answer on, and shows the state instead. Slack sends that click only once the owner
confirmed in the dialog.

The core rewrites the offer in place as the update goes on (`ChannelChat.rewrite`, an edit of the
message into a notice with nothing to press) and withdraws it when it must (`ChannelChat.withdraw`),
as it does for the other two lists. A line that answers a click without touching the offer (an
update already under way, a restart already begun) is `ChannelChat.tell`: an ephemeral message in the
channel for the owner (`chat.postEphemeral`), small and grey like a notice, which rejects with a
`ChatError` named by Slack's code.

The line the owner is told once per version (`texts.UPDATE_NOTICE`) comes under his first message
after the daemon learns of the version. For a reply in a thread it goes through `ThreadChat.tell`,
an ephemeral message with `thread_ts` set to that thread. Slack shows an ephemeral message in a thread only while the thread is active, and
documents no guarantee of delivery: the user must be currently active in Slack, and the message does
not survive a reload (`chat.postEphemeral` and the messaging page, docs.slack.dev, read
2026-10-17). The owner has just written, so he is active; the Home tab's line is what stays. For a message
at the top level, which has no reply yet, the core sends the line to the channel
(`ChannelChat.tell`), as `Answers.tellOwnerAbout` does for its own lines: Slack shows an
ephemeral message in a thread only once the thread is active. It is not known whether Slack
notifies for it, and the line has not been seen on a real workspace.

### Notices

The daemon's notices (the answer to `!bind`, `!bypass` and `!stop`, a word used in the wrong place,
a resume that did not happen or is refused, a refused attachment, a restart, and the ephemeral
errors) are a context block, small and grey as the footer, so they read apart from Claude's replies:
`ThreadChat.notice` for the session's own, `ThreadChat.tell`, `ChannelChat.tell` and
`ChannelChat.notice` for the flows' answers (it resolves with the `ts` of the post, which `ChannelChat.rewrite` takes later), `Answers.notice` and `Answers.tellOwner` for the Slack listeners'. The root `!fork` posts is a full-size markdown block at the top level of the channel (`ChannelChat.open`), and the thread it starts is named by that post's `ts`. A line for the owner
alone about a top-level message that has no reply yet goes to the channel
(`Answers.tellOwnerAbout`): Slack shows an ephemeral message in a thread only when the thread is
already active. That covers a refused attachment and a refused channel. The lines about an audio
clip are normal posts instead (`Answers.tellAbout`), in the clip's thread or in the channel for a
clip at the top level: Slack lets nobody delete or update an ephemeral message, and the line that
says a clip waits is deleted (`Answers.withdraw`) when its transcript arrives or the wait ends. A
clip whose file is somebody else's is still answered for the owner alone. The same holds
for the lines of the `!bind` and `!resume` lists; their rows keep a section, since a context block
holds no button. Their text is mrkdwn, and what comes from outside (a folder, a file name, a typed
target) is escaped for it (`ChatProvider.escape`, which the Slack provider answers with
`escape.mrkdwnEscape`). `!help`, `!guide`, `!status` and the answer to a
resume stay a markdown block at full size (`ThreadChat.say`): the first three are read, and a resumed
session's title keeps every character inside its bold only there, since mrkdwn has no escape for
`*`. A shorter target is read only as a title. The list holds the directory's own sessions, not
other worktrees', as the terminal's picker starts. A Resume click is checked like any other button,
and the session must still be one of the directory's. `!bind` alone lists, through
`folders.bindableFolders`, the folders where a session can start: `ALLOWED_ROOT`, then its folders,
then theirs (`folders.foldersWithin`), skipping hidden folders and symlinks and never descending
into a git repository (a `.git` directory or file). A folder is kept when the back end says the
owner trusted it (`AgentBackend.folderTrusted`). The checks run eight at a time
(`folders.TRUST_BATCH`) and stop once one more than the 20 rows shown (`folders.FOLDER_ROWS`) is
found, so the higher levels fill the rows, which are then shown in path order. The trust record is
parsed again only when its mtime or size changes. A Bind click is checked like any other button, its
folder goes through the same `directory.resolveDirectory` check as a typed `!bind <folder>`, a click
on the channel's own folder changes nothing, and a click while any of the channel's threads is not
idle is refused, as a typed `!bind` is. The `!resume` list reads the last message of a session's
transcript only while that session can still be among the 20 shown: a file's mtime bounds its last
message from above (`listing.byLastActivity`). The SDK dates a listed session by its transcript
file's mtime and names no path for a transcript, so the back end finds the folder's transcript
directory itself (`listing.projectFolder`): under `~/.claude/projects/`, or under
`CLAUDE_CONFIG_DIR` when that is set (by the daemon's `.env` or its environment: the Claude module
gives the folder to the listing, `claudeAgent`), in a directory named after the folder's real path (composed to
NFC on macOS) with every character that is not an ASCII letter or digit turned into `-`; past
`listing.LONG_PROJECT_KEY` (200) characters, the first 200, a `-` and a hash, and since that hash is
Claude Code's to compute, the first directory that starts with the same 200 characters and `-`
stands in for it. The rule is the one the SDK itself applies (measured: "Transcript folder name").
With no such directory the sessions keep their files' times, and a warning says so. Top-level
`!status` (`status.channelStatus`) answers with a notice, small text: the channel's directory,
then one line per thread of the channel that holds a session in `state.json`, live or not (a live
one whose setup is still open too), newest first by the session's last message and at most
`STATUS_ROWS`, the others counted on a last line. Each line is a link to its thread labelled with
the session's title (`Talk.noticeLink`) and led by the mark its root carries
(`SlackChat.statusMark`: ⏳ busy, ✋ waiting for the owner, ✅ or ❌ at rest, by how its last turn
ended, from `state.json` for a closed session), with the time since its last message when at rest,
its running tasks, its bypass and its folder when it differs from the channel's; a chat with no
reactions writes the status as a word after the link instead; while a stop waits, a notice
under it names the threads the stop waits for. Inside a thread `!status` is that session's own
(`ThreadSession.status`, see Footer above). Top-level `!stop` (`SessionManager.stopChannel`) and
`!bind`'s busy check (`SessionManager.sessionsOf`) read the channel's live sessions. `commands.helpText` lists the daemon's own words, then, only when it is called with a session's
commands (never at the top level, where a word never has one), those the session's start reported
(`AgentSession.info`), keeping only the lines that contain the text after `!help` when there is one,
so a command a new Claude Code release adds needs no change here. Bolt's per-request authorization
returns the identity `auth.test` gave at startup and no token, so no request costs an extra API call
and Bolt builds no client of its own; its `ignoreSelf` filter and its conversation store are
switched off, and what Bolt logs goes to the daemon's log.

## Building the provider

`module.slackChat` builds the Slack provider (its `build` reads the core only once it is used): the two Slack clients (`module.makeClients`: `clients.sharedClient` for every call but a
reply's, `clients.repliesClient` for replies), `auth.test` for the workspace id and the bot
user id, the `SlackChat` with the shared `UpdateLimiter` and the channels' `ChannelLine` (see "Pushes and threads" above), the `ThreadDeleter` when the owner's
user token is configured (`module.deleter`, which calls `auth.test` with that token), the
`Home`, the `ChannelGuard` and the attachments folder (`attachments.prepareUploads`, see
"Attached files").

The entry requires `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `SLACK_OWNER_USER_ID` and reads
`SLACK_USER_TOKEN`. It refuses a token of the wrong kind in `module.slackChat`, before it calls Slack
(`tokens.wrongKind`).

`ChatProvider.identities` has two keys for Slack, because it has two tokens and Slack documents no call that maps the app-level token to its app: the bot (`<team id>:<bot user id>`, from `auth.test` on the bot token) and the app-level
token Socket Mode connects with (`app-token:` and the SHA-256 of the token, computed in
`module.appTokenKey` so that the token itself never leaves the Slack module).
A copied `.env` that keeps either token collides on that key. The core takes the lock on each key (`lock.chatIdentityLocks`; see "State and the single-instance lock" in [architecture.md](architecture.md#state-and-the-single-instance-lock)).

## The Socket Mode connection

`SlackChat.start` opens the connection and builds the Bolt app with `app.buildApp`, which registers the listeners. Slack delivers an event over the connection, which Bolt's `SocketModeReceiver` holds (`app.socketReceiver`).

`@slack/socket-mode` 3.1.0 reconnects from its `close` listener without awaiting the call
(`SocketModeClient.delayReconnectAttempt`), and when Slack refuses the app token for good
(`invalid_auth` and the four other codes the client calls unrecoverable) the request for a new
WebSocket URL is rejected there with no event for it. The log then holds
`unhandled rejection: invalid_auth`, and the daemon needs a working token and a restart.

When the network is gone the Socket Mode client asks Slack for a new WebSocket URL again and
again until it gets one. `app.socketReceiver` sets how: the waits start at one second, grow by
1.3 each time, stop growing at `app.RECONNECT_WAIT_SECONDS` (60), and the client never gives up,
so a try follows the one that failed by a minute at most. Left to itself `@slack/socket-mode`
3.1.0 lets the wait grow with no limit: with the network gone for two hours it tried 30 times,
the last wait 26 minutes (run on mocked timers, 2026-10-10). The log holds
`socket mode: reconnecting`, then one warning per failed try.

The Slack libraries are given loggers that never write their own text (`quiet-logger`), since it can quote a message and, at the debug level, the Socket Mode ticket in the WebSocket URL: the web clients write nothing, Bolt and the Socket Mode client one line per warning or error that names the library, and the daemon logs the states of the connection itself.

## Stopping

`ChatProvider.stop` (`SlackChat.stop`) closes the connection, tells the listeners it is stopping and gives up the clips still waiting for a transcript. `ChatProvider.close` publishes the session index a last time.

From `ChatProvider.stop` the listeners' checks (`Answers.admitted`, or `Answers.fromOwner` and `Answers.channelAllowed` for a message) refuse, and nothing posts, reacts, opens a modal, submits a prompt or deletes a request.

Node stays alive after a stop while anything holds its event loop, and the Socket Mode connection does: `@slack/socket-mode` 3.1.0 closed its WebSocket 5.9 seconds after the stop in each of three runs on 2026-10-10, with the lock already free.

A thread left with only background tasks while a restart waits says `RESTART_WAITS` (`src/chat/slack/texts.ts`) in its status line. Where Slack refuses the app a thread status (`ThreadChat.activityRefused`), the core says it in one message (`texts.RESTART_WAITS_MESSAGE`).

## Who may talk to it

The Slack listeners run two checks, through `Answers.admitted` (the `message` listener, and Answer opening a question's
form, run the two halves themselves, in the order [Slack handlers](slack-provider.md#slack-handlers)
gives), before anything reaches Claude Code:

1. `guards.isOwner`: the Slack user is the configured owner AND the workspace is the one `auth.test`
   reported at startup. A click from a user whose home workspace differs is refused
   (`guards.interactionActor`).
2. `ChannelGuard.refusal`: the channel is private, not shared with another workspace, and its
   members are exactly the owner and the bot. It is read from Slack every time, so inviting a third
   person stops the bot in that channel at once. A channel that cannot be read is refused.

A payload is read field by field, and a field of the wrong type never passes a check. Messages with
a subtype (edits, deletions, joins) and messages from bots are ignored (`guards.isPromptMessage`),
except `file_share`, a message carrying files, and `thread_broadcast`, a thread reply sent with
**Also send to #channel**, which is handled as any reply in its thread. Neither event has a `team`
field (measured: "File share event has no team", "Thread broadcast event has no team"), so
`guards.messageActor` reads the workspace elsewhere. For a `file_share` it comes from the files'
`user_team`, which must be the same for every file, or the message is refused. For a
`thread_broadcast` it is the `team_id` of the envelope the event came in, and only when the
envelope's `is_ext_shared_channel` is `false`: that id names the workspace the event happened in,
not the writer's own, so in a channel shared outside the workspace the message is ignored. The
channel check refuses such a channel in any case. A `team` that is present and is no string names no
workspace: the message is refused, and neither the files nor the envelope are read in its place. A
`thread_broadcast` that carries files follows the files' rule; no such event has been recorded. The
hidden `message_changed` that Slack sends after a `thread_broadcast` is ignored like any edit. A
refusal reaches the owner as an ephemeral message; everyone else gets nothing.

A control of the session index (the Home tab) runs the first check alone. Its payload names no
channel, and all it does is choose what the owner's own page shows, or delete what the owner
confirmed there: nothing reaches Claude Code.

A word typed inside a session's thread is answered by an ephemeral `Talk.say` under the owner's message (`chat.postEphemeral` with `thread_ts`), which Slack drops on reload. `!bypass` adds `Talk.acknowledge`, a ✅ reaction on the word, which stays. Slack shows a message only the user sees in a thread only once that thread is active (`chat.postEphemeral` and the messaging page, docs.slack.dev, read 2026-10-17), so a notice for a message of the channel goes to the channel; whether Slack notifies for one is not known.

## Attached files

`attachments` handles the files of a `file_share` message, in the Slack provider. The message
reaches the core at once as an `InboundMessage` whose `content` downloads, checks and saves the
files and makes the prompt; the message flow reads it when the message's turn among its thread's
comes, so nothing of the files reaches Claude Code before that. Every file is checked first (`attachments.refusal`): its download URL must be
`https://files.slack.com/...`, the only host that receives the bot token, and its type and size
must be within the limits listed in [Files in a message](setup.md#files-in-a-message). The image
limits are those of Claude's vision API; a non-image file must be a `text/*` type or one of
`attachments.FILE_TYPES`. One message takes at most the images `attachments.imagesRefusal` allows,
since images stay in the conversation and are sent again at every turn, and a request is capped at
32 MB. Then the
files are downloaded together, with the bot token and no redirect followed, each within
`attachments.DOWNLOAD_TIMEOUT_MS`; `attachments.download` checks the host again before it sends the
token. Slack answers 302 when the app lacks `files:read` (measured: "Download without files:read").
An image becomes an image part, and the turn's prompt one user message of content parts
(`attachments.promptFor`), which the back end sends through the SDK's streaming input
(`prompt.userMessage`); any other file is saved to the instance's scratch folder (`ChatContext.scratchDir`, `$TMPDIR/allaboard/` for the default instance) and its path is appended to
the prompt, but only once every file arrived, so a failed message leaves no copy. The folder must be
a real directory of this user with no group or other permission bit set (it is created with mode 700),
or nothing is written there; at each start the files older
than 3 days are removed (`attachments.prepareUploads`), so a conversation resumed after a restart
still finds its files. A refused file or a failed download sends nothing: `content` answers null after the provider told
the owner which file and why.

## Questions and the form

The session puts a permission or a question to the owner through `ThreadChat.ask` (see "Approvals" in [architecture.md](architecture.md#approvals)); this is how the Slack provider draws it.

Everything the model wrote (the title, the description, the input, a
question's header) goes to Slack with `&`, `<` and `>` escaped and a zero-width space after each
backtick (`escape.shownAsWritten`), so no `<url|label>` can hide what it links and no text can close
its code block. 

Answer opens a modal (`requests.questionView`) that shows one question at a time: radio buttons, or checkboxes when several may be picked, each option with its description, and
**Other** as the last option of the list, as the terminal's list ends with its own row for a typed
answer. The choice is required (no `optional`, so Slack shows no `(optional)` beside the question).
While Other is chosen an input block under the choice, **Your answer** (required, placeholder
`Type your own answer`), takes the text; **Notes** (optional) shows while a real option is
chosen, not for Other alone (with a multi-select, while at least one real box is ticked, Other
ticked or not), and a note kept in the draft is sent only then. Slack caps an option object's text and description at 75
characters each and gives it no place for the option's `preview`. When an option says more than
that, the page shows the question in bold, then every option whole in a `rich_text` block: its label
in bold, its full description, and its preview in a preformatted element, which keeps its line
breaks. Rich text shows its text as written, so nothing Claude wrote is read as markup. The choice
under them keeps the labels alone, titled with the question's header. With
several questions the terminal's tab row is drawn as one `context` line: each question's header
with `☒` once answered and `☐` before, cut at 40 characters, a header left empty reading
`Question 2`, the page on screen in bold, then `✔ Submit` (bold on the review page). The modal's
own button reads `Next (1/3)` and moves to the next page (`response_action: update`) only once the
question has an answer, otherwise the question gets an error (`response_action: errors`), and, before
the review was reached, it moves on whether or not the other questions already have one. On the last question it reads
`Review`: it opens one more page of the same form (its page number is the question count) when
every question has an answer, else the first question without one, with no error text. That page
holds the tab row, `Review your answers`, and per question a section `● question` and `→ answer`
(a multi-select's joined with `, `) and, when a real option was chosen and the question has notes,
a line `Notes: …` under it, with an `Edit` button as the section's accessory (`question_edit_{n}`,
one action id per question, since Slack wants them unique in a view); each text goes through
`escape.shownAsWritten`, which escapes `&`, `<`, `>` and backticks (so `*` and `_` still format),
and a section is cut to 3,000 characters before the escape, never inside one. `Edit` opens that
question's page with its answers as stored, through `views.update` on the click's view id and
`hash` (`Requests.onQuestionEdit`); the review page has no field, so nothing is absorbed or
validated. The draft records that the review was reached (`Draft.reviewed`): from then on, and on
a page opened by `Edit`, the footer reads `Review` and Next goes back to the review page when
every question has an answer, else to the first one without. `Submit answers` alone sends. The
modal's close button reads `Close` on every page. No question page has a button in its body (the review page has `Edit`). One question
has none of this and its `Submit` sends.
What was filled is kept by the Slack provider in memory (`Requests.drafts`, `requests.Draft`), by
request id, with the page on screen; the
view's `private_metadata` holds only the request's id, channel and thread, the form's generation
and the page it shows (`requests.FormIds`), so Other and Notes take 300 characters each
(`TYPED_LIMIT`, `NOTES_LIMIT`) with no Slack cap to fit. Only the newest form of a request is
valid: every Answer opens a new generation (Close then Answer, a second click, a second device),
and the older forms are stale (a form whose `views.open` fails does not count: the older one
stays valid). A stale form's changes and its Edit are ignored, and its Next or Submit answers
`response_action: errors` with `texts.QUESTION_STALE` on the question's block (on the review page,
which has no field, the form is replaced by that sentence) and sends nothing; a change from a page Next has already left, or an Edit from a page that is not the review, is ignored too. Every field of the valid form
reports each change (an option picked, a box ticked, a character typed under Other or in Notes:
`dispatch_action`), and the draft is updated from it. Only a change of the choice redraws the
form with `views.update` (Other's field and Notes come and go with it); typing never does. A
block keeps its `block_id` (`q0`, `o0`, `n0`) while it stays on screen, so Slack keeps what is
typed in it. An entry goes when its request is answered, skipped or found gone, at
the next Answer for a request that ended another way, and when the app closes. Answer after Close
reopens the form on the page left, with the pages already submitted and what each field of the
open page held at its last change.

A text kept in the draft is sent only while
Other is chosen, and the Review page shows it as the answer. With nothing chosen Next and Submit
show `Choose an option or type your own answer.` under the question; Other chosen with only
spaces is a field error on the Other block. Next and Submit also compare the input blocks the
payload's `view.blocks` lists (what is on screen) with the ones the draft draws, and answer
`response_action: update` with the form drawn again, sending nothing, in two cases only: Other is
chosen on the page and its field `o{page}` is not on screen (Slack's required check could not run
on it), or the draft holds a note for the page, the form draws its field `n{page}` and it is not on
screen. Any other difference sends what the draft holds, so a Next clicked before the redraw that
adds Notes lands passes at once, and a field left on screen that the choice no longer needs (Other
unticked, the redraw refused) is read but its text is not used while its choice is not. The
reference for `view.state.values` does not say whether an empty input is listed (read 2026-10-16),
so the state is not used for this. A note kept in the
draft is not sent without an answer, and the Review page does not show it either. 

The modal carries no channel or thread: each click in it is checked against the
owner, the workspace, and the channel and thread its request was posted in (`requests.FormIds` in its
`private_metadata`; the draft is never in it). 

## The setup message

A session's setup (see "Messages, the same-folder hold and the setup" in [architecture.md](architecture.md#messages-the-same-folder-hold-and-the-setup)) is drawn as one message in the thread (`setup.setupBlocks`): a
header (`texts.SETUP_HEADER`) and one `actions` block (block_id `setup`, one row that Slack wraps
on a narrow screen) holding the controls the request offers. A Model select lists the
CLI's own models (the models of `AgentSession.info`, kept as `ThreadSession.models` and stored
with the pending setup, so a click reads its choice against the list the message was built from),
each option showing the model's `displayName` and, under it, the CLI's own `description` (cut to
Slack's 75 characters, left out when the entry has none); the select is left out when the agent
lists no model. An Effort select offers `Effort: default` (which passes nothing) and
`Effort: <level>` for the chosen model's `supportedEffortLevels`, or for the agent's own
`effortLevels` when it lists no model (left out when the agent has none either). A Bypass
checkbox is shown only when the request offers a bypass mode, and is ticked when the folder's own Claude Code settings start the process in
bypassPermissions, so unticking is an explicit off, with `!bypass off`'s semantics. Start carries the setup id. `state.values` is keyed
by that block_id, then by each control's action_id (`setup.readSelection`). Changing the model
rewrites the message (`chat.update`, which never notifies, and is skipped once the setup is
decided) with the new model's levels, drawn from what the request said (`SlackChat.drawnSetup`,
kept for the last 64 setups posted). 

## The root's reaction

The Slack provider keeps one `StatusReaction` (in `status`) on the thread's own root message, which `thread_ts` always is: a top-level owner message, or the owner's own `!resume` message. The reaction is the thread's status as the core asks it (`ThreadChat.showStatus`).

A change of the reaction is
two calls, `reactions.add` then `reactions.remove`, and a session reads idle before the second has
returned: a close of an idle session (the idle close, a restart's drain) aborts the reader's wait
there, and the call in flight still runs to its end. A `StatusReaction` whose change was aborted
reads as a fresh instance, so its next change strips every other name, and `ThreadSession.close`
calls `ThreadChat.settleStatus` (`StatusReaction.settle`), which makes the change asked for last
and makes no call when the root already shows it. A session rebuilt on the same root (a restart, a
resumed thread) starts a fresh `StatusReaction`, whose first successful `show` strips every other
reaction name already on the root, so an earlier session's leftover `✅` or `❌` never sits next to
the new one. A `missing_scope` failure (the workspace has not reinstalled the app for
`reactions:write`) is logged once for the whole process; every `StatusReaction` instance stops
calling Slack for reactions for the rest of the run. 

## The status line

The provider keeps the activity line as one `ThreadStatus` (in `status`): Slack's status line under the thread's last message (`assistant.threads.setStatus`), in Slack's words (`activityWords`). `ThreadStatus.show` never waits on Slack: one task per
instance makes the calls in order, so two quick changes end on the last one and a turn that ends
at once sets nothing. The line is sent as the one loading message, which is what a client shows,
with a `status` that says the same after the app's name (`is working…`,
`is compacting the conversation…`) for a client that draws that instead (with `status` alone, iOS showed
nothing: measured: "Thread status on iOS"). Slack removes a status two minutes after it was set
and clears it when the app replies (documented: "Status removal after two minutes"), so it is set
again every `status.THREAD_STATUS_REFRESH_SECONDS` and within
`status.THREAD_STATUS_AFTER_WRITE_SECONDS` of a write (`ThreadStatus.wrote`, which `SlackThread`
calls after every pass of a reply that made a Slack call and after every notice it posts), at most
one call per that interval. An answer to a word typed in the thread reaches the status through `ThreadChat.written`, which `SlackThread` calls after every notice it posts; `ThreadChat.close` clears the status. A clearing call that fails is tried once more, and again at the close. A
refusal is logged once per error code in a row and swallowed; one that says the token cannot call
the method (`status.THREAD_STATUS_REFUSED`) stops every `ThreadStatus` from calling Slack for the
rest of the run. Nothing about it is stored, and a crash leaves at most a status Slack removes by
itself.

## Repairing a reply

The Slack provider's `endReply` (`src/chat/slack/repair.ts`) stops the message's stream, reads the
message back by its own ts and edits it: every card left running closed as an error, the list of
what still runs taken off, and the stopped line appended (within Slack's 50 blocks). The stream's
own stop is the one notification the reply owes; the edit notifies nobody and nothing is posted.
A message that cannot be read back, or is gone, is left as it is. Its `withdraw` deletes the
message, and `showStatus` goes through the same `StatusReaction` a live session uses. Each of the
three answers false when Slack did not do it and the message is still there; `channel_not_found`,
`message_not_found` or `thread_not_found` (`errors.GONE`) says the message is gone, which counts
as done. The Slack calls, the cap and the cases that leave a message untouched are in the doc
comment of `endReply`.

## Answering the cleanup

The core's cleanup of `state.json` ("Cleaning `state.json`" in [architecture.md](architecture.md#cleaning-statejson)) asks the provider whether a channel and a thread are still there (`ChatProvider.channelState`, `ChatProvider.threadState`).

- The lookup for channels is `channels.channelLookup`: `gone` is `channel_not_found` from
`conversations.info`, and any other failure is no answer and removes nothing. A private channel the bot was removed from gives the
same answer as a deleted one, so it is forgotten too. 

- The lookup for threads is `channels.threadLookup`: `gone` is `thread_not_found`
from `conversations.replies` on the root with `limit=1`, or a root returned as a tombstone
(`subtype` `tombstone`, which is what a root deleted while replies remain becomes), and any other
failure is no answer.

## Measured platform behaviour

What this page states about Slack that no reference documents or that a reference leaves open, with how and when each was observed. The prose points to a row as `measured: "Name"`; the rows about the SDK and Claude Code are in [architecture.md](architecture.md#measured-platform-behaviour). "Not recorded" marks a date, version or method that was not written down when the observation was made. A documentation read has no version. A row names the package it was observed through (`slack-sdk` of the Python library the daemon no longer uses, `slack-bolt`); the behaviour is Slack's own. The last row is a documentation read, not an observation.

| Name | Observed | Method | Date | Version |
|---|---|---|---|---|
| File share event has no team | A `file_share` message event carries no `team` field | not recorded | 2026-09-25 | slack-bolt 1.30.0 |
| Thread broadcast event has no team | A reply sent with **Also send to #channel** arrives as a `message` event of subtype `thread_broadcast` with `thread_ts`, a `root` copy of the thread's first message and no `team` or `parent_user_id`; its envelope has `team_id` and `is_ext_shared_channel`; a hidden `message_changed` wrapping the same reply follows | A reply recorded in Socket Mode, daemon stopped | 2026-10-09 | slack-bolt 1.30.0 |
| Download without files:read | Slack answers 302 to a file download when the app lacks `files:read` | not recorded | 2026-09-25 | not recorded |
| Card text is appended | Slack appends the `details` and the `output` of a `task_update` to what the card already holds | not recorded | 2026-10-01 | slack-sdk 3.44.1 |
| Stream lifetime | `chat.appendStream` is refused 300.3 seconds after `chat.startStream` | not recorded | 2026-09-28 | slack-sdk 3.44.1 |
| Update after stop is silent | A stream stopped at 4 minutes 51 seconds, then ten `chat.update` calls on its message: no notification | not recorded | 2026-09-29 | not recorded |
| Stream text under a later message on iOS | On Slack for iOS, the text of a reply that is a stream still open disappears once the app posts a message below it, and shows again when the stream stops. Same with the thread status line set before, during or cleared before the post; the text stays only with no status line, or when `chat.stopStream` runs on the reply before the post. `conversations.replies` held the full text throughout (`streaming_state` `in_progress`) | A probe on a dev app, the owner watching the thread live on iOS; one run per condition | 2026-10-25 | Slack for iOS, version not recorded |
| Message limits | A message holds 12,000 characters and 50 blocks or task cards | not recorded | 2026-09-28 | slack-sdk 3.44.1 |
| Block cap after a stream stops | A post and an update are held to 50 items; a stream is not, but the update after its stop is | not recorded | 2026-10-08 | slack-sdk 3.45.0 |
| Container text on update | A stream and a post count the text of a collapsed container toward the 12,000 characters; `chat.update` does not (50 containers of 10,000 characters accepted, nothing refused) | not recorded | 2026-10-06 | slack-sdk 3.44.1 |
| Card text cap | The text of a message's cards counts toward the cap of a streamed message by a formula Slack does not document | private test channel | 2026-10-01 | slack-sdk 3.44.1 |
| Open card stored as error | A card left `in_progress` in a stopped message is stored as an error until it is updated | not recorded | 2026-09-28 | slack-sdk 3.44.1 |
| Push on stream stop | A stream in a thread the owner started notifies once, when it stops, with its first text as the banner, and never when it starts | iPhone locked, Slack open in a browser, channel on Just mentions | 2026-09-29 | not recorded |
| Open stream cannot be deleted | A stream cannot be deleted while it is open | not recorded | 2026-09-28 | slack-sdk 3.44.1 |
| Stream needs a thread | `chat.startStream` answers `invalid_thread_ts` without `thread_ts` | not recorded | 2026-09-23 | not recorded |
| Thread status on iOS | A thread status sent as `status` alone showed nothing on iOS; the loading message shows | Slack iOS and desktop, free plan, an app holding `assistant:write` | 2026-10-02 | slack-sdk 3.44.1 |
| Permalink opens on the reply | Slack opens a thread on the reply that a permalink names | Mac app and iOS | 2026-10-05 | not recorded |
| Clip transcript | A clip is a message with no text and one file of subtype `slack_audio` (`audio/mp4`, `media_display_type` `audio`); the same recording uploaded as a file has no subtype and gets a transcript too. No event follows its posting. After **Generate transcript**, `file_change` arrived four times in 15 seconds and `files.info` then gave `transcription` with `status` `complete`, a `locale` and `preview` (`content`, `has_more` false up to 67 characters); `vtt` on `files.slack.com` returned the transcript as WebVTT to the bot token. Slack chose the locale: `it-IT` once and `en-GB` twice for clips spoken in Italian, the two with wrong words. Not seen: a status other than `complete`, `has_more` true, the body of the `file_change` event (the log names it only) | Three clips from the iOS app, Slack free plan, a workspace set to English | 2026-10-09 | slack-sdk 3.45.0 |
| Thread status with desktop open | The iOS app can show no thread status for a thread that Slack on desktop already has open; with desktop closed, or with the thread opened on iOS first, it shows on both | Five runs read by eye, one per condition; the reference of `assistant.threads.setStatus` does not describe it | 2026-10-04 | slack-sdk 3.44.1 |
| Status removal after two minutes | Slack removes a thread status two minutes after it was set and clears it when the app replies | `assistant.threads.setStatus` reference, read | 2026-10-02 | none, a documentation read |

## Setting up an instance

`slackChat` gives `ChatEntry.setup`, built by `onboarding.slackSetup` (`src/chat/slack/onboarding.ts`):
what `allaboard setup` asks for Slack. Its intro prints the link that opens Slack's form for a new
app with the package's manifest filled in (`onboarding.creationLink`, the `manifest_json` form of
Slack's manifest guide, read 2026-10-18); for a named instance `onboarding.manifestOf` names the app
and its bot `allaboard-<name>`, the app's name cut to `onboarding.APP_NAME_LIMIT` characters.

Each token is checked as it is pasted: its prefix first (`tokens.wrongKind`, the rule the start's
own check uses), then one call that needs no scope, through a client that sends it once and logs
nothing. The bot and the user token go to `auth.test`, the app-level token to
`apps.connections.open`, which only returns a WebSocket URL; nothing connects to it. Slack's
refusal code becomes a sentence and the question is asked again. The user token must belong to the
bot's workspace, and its `user_id` becomes `SLACK_OWNER_USER_ID`, so the member ID is asked only
when the user token is skipped, with a check of its form alone.
