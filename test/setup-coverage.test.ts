/**
 * `allaboard setup` stays in step with the variables: every variable a registry entry declares is
 * asked, or declared as set by an answer, in that entry's setup, and every question belongs to a
 * variable the entry declares. A new variable fails here until the wizard covers it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { REQUIRED, SELECTORS } from "../src/core/config.ts";
import { DEFAULT_INSTANCE } from "../src/core/instance.ts";
import { answerWizard } from "../src/core/wizard.ts";
import type { ModuleSetup } from "../src/module-setup.ts";
import { REGISTRY } from "../src/registry.ts";

interface Described {
  readonly name: string;
  readonly declared: readonly string[];
  readonly setup: ModuleSetup | null;
}

function entries(): Described[] {
  const agents = Object.entries(REGISTRY.agents).map(([name, entry]) => ({
    name: `agent ${name}`,
    declared: [...entry.required, ...entry.optional],
    setup: entry.setup?.() ?? null,
  }));
  const chats = Object.entries(REGISTRY.chats).map(([name, entry]) => ({
    name: `chat ${name}`,
    declared: [...entry.required, ...entry.optional],
    setup: entry.setup?.(DEFAULT_INSTANCE) ?? null,
  }));
  return [...agents, ...chats];
}

for (const { name, declared, setup } of entries()) {
  test(`${name}: its setup asks or sets every variable it declares, and only those`, () => {
    assert.ok(setup !== null, `${name} offers no setup: add a "setup" to its registry entry`);
    const covered = new Set(setup.questions.flatMap((q) => [q.variable, ...(q.sets ?? [])]));
    for (const variable of declared) {
      assert.ok(covered.has(variable), `add a question for ${variable} to the module's setup`);
    }
    for (const q of setup.questions) {
      for (const variable of [q.variable, ...(q.sets ?? [])]) {
        assert.ok(
          declared.includes(variable),
          `the setup of ${name} handles ${variable}, which the entry does not declare in "required" or "optional"`,
        );
      }
    }
  });
}

test("the wizard writes every selector and every variable the core requires", async () => {
  const home = mkdtempSync(join(tmpdir(), "allaboard-coverage-"));
  const projects = mkdtempSync(join(tmpdir(), "allaboard-coverage-root-"));
  const { chat, agent } = REGISTRY.defaults;
  // The modules ask nothing of their own here: what is left is the core's part of the file.
  const code = await answerWizard(
    DEFAULT_INSTANCE,
    {
      chats: { [chat]: { setup: () => ({ intro: [], questions: [] }) } },
      agents: { [agent]: {} },
      defaults: REGISTRY.defaults,
    },
    { out: () => {}, err: () => {} },
    {
      home,
      interactive: true,
      installService: null,
      prompter: {
        ask: async () => projects,
        choose: async (_message, _names, preselected) => preselected,
      },
    },
  );
  assert.equal(code, 0);
  const written = parseEnv(readFileSync(join(home, ".config", "allaboard", ".env"), "utf8"));
  for (const variable of [...SELECTORS, ...REQUIRED]) {
    assert.ok(
      Object.hasOwn(written, variable),
      `add a question for ${variable} to the wizard core (src/core/wizard.ts)`,
    );
  }
});

test("the wizard asks each selector as a list of the registry's names, not just writes it", async () => {
  const lists: { message: string; names: readonly string[]; preselected: string }[] = [];
  await answerWizard(
    DEFAULT_INSTANCE,
    REGISTRY,
    { out: () => {}, err: () => {} },
    {
      home: mkdtempSync(join(tmpdir(), "allaboard-coverage-")),
      interactive: true,
      installService: null,
      prompter: {
        // Ctrl-C at the first question: both lists were shown before it.
        ask: async () => null,
        choose: async (message, names, preselected) => {
          lists.push({ message, names, preselected });
          return preselected;
        },
      },
    },
  );
  for (const [variable, entries, preselected] of [
    [SELECTORS[1], REGISTRY.chats, REGISTRY.defaults.chat],
    [SELECTORS[0], REGISTRY.agents, REGISTRY.defaults.agent],
  ] as const) {
    const list = lists.find((l) => l.message.includes(`(${variable})`));
    assert.ok(list !== undefined, `the wizard does not ask ${variable}`);
    assert.deepEqual([...list.names].sort(), Object.keys(entries).sort());
    assert.equal(list.preselected, preselected);
  }
});
