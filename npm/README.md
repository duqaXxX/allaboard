# allaboard

Your Claude Code workspace in Slack.

All your projects, all your sessions and all your Macs, in the one app you already keep open.
Connect every Mac you work on and every Claude Code account you use to the same Slack, and each
of them is one message away. Each project is a channel, each session is a thread: follow the work
as Claude writes it, approve a command with one tap, and pick any session up again days later.
Claude Code keeps running on each Mac, with its own files and its own setup.

## Install

```sh
npm install -g allaboard
```

The [setup guide](https://github.com/duqaXxX/allaboard/blob/v{{VERSION}}/docs/setup.md) says which
systems this version supports, and takes you through
[creating the Slack app](https://github.com/duqaXxX/allaboard/blob/v{{VERSION}}/docs/setup.md#part-1-the-slack-app)
from [`slack-app-manifest.json`](https://github.com/duqaXxX/allaboard/blob/v{{VERSION}}/slack-app-manifest.json),
the settings, and the service that starts allaboard at login. `allaboard setup` asks for the
tokens, checks each with Slack, writes the configuration and offers to install the service
(`allaboard service install` does that later):

```sh
allaboard setup
```

To bring another Mac or another Claude Code account into the same Slack, see
[the guide's Part 6](https://github.com/duqaXxX/allaboard/blob/v{{VERSION}}/docs/setup.md#part-6-a-second-instance).

## Update

When a new version is out, the bot's Home tab offers it with an Update button, and
`!allaboard update` offers it in any channel. Running turns finish first, then allaboard restarts
on the new version. From a terminal:

```sh
allaboard update
```

## More

- Documentation and source: [github.com/duqaXxX/allaboard](https://github.com/duqaXxX/allaboard)
- Security model: [SECURITY.md](https://github.com/duqaXxX/allaboard/blob/v{{VERSION}}/SECURITY.md)
- License: MIT
