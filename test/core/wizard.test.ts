/**
 * `allaboard setup` as the core runs it: a fake prompter answers, a fake chat asks, and the
 * configuration folder is a temporary home.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "node:test";
import { parseEnv } from "node:util";
import { REQUIRED, SELECTORS } from "../../src/core/config.ts";
import { DEFAULT_INSTANCE } from "../../src/core/instance.ts";
import {
  answerWizard,
  CORE_VARIABLES,
  envText,
  INTERRUPTED,
  type SetupModules,
  type WizardHost,
} from "../../src/core/wizard.ts";
import type { Check, ModuleSetup, SetupQuestion } from "../../src/module-setup.ts";

/** A path under the home as the wizard shows it: `~`, then the system's separator. */
const onScreen = (...parts: string[]): string => join("~", ...parts);

const DEV = { name: "dev" };

function question(
  variable: string,
  check: (answer: string) => Check,
  more: Partial<SetupQuestion> = {},
) {
  return {
    variable,
    message: `Ask ${variable}:`,
    secret: false,
    optional: false,
    check: async (answer: string) => check(answer),
    ...more,
  } satisfies SetupQuestion;
}

const accept = (): Check => ({});

const DEFAULTS = { agent: "alpha", chat: "beta" };
const SELECTED = { ALLABOARD_AGENT: "alpha", ALLABOARD_CHAT: "beta" };

/** The modules of a setup: a chat that asks `questions`, and an agent that asks `agentQuestions`. */
function chatOf(
  questions: readonly SetupQuestion[],
  agentQuestions: readonly SetupQuestion[] | null = null,
): SetupModules {
  const agent: ModuleSetup | null =
    agentQuestions === null ? null : { intro: [], questions: agentQuestions };
  return {
    chats: { beta: { setup: () => ({ intro: ["1. Do this first."], questions }) } },
    agents: { alpha: agent === null ? {} : { setup: () => agent } },
    defaults: DEFAULTS,
  };
}

function setupOf(root: string) {
  const home = mkdtempSync(join(tmpdir(), "allaboard-wizard-"));
  const output = {
    stdout: "",
    stderr: "",
    out: (t: string) => {
      output.stdout += t;
    },
    err: (t: string) => {
      output.stderr += t;
    },
  };
  const asked: { message: string; secret: boolean }[] = [];
  return { home, output, asked, root };
}

/** A list the prompter showed: the question, the names in order and the one preselected. */
interface Listed {
  message: string;
  names: string[];
  preselected: string;
}

/** A host whose prompter types `answers` in order; a `null` is Ctrl-C. */
function hostOf(
  home: string,
  answers: (string | null)[],
  asked: { message: string; secret: boolean }[],
  options: Partial<WizardHost> = {},
  chosen: { picks?: (string | null)[]; listed?: Listed[] } = {},
): WizardHost {
  const queue = [...answers];
  const picks = [...(chosen.picks ?? [])];
  const listed = chosen.listed ?? [];
  return {
    home,
    interactive: true,
    prompter: {
      ask: async (message, secret) => {
        asked.push({ message, secret });
        if (queue.length === 0) assert.fail(`asked more than answered: ${message}`);
        return queue.shift() as string | null;
      },
      // The service's Yes or No is read from the same queue: "" and "y" pick Yes, anything else No.
      // The chat and the agent are picked from `options.picks`, the preselected one when it runs out.
      choose: async (message, names, preselected) => {
        if (names.join() === "Yes,No") {
          asked.push({ message, secret: false });
          if (queue.length === 0) assert.fail(`asked more than answered: ${message}`);
          const typed = queue.shift() as string | null;
          return typed === null ? null : /^(y(es)?)?$/i.test(typed) ? "Yes" : "No";
        }
        listed.push({ message, names: [...names], preselected });
        return picks.length === 0 ? preselected : (picks.shift() as string | null);
      },
    },
    installService: null,
    ...options,
  };
}

const envOf = (home: string, folder = ".config/allaboard") => join(home, folder, ".env");

