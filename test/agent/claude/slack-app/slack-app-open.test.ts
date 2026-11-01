/**
 * `!open`, through Bolt's own entry point: the message only the owner sees (a search field and a few
 * files as buttons), a name typed in the thread, and what nobody but the owner may do with either. The log lines that say which path answered `texts.HOLD_GONE` are in
 * `slack-app-clip.test.ts`.
 *
 * The tests stand at two seams: the lookup the world's back end answers with
 * (`world.backend.repository`) and a `Listings` of their own over it. A wait for the daemon to
 * come to rest is `world.idle()` or `world.settle()`; nothing waits on the wall clock. A click's
 * `response_url` is mocked (`respondedTo`), so that what the daemon takes away can be read.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { trustedRepository } from "../../../../src/agent/claude/trust.ts";
import type { Repository } from "../../../../src/agent/seam.ts";
import { logger } from "../../../../src/chat/slack/app/answers.ts";
import { startedAt } from "../../../../src/chat/slack/app/open.ts";
import { FILE_BUTTONS } from "../../../../src/chat/slack/openfile/search.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import {
  type Listing,
  Listings,
  type RepositoryLookup,
} from "../../../../src/core/files/listing.ts";
import { regularFiles } from "../../../../src/core/files/read.ts";
import * as texts from "../../../../src/core/texts.ts";
import { fill, named } from "../../../../src/core/texts.ts";
import {
  AsyncEvent,
  BOT,
  CHANNEL,
  FakeClock,
  OTHER_TEAM,
  OTHER_THREAD,
  OWNER,
  STRANGER,
  TEAM,
  THREAD,
} from "../../../support/fake-slack.ts";
import { commitAt, committed, git, gitInit, trust } from "../../../support/git-layouts.ts";
import { NAMES } from "../../../support/names.ts";
import {
  askedOpen,
  type Body,
  fileButtons,
  fileClick,
  inAThread,
  madeBeforeTheThread,
  message,
  opened,
  projectOf,
  put,
  reply,
  respondedTo,
  said,
  searchEnter,
  searchPosts,
  type World,
  type WorldOptions,
  worldFor,
} from "../../../support/slack-app.ts";

// A symbolic link is a POSIX matter; Windows is not a supported host.
const SYMLINKS = { skip: process.platform === "win32" ? "links are read by POSIX rules" : false };

// Each pair is a user who is not the owner, and the owner from another workspace.
const ANYONE_ELSE: ReadonlyArray<readonly [user: string, team: string]> = [
  [STRANGER, TEAM],
  [OWNER, OTHER_TEAM],
];

/** What `respondedTo` caught: everything the daemon posted to a click's `response_url`. */
let responses: Body[] = [];

/**
 * The last `!open` message the owner was shown, as the tests read it: the files its buttons carry
 * and the lines under them. Read when asked, so one object follows the message as it is replaced.
 */
function search(world: World) {
  const post = (): Body => {
    const posts = searchPosts(world);
    assert.ok(posts.length > 0, "no search message was shown");
    return posts.at(-1) as Body;
  };
  return {
    post,
    rows: (): string[] => fileButtons(post()).map(([, path]) => path),
    labels: (): string[] =>
      (post().blocks as Body[])
        .filter((block) => block.type === "context")
        .map((block) => block.elements[0].text),
    field: (): unknown => post().blocks[0].element.initial_value,
  };
}

/**
 * A timer that keeps the event loop alive for the test's duration: on Node 22 a test that awaits
 * something which never comes, with only unref'd timers pending, lets the process finish and
 * cancels the rest of the file (the sessions harness does the same; the world does not).
 */
function keepAlive(t: TestContext): void {
  responses = respondedTo(t);
  const guard = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(guard));
}

function openWorld(t: TestContext, options: WorldOptions = {}): World {
  keepAlive(t);
  return worldFor(t)(options);
}

/**
 * A world whose `!open` listings are `listings`, which is made over the lookup the world's
 * sessions answer with: the world needs the listings to be made, and they need the world to look
 * a repository up.
 */
function worldWith<L extends Listings>(
  t: TestContext,
  make: (lookup: RepositoryLookup) => L,
): World {
  keepAlive(t);
  let world: World | undefined;
  const listings = make((directory) => {
    if (world === undefined) throw new Error("the world is not made yet");
    return world.sessions.repository(directory);
  });
  world = worldFor(t)({ listings });
  return world;
}

/** A walk of a plain folder that ran out of time with `found` in hand. */
class CutListings extends Listings {
  readonly #found: readonly string[];
  #made = false;

  constructor(lookup: RepositoryLookup, found: readonly string[]) {
    super(lookup);
    this.#found = found;
  }

