import assert from "node:assert/strict";
import { test } from "node:test";
import { Translator } from "../../src/agent/claude/translate.ts";
import type { QuestionRequest, SessionEvent } from "../../src/agent/seam.ts";

// The shapes below are those measured on Claude Code 2.1.304 with SDK 0.3.304 (2026-10-21,
// `actions/scripts/2026-10-21-measure-420-*.ts`); the content is synthetic.
const scenes = () => import("../../probe/scenes.ts");

const INIT = { type: "system", subtype: "init", apiKeySource: "none", permissionMode: "default" };
const LOGGED_OUT = {
  type: "assistant",
  error: "authentication_failed",
  message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in" }] },
  parent_tool_use_id: null,
  is_api_error_message: true,
};
const ERROR_RESULT = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: "Not logged in",
  terminal_reason: "api_error",
  num_turns: 1,
  modelUsage: {},
};

test("the mode of a settings file is judged against a session that names none", async () => {
  const { judgeSettingsMode } = await scenes();
  assert.deepEqual(judgeSettingsMode("default", "acceptEdits"), {
    caused: true,
    holds: true,
    detail: "",
    seen: {},
  });
  const other = judgeSettingsMode("default", "default");
  assert.equal(other.caused, true);
  assert.equal(other.holds, false);
  assert.match(other.detail, /default/);
  // The control reports another mode: the mode did not come from the file alone.
  assert.equal(judgeSettingsMode("plan", "acceptEdits").caused, false);
  assert.equal(judgeSettingsMode(undefined, undefined).caused, false);
});

test("a logged-out turn is read as an authentication failure by the back end", async () => {
  const { judgeLoggedOut } = await scenes();
  const seen = judgeLoggedOut([INIT, LOGGED_OUT, ERROR_RESULT]);
  assert.equal(seen.caused, true);
  assert.equal(seen.holds, true);
  // The error record without its category: the daemon would not show the login instructions.
  const { error: _error, ...plain } = LOGGED_OUT;
  const lost = judgeLoggedOut([INIT, plain, ERROR_RESULT]);
  assert.equal(lost.caused, true);
  assert.equal(lost.holds, false);
  // Another category does not read as a failed login.
  const other = judgeLoggedOut([INIT, { ...LOGGED_OUT, error: "model_not_found" }, ERROR_RESULT]);
  assert.equal(other.holds, false);
  assert.match(other.detail, /model_not_found/);
  // A turn that did not fail: a login reached the session, nothing was learned.
  const fine = judgeLoggedOut([INIT, { type: "result", subtype: "success", is_error: false }]);
  assert.equal(fine.caused, false);
  assert.equal(judgeLoggedOut([]).caused, false);
});

const REFUSED: SessionEvent[] = [
  {
    type: "agent_error",
    kind: "other",
    category: "model_not_found",
    text: "There is an issue with the selected model",
    parentCallId: null,
  },
  {
    type: "turn_ended",
    sessionId: "s",
    startedBy: "owner",
    finalText: "",
    ending: "error",
    steps: 1,
    tokens: {},
  } as SessionEvent,
];

test("an API error is judged on the agent error and the turn's ending", async () => {
  const { judgeApiError } = await scenes();
  const seen = judgeApiError(REFUSED);
  assert.deepEqual(seen, {
    caused: true,
    holds: true,
    detail: "",
    seen: { category: "model_not_found" },
  });
  // An error result with no text of its own to show: the daemon has nothing to give the owner.
  const empty = judgeApiError([
    { ...(REFUSED[0] as object), text: "" } as SessionEvent,
    REFUSED[1] as SessionEvent,
  ]);
  assert.equal(empty.caused, true);
  assert.equal(empty.holds, false);
  // The turn ended well: the API took the model, nothing was learned.
  const fine = judgeApiError([{ ...(REFUSED[1] as object), ending: "done" } as SessionEvent]);
  assert.equal(fine.caused, false);
});

const ASKED: QuestionRequest = {
  type: "question",
  callId: "toolu_1",
  toolName: "AskUserQuestion",
  title: null,
  questions: [
    {
      header: "Colour",
      text: "Which colour?",
      multiSelect: false,
      options: [
        { label: "Teal", description: "", preview: null },
        { label: "Amber", description: "", preview: null },
      ],
    },
  ],
};