test("the happy path writes the file, readable by its owner alone, and shows the path with ~", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const chat = chatOf([
    question("A_TOKEN", () => ({ note: "fine" }), { secret: true }),
    question("B_NAME", accept),
  ]);
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chat,
    output,
    hostOf(home, ["a1", "b one", projects], asked),
  );
  assert.equal(code, 0, output.stderr);
  const file = envOf(home);
  assert.deepEqual(
    { ...parseEnv(readFileSync(file, "utf8")) },
    {
      ...SELECTED,
      A_TOKEN: "a1",
      B_NAME: "b one",
      ALLOWED_ROOT: projects,
    },
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, ".config/allaboard")).mode & 0o777, 0o700);
  }
  assert.deepEqual(
    readdirSync(join(home, ".config/allaboard")),
    [".env"],
    "no temporary file is left",
  );
  assert.deepEqual(
    asked.map((a) => a.secret),
    [true, false, false],
  );
  assert.ok(
    output.stdout.includes(`allaboard setup: writes ${onScreen(".config", "allaboard", ".env")}`),
  );
  assert.match(output.stdout, /1\. Do this first\./);
  assert.match(output.stdout, /^\? Ask A_TOKEN: \*{8} {3}✔ fine$/m);
  // Windows ignores the file mode, so the wizard makes no claim about who may read the file there.
  const readable = process.platform === "win32" ? "" : " (readable by you only)";
  assert.ok(
    output.stdout.includes(`Wrote ${onScreen(".config", "allaboard", ".env")}${readable}.`),
  );
  assert.ok(!output.stdout.includes(home), "the home is written as ~");
});

test("the file's variables are listed before the file is written", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const file = envOf(home);
  let existedAtSummary: boolean | null = null;
  const watching = {
    out: (text: string) => {
      output.out(text);
      if (text.startsWith("\nThe file holds:")) existedAtSummary = existsSync(file);
    },
    err: output.err,
  };
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chatOf([question("B_NAME", accept)]),
    watching,
    hostOf(home, ["b one", projects], asked),
  );
  assert.equal(code, 0, output.stderr);
  assert.equal(
    existedAtSummary,
    false,
    "the summary was printed after the file existed, or not at all",
  );
  assert.ok(existsSync(file));
  assert.ok(
    output.stdout.indexOf("The file holds:") < output.stdout.indexOf("Wrote "),
    "the summary comes before the Wrote line",
  );
});

test("--instance writes that instance's folder", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const code = await answerWizard(
    DEV,
    chatOf([question("A", accept)]),
    output,
    hostOf(home, ["x", projects], asked),
  );
  assert.equal(code, 0);
  assert.ok(existsSync(envOf(home, ".config/allaboard-dev")));
  assert.ok(!existsSync(envOf(home)));
  assert.ok(output.stdout.includes(onScreen(".config", "allaboard-dev", ".env")));
  assert.match(output.stdout, /allaboard --instance dev/);
});

test("an .env that exists is refused before anything is asked, and left as it is", async () => {
  const { home, output, asked } = setupOf("");
  mkdirSync(join(home, ".config/allaboard"), { recursive: true });
  writeFileSync(envOf(home), "KEEP=me\n");
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chatOf([question("A", accept)]),
    output,
    hostOf(home, [], asked),
  );
  assert.equal(code, 1);
  assert.deepEqual(asked, []);
  assert.equal(readFileSync(envOf(home), "utf8"), "KEEP=me\n");
  assert.ok(output.stderr.includes(`${onScreen(".config", "allaboard", ".env")} exists already`));
  assert.equal(output.stdout, "");
});

test("a refused answer is said and asked again", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const chat = chatOf([
    question("A", (answer): Check => (answer === "good" ? {} : { refusal: "Not that one." })),
  ]);
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chat,
    output,
    hostOf(home, ["bad", "", "good", projects], asked),
  );
  assert.equal(code, 0);
  assert.equal(asked.filter((a) => a.message === "Ask A:").length, 3);
  assert.match(output.stdout, /^\? Ask A: bad {3}✖ Not that one\.$/m);
  assert.match(output.stdout, /^\? Ask A: {3}✖ Nothing was typed; this one is needed\.$/m);
  assert.equal(parseEnv(readFileSync(envOf(home), "utf8")).A, "good");
});