  override async of(
    _folder: string,
    options: { again?: boolean; signal?: AbortSignal } = {},
  ): Promise<Listing> {
    // The first listing is made for the request that gets it; the next one is the one kept.
    const fresh = !this.#made || options.again === true;
    this.#made = true;
    return { files: this.#found, complete: false, fresh };
  }
}

/** The lookup of the world's sessions, counting the folders it was asked about. */
function counted(world: World): string[] {
  const asked: string[] = [];
  const real = world.backend.repository;
  world.backend.repository = (directory) => {
    asked.push(directory);
    return real(directory);
  };
  return asked;
}

/** The lookup of the world's sessions, held until `release` is set (a repository that is slow). */
function _slowLookup(world: World, release: AsyncEvent): void {
  const real = world.backend.repository;
  world.backend.repository = async (directory): Promise<Repository | null> => {
    await release.wait();
    return real(directory);
  };
}

function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1);
  return items[0] as T;
}

function calls(world: World, method: string): Body[] {
  return world.slack.callsTo(method) as Body[];
}

test("two replies sent together reach the queue in the order they were sent", async (t) => {
  // Nothing of `!open` runs when a prompt arrives: a slow repository lookup (a cold cache, a
  // slow git) must not hold a prompt, or let a later one overtake it. With a lookup awaited
  // before the arrival lock, the first reply here is overtaken by the second.
  const world = openWorld(t);
  projectOf(world);
  await inAThread(world);
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session !== null);
  const queued: string[] = [];
  const submit = session.submit.bind(session);
  session.submit = async (prompt) => {
    queued.push(String(prompt));
    return submit(prompt);
  };
  const asked = counted(world);
  const real = world.backend.repository;
  const slow = new AsyncEvent();
  let first = true;
  world.backend.repository = async (directory) => {
    if (first) {
      first = false;
      await slow.wait();
    }
    return real(directory);
  };
  await world.dispatch(reply("first", THREAD));
  await world.dispatch(reply("second", THREAD));
  slow.set();
  await world.settle();
  assert.deepEqual(queued, ["first", "second"]);
  const lookedUp = asked.length; // the replies' own footers look a repository up when they end
  await askedOpen(world, "!open zzz");
  assert.ok(asked.length > lookedUp); // the control: the lookup is counted, and a name makes one
});

test("open alone shows the field and the files changed in the session, newest first", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  const committedSince = put(project, "docs/guide.md");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "docs");
  const older = put(project, "notes.txt");
  utimesSync(committedSince, 1_790_000_100, 1_790_000_100);
  utimesSync(older, 1_790_000_000, 1_790_000_000);
  const posts = calls(world, "chat.postMessage").length;
  await askedOpen(world, "!open");
  const post = only(searchPosts(world));
  assert.ok(post.thread_ts === THREAD && post.channel === CHANNEL);
  assert.equal(post.text, slackTexts.OPEN_FALLBACK);
  assert.deepEqual(modal.rows(), ["docs/guide.md", "notes.txt"]);
  assert.deepEqual(fileButtons(post), [
    ["docs/guide.md", "docs/guide.md"],
    ["notes.txt", "notes.txt"],
  ]);
  assert.deepEqual(modal.labels(), [fill(slackTexts.OPEN_CHANGED, { count: 2 })]);
  assert.equal(modal.field(), undefined);
  // Only the owner sees it: an ephemeral message, and not one post to the thread.
  assert.equal(calls(world, "chat.postMessage").length, posts);
  assert.deepEqual(opened(world), []);
});

test("a session that changed nothing gets the line that says to type", async (t) => {
  const world = openWorld(t);
  projectOf(world);
  const modal = search(world);
  await inAThread(world);
  await askedOpen(world, "!open");
  assert.deepEqual(modal.rows(), []);
  assert.deepEqual(modal.labels(), [slackTexts.OPEN_TYPE_A_NAME]);
});

test("the changes are counted from where head was when the thread started", async (t) => {
  // Nothing is remembered by the daemon: HEAD's log says where the repository stood at THREAD's
  // time (an epoch second), so a daemon restarted since gives the same answer.
  const world = openWorld(t);
  const modal = search(world);
  const folder = join(world.root, "app");
  const start = Number(THREAD.split(".")[0]);
  const repo = realpathSync.native(gitInit(join(folder, "workspace")));
  commitAt(repo, "base.py", start - 1000);
  commitAt(repo, "before.py", start - 500); // moved HEAD before the thread began
  commitAt(repo, "made_by_claude.py", start + 500);
  put(repo, "uncommitted.py");
  await inAThread(world);
  await askedOpen(world, "!open");
  await world.settle();
  assert.deepEqual(modal.rows().toSorted(), [
    "workspace/made_by_claude.py",
    "workspace/uncommitted.py",
  ]);
});

test("a repository made after the thread began lists every file as changed", async (t) => {
  const world = openWorld(t);
  const modal = search(world);
  await inAThread(world);
  const made = committed(join(world.root, "app")); // THREAD is long past: the first commit is the session's
  put(made, "new.py");
  await askedOpen(world, "!open");
  await world.settle();
  assert.deepEqual(modal.rows().toSorted(), ["README", "new.py"]);
});