function answered(output: string | null, isError = false): SessionEvent[] {
  return [
    {
      type: "call_ended",
      callId: "toolu_1",
      isError,
      output,
      fileChange: null,
      model: null,
      parentCallId: null,
    },
  ];
}

test("a question is judged on its options and on the answer the call returns", async () => {
  const { judgeQuestion } = await scenes();
  const sentence =
    'Your questions have been answered: "Which colour?"="Teal". You can now continue.';
  assert.equal(judgeQuestion([ASKED], answered(sentence)).holds, true);
  // The answer given is not in the result: updatedInput did not reach the call.
  const lost = judgeQuestion([ASKED], answered("Your questions have been answered."));
  assert.equal(lost.caused, true);
  assert.equal(lost.holds, false);
  assert.equal(judgeQuestion([ASKED], answered(sentence, true)).holds, false);
  // One option only: the form would not offer a choice.
  const [only] = ASKED.questions;
  const single = {
    ...ASKED,
    questions: [{ ...only, options: only?.options.slice(0, 1) }],
  } as QuestionRequest;
  assert.equal(judgeQuestion([single], answered(sentence)).holds, false);
  // Claude never asked, or the call never ended: nothing was learned.
  assert.equal(judgeQuestion([], []).caused, false);
  assert.equal(judgeQuestion([ASKED], []).caused, false);
});

function sent(to: string, output: string): SessionEvent[] {
  return [
    {
      type: "task_started",
      taskId: "a886070fe4225f0c4",
      kind: "subagent",
      taskType: "local_agent",
      description: "d",
      callId: "toolu_0",
      agentType: null,
      background: true,
      parentTaskId: null,
    },
    {
      type: "task_ended",
      taskId: "a886070fe4225f0c4",
      status: "completed",
      summary: "READY",
      durationMs: 900,
      callId: "toolu_0",
      report: null,
      reportSent: false,
      foldNamed: true,
    },
    {
      type: "call_started",
      callId: "toolu_2",
      toolName: "SendMessage",
      input: { to, message: "again", type: "message" },
      parentCallId: null,
    },
    {
      type: "call_ended",
      callId: "toolu_2",
      isError: false,
      output,
      fileChange: null,
      model: null,
      parentCallId: null,
    },
  ];
}

test("a message to an ended subagent is judged on the line its result carries", async () => {
  const { judgeResumed } = await scenes();
  const result =
    '{"success":true,"message":"Resuming agent a886070","resumedAgentId":"a886070fe4225f0c4"}';
  assert.equal(judgeResumed(sent("a886070fe4225f0c4", result)).holds, true);
  // The result no longer says the agent resumes.
  const quiet = judgeResumed(sent("a886070fe4225f0c4", '{"success":true}'));
  assert.equal(quiet.caused, true);
  assert.equal(quiet.holds, false);
  // The message went to an agent that was never seen ending: no ended subagent was messaged.
  assert.equal(judgeResumed(sent("someone-else", result)).caused, false);
  assert.equal(judgeResumed([]).caused, false);
});

