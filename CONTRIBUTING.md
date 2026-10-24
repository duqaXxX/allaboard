# Contributing

## Reporting a problem

Open an issue with the **Bug report** or **Feature request** form; blank issues are turned off.
The bug form asks for the allaboard and Claude Code versions, what you did, what you expected
and what happened. Leave out tokens, real Slack ids, paths from your machine and excerpts of real
sessions. A vulnerability goes to the **Security** tab, never to an issue (see
[SECURITY.md](SECURITY.md)).

## Sending a change

1. Fork, branch, and keep one subject per pull request.
2. Run the checks below; CI runs the same ones.
3. Update the doc a change makes false in the same commit, and add a line under `## Unreleased`
   in [docs/CHANGELOG.md](docs/CHANGELOG.md) for a change in behaviour. `test/docs.test.ts`
   fails on a name a doc cites that the source no longer defines (`sinks.ReplySink`,
   `ThreadSession.mode`), and on a variable, a Slack scope or a word that
   [docs/setup.md](docs/setup.md) does not name.
4. A new `!word` of the daemon is a member of the `Word` union of `src/core/commands.ts` with its
   entry in `WORD`, and needs a line in the `!guide` text (the `GUIDE_` parts of `src/core/texts.ts`, which
   `src/core/guide.ts` assembles) and in `texts.HELP_WORDS`: `test/core/commands.test.ts` fails until both explain it. Change the guide
   whenever a behaviour it describes changes. The word also needs a row in the Commands table of
   [README.md](README.md), which `test/docs.test.ts` checks against `WORD`.
5. The README is the landing page and has a word limit (`README_WORD_LIMIT` in
   `test/docs.test.ts`): describe a feature in [docs/setup.md](docs/setup.md), and change the
   README only when one of its lines stops being true.

## Adding an agent or a chat

An agent and a chat are modules, chosen by name in the configuration ("Modules" in
[docs/architecture.md](docs/architecture.md)). No second real agent or chat ships. The seams were
shaped on the Claude back end, the Slack provider and two test modules, so the first real module
may find a seam that needs a change: open an issue before writing one.

1. Implement the seam: `AgentBackend` and `AgentSession` of `src/agent/seam.ts`, or `ChatProvider`,
   `ThreadChat` and `ChannelChat` of `src/chat/seam.ts`. A chat provider checks that it was the
   owner on every inbound path before it calls `ChatInbound`; for the deletion of a root
   (`rootGone`), where the chat's event does not say who deleted it, it checks that the deleted
   message's author is the owner. It reaches the core through
   `src/core/port.ts` alone. An agent also gives its words (`AgentWords`): what it is called,
   and the names of its own commands that start a new session, log in and log out, which the core
   answers itself, the shell lines that continue a session and open the agent to trust a folder,
   and the commands of its terminal that a session does not offer, which the core answers too. The rules the core relies on beside the types, and which of them a conformance
   check holds, are in [docs/architecture.md](docs/architecture.md), under "What an agent must do
   that the types do not say" and "What a chat must do that the types do not say".
2. Declare the capabilities truthfully (`Capabilities`, `ChatCapabilities`). A capability left
   false means the feature is not offered; the conformance suite checks the declarations it can
   against what the module does (a member present exactly when it is declared, a list that matches
   the capabilities) and runs the checks of a capability only for a module that declares it.