test("a folder that is not a repository has no changed files", async (t) => {
  const world = openWorld(t);
  const modal = search(world);
  await inAThread(world);
  put(join(world.root, "app"), "plain.txt");
  await askedOpen(world, "!open");
  await world.settle();
  assert.ok(modal.rows().length === 0);
  assert.deepEqual(modal.labels(), [slackTexts.OPEN_TYPE_A_NAME]);
});

test("the repositories of a folder are looked up once for a short while", async (t) => {
  // The listings keep them for REPOSITORIES_TTL seconds: of a clock that does not move, so
  // that a slow machine cannot make the second click come too late.
  const world = worldWith(t, (lookup) => new Listings(lookup, { clock: new FakeClock() }));
  const folder = join(world.root, "app");
  madeBeforeTheThread(join(folder, "workspace"));
  await inAThread(world);
  const asked = counted(world);
  await askedOpen(world, "!open");
  await world.settle();
  const first = asked.length;
  assert.ok(first > 0);
  await askedOpen(world, "!open");
  await world.settle();
  assert.equal(asked.length, first); // the second click found them kept
});

test("the changes of a repository inside the folder are listed", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  // The channel's folder is a plain folder that holds a repository one level down.
  const folder = join(dirname(project), "plain");
  mkdirSync(folder);
  world.state.bind(CHANNEL, folder);
  const nested = madeBeforeTheThread(join(folder, "workspace"));
  await inAThread(world);
  put(nested, "docs/new.md");
  put(folder, "notes.txt"); // outside any repository: not a change
  await askedOpen(world, "!open");
  await world.settle();
  assert.deepEqual(modal.rows(), ["workspace/docs/new.md"]);
  assert.deepEqual(modal.labels(), [slackTexts.OPEN_CHANGED_ONE]);
});

test("a name that matches several files shows them with the words in the field", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  for (const name of ["docs/setup.md", "src/setup.py", "setup/readme.md"]) put(project, name);
  await askedOpen(world, "!open setup");
  assert.deepEqual(opened(world), []);
  assert.equal(only(searchPosts(world)).thread_ts, THREAD);
  assert.equal(modal.field(), "setup");
  // The file names first, then the folder's file.
  assert.deepEqual(modal.rows(), ["src/setup.py", "docs/setup.md", "setup/readme.md"]);
  assert.deepEqual(modal.labels(), [fill(slackTexts.OPEN_ROWS_MATCH, { count: 3 })]);
});

test("a name that matches nothing says so under the field, which keeps the words", async (t) => {
  const world = openWorld(t);
  projectOf(world);
  const modal = search(world);
  await inAThread(world);
  await askedOpen(world, "!open zzz");
  assert.deepEqual(opened(world), []);
  assert.equal(modal.field(), "zzz");
  assert.deepEqual(modal.rows(), []);
  assert.deepEqual(modal.labels(), [fill(slackTexts.OPEN_NO_MATCH, { words: "zzz" })]);
});

test("the matches of a plain folder are what its disk holds", async (t) => {
  const world = openWorld(t);
  const modal = search(world);
  await inAThread(world);
  for (const name of ["a/setup.md", "b/setup.py"]) put(join(world.root, "app"), name);
  await askedOpen(world, "!open setup");
  assert.deepEqual(modal.rows().toSorted(), ["a/setup.md", "b/setup.py"]);
});

test("a path is an exact name even when git ignores the file", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, ".gitignore", "*.log\n");
  put(project, "trace.log", "line\n");
  await askedOpen(world, "!open trace.log");
  assert.equal(only(opened(world)).files[0].title, "trace.log");
  assert.deepEqual(searchPosts(world), []);
});

test("more than five matches show five and say so", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  for (let i = 0; i < 130; i += 1) put(project, `data/part${String(i).padStart(3, "0")}.csv`);
  await askedOpen(world, "!open part");
  assert.equal(modal.rows().length, FILE_BUTTONS);
  assert.deepEqual(modal.labels(), [
    fill(slackTexts.OPEN_ROWS_MATCH, { count: 130 }),
    fill(slackTexts.OPEN_MATCHES_CAPPED, { shown: FILE_BUTTONS, count: 130 }),
  ]);
});

test("two files with the same last two segments are told apart by their paths", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  for (const name of ["a/pkg/index.ts", "b/pkg/index.ts", "c/notes.ts"]) put(project, name);
  await askedOpen(world, "!open .ts");
  const labels = fileButtons(only(searchPosts(world))).map(([label]) => label);
  assert.deepEqual(labels.toSorted(), ["a/pkg/index.ts", "b/pkg/index.ts", "c/notes.ts"]);
});