test("each answer prints one line: a fixed mask for a secret, the text, skipped, and the refusal", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const chat = chatOf(
    [
      question("S", (a): Check => (a === "no" ? { refusal: "Nope." } : { note: "ok" }), {
        secret: true,
      }),
      question("N", accept, { optional: true }),
    ],
    [question("P", accept, { optional: true })],
  );
  const typedRoot = `${projects}`;
  await answerWizard(
    DEFAULT_INSTANCE,
    chat,
    output,
    hostOf(home, ["no", "a-long-secret-of-many-characters", "", typedRoot, ""], asked),
  );
  const lines = output.stdout.split("\n").filter((line) => line.startsWith("? "));
  assert.deepEqual(lines, [
    "? Chat (ALLABOARD_CHAT): beta   ✔",
    "? Agent (ALLABOARD_AGENT): alpha   ✔",
    "? Ask S: ********   ✖ Nope.",
    "? Ask S: ********   ✔ ok",
    "? Ask N: skipped",
    `? Folder your projects live under (ALLOWED_ROOT): ${typedRoot}   ✔`,
    "? Ask P: skipped",
  ]);
});

test("a value that cannot be written is refused when it is typed and asked again", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chatOf([question("A", accept)]),
    output,
    hostOf(home, [`a$${"{"}B}`, "fine", projects], asked),
  );
  assert.equal(code, 0);
  assert.equal(asked.filter((a) => a.message === "Ask A:").length, 2);
  assert.match(output.stdout, /^\? Ask A: a\$\{B\} {3}✖ A cannot be written to \.env/m);
  assert.equal(parseEnv(readFileSync(envOf(home), "utf8")).A, "fine");
});

test("a configuration folder that cannot be looked at is a refusal naming the code", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("modes are not enforced here");
    return;
  }
  const { home, output, asked } = setupOf("");
  const folder = join(home, ".config/allaboard");
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o000);
  try {
    const code = await answerWizard(
      DEFAULT_INSTANCE,
      chatOf([question("A", accept)]),
      output,
      hostOf(home, [], asked),
    );
    assert.equal(code, 1);
    assert.deepEqual(asked, []);
    assert.match(output.stderr, /cannot look at ~\/\.config\/allaboard\/\.env \(EACCES\)/);
  } finally {
    chmodSync(folder, 0o700);
  }
});

test("the allowed root follows the daemon's rule: a relative path and a missing folder are refused", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chatOf([]),
    output,
    hostOf(home, ["relative/dir", join(projects, "missing"), projects], asked),
  );
  assert.equal(code, 0);
  assert.match(output.stdout, /ALLOWED_ROOT must be an absolute path, or one starting with ~\//);
  assert.match(output.stdout, /ALLOWED_ROOT is not a directory/);
});

test("an optional question is skipped on an empty answer and its variable is not written", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const chat = chatOf([question("A", accept), question("OPT", accept, { optional: true })]);
  await answerWizard(DEFAULT_INSTANCE, chat, output, hostOf(home, ["a", "", projects], asked));
  assert.deepEqual(Object.keys(parseEnv(readFileSync(envOf(home), "utf8"))).sort(), [
    "A",
    "ALLABOARD_AGENT",
    "ALLABOARD_CHAT",
    "ALLOWED_ROOT",
  ]);
});

test("a variable a check sets is written and its question is not asked", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const chat = chatOf([
    question("USER", () => ({ set: { WHO: "U000ALICE" } }), {
      optional: true,
      sets: ["WHO"],
    }),
    question("WHO", accept),
  ]);
  await answerWizard(DEFAULT_INSTANCE, chat, output, hostOf(home, ["tok", projects], asked));
  assert.ok(!asked.some((a) => a.message === "Ask WHO:"));
  assert.equal(parseEnv(readFileSync(envOf(home), "utf8")).WHO, "U000ALICE");
});

test("without a terminal it refuses before asking anything", async () => {
  const { home, output, asked } = setupOf("");
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chatOf([question("A", accept)]),
    output,
    hostOf(home, [], asked, { interactive: false }),
  );
  assert.equal(code, 1);
  assert.match(output.stderr, /needs a terminal/);
  assert.deepEqual(asked, []);
  assert.ok(!existsSync(join(home, ".config")));
});

test("a chat that declares no setup is told so, and nothing is asked", async () => {
  const { home, output, asked } = setupOf("");
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    { chats: { beta: {} }, agents: { alpha: {} }, defaults: DEFAULTS },
    output,
    hostOf(home, [], asked),
  );
  assert.equal(code, 1);
  assert.match(output.stderr, /offers no setup/);
  assert.ok(!existsSync(envOf(home)));
});