3. Export an entry (`AgentEntry` or `ChatEntry`): the variables the module reads, `required` and
   `optional`, and `build`. Either entry may also give `setup`, the questions `allaboard setup`
   asks to write its variables (`src/chat/slack/onboarding.ts`, `claudeSetup` in
   `src/agent/claude/module.ts`); without it the owner writes them by hand. A module's setup must
   ask or set every variable it declares, and ask for no other: `test/setup-coverage.test.ts`
   fails otherwise, and a question whose check sets other variables names them in `sets`. An
   `AgentEntry` may also give `executable`, the agent's own command line program: `allaboard service
   install` puts the folder where the owner's terminal finds it on the service's `PATH`. `src/agent/claude/module.ts` and `src/chat/slack/module.ts` are the two
   that exist.
4. Run the conformance suite against it. In `test/conformance/agent.test.ts`, call
   `agentConformance` with a harness (`AgentHarness` in `test/conformance/agent.ts`) that creates
   an instance of the agent in a world of its own (`AgentWorld`) and plays it: the suite asks it to
   say a text, call a tool, ask a question, run its effort command or die, and reads the events. In
   `test/conformance/chat.test.ts`, call `chatConformance` with a function (`MakeRig` in
   `test/conformance/chat.ts`) that builds a rig (`ChatRig`): the provider, a channel and a thread,
   the owner and somebody else as people who write and click, whether the chat can show a line to
   the owner alone, and a way to read what the chat shows. A check that needs a capability the module does not declare
   is skipped by name. A session is named by `session_started` only once a start that resumes its
   id would succeed (the core stores the id at once, and the setup's Start resumes it before any
   prompt); the suite checks that for a harness whose world refuses a resume of an id the agent
   has no record of (`AgentHarness.refusesUnrecordedResume`). `node --test
   test/conformance/agent.test.ts` runs one file.
5. Add the entry to `REGISTRY` in `src/registry.ts`.
6. Name its variables in [docs/setup.md](docs/setup.md); `test/docs.test.ts` fails on a variable
   of any entry that the page does not name.

`test/support/plain-agent.ts` and `test/support/memory-chat.ts` are the worked examples: each is
written against its seam and `src/core/port.ts` alone and declares few capabilities, and the
scenario under `test/scenario/` runs the daemon with the two selected by name. The memory chat
shows the part of a chat that the port carries: it keeps the order of its own messages and asks
`tails`, `isLast` and `isOvertaken` which reply shows the list of what still runs and which reply
is last or overtaken. The footer goes under the reply the session names.

Two tests refuse what a module must not do, by layer, so that they hold for a module that is not
there yet. `test/imports.test.ts` fails when the core imports a module, when a module imports
another module (of its layer or the other), when anything but `src/daemon.ts` imports
`src/registry.ts`, when anything but `src/main.ts` imports `src/daemon.ts`, when anything imports
`src/main.ts`, when a chat provider imports anything of the core but its port, when the host layer
(`src/host/`) and the three layers import each other, and when a package is imported by a module
(or the host layer) that does not list it; it also fails on an `import()` whose specifier is not a literal and on `createRequire`, which it cannot
read. A new module adds its package to `LIBRARIES` in that test. `test/vocabulary.test.ts` fails on
an identifier or a string outside the module directories under `src/agent/` and `src/chat/` and
`src/registry.ts` that names an agent or a chat: the name of each module directory is one of the
words, read from the disk, so a module's own words stay in its directory and a text of the core
takes the module's name from `AgentBackend.name` or `ChatProvider.name`. A new module adds the
words only it has (its library, what it calls things) to `MODULE_WORDS` in that test.

## Checks

The daemon is TypeScript, in three layers: `src/agent/` (the Claude back end), `src/core/` and
`src/chat/` (the Slack provider), with `src/registry.ts` and `src/daemon.ts` joining them
(`src/main.ts` is the entry: it checks the Node and loads `src/daemon.ts`).
`test/imports.test.ts` fails when a layer imports what it must not. Run from the repository root:

```bash
npm ci
npm run check
```

`npm run check` runs Biome (`biome check .`), `tsc --noEmit` and the tests. They need Node 22.19 or
later, the `engines` of `package.json` that the installed package needs too. Node runs the tests
from the sources, with the types stripped, so they need no build; they start no Claude Code process
and open no connection. One file: `node --test test/core/config.test.ts`. `npm run format` applies
Biome's fixes, and `npm run build` compiles `src/` to `dist/`.

CI runs the tests on Linux, macOS and Windows, and it is the judge for the systems you do not
run: a test can pass on one system and fail on another (outside macOS every lock is a listening
socket or pipe, and Windows has no POSIX signals). A pull request is ready once every job is
green. To reproduce a failure of the Linux job, `npm run test:linux` runs the suite in Docker the
way that job does (Node 22, a clean copy, a user that is not root); `npm run test:linux -- --ref
<rev>` runs it on one commit. A test whose subject exists on some systems only says so with
`skip` and the reason.

Test fixtures are synthetic in content (ids such as `U000ALICE`) and recorded in shape, under
`test/fixtures/`, which `test/support/fixtures.ts` reads. Never write the shape of an SDK message
or a Slack payload by hand.

`test/golden/` holds snapshots: for every recording under `test/fixtures/sdk/`, the calls the
renderer makes on its sink and the Slack calls the reply sink makes for them. Two tests fail when
the code produces anything else. `npm run golden` writes the files again from the code as it is,
so a change to a reply shows as a diff under `test/golden/`: read that diff before committing it,
since the tests pass on whatever was written last.

### Running your own build

To run the daemon from a clone instead of the version on the npm registry:

```bash
npm ci
npm install -g "./$(npm pack --silent)"
allaboard service restart
```

`npm pack` builds the package (its `prepack` script runs the TypeScript compiler) into a tarball in
the clone, from whatever the working tree holds, committed or not, and `npm install -g` installs it
in npm's global prefix in place of any copy installed from the registry. The restart makes the
service run it.

## SDK releases

allaboard pins `@anthropic-ai/claude-agent-sdk` to an exact version in `package.json` and runs the
Claude Code CLI that package bundles. The suite replays recorded streams, so it cannot see what a
new Claude Code CLI does differently. The **probe** can. It runs the daemon's own session code
against the real CLI the SDK bundles, with Slack faked, and uses your Claude Code login and tokens
from your plan (Haiku, and Sonnet for the one scene that needs auto mode), so it runs on your machine and is not part of `npm test`:

```
node probe/main.ts            # the pinned SDK, if it is not certified yet; if it is, its stored report
node probe/main.ts --latest   # the newest release on npm, in a temporary git worktree
node probe/main.ts --force    # run even if already certified
node probe/main.ts --surface --from <sdk.d.ts>   # what the installed release adds to that file: no token
```

`--latest` works on a worktree of `HEAD`, so commit a change to the probe before using it. Each
claim in `probe/claims.ts` ends in one of five outcomes:

| Outcome | Meaning |
|---|---|
| HOLDS | the probe caused the event and the behaviour was there |
| BROKEN | the probe caused the event itself and the behaviour was missing: do not pin the release |
| UNPROVEN | the event did not happen, so nothing was learned |
| RETIRED | Claude Code no longer offers the event |
| FELL | a limit claim only: the probe caused the event and the limit of `docs/limits.md` was gone |

A **gesture** claim is one the probe causes itself (a prompt, `!stop`, a resume). A **model**
claim needs Claude to act (call Bash, read a file), so when it fails it is UNPROVEN, never
BROKEN: Claude may simply have chosen otherwise. A **limit** claim holds while a limit of the Agent
SDK section of [docs/limits.md](docs/limits.md) holds (a command still not offered, a tool still
absent, a line of the system prompt still the SDK's). When it does not, the outcome is FELL: the
release is not broken, the limit is gone, and the report asks for the row to change. A limit claim
never blocks a certificate and never moves the exit status; one the run could not prove is
UNPROVEN and goes in the hand checklist. Each reads something that is really there (the Bash tool
in a request, the preset's sections of the system prompt, the initialization message) and is
UNPROVEN otherwise, and it FELL only when a value it parses, or the one command or line it
finds, differs from the measured one, so that a reworded prompt or a failed capture never reads
as a fallen limit.
The release is certified, and its version
added to `probe/certified-versions.json` (with the ids of the limit claims that fell, under `fell`),
only when every gesture claim holds or is retired. What
the run could not prove is printed as a checklist of things to try in Slack, followed by the By
hand column of [docs/features.md](docs/features.md), which maps every feature to its tests, its
probe claims and what nothing checks automatically; a new feature or claim adds its row there.
A feature that rests on the SDK (what it does depends on what the SDK or the CLI emits, accepts
or lists) has a claim in its Probe cell, or `by hand: <why>` when a probe cannot see it (the Chrome
extension, for one), which the checklist prints; a feature that does not rest on it (Slack, the Home
tab, the daemon's own words, npm, the LaunchAgent) reads `n/a: <reason>` of a few words. `none`, an
empty cell, a mix of the forms and a reason that names a claim fail `test/probe/features.test.ts`.
A failure of the machine rather than the SDK (a turn past its time limit, the network) leaves its
claims UNPROVEN.

Each claim also records the facts it rests on (`seen`) that can differ while it holds: names,
counts of what the probe itself sent, field sets and booleans, never conversation content, a
path, an id, a time or a token count. A fact the pass condition fixes is not kept. A run that certifies writes them to
`probe/observations/<sdk version>.json`, beside the certificate, and the file is committed. The
report sorts every claim against the file of the newest certified release before the probed one
(the certificates of the checkout decide, also for a `--latest` run in a worktree) and lists the
claims, each with its kind, in this order. A release that is already certified prints the report
again from the stored files, at no cost:

| Group | Meaning |
|---|---|
| Changed | the claim holds on other facts than the baseline's; the lines that differ are printed (`+` added, `-` removed, `~` changed) with the `docs/features.md` rows tied to the claim |
| No longer supported | BROKEN |
| Newly supported | FELL: the `docs/limits.md` row the claim checks is printed beside it, and the run ends by asking for the page to change |
| Not proven | UNPROVEN, with its entry in the hand checklist; the kind shows whether it blocks certification (a `gesture` claim does, a `model` or `limit` claim does not) |
| No baseline | the claim holds, but the baseline has no stored facts for it (or no earlier release is certified), so nothing is compared |
| Unchanged | the claim holds on the same facts |
| Retired | RETIRED |

The probe does not judge a change better or worse: read each one, with the features named beside
it, before pinning. The pin rule is that no claim is BROKEN, no gesture claim is UNPROVEN and
every changed claim was read and accepted in the pull request that moves the pin, which also
commits the new observations file. A changed claim does not alter the exit status; the last line
of the claims says how many changed and how many limits fell. A new claim sets `seen` in its scene; a claim that has no
fact that can differ while it holds says so in `NO_FACTS` of `test/probe/verdicts.test.ts`.

The design follows the upgrade guard of [seedeep](https://github.com/duqaXxX/seedeep).

`node probe/live-agent.ts` is a second live run, of the Claude back end alone: 23 checks through
`ClaudeBackend` and `ClaudeSession` on Haiku, in fresh temporary folders with none of your
settings loaded, one `PASS` or `FAIL` line each. It spends a few cents of tokens, is not tied to a
release, and exits 1 when a check fails.

Before its scenes, the probe checks
[docs/sdk-surface.md](docs/sdk-surface.md), the table of every type, field,
value, method and option of the SDK the source depends on, against the release it runs on. A row
the package no longer defines is BROKEN and stops the run with exit status 3 before any token is
spent. A row marked `reference` that the published
[reference](https://code.claude.com/docs/en/agent-sdk/typescript) no longer names is UNPROVEN and
is listed to be read by hand. The rows the reference never named and no claim covers are counted;
`node probe/main.ts --surface` lists them and checks the table alone, with no token spent. A
change that reads a new field, key or value of the SDK adds its row there in the same pull
request; `test/agent/claude/sdk-surface.test.ts` fails on an imported SDK name with no row.

A run on a release that is not certified yet also prints, after the claims, Claude Code's own
changelog from the CLI of the newest certified release below it to the CLI under test, every
entry (`probe/changelog.ts`).

A `--latest` run also prints what the release adds beside what it could change: the names its
`sdk.d.ts` declares that the pinned one does not and the names it no longer declares, under "Added
to the SDK" and "Removed from the SDK". The names are the exported declarations, the members of
each object type and interface as `Type.member` (`Options.model`, `SDKCompactBoundaryMessage.uuid`),
the members of the `SDKMessage` union and the `subtype` of each system message
(`system:task_started`). A limit row of `docs/limits.md` and a feature row of `docs/features.md` may
name in a `Rests on` cell the SDK names and the `/commands` it depends on, in backticks, or leave
the cell empty when nothing in the SDK would show a change. A cell names only names that exist in
the pinned release, so matching is by name and by owner type: a row that names a type
(`SDKToolProgressMessage`, `Options`) is printed as a candidate when that type gains or loses a
member, a row that names a `Type.member` or a `/command` when that one is removed or gone, and a
new command a limit row lists is a fallen limit candidate. A limit row reads "may now be
supported" for an addition, a feature row "added: check this row"; a removal is "may break" for
both. A candidate is a place to look, never a verdict. If either `sdk.d.ts` or a `Rests on` cell
cannot be read, the run logs one line saying so, prints no block and keeps its exit status. These lines never move the exit
status. `node probe/main.ts --surface --from <sdk.d.ts>` prints the same block for the installed
package against any older `sdk.d.ts` (unpack one with `npm pack @anthropic-ai/claude-agent-sdk@<version>`
outside the repository), with no token spent. `test/probe/diff.test.ts` fails on a `Rests on` name
that the pinned `sdk.d.ts` does not define and on a `/command` that neither
`test/fixtures/sdk/server-info.json` nor a limit row lists.

The probe also compares the commands a session is offered on the release with the list recorded
in `test/fixtures/sdk/server-info.json`, and prints the ones that are new or gone after the
claims. A new command is typed in Slack as `!name` from the day the release is pinned: try it in
a thread, decide what Slack shows for it, then record the list again. The comparison stops no
certificate. `node probe/main.ts --commands` runs it alone, with no token spent.

Every message the scenes' sessions read is also compared with the streams under `test/fixtures/sdk/`
(`probe/shapes.ts`): per kind of record, the key paths and the type of their value, content and
order left out; a `null` matches any type the path is known with. A kind, a path or a built-in tool
that no fixture shows is a difference, printed with the claims, and any difference stops the
certificate (exit status 4). When the source reads what changed, record that fixture again (and its
goldens with `npm run golden`); when it does not, add the entries the probe prints to
`probe/accepted-shapes.json`, with the Claude Code version, in the pull request that moves the pin,
and commit them before running `--latest` again. Only what a run adds is checked: a path the
fixtures hold and a run did not produce may be one its scenes never caused, so a field that a
release removes or renames shows here only as its new name.

The scenes cause only some of the messages the fixtures hold. A full recording (`probe/families.ts`)
adds one session per family of the others: a subagent and its report, a question answered, a
Monitor, a skill run with `context: fork`, `/clear` and `/usage`, and an API error from a local stub
with a made-up key. Each session has the daemon's session options but its setting sources: none (the
project's alone for the skill), so the owner's settings are not applied, and the claude.ai
connectors are off (`ENABLE_CLAUDEAI_MCP_SERVERS=false`). A family that does not cause what it is
for (the AskUserQuestion call, a subagent's report...) has not finished. Its messages join the
comparison above, and each family lists, as a warning that stops nothing, the paths of its fixtures
it did not produce. The probe runs it when its scenes find a difference, when the SDK's message
types differ from those of the last full recording, when that one is 7 days old, or with `--full`. A
full recording where every family finished writes `probe/full-recording.json`; a family that did not
finish is recorded again on the next run. The report gives each family's cost as its sessions state
it (`total_cost_usd`).

Every row of the Agent SDK section of [docs/limits.md](docs/limits.md) has a `Checked by` cell:
the ids of the limit claims that check it, or `by hand:` and why (it needs Claude, a phone or
Slack). `test/docs.test.ts` requires one of the two in every row and a row for every limit claim.
One claim (`P23`) sends every command the page lists as not offered to a session; a command
answered otherwise while others still say `isn't available in this environment` makes it FELL,
and answers that are all reworded or silent leave it UNPROVEN. Another (`P25`) leaves a command
running in the background and reads the turn Claude Code opens by itself when it ends: it holds
while nothing in the stream says what woke that turn. `L1` to `L6`, `L8` and `L9` read requests,
the initialization message and records: the Bash tool's time limits (`L1`, FELL only when a number
differs), the identity line (`L4`), the hint on `!` (`L5`) and the compaction instructions (`L8`)
in a request; the tools, agents and skills (`L3`, `L6`) in the initialization message; and the
records of a turn (`L2` no `session_state_changed`, `L9` no `active_goal`). A FELL claim means
the row leaves the page or changes, in the pull request that moves the pin.