test("Enter in the field shows the files that match, and leaves out what git ignores", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  put(project, "src/parser.py");
  put(project, "src/lexer.py");
  put(project, ".gitignore", "*.log\n");
  put(project, "trace.log");
  await world.dispatch(searchEnter("PARS"));
  await world.settle();
  assert.deepEqual(modal.rows(), ["src/parser.py"]);
  assert.deepEqual(modal.labels(), [slackTexts.OPEN_ROWS_MATCH_ONE]);
  assert.equal(modal.field(), "PARS");
  await world.dispatch(searchEnter("trace")); // there, and ignored
  await world.settle();
  assert.deepEqual(modal.rows(), []);
  assert.deepEqual(modal.labels(), [fill(slackTexts.OPEN_NO_MATCH, { words: "trace" })]);
});

test("a count below the rows is exact even when a match is gone", async (t) => {
  // `git ls-files` still names a tracked file deleted from the work tree.
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  for (const name of ["keep-a.py", "keep-b.py", "gone.py"]) put(project, name);
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "three");
  unlinkSync(join(project, "gone.py"));
  await world.dispatch(searchEnter(".py"));
  await world.settle();
  assert.deepEqual(modal.rows().toSorted(), ["keep-a.py", "keep-b.py"]);
  assert.deepEqual(modal.labels(), [fill(slackTexts.OPEN_ROWS_MATCH, { count: 2 })]);
});

test("Enter leaves out a file whose path is too long for a button", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  const longName = "z".repeat(140);
  put(project, `${longName}/${longName}.py`);
  put(project, "short_z.py");
  await world.dispatch(searchEnter("z"));
  await world.settle();
  assert.deepEqual(modal.rows(), ["short_z.py"]);
});

test("Enter in a folder with no repository reads the disk", async (t) => {
  const world = openWorld(t);
  const modal = search(world);
  await inAThread(world);
  const plain = join(world.root, "app");
  put(plain, "plain.txt");
  put(plain, "sub/deep/plain-too.txt");
  await world.dispatch(searchEnter("plain"));
  await world.settle();
  assert.deepEqual(modal.rows().toSorted(), ["plain.txt", "sub/deep/plain-too.txt"]);
});

test("Enter in a repository inside the folder leaves out what git ignores", async (t) => {
  const world = openWorld(t);
  const modal = search(world);
  const folder = join(world.root, "app");
  const nested = realpathSync.native(committed(join(folder, "workspace")));
  put(nested, ".gitignore", ".venv/\n");
  put(nested, "docs/setup.md");
  put(nested, ".venv/lib/setup_tools.py");
  put(folder, "setup-notes.txt");
  await inAThread(world);
  await world.dispatch(searchEnter("setup"));
  await world.settle();
  assert.deepEqual(modal.rows().toSorted(), ["setup-notes.txt", "workspace/docs/setup.md"]);
});

/**
 * A repository inside the channel's folder whose config names a `clean` filter, in a world where
 * the folder is trusted and the repository is not. The filter leaves `marker` when git runs it,
 * which `command` does here once, as the control.
 */
function plantedBelow(world: World, ...command: string[]): { nested: string; marker: string } {
  const folder = join(world.root, "app");
  const nested = realpathSync.native(committed(join(folder, "workspace")));
  const marker = join(world.root, "filter-ran");
  git(nested, "config", "filter.planted.clean", `sh -c 'touch "${marker}"; cat'`);
  put(nested, ".git/info/attributes", "* filter=planted\n");
  // A tracked file of the size it was committed with: `status` reads it to tell it changed.
  put(nested, "README", "two\n");
  git(nested, ...command);
  assert.ok(existsSync(marker)); // the control: git left to itself runs the planted filter
  rmSync(marker);
  const home = join(world.root, "home");
  mkdirSync(home);
  trust(home, [realpathSync.native(folder)]);
  world.backend.repository = (directory) => trustedRepository(directory, home);
  return { nested, marker };
}

test("open alone runs no git in a nested repository the owner did not trust", async (t) => {
  // The changed files come from `git status`, which reads a changed file through the `clean`
  // filter the repository's config names. One click would run it in every repository below the
  // folder, also where the agent never went.
  const world = openWorld(t);
  const modal = search(world);
  const { marker } = plantedBelow(world, "status", "--porcelain");
  await inAThread(world);
  await askedOpen(world, "!open");
  await world.settle();
  assert.ok(modal.rows().every((row) => !row.startsWith("workspace/")));
  assert.ok(!existsSync(marker));
});

test("a search runs no git in a nested repository the owner did not trust", async (t) => {
  // The folder is trusted, the repository inside it is not: git would read the repository's own
  // config. Its files come from the walk of the disk, the ones its `.gitignore` names too.
  const world = openWorld(t);
  const modal = search(world);
  const { nested, marker } = plantedBelow(world, "diff-files", "--shortstat");
  put(nested, ".gitignore", ".venv/\n");
  put(nested, "docs/guide.md");
  put(nested, ".venv/lib/guide_tools.py");
  await inAThread(world);
  await world.dispatch(searchEnter("guide"));
  await world.settle();
  assert.deepEqual(modal.rows().toSorted(), [
    "workspace/.venv/lib/guide_tools.py",
    "workspace/docs/guide.md",
  ]);
  assert.ok(!existsSync(marker));
});