/** Two chats and two agents; the second of each asks one question of its own. */
function twoOf(): SetupModules {
  const setupOf = (variable: string) => () => ({
    intro: [`Intro of ${variable}.`],
    questions: [question(variable, accept)],
  });
  return {
    chats: {
      beta: { setup: setupOf("BETA_Q") },
      gamma: { setup: setupOf("GAMMA_Q") },
    },
    agents: { alpha: { setup: setupOf("ALPHA_Q") }, delta: { setup: setupOf("DELTA_Q") } },
    defaults: DEFAULTS,
  };
}

test("the lists show every name with the default first, and a picked chat and agent run their own questions", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const listed: Listed[] = [];
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    twoOf(),
    output,
    hostOf(home, ["g", projects, "d"], asked, {}, { picks: ["gamma", "delta"], listed }),
  );
  assert.equal(code, 0, output.stderr);
  assert.deepEqual(listed[0]?.names.sort(), ["beta", "gamma"]);
  assert.deepEqual(listed[1]?.names.sort(), ["alpha", "delta"]);
  assert.deepEqual(
    asked.map((a) => a.message),
    ["Ask GAMMA_Q:", "Folder your projects live under (ALLOWED_ROOT):", "Ask DELTA_Q:"],
  );
  assert.match(output.stdout, /^\? Chat \(ALLABOARD_CHAT\): gamma {3}✔$/m);
  assert.match(output.stdout, /^\? Agent \(ALLABOARD_AGENT\): delta {3}✔$/m);
  assert.match(output.stdout, /Intro of GAMMA_Q\./);
  assert.deepEqual(
    { ...parseEnv(readFileSync(envOf(home), "utf8")) },
    {
      ALLABOARD_AGENT: "delta",
      ALLABOARD_CHAT: "gamma",
      GAMMA_Q: "g",
      ALLOWED_ROOT: projects,
      DELTA_Q: "d",
    },
  );
});

test("a chosen chat with no setup is refused after the pick, and nothing is written", async () => {
  const { home, output, asked } = setupOf("");
  const modules = twoOf();
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    { ...modules, chats: { ...modules.chats, gamma: {} } },
    output,
    hostOf(home, [], asked, {}, { picks: ["gamma"] }),
  );
  assert.equal(code, 1);
  assert.match(output.stderr, /chat gamma offers no setup/);
  assert.ok(!existsSync(envOf(home)));
});

test("a chosen agent with no setup asks nothing more for it", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const modules = twoOf();
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    { ...modules, agents: { ...modules.agents, delta: {} } },
    output,
    hostOf(home, ["b", projects], asked, {}, { picks: ["beta", "delta"] }),
  );
  assert.equal(code, 0, output.stderr);
  assert.deepEqual(
    asked.map((a) => a.message),
    ["Ask BETA_Q:", "Folder your projects live under (ALLOWED_ROOT):"],
  );
  assert.equal(parseEnv(readFileSync(envOf(home), "utf8")).ALLABOARD_AGENT, "delta");
});

for (const at of [0, 1]) {
  test(`Ctrl-C at pick ${at + 1} writes nothing and asks nothing`, async () => {
    const { home, output, asked } = setupOf("");
    const picks = at === 0 ? [null] : ["beta", null];
    const code = await answerWizard(
      DEFAULT_INSTANCE,
      twoOf(),
      output,
      hostOf(home, [], asked, {}, { picks }),
    );
    assert.equal(code, INTERRUPTED);
    assert.deepEqual(asked, []);
    assert.match(output.stdout, /Cancelled: nothing was written/);
    assert.ok(!existsSync(envOf(home)));
  });
}

for (const at of [0, 1, 2]) {
  test(`Ctrl-C at question ${at + 1} writes nothing and ends with 130`, async () => {
    const { home, output, asked } = setupOf("");
    const answers: (string | null)[] = ["a", "b"].slice(0, at);
    const chat = chatOf([question("A", accept), question("B", accept)]);
    const code = await answerWizard(
      DEFAULT_INSTANCE,
      chat,
      output,
      hostOf(home, [...answers, null], asked),
    );
    assert.equal(code, INTERRUPTED);
    assert.ok(!existsSync(envOf(home)));
    assert.match(output.stdout, /nothing was written/);
  });
}

