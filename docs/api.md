# Local API

Sensor listens on a named pipe on Windows (`\\.\pipe\sensor-<username>`) and on a unix socket elsewhere (`$XDG_RUNTIME_DIR/sensor-<uid>.sock` or the temp folder). `SENSOR_SOCKET` overrides the path. Messages are newline-delimited JSON-RPC 2.0. The API can be turned off with the `api.enabled` setting.

## Authenticate

The first call must be `auth`:

```json
{"jsonrpc":"2.0","id":1,"method":"auth","params":{"token":"snsr_..."}}
```

- On first start Sensor creates a CLI token in its data folder (`cli-token`, readable only by you). It has every scope except `auth:admin`, `files:delete`, `git:destructive`, `forms:submit`, `scripts:exec` and `backup:write`.
- Create narrower or broader tokens in the app (Settings), or with `sensor auth grant <name> <scope,...>` from an admin token.
- Tokens are stored hashed. `sensor auth list` and `sensor auth revoke <id>` manage them.

## Call commands

Every command in the registry is an API method:

```json
{"jsonrpc":"2.0","id":2,"method":"tabs.open","params":{"url":"https://example.com"}}
{"jsonrpc":"2.0","id":3,"method":"commands.list","params":{}}
{"jsonrpc":"2.0","id":4,"method":"commands.describe","params":{"id":"macros.run"}}
```

`commands.list` returns, for each command, its id, title, parameter schema (type, required, default, enum, positional index), required scopes and whether it is destructive. The CLI generates its help and argument parsing from this list.

When a token lacks a scope, Sensor asks the user in the app ("Allow once" / "Deny"). If there is nobody to ask, the call fails with `-32003`.

| code | meaning |
|---|---|
| -32001 | not authenticated |
| -32003 | forbidden (missing scope, denied) |
| -32601 | unknown command |
| -32602 | invalid parameters |
| -32603 | command failed (message says why) |

## Events

```json
{"jsonrpc":"2.0","id":5,"method":"events.subscribe","params":{"topics":["download.*","macro.completed"]}}
```

Events arrive as `{"jsonrpc":"2.0","method":"event","params":{"seq":42,"ts":...,"topic":"download.completed","data":{...}}}`. The `seq` number goes up by one per event, so you can spot gaps. You only receive events whose scope your token has (for example `tab.*` needs `tabs:read`).

Common topics:

- tabs and pages: `tab.opened`, `tab.changed`, `tab.closed`, `page.navigated`, `page.recognized`
- downloads: `download.started`, `download.completed`
- notes: `note.saved`, `note.changed`, `annotation.changed`
- macros and triggers: `macro.started`, `macro.completed`, `macro.failed`, `macro.waiting`, `trigger.fired`
- dev environment: `task.changed`, `agent.started`, `agent.exited`, `worktree.created`, `git.merged`
- AI: `ai.sent`, `ai.captured`
- backups: `backup.created`
- settings and notifications: `settings.changed`, `notification.posted`

## Scopes

`sensor raw auth.scopes` lists them all with descriptions. The ones that matter most:

| scope | allows |
|---|---|
| `page:interact` | clicking, typing and scripts inside web pages |
| `forms:submit` | pressing send/submit on websites (AI sites included) |
| `files:delete` | deleting files (to the recycle bin) |
| `git:destructive` | writing to protected branches, removing worktrees |
| `scripts:exec` | running shell commands (task validation) |
| `backup:write` | creating and restoring checkpoints |
| `auth:admin` | managing tokens |