test("Enter resolves in the folder of the thread s own session", async (t) => {
  // The channel was bound to another folder after the thread began.
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  const elsewhere = join(world.root, "elsewhere");
  put(elsewhere, "only_there.py");
  put(project, "only_here.py");
  world.state.bind(CHANNEL, elsewhere);
  await world.dispatch(searchEnter("only"));
  await world.settle();
  assert.deepEqual(modal.rows(), ["only_here.py"]);
});

test("Enter takes the old message away and posts a new one, never rewriting it", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  put(project, "src/parser.py");
  await askedOpen(world, "!open");
  await world.dispatch(searchEnter("pars"));
  // Rewriting an ephemeral message through `response_url` showed it in the channel too.
  assert.deepEqual(responses, [{ delete_original: true }]);
  const [first, second] = searchPosts(world);
  assert.ok(first && second && second.thread_ts === THREAD && second.channel === CHANNEL);
  assert.equal(modal.field(), "pars");
  assert.deepEqual(modal.rows(), ["src/parser.py"]);
  assert.deepEqual(
    calls(world, "chat.update").filter((call) => call.ts === undefined),
    [],
  );
});

test("an empty field shows the changed files again", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  put(project, "new.py");
  await world.dispatch(searchEnter("new"));
  await world.dispatch(searchEnter(""));
  assert.equal(modal.field(), undefined);
  assert.deepEqual(modal.rows(), ["new.py"]);
  assert.deepEqual(modal.labels(), [slackTexts.OPEN_CHANGED_ONE]);
});

test("Enter with words that match nothing says so, and keeps the words in the field", async (t) => {
  const world = openWorld(t);
  projectOf(world);
  const modal = search(world);
  await inAThread(world);
  await world.dispatch(searchEnter("nothing-like-it"));
  assert.equal(modal.field(), "nothing-like-it");
  assert.deepEqual(modal.rows(), []);
  assert.deepEqual(modal.labels(), [fill(slackTexts.OPEN_NO_MATCH, { words: "nothing-like-it" })]);
});

test("Enter in a thread that holds no session searches nothing", async (t) => {
  const world = openWorld(t);
  projectOf(world);
  await world.dispatch(searchEnter("read"));
  assert.deepEqual(searchPosts(world), []);
  assert.deepEqual(responses, []);
  assert.deepEqual(world.ephemerals(), [texts.NOT_A_SESSION]);
});

test("Enter in a refused channel searches nothing", async (t) => {
  const world = openWorld(t);
  projectOf(world);
  await inAThread(world);
  world.slack.responses["conversations.members"] = { ok: true, members: [OWNER, BOT, STRANGER] };
  await world.dispatch(searchEnter("read"));
  assert.deepEqual(searchPosts(world), []);
  assert.deepEqual(world.ephemerals(), [
    fill(slackTexts.CHANNEL_REFUSED, { reason: slackTexts.REASON_MEMBERS }),
  ]);
});

for (const [user, team] of ANYONE_ELSE) {
  test(`Enter by anyone else searches nothing [${user}-${team}]`, async (t) => {
    const world = openWorld(t);
    projectOf(world);
    await inAThread(world);
    const before = world.slack.apiCalls.length;
    await world.dispatch(searchEnter("READ", { id: user, team_id: team }));
    await world.settle();
    assert.equal(world.slack.apiCalls.length, before);
    assert.deepEqual(responses, []);
  });

  test(`a file button clicked by anyone else shares nothing [${user}-${team}]`, async (t) => {
    const world = openWorld(t);
    const project = projectOf(world);
    await inAThread(world);
    put(project, "a.py");
    const before = world.slack.apiCalls.length;
    await world.dispatch(fileClick("a.py", { id: user, team_id: team }));
    await world.settle();
    assert.equal(world.slack.apiCalls.length, before);
    assert.deepEqual(responses, []);
  });
}

test("a file button shares the file into the thread and takes the message away", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "docs/guide.md", "# Guide\n");
  await askedOpen(world, "!open");
  await world.dispatch(fileClick("docs/guide.md"));
  const done = only(opened(world));
  assert.ok(done.channel_id === CHANNEL && done.thread_ts === THREAD);
  assert.deepEqual(done.files, [{ id: "F000FILE", title: "docs/guide.md" }]);
  assert.deepEqual(responses, [{ delete_original: true }]);
  assert.deepEqual(world.ephemerals(), [slackTexts.OPEN_FALLBACK]); // the one shown, no other
});