test("the service is offered where a manager exists, and yes installs it", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  let installed = 0;
  const host = hostOf(home, ["a", projects, "y"], asked, {
    installService: () => {
      installed += 1;
      return { code: 0, out: ["Installed the service."], err: [] };
    },
  });
  const code = await answerWizard(DEFAULT_INSTANCE, chatOf([question("A", accept)]), output, host);
  assert.equal(code, 0);
  assert.equal(installed, 1);
  assert.equal(asked.at(-1)?.message, "Start allaboard now and at every login?");
  assert.match(output.stdout, /Installed the service\./);
});

test("an empty answer to the service question means yes; n installs nothing", async () => {
  for (const [typed, count] of [
    ["", 1],
    ["n", 0],
  ] as const) {
    const { home, output, asked } = setupOf("");
    const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
    let installed = 0;
    const host = hostOf(home, ["a", projects, typed], asked, {
      installService: () => {
        installed += 1;
        return { code: 0, out: [], err: [] };
      },
    });
    assert.equal(await answerWizard(DEV, chatOf([question("A", accept)]), output, host), 0);
    assert.equal(installed, count, JSON.stringify(typed));
    if (count === 0) assert.match(output.stdout, /allaboard service install --instance dev/);
  }
});

test("where there is no service manager the wizard ends after Wrote and asks nothing more", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chatOf([question("A", accept)]),
    output,
    hostOf(home, ["a", projects], asked),
  );
  assert.equal(code, 0);
  assert.equal(asked.length, 2);
});

test("Ctrl-C at the service question keeps the file and ends with 130", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const host = hostOf(home, ["a", projects, null], asked, {
    installService: () => assert.fail("installed"),
  });
  assert.equal(
    await answerWizard(DEFAULT_INSTANCE, chatOf([question("A", accept)]), output, host),
    INTERRUPTED,
  );
  assert.ok(existsSync(envOf(home)));
});

test("the file is never replaced: an .env that appears while the owner answers survives", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const chat = chatOf([
    question("A", () => {
      mkdirSync(join(home, ".config/allaboard"), { recursive: true });
      writeFileSync(envOf(home), "OTHER=1\n");
      return {};
    }),
  ]);
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chat,
    output,
    hostOf(home, ["a", projects], asked),
  );
  assert.equal(code, 1);
  assert.equal(readFileSync(envOf(home), "utf8"), "OTHER=1\n");
  assert.deepEqual(readdirSync(join(home, ".config/allaboard")), [".env"]);
  assert.match(output.stderr, /appeared while you answered/);
});

test("envText quotes what a bare value would not read back, and refuses what cannot be written", () => {
  const values = {
    PLAIN: "xoxb-1-abc",
    SPACED: "a b",
    HASH: "a#b",
    QUOTED: 'say "hi" now',
    TILDE: "~/code",
  };
  assert.deepEqual({ ...parseEnv(envText(values)) }, values);
  assert.equal(envText({ PLAIN: "x" }), "PLAIN=x\n");
  assert.throws(() => envText({ K: "a\nb" }), /line break/);
  assert.throws(() => envText({ K: `a$${"{"}B}` }), /line break or/);
  assert.throws(() => envText({ K: `"a'b\`c d` }), /every quote/);
});

test("the selectors are written first from the registry's defaults and never asked", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  await answerWizard(
    DEFAULT_INSTANCE,
    chatOf([question("A", accept)]),
    output,
    hostOf(home, ["a", projects], asked),
  );
  assert.ok(!asked.some((a) => /ALLABOARD_/.test(a.message)));
  assert.deepEqual(
    { ...parseEnv(readFileSync(envOf(home), "utf8")) },
    { ...SELECTED, A: "a", ALLOWED_ROOT: projects },
  );
});