test("a guard flipped makes the judge answer otherwise", async () => {
  const { judgeApiError, judgeLoggedOut, judgeQuestion, judgeResumed } = await scenes();
  // judgeApiError: an agent error beside a turn that did not end in error does not hold ...
  const ended = (ending: string) =>
    ({
      type: "turn_ended",
      sessionId: "s",
      startedBy: "owner",
      finalText: "",
      ending,
      steps: 1,
      tokens: {},
    }) as SessionEvent;
  const failure = REFUSED[0] as SessionEvent;
  const soft = judgeApiError([failure, ended("done")]);
  assert.equal(soft.caused, true);
  assert.equal(soft.holds, false);
  // ... and an error ending with no agent error to show does not hold either.
  const bare = judgeApiError([ended("error")]);
  assert.equal(bare.caused, true);
  assert.equal(bare.holds, false);
  // Nothing refused: not caused.
  assert.equal(judgeApiError([ended("done")]).caused, false);

  // judgeResumed: a subagent that ended after the message was sent is not an ended subagent.
  const result = '{"success":true,"message":"Resuming agent a886070"}';
  const [started, over, call, back] = sent("a886070fe4225f0c4", result) as SessionEvent[];
  assert.equal(judgeResumed([started, call, back, over] as SessionEvent[]).caused, false);
  // The agent ends again after it resumed: its first end is the one that precedes the message.
  const again = { ...(over as object) } as SessionEvent;
  assert.equal(judgeResumed([started, over, call, back, again] as SessionEvent[]).holds, true);
  // A call that failed does not hold, whatever it says.
  const failed = { ...(back as object), isError: true } as SessionEvent;
  const errored = judgeResumed([started, over, call, failed] as SessionEvent[]);
  assert.equal(errored.caused, true);
  assert.equal(errored.holds, false);

  // judgeQuestion: an empty first label never counts as an answer given, even when quoted.
  const [only] = ASKED.questions;
  const blank = {
    ...ASKED,
    questions: [
      {
        ...only,
        options: [{ label: "", description: "", preview: null }, ...(only?.options ?? [])],
      },
    ],
  } as QuestionRequest;
  // The same with the empty label last: every option needs one.
  const tail = {
    ...ASKED,
    questions: [
      {
        ...only,
        options: [
          ...(only?.options.slice(0, 1) ?? []),
          { label: "", description: "", preview: null },
        ],
      },
    ],
  } as QuestionRequest;
  assert.equal(judgeQuestion([tail], answered('"Which colour?"="Teal"')).holds, false);
  const quoted = 'Your questions have been answered: "Which colour?"="". Go on.';
  assert.equal(judgeQuestion([blank], answered(quoted)).holds, false);
  // The answer must be the pair as the tool words it, not any mention of the label.
  const loose = judgeQuestion([ASKED], answered('You may like Teal or Amber, said "Teal".'));
  assert.equal(loose.caused, true);
  assert.equal(loose.holds, false);

  // judgeLoggedOut: an authentication error with no text has nothing to show the owner.
  const silent = { ...LOGGED_OUT, message: { model: "<synthetic>", content: [] } };
  const empty = judgeLoggedOut([INIT, silent, ERROR_RESULT]);
  assert.equal(empty.caused, true);
  assert.equal(empty.holds, false);
});

test("a folder's trust is judged on the notice the untrusted folder draws", async () => {
  const { judgeTrust } = await scenes();
  const notice = [
    "Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once.\n",
  ];
  assert.deepEqual(judgeTrust([], notice), { caused: true, holds: true, detail: "", seen: {} });
  // The trusted folder draws it too: the record is not honoured.
  const same = judgeTrust(notice, notice);
  assert.equal(same.caused, true);
  assert.equal(same.holds, false);
  // The control: the untrusted folder says nothing, so the notice proves nothing.
  assert.equal(judgeTrust([], []).caused, false);
  assert.equal(judgeTrust(notice, []).caused, false);
});

test("a shell card needs the command line its call's input carries", async () => {
  const { judgeShellCard } = await scenes();
  const call = (input: Record<string, unknown>): SessionEvent => ({
    type: "call_started",
    callId: "toolu_1",
    toolName: "Bash",
    input,
    parentCallId: null,
  });
  const run = call({ command: "echo ok > probe-ran.txt", description: "x" }) as Extract<
    SessionEvent,
    { type: "call_started" }
  >;
  assert.equal(judgeShellCard(true, run, true, "").holds, true);
  const bare = call({ description: "x" }) as typeof run;
  const missing = judgeShellCard(true, bare, true, "");
  assert.equal(missing.caused, true);
  assert.equal(missing.holds, false);
  assert.equal(judgeShellCard(true, run, false, "").holds, false);
  assert.equal(judgeShellCard(false, undefined, false, "none").caused, false);
});

// The records of a background subagent that starts a background command, in the shapes recorded
// on 2026-10-24 (2.1.309; `subagent-handback` for the note and the report apart, the child's
// start as `test/agent/claude/sessions/sessions.test.ts` has it); the content is synthetic.
const NOTE =
  'This agent\'s report was delivered to you as a message from "a1" (its SubagentHandback call). Read it there; it is not repeated here.\n';
