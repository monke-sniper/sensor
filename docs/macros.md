# Macros and workflows

A macro is a JSON document. Record one (palette: **Start Recording Macro**, `Ctrl+Shift+R`), build one step by step in the Macros panel, or write the JSON yourself and `sensor macros save '<json>'`.

```json
{
  "name": "Search and save",
  "description": "Search a site and save the top result to a note",
  "inputs": { "query": { "type": "string", "default": "sensor" } },
  "steps": [
    { "op": "open", "url": "https://duckduckgo.com/?q={{ query | urlencode }}" },
    { "op": "waitFor", "selectors": ["[data-testid=result]", "article"] },
    { "op": "extract", "selectors": ["[data-testid=result] h2"], "save": "title" },
    { "op": "if", "cond": "title", "then": [
      { "op": "command", "command": "notes.create", "args": { "title": "{{title}}", "body": "Found for {{query}}" } }
    ], "else": [ { "op": "fail", "message": "no results" } ] },
    { "op": "output", "name": "title", "value": "{{title}}" }
  ]
}
```

## How it runs

- Steps run in order through the command bus, as a `macro:<name>` principal.
- A macro may only use the scopes in its `scopes` list. Sensor infers them from the steps when you save. When an API token or another macro starts a run, the run gets only the scopes both sides have. So a macro never gives anyone more power than they already had.
- Running a macro needs no AI. Elements are found with recorded selector lists (`css`, `text=…`, `role=button[name=…]`, `xpath=…`), tried in order. Each element step waits for its target first (`timeout`, default 15 s).
- Every step is logged with timing. Variables marked `secret` never appear in logs or in stored run state.
- Stop all runs with `Ctrl+Shift+Esc` or `sensor macros cancel`.

## Step types

| op | fields | does |
|---|---|---|
| `open` | `url`, `incognito`, `target` (tab/panel/float) | opens a tab and makes it the macro's tab |
| `navigate` | `url` | loads a URL in the macro's tab |
| `useTab` | `id` | switches the macro's tab (default: active tab) |
| `click` | `selectors` | clicks the first visible match |
| `type` | `selectors`, `text`, `clear` | focuses and types (through the real input pipeline) |
| `select` | `selectors`, `value` | chooses an `<option>` by value or label |
| `press` | `key` (e.g. `Enter`, `Control+A`) | key press in the page |
| `waitFor` | `selectors` | waits for an element |
| `wait` | `ms` | sleeps (cancellable) |
| `extract` | `selectors`, `attr`, `all`, `format` (text/markdown/html), `save` | reads from elements |
| `read` | `format`, `save` | whole page as markdown/text/html |
| `upload` | `files`, `selector` | attaches local files to a file input |
| `screenshot` | `path` | PNG of the tab |
| `command` | `command`, `args`, `save` | runs any Sensor command (`notes.create`, `ai.ask`, `files.convert`, …) |
| `set` | `var` + `value` or `expr`, or `vars` | sets variables |
| `input` | `var`, `prompt`, `secret`, `default`, `timeout` | asks the user (Macros panel, or `sensor macros answer <run> <value>`) |
| `if` | `cond`, `then`, `else` | branches |
| `loop` | `over` / `times` / `while`, `as`, `index`, `steps`, `max` | iterates; `break` exits |
| `call` | `macro`, `args`, `save` | runs another macro; its outputs are saved |
| `output` | `name`, `value` | sets a run output |
| `checkpoint` | | marks a resume point (top-level steps) |
| `log`, `notify`, `assert`, `fail`, `stop`, `break` | | |

Fields every step can have:

- `label`: a target for `onError: "goto:<label>"`.
- `when`: skip the step unless the condition is true.
- `retry` and `retryDelay`.
- `onError`: `stop` (default), `continue` (sets `lastError`) or `goto:<label>`.
- `timeout`.
- `desc`: a note.

## Templates and expressions

`{{ ... }}` inserts a value. If a string is exactly one template (`"{{items}}"`), the value keeps its type (array, number, object).

Expressions support:

- paths: `a.b`, `a[0]`, `a['key']`
- literals: `"text"`, `12`, `true`, `null`, `[1, 2]`
- operators: `== != < <= > >= && || ! not + - * / %`
- text tests: `contains`, `matches` (regex), `startsWith`, `endsWith`
- filters: `| upper | lower | trim | length | first | last | urlencode | lines | number | string | json | keys | basename | default:x | join:", " | split:"," | slice:n`

There is no `eval` and no function calls. Unknown variables are `undefined`, not errors.

Variables available in a run:

- the inputs (also as `inputs.*`)
- anything you `save` or `set`
- `last`: the result of the previous step
- `lastError`
- loop variables
- for trigger runs, the event data

## Recording

While recording, the page preload reports trusted clicks, typing (merged per field), `<select>` changes and Enter/Escape/Tab. A navigation that you typed (one that didn't follow a click or key press) becomes a `navigate` step. Passwords are never recorded: they become a `{{password}}` secret input. Incognito tabs are never recorded.

## Triggers

```bash
sensor triggers add "Search and save" schedule --config '{"every": 60}'
sensor triggers add "Search and save" schedule --config '{"at": "08:30", "days": [1,2,3,4,5]}'
sensor triggers add "File PDFs" event --config '{"topic": "download.completed", "where": "event.path endsWith \".pdf\"", "inputs": {"file": "{{event.path}}"}}'
sensor triggers add "Import CSV" file --config '{"dir": "C:\\Users\\me\\Inbox", "pattern": "*.csv"}'
```

- Event data is passed to the macro as inputs.
- High-frequency or self-referential topics (`macro.step`, `command.ran`, `terminal.output`, …) can't be used as triggers.
- A trigger never starts a second run while its previous run is still going.
- Imported macros bring their triggers in disabled.

## Resume

When a run fails after a `checkpoint`, **Resume** (or `sensor macros resume <run>`) restarts it right after the checkpoint, with the saved variables. You can pass extra inputs, which you'll need for secrets, since those are never stored.

## Scripts

Use a script when a macro gets too complicated. Scripts are JavaScript files in `<data>/scripts` (or the `scripts.dir` setting):

```js
// @name Tidy downloads
// @description Move finished PDFs from Downloads into a Papers folder
// @scopes downloads:read, files:write
module.exports = async (sensor, args) => {
  const list = await sensor.run('downloads.list');
  let moved = 0;
  for (const d of list) {
    if (d.state === 'completed' && d.path?.endsWith('.pdf')) {
      await sensor.run('files.move', { paths: [d.path], dest: args.dest });
      moved++;
    }
  }
  console.log(`moved ${moved}`);
  return { moved };
};
```

- Run with `sensor scripts run "tidy-downloads" --args '{"dest":"C:\\Papers"}'`, or from a macro with `{ "op": "command", "command": "scripts.run", "args": { "name": "tidy-downloads" } }`.
- Each run gets a fresh worker thread and a timeout. Console output is returned with the result.
- `sensor.run` goes through the command bus as `script:<name>`, so it is limited to the `@scopes` header (and to the caller's scopes).
- The worker itself is ordinary Node.js. Treat scripts like shell scripts: only run code you trust. That is why running one needs `scripts:exec`, which the default CLI token doesn't have.