test("the agent's questions come after the chat's and the root, and Enter skips an optional one", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const modules = chatOf(
    [question("A", accept)],
    [
      question("X_TIMEOUT", accept, { optional: true }),
      question("X_DIR", accept, { optional: true }),
    ],
  );
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    modules,
    output,
    hostOf(home, ["a", projects, "", "/work"], asked),
  );
  assert.equal(code, 0, output.stderr);
  assert.deepEqual(
    asked.map((a) => a.message),
    ["Ask A:", "Folder your projects live under (ALLOWED_ROOT):", "Ask X_TIMEOUT:", "Ask X_DIR:"],
  );
  assert.deepEqual(
    { ...parseEnv(readFileSync(envOf(home), "utf8")) },
    { ...SELECTED, A: "a", ALLOWED_ROOT: projects, X_DIR: "/work" },
  );
});

test("a check that sets a variable its question did not declare is refused", async () => {
  const { home, output, asked } = setupOf("");
  const modules = chatOf([question("A", () => ({ set: { B: "b" } }))]);
  await assert.rejects(
    answerWizard(DEFAULT_INSTANCE, modules, output, hostOf(home, ["a"], asked)),
    /set B without declaring it/,
  );
  assert.ok(!existsSync(envOf(home)));
});

test("the variables the core writes are its selectors and its required ones", () => {
  assert.deepEqual([...CORE_VARIABLES].sort(), [...SELECTORS, ...REQUIRED].sort());
});

test("the chat and the agent are picked first, each from a list with the default preselected", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const listed: Listed[] = [];
  await answerWizard(
    DEFAULT_INSTANCE,
    chatOf([]),
    output,
    hostOf(home, [projects], asked, {}, { listed }),
  );
  assert.deepEqual(listed, [
    { message: "Chat (ALLABOARD_CHAT):", names: ["beta"], preselected: "beta" },
    { message: "Agent (ALLABOARD_AGENT):", names: ["alpha"], preselected: "alpha" },
  ]);
  assert.deepEqual(
    asked.map((a) => a.message),
    ["Folder your projects live under (ALLOWED_ROOT):"],
  );
  const lines = output.stdout.split("\n");
  const header = lines.findIndex((line) => line.startsWith("allaboard setup: writes"));
  assert.equal(lines[header + 2], "? Chat (ALLABOARD_CHAT): beta   ✔");
  assert.equal(lines[header + 3], "? Agent (ALLABOARD_AGENT): alpha   ✔");
  assert.equal(lines[header + 5], "1. Do this first.");
});

test("the summary lists the file in order: a secret masked, a set value in clear, a skipped one absent", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const chat = chatOf(
    [
      question("T", () => ({ set: { WHO: "U000ALICE" } }), { secret: true, sets: ["WHO"] }),
      question("WHO", accept),
      question("SKIPPED", accept, { optional: true }),
    ],
    [question("N", accept)],
  );
  await answerWizard(
    DEFAULT_INSTANCE,
    chat,
    output,
    hostOf(home, ["a-secret-token", "", projects, "7"], asked),
  );
  const at = output.stdout.indexOf("The file holds:\n");
  const wrote = output.stdout.indexOf("\nWrote ");
  assert.ok(at > 0 && wrote > at);
  assert.equal(
    output.stdout.slice(at, wrote),
    [
      "The file holds:",
      "  ALLABOARD_AGENT=alpha",
      "  ALLABOARD_CHAT=beta",
      "  T=********",
      "  WHO=U000ALICE",
      `  ALLOWED_ROOT=${projects}`,
      "  N=7",
      "",
    ].join("\n"),
  );
  assert.ok(!output.stdout.includes("a-secret-token"));
});

test("an empty answer gives the question's default, and a check's value is what is written", async () => {
  const { home, output, asked } = setupOf("");
  const projects = mkdtempSync(join(tmpdir(), "allaboard-projects-"));
  const chat = chatOf([
    question(
      "HOURS",
      (a) => ({ value: String(Number(a) * 1000), note: `${Number(a) * 1000} ms` }),
      {
        default: "4",
      },
    ),
    question("PLAIN", accept, { default: "dflt" }),
  ]);
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    chat,
    output,
    hostOf(home, ["", "", projects], asked),
  );
  assert.equal(code, 0, output.stderr);
  assert.match(output.stdout, /^\? Ask HOURS: 4 {3}✔ 4000 ms$/m);
  assert.match(output.stdout, /^\? Ask PLAIN: dflt {3}✔$/m);
  const written = parseEnv(readFileSync(envOf(home), "utf8"));
  assert.equal(written.HOURS, "4000");
  assert.equal(written.PLAIN, "dflt");
});