test("a click with no response url still shares the file", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "a.py");
  const body = fileClick("a.py");
  delete body.response_url;
  await world.dispatch(body);
  assert.equal(opened(world).length, 1);
});

test("a file button in a thread that holds no session shares nothing", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  put(project, "a.py");
  await world.dispatch(fileClick("a.py"));
  assert.deepEqual(opened(world), []);
  assert.deepEqual(world.ephemerals(), [texts.NOT_A_SESSION]);
});

test("a file button in a refused channel shares nothing", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "a.py");
  world.slack.responses["conversations.members"] = { ok: true, members: [OWNER, BOT, STRANGER] };
  await world.dispatch(fileClick("a.py"));
  assert.deepEqual(opened(world), []);
  assert.deepEqual(world.ephemerals(), [
    fill(slackTexts.CHANNEL_REFUSED, { reason: slackTexts.REASON_MEMBERS }),
  ]);
});

test("a button whose value is no string shares nothing", async (t) => {
  const world = openWorld(t);
  projectOf(world);
  await inAThread(world);
  const body = fileClick("a.py");
  delete body.actions[0].value;
  await world.dispatch(body);
  assert.deepEqual(opened(world), []);
});

test("a path too long for a button is not offered, and stays reachable by its name", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  const longName = "z".repeat(140);
  put(project, `${longName}/${longName}.py`);
  put(project, "short_z.py");
  await askedOpen(world, "!open z");
  assert.deepEqual(modal.rows(), ["short_z.py"]);
});

test("the message stays so another file can be chosen after a failure", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "empty.txt", "");
  put(project, "b.py");
  await askedOpen(world, "!open");
  await world.dispatch(fileClick("empty.txt"));
  await world.dispatch(fileClick("b.py"));
  assert.equal(opened(world).length, 1);
  assert.deepEqual(calls(world, "chat.delete"), []);
});

for (const value of ["../outside.txt", "link.txt", "dir-link/secret.txt", "/etc/hosts", "docs"]) {
  test(`a button value that leaves the folder or is no file is refused [${value}]`, {
    ...SYMLINKS,
  }, async (t) => {
    const world = openWorld(t);
    const project = projectOf(world);
    await inAThread(world);
    // Both `../outside.txt` and `dir-link/secret.txt` name a file that exists, so that only the
    // rule keeps them from being shared.
    const secret = put(world.tmpPath, "outside.txt");
    put(world.root, "outside.txt");
    put(world.tmpPath, "secret.txt");
    symlinkSync(secret, join(project, "link.txt"));
    symlinkSync(world.tmpPath, join(project, "dir-link"));
    mkdirSync(join(project, "docs"));
    await world.dispatch(fileClick(value));
    assert.ok(opened(world).length === 0 && world.slack.uploaded.length === 0);
    assert.deepEqual(world.ephemerals(), [fill(slackTexts.OPEN_NOT_A_FILE, { path: value })]);
  });
}

/** What the app's logger is asked to write at `info` from here on. */
function loggedInfo(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(logger, "info", (line: string) => lines.push(line));
  return lines;
}

test("a file the daemon may not read is told as no file, and the log names the code", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "no closed file" : false,
}, async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  const file = put(project, "notes.md");
  chmodSync(file, 0o000);
  // The world removes the folder first, in the other order than the file would be restored.
  t.after(() => existsSync(file) && chmodSync(file, 0o600));
  const lines = loggedInfo(t);
  await world.dispatch(fileClick("notes.md"));
  assert.deepEqual(world.ephemerals(), [fill(slackTexts.OPEN_NOT_A_FILE, { path: "notes.md" })]);
  const unread = lines.filter((line) => line.includes("could not open"));
  assert.equal(unread.length, 1, lines.join("\n"));
  const line = String(unread[0]);
  assert.ok(line.includes("EACCES"));
  assert.ok(!line.includes("notes.md")); // the code, never the path
});

test("a value that leaves the folder logs no cause", SYMLINKS, async (t) => {
  const world = openWorld(t);
  await inAThread(world);
  put(world.tmpPath, "outside.txt");
  put(world.root, "outside.txt");
  const lines = loggedInfo(t);
  await world.dispatch(fileClick("../outside.txt"));
  assert.deepEqual(world.ephemerals(), [
    fill(slackTexts.OPEN_NOT_A_FILE, { path: "../outside.txt" }),
  ]);
  assert.deepEqual(
    lines.filter((line) => line.includes("could not open")),
    [],
  );
});

test("open resolves in the folder of the thread s own session", async (t) => {
  // The channel was bound to another folder after the thread began.
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  const elsewhere = join(world.root, "elsewhere");
  put(elsewhere, "only_there.py");
  put(project, "only_here.py");
  world.state.bind(CHANNEL, elsewhere);
  await world.dispatch(fileClick("only_there.py"));
  assert.deepEqual(opened(world), []);
  await world.dispatch(fileClick("only_here.py"));
  assert.equal(opened(world).length, 1);
});

