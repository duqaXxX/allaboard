# allaboard

Your Claude Code workspace in Slack.

All your projects, all your sessions and all your Macs, in the one app you already keep open.
Connect every Mac you work on and every Claude Code account you use to the same Slack, and each
of them is one message away. Start a task at your desk, follow it from your phone, approve a
command with one tap, and pick the work up again next week right where it stopped. Claude Code
keeps running on each Mac, with its own files and its own setup.

<!-- Demo recording goes here: a reply growing in a thread, an Approve click, the footer. -->

## Why work from Slack

### Every Mac in one Slack

Your desktop at the office, your laptop at home, a second Claude Code account for a client: each
one gets its own bot, and all of them live side by side in the same Slack. To work on another
machine, you open one of its channels.

### Everything in one view

Each project is a channel, each session is a thread. Each bot's Home tab shows its sessions at a
glance: what is working, what is waiting for you, what is done.

### Sessions that stay

Come back to a thread days later and carry on. A session you started in the terminal continues
in Slack with `!resume`.

### Watch Claude work

The reply is written in front of you as Claude works, with every command it runs and every edit
it makes. When it is done, a short summary closes the thread: branch, lines changed, model,
context and usage.

### In control from anywhere

Approve or Deny with a button, answer Claude's questions in a form, stop a turn with `!stop`.
At your desk or on the train, it works the same.

### All of Claude Code

Type `!` where the terminal takes `/`: `!compact`, `!model opus`, and every new command the day
it ships. Drop an image or a file into the message and Claude gets it.

### One-click updates

When a new version is out, the Home tab offers it with an Update button. Running work finishes
first, then allaboard restarts on the new version.

## Before you install

- macOS 13 or later, on a Mac that stays awake. allaboard runs as a LaunchAgent in your login
  session, through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).
- Claude Code logged in with a claude.ai subscription, and [Node 22.19](https://nodejs.org/) or
  later. It can sit beside the Node your terminal uses: see
  [A Node of its own](docs/setup.md#a-node-of-its-own).
- A Slack workspace where you are the only member. The bot answers you and nobody else, but a
  workspace admin could still read or export what Claude prints, and whoever controls your Slack
  account controls the machine. A free workspace allows 10 apps, one per instance.
- Projects in a folder macOS protects, such as `~/Documents` or `~/Desktop`, need Full Disk
  Access for the daemon.
- Status: version 0.7.0, an early release. [docs/features.md](docs/features.md) lists what is
  tested and what is still checked by hand, and [docs/limits.md](docs/limits.md) what the
  terminal does and Slack does not.

## Quick start

```bash
npm install -g allaboard
```

Then [docs/setup.md](docs/setup.md) takes you through five steps:

1. Create the Slack app from [`slack-app-manifest.json`](slack-app-manifest.json) and copy its
   tokens.
2. Run `allaboard setup`: it asks for the tokens and writes `~/.config/allaboard/.env`.
3. Trust your project folder in Claude Code.
4. Install the service: `allaboard service install`.
5. In a private channel with you and the bot, send `!bind <folder>`, then your first message.

## Commands

| Command | What it does |
|---|---|
| `!guide` | Explains how the channel works |
| `!bind <folder>` | Binds the channel to a project folder |
| `!status` | Lists the channel's sessions; in a thread, shows that session's details |
| `!stop` | Stops every session of the channel; in a thread, that one |
| `!resume` | Lists the folder's sessions, the terminal's included, with a Resume button each |
| `!bypass on` / `off` | Switches a session to `bypassPermissions` and back |
| `!open` | Shares a file of the session's folder into the thread |
| `!tag <name>` | Tags and pins the thread's first message |
| `!untag` | Takes the tag and the pin away |
| `!delete-thread` | Deletes the thread, once you confirm |
| `!allaboard` | Shows the version that runs and the latest; `update` installs the newer one, `restart` restarts |
| `!help` | Lists the commands a session offers |

Every command with its answers and limits: [docs/setup.md](docs/setup.md#using-it).

## Security model

The bot answers one Slack user in one workspace, and only in private channels whose members are
that user and the bot. Every message, button and form submission is checked on its own, and a
session starts only in a folder you have trusted in Claude Code. The tokens live in a mode-600
file. Nothing else is stored but each channel's folder and, per thread, its session id, bypass
switch, effort level, last status and the message ids a crash repair needs. See
[SECURITY.md](SECURITY.md) and the checklist in
[docs/setup.md](docs/setup.md#part-5-security-checklist).

## Documentation

- [docs/setup.md](docs/setup.md): the whole setup and every command.
- [docs/architecture.md](docs/architecture.md): how the daemon is built.
- [docs/features.md](docs/features.md): each feature and what verifies it.
- [docs/limits.md](docs/limits.md): what the terminal does and Slack does not, and why.
- [docs/CHANGELOG.md](docs/CHANGELOG.md): what changed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