The **SDK release watch** workflow (`.github/workflows/sdk-release-watch.yml`) reads, every day,
the latest `@anthropic-ai/claude-agent-sdk` release from the npm registry, runs `npm test` on it,
and keeps one issue labelled `sdk release` and `priority: high` with the versions, the outcome and
the checks left to do by hand (`.github/scripts/watch-sdk-release.sh`,
`.github/scripts/sdk-release-report.mjs`). The body is rewritten on each run; a comment is added
once per new version and whenever the suite does not pass. Close the issue once the release is checked: a closed issue with the same title is not
opened again.

## Releases

allaboard is published to the npm registry as `allaboard`, one package for every system, from a git
tag. The version follows semver within 0.x: a release that changes the pin of
`@anthropic-ai/claude-agent-sdk` or adds something the owner can see is a minor (`0.2.0`), a
release of fixes alone a patch (`0.1.1`). The pinned SDK is one the probe certified (see SDK
releases above).

1. A pull request sets `version` in `package.json` and moves what is under `## Unreleased` in
   `docs/CHANGELOG.md` into a section `## [x.y.z] - YYYY-MM-DD`, leaving `## Unreleased` empty
   above it.
2. Once it is merged, tag the merge commit and push the tag:

   ```bash
   git tag v0.2.0 <merge commit>
   git push origin v0.2.0
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) checks that the tag names
   `package.json`'s version and that the changelog has its dated section, which is not empty
   (`.github/scripts/release.mjs`), and that the tagged commit is on `main`. It then runs lint and types on Linux and the tests
   on Linux, macOS and Windows, publishes through npm's trusted publishing, and creates the GitHub
   Release with the version's section as its notes, or a link to that section when it is longer
   than GitHub takes. A version already on the
   registry is not published again, so a re-run only completes what is missing.

The package on npm has a README of its own, `npm/README.md`: short, with absolute links to GitHub
pinned to the version's tag through `{{VERSION}}`. npm always packs the README at the root of the
folder it publishes, so `npm run build:npm` assembles the package in `build/npm/allaboard`
(`.github/scripts/npm-package.mjs`): the built `dist`, a `package.json` with what an install needs
and no scripts or devDependencies, `LICENSE`, `slack-app-manifest.json`, and that README. That
folder is what is published, by the workflow and by hand.

Trusted publishing has no npm token: npm exchanges the workflow's OIDC token for one publish, and
attaches provenance. It needs a package that already exists on the registry, so the first version
is published by hand, once, by the package's owner with 2FA: `npm run build:npm` then
`npm publish build/npm/allaboard` from a clean checkout of the merge commit, and only then the
tag, whose workflow finds the version on the registry and creates the GitHub Release. Then, just before the next release (a new trusted publisher must
publish within 2 days), the owner links the package to the workflow, with npm 11.15 or later:

```bash
npm trust github allaboard --file release.yml --repository duqaXxX/allaboard --allow-publish
```

and sets "Require two-factor authentication and disallow tokens" in the package's settings on
npmjs.com.

The check that the tagged commit is on `main` catches a tag put on the wrong commit by mistake.
It runs from the workflow file of the tagged commit, so it does not stop someone who can push to
the repository and edits that file in the same commit. The repository's ruleset `release tags`
refuses to delete, move or force-push a tag `v*`, for everyone: a published version's tag never
changes.