const agentStart = {
  type: "system",
  subtype: "task_started",
  task_id: "a1",
  tool_use_id: "toolu_agent",
  description: "Start a sleep",
  subagent_type: "general-purpose",
  is_backgrounded: true,
  task_type: "local_agent",
};
const childStart = {
  type: "system",
  subtype: "task_started",
  task_id: "b1",
  tool_use_id: "toolu_child",
  description: "Sleep 20",
  task_type: "local_bash",
  is_backgrounded: true,
  parent_task_id: "a1",
  owned_by_subagent: true,
};
const notification = (taskId: string, toolUseId: string, over: object) => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  tool_use_id: toolUseId,
  status: "completed",
  output_file: "/tmp/x.output",
  ...over,
});
const agentNote = (words: string) =>
  notification("a1", "toolu_agent", {
    summary: NOTE,
    handback: "send",
    handback_report: { text: words },
  });
const childEnd = notification("b1", "toolu_child", {
  summary: 'Background command "Sleep 20" completed (exit code 0)',
});

function played(raw: object[]): SessionEvent[] {
  const translator = new Translator();
  return raw.flatMap((record) => translator.translate(record));
}

test("a subagent still running its command at the first notification is waiting, then done", async () => {
  const { handbackFacts, judgeHandback } = await scenes();
  const auto = [agentStart, childStart, agentNote("started"), childEnd, agentNote("slept")];
  const facts = handbackFacts(played(auto), auto);
  assert.deepEqual(facts.notifications, [
    { form: "note", handback: "send", reportText: true, running: 1 },
    { form: "note", handback: "send", reportText: true, running: 0 },
  ]);
  assert.equal(facts.started, 1);
  assert.equal(facts.settled, true);

  const bypass = [
    agentStart,
    childStart,
    notification("a1", "toolu_agent", { summary: "It started and ended." }),
  ];
  const plain = handbackFacts(played(bypass), bypass);
  assert.deepEqual(plain.notifications, [
    { form: "words", handback: null, reportText: false, running: 1 },
  ]);

  assert.equal(plain.lastReport, true);
  assert.equal(plain.sent, false);
  assert.equal(facts.sent, true);

  const done = judgeHandback({ bypass: plain, auto: facts });
  assert.equal(done.caused, true);
  assert.equal(done.holds, true);
  assert.deepEqual(Object.keys(done.seen), ["bypass", "auto"]);
  // The facts hold no summary text and no id.
  assert.ok(!JSON.stringify(done.seen).includes("a1"));
  assert.ok(!JSON.stringify(done.seen).includes("slept"));
});

test("a subagent that started no background task is not a caused hand-back", async () => {
  const { handbackFacts, judgeHandback } = await scenes();
  const none = [agentStart, agentNote("started")];
  const facts = handbackFacts(played(none), none);
  assert.equal(facts.started, 0);
  const judged = judgeHandback({ bypass: facts, auto: facts });
  assert.equal(judged.caused, false);
  assert.match(judged.detail, /started no background task/);
  assert.equal(handbackFacts([], []).notifications.length, 0);
});

test("an auto mode end with no hand-back does not hold", async () => {
  const { handbackFacts, judgeHandback } = await scenes();
  // The summary is the agent's words and no report apart: the back end reads a report, but it
  // is not a sent one.
  const bare = [
    agentStart,
    childStart,
    notification("a1", "toolu_agent", { summary: "It started." }),
    childEnd,
    notification("a1", "toolu_agent", { summary: "It slept." }),
  ];
  const facts = handbackFacts(played(bare), bare);
  const judged = judgeHandback({ bypass: facts, auto: facts });
  assert.equal(judged.caused, true);
  assert.equal(judged.holds, false);
  assert.match(judged.detail, /auto/);
  // A last end with no words at all fails in the mode it happens in.
  const empty = [agentStart, childStart, notification("a1", "toolu_agent", { summary: "" })];
  const emptyFacts = handbackFacts(played(empty), empty);
  const silent = judgeHandback({ bypass: emptyFacts, auto: facts });
  assert.equal(silent.holds, false);
  assert.match(silent.detail, /bypass/);
});

test("a subagent first notified after its own task ended shows no wait: not caused", async () => {
  const { handbackFacts, judgeHandback } = await scenes();
  const late = [
    agentStart,
    childStart,
    childEnd,
    notification("a1", "toolu_agent", { summary: "It started and ended." }),
  ];
  const facts = handbackFacts(played(late), late);
  assert.deepEqual(
    facts.notifications.map((notice) => notice.running),
    [0],
  );
  const judged = judgeHandback({ bypass: facts, auto: facts });
  assert.equal(judged.caused, false);
  assert.match(judged.detail, /had ended at every notification/);
});