test("open with the path of a file shares it into the thread", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "docs/guide.md", "# Guide\n");
  const posts = calls(world, "chat.postMessage").length;
  await askedOpen(world, "!open docs/guide.md");
  const asked = only(calls(world, "files.getUploadURLExternal"));
  assert.ok(asked.filename === "guide.md" && asked.length === Buffer.byteLength("# Guide\n"));
  assert.deepEqual(
    world.slack.uploaded.map((upload) => upload.data),
    [Buffer.from("# Guide\n")],
  );
  const done = only(opened(world));
  assert.ok(done.channel_id === CHANNEL && done.thread_ts === THREAD);
  assert.deepEqual(done.files, [{ id: "F000FILE", title: "docs/guide.md" }]);
  // No line of its own on success: the file is the answer.
  assert.equal(calls(world, "chat.postMessage").length, posts);
  assert.deepEqual(world.ephemerals(), []);
});

test("a path needs no git", async (t) => {
  const world = openWorld(t);
  await inAThread(world);
  put(join(world.root, "app"), "plain.txt");
  await askedOpen(world, "!open plain.txt");
  assert.equal(opened(world).length, 1);
});

test("a name that matches one file opens it", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "src/Parser.py");
  put(project, "src/lexer.py");
  await askedOpen(world, "!open PARS");
  const done = only(opened(world));
  assert.equal(done.files[0].title, "src/Parser.py");
});

test("a file made after a name matched nothing is found by the next search", async (t) => {
  // A kept listing is never the reason for "no match": it is made again first.
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  await askedOpen(world, "!open zzz");
  assert.deepEqual(search(world).labels(), [fill(slackTexts.OPEN_NO_MATCH, { words: "zzz" })]);
  put(project, "src/zzz-made-since.py");
  await askedOpen(world, "!open zzz");
  const done = only(opened(world));
  assert.equal(done.files[0].title, "src/zzz-made-since.py");
});

test("Enter finds a file made after the search matched nothing", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  const modal = search(world);
  await inAThread(world);
  await world.dispatch(searchEnter("qqq"));
  await world.settle();
  assert.deepEqual(modal.rows(), []);
  assert.deepEqual(modal.labels(), [fill(slackTexts.OPEN_NO_MATCH, { words: "qqq" })]);
  put(project, "qqq-made-since.py");
  await world.dispatch(searchEnter("qqq-"));
  await world.settle();
  assert.deepEqual(modal.rows(), ["qqq-made-since.py"]);
});

test("a name that matches nothing in a listing that was cut says so", async (t) => {
  const world = worldWith(t, (lookup) => new CutListings(lookup, ["a/other.py"]));
  const modal = search(world);
  await inAThread(world);
  await askedOpen(world, "!open nothing-like-it");
  assert.deepEqual(opened(world), []);
  assert.deepEqual(modal.labels(), [
    fill(slackTexts.OPEN_NO_MATCH_PARTIAL, { words: "nothing-like-it" }),
  ]);
});

test("the only match of a listing that was cut is not opened on its own", async (t) => {
  const world = worldWith(t, (lookup) => new CutListings(lookup, ["a/one.py"]));
  const modal = search(world);
  await inAThread(world);
  put(join(world.root, "app"), "a/one.py");
  await askedOpen(world, "!open one");
  assert.deepEqual(opened(world), []);
  assert.equal(modal.field(), "one");
  assert.deepEqual(modal.rows(), ["a/one.py"]);
  assert.deepEqual(modal.labels(), [slackTexts.OPEN_ROWS_MATCH_ONE, slackTexts.OPEN_PARTIAL]);
});

test("a cut listing is said under Enter's matches too", async (t) => {
  const world = worldWith(t, (lookup) => new CutListings(lookup, ["a/one.py"]));
  const modal = search(world);
  await inAThread(world);
  put(join(world.root, "app"), "a/one.py");
  await world.dispatch(searchEnter("zzz"));
  assert.deepEqual(modal.labels(), [fill(slackTexts.OPEN_NO_MATCH_PARTIAL, { words: "zzz" })]);
  await world.dispatch(searchEnter("one"));
  assert.deepEqual(modal.rows(), ["a/one.py"]);
  assert.deepEqual(modal.labels(), [slackTexts.OPEN_ROWS_MATCH_ONE, slackTexts.OPEN_PARTIAL]);
});

test("a file over one megabyte is refused", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  writeFileSync(join(project, "big.log"), Buffer.alloc((1 << 20) + 1, "x"));
  await askedOpen(world, "!open big.log");
  assert.deepEqual(calls(world, "files.getUploadURLExternal"), []);
  assert.deepEqual(world.ephemerals(), [
    fill(named(slackTexts.OPEN_TOO_LARGE, NAMES), { path: "big.log" }),
  ]);
});

