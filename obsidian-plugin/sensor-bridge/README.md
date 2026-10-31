# Sensor Bridge (Obsidian plugin)

Connects your real Obsidian app to Sensor's local API. Sensor never replaces Obsidian's editor; this plugin lets the two work together.

What it does:

- Inserts text at your cursor when Sensor asks (`sensor obsidian insert "..."`, "Insert Link To Current Tab In Obsidian" in Sensor's palette).
- Obsidian commands: insert a link to Sensor's current tab, insert the current page as markdown, insert the selected text as a quote, open the note's web links in Sensor, search Sensor for the selection.
- Shows `Sensor ●` in the status bar while connected.

## Install

1. Copy `manifest.json` and `main.js` into `<your vault>/.obsidian/plugins/sensor-bridge/`.
2. In Obsidian: Settings → Community plugins → enable **Sensor Bridge**.
3. Start Sensor. The plugin reads the token Sensor creates at `%APPDATA%\Sensor\data\cli-token` (Windows), `~/Library/Application Support/Sensor/data/cli-token` (macOS) or `~/.config/Sensor/data/cli-token` (Linux).

To limit what the plugin can do, create a narrower token in Sensor and paste it into the plugin settings:

```
sensor auth grant obsidian notes:read,notes:write,tabs:read,tabs:write,page:read,search:read
```

Desktop only (it needs Node's `net` module to reach the local pipe/socket).