test("an empty file is refused before anything is uploaded", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "empty.txt", "");
  await askedOpen(world, "!open empty.txt");
  assert.deepEqual(calls(world, "files.getUploadURLExternal"), []);
  assert.deepEqual(world.slack.uploaded, []);
  assert.deepEqual(world.ephemerals(), [fill(slackTexts.OPEN_EMPTY, { path: "empty.txt" })]);
  // Chosen as a button it is the same file, with the same answer.
  await world.dispatch(fileClick("empty.txt"));
  assert.deepEqual(world.slack.uploaded, []);
  assert.deepEqual(
    world.ephemerals(),
    Array(2).fill(fill(slackTexts.OPEN_EMPTY, { path: "empty.txt" })),
  );
});

test("without the files write scope the owner is told what to do", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "a.md");
  world.slack.responses["files.getUploadURLExternal"] = { ok: false, error: "missing_scope" };
  await askedOpen(world, "!open a.md");
  assert.deepEqual(world.ephemerals(), [slackTexts.OPEN_NO_SCOPE]);
  assert.ok(slackTexts.OPEN_NO_SCOPE.includes("files:write"));
  assert.ok(slackTexts.OPEN_NO_SCOPE.includes("slack-app-manifest.json"));
});

test("another slack failure names its code and no file content", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "a.md", "secret words\n");
  world.slack.responses["files.completeUploadExternal"] = { ok: false, error: "ratelimited" };
  await askedOpen(world, "!open a.md");
  assert.deepEqual(world.ephemerals(), [
    fill(slackTexts.OPEN_FAILED, { path: "a.md", error: "ratelimited" }),
  ]);
});

test("a word outside a session s thread is answered as bypass is", async (t) => {
  const world = openWorld(t);
  projectOf(world);
  await world.dispatch(message("!open"));
  await world.dispatch(reply("!open", OTHER_THREAD)); // a thread that holds no session
  assert.deepEqual(said(world), [texts.OPEN_TOP_LEVEL, texts.OPEN_TOP_LEVEL]);
  assert.deepEqual(searchPosts(world), []);
  assert.deepEqual(opened(world), []);
});

test("a name is looked up in a folder with no repository", async (t) => {
  const world = openWorld(t);
  await inAThread(world);
  const plain = join(world.root, "app");
  put(plain, "docs/Guide.md");
  put(plain, "other.txt");
  await askedOpen(world, "!open guide");
  const done = only(opened(world));
  assert.equal(done.files[0].title, "docs/Guide.md");
  assert.deepEqual(world.ephemerals(), []);
});

for (const ts of ["", "abc", "1790000000.x", "-5", "1790000000 +0000", "@{1}", "../x"]) {
  test(`a thread ts that is no epoch second gives no start [${ts === "" ? "empty" : ts}]`, () => {
    assert.equal(startedAt(ts), null);
  });
}

test("a shared file takes the message back, and a refused one leaves it", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "empty.md", "");
  put(project, "full.md");
  await world.dispatch(fileClick("empty.md"));
  assert.equal(responses.length, 0);
  await world.dispatch(fileClick("full.md"));
  assert.equal(responses.length, 1);
});

test("a second click while the first is at work shares nothing more", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "a.md");
  await Promise.all([world.dispatch(fileClick("a.md")), world.dispatch(fileClick("a.md"))]);
  assert.equal(world.slack.uploaded.length, 1);
});

test("a message's second Enter posts no second message", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  put(project, "guide.md");
  const posts = () => calls(world, "chat.postEphemeral").length;
  const before = posts();
  const enter = searchEnter("guide");
  await world.dispatch(enter);
  await world.dispatch(enter);
  assert.equal(posts(), before + 1);
});

test("long paths ahead of a short match leave its button", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  const deep = "d".repeat(150);
  for (let at = 0; at < 5; at += 1) put(project, `${deep}/needle${at}.md`);
  put(project, "needle-dir/a.md");
  await world.dispatch(searchEnter("needle"));
  const posted = calls(world, "chat.postEphemeral").at(-1);
  assert.ok(JSON.stringify(posted?.blocks).includes("needle-dir/a.md"));
});

test("a failed post keeps the message, and its field answers again", async (t) => {
  const world = openWorld(t);
  const project = projectOf(world);
  await inAThread(world);
  await world.settle();
  put(project, "guide.md");
  const failing = world.slack.responses["chat.postEphemeral"];
  world.slack.responses["chat.postEphemeral"] = { ok: false, error: "ratelimited" };
  const enter = searchEnter("guide");
  await world.dispatch(enter);
  assert.equal(responses.length, 0);
  if (failing === undefined) delete world.slack.responses["chat.postEphemeral"];
  else world.slack.responses["chat.postEphemeral"] = failing;
  await world.dispatch(enter);
  assert.equal(responses.length, 1);
});
