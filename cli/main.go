// sensor: command-line client for the Sensor local API.
//
//	sensor help [group|command]
//	sensor <group> <verb> [positional...] [--param value] [--flag]
//	sensor events watch [topic...]
//	sensor raw <method> [json-params]
//
// Commands, their parameters and help text come from the running app's command
// registry, so the CLI never drifts from the GUI.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type client struct {
	conn io.ReadWriteCloser
	r    *bufio.Reader
	id   int
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcMsg struct {
	ID     *int            `json:"id"`
	Method string          `json:"method"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
	Params json.RawMessage `json:"params"`
}

type paramSpec struct {
	Type        string   `json:"type"`
	Required    bool     `json:"required"`
	Description string   `json:"description"`
	Enum        []string `json:"enum"`
	Positional  *int     `json:"positional"`
}

type commandInfo struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Category    string               `json:"category"`
	Scopes      []string             `json:"scopes"`
	Destructive bool                 `json:"destructive"`
	Params      map[string]paramSpec `json:"params"`
	Shortcut    string               `json:"shortcut"`
}

func defaultDataDir() string {
	if d := os.Getenv("SENSOR_DATA_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		appdata := os.Getenv("APPDATA")
		if appdata == "" {
			appdata = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appdata, "Sensor", "data")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Sensor", "data")
	default:
		cfg := os.Getenv("XDG_CONFIG_HOME")
		if cfg == "" {
			cfg = filepath.Join(home, ".config")
		}
		return filepath.Join(cfg, "Sensor", "data")
	}
}

func token() (string, error) {
	if t := os.Getenv("SENSOR_TOKEN"); t != "" {
		return t, nil
	}
	b, err := os.ReadFile(filepath.Join(defaultDataDir(), "cli-token"))
	if err != nil {
		return "", fmt.Errorf("no token: set SENSOR_TOKEN or start Sensor once to create %s", filepath.Join(defaultDataDir(), "cli-token"))
	}
	return strings.TrimSpace(string(b)), nil
}

func connect() (*client, error) {
	path := defaultSocket()
	conn, err := dial(path)
	if err != nil {
		return nil, fmt.Errorf("cannot reach Sensor at %s (is it running?): %w", path, err)
	}
	c := &client{conn: conn, r: bufio.NewReaderSize(conn, 1<<20)}
	tok, err := token()
	if err != nil {
		return nil, err
	}
	if _, err := c.call("auth", map[string]any{"token": tok}); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *client) send(method string, params any) (int, error) {
	c.id++
	msg := map[string]any{"jsonrpc": "2.0", "id": c.id, "method": method, "params": params}
	b, err := json.Marshal(msg)
	if err != nil {
		return 0, err
	}
	_, err = c.conn.Write(append(b, '\n'))
	return c.id, err
}

func (c *client) read() (*rpcMsg, error) {
	line, err := c.r.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var m rpcMsg
	if err := json.Unmarshal(line, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (c *client) call(method string, params any) (json.RawMessage, error) {
	id, err := c.send(method, params)
	if err != nil {
		return nil, err
	}
	for {
		m, err := c.read()
		if err != nil {
			return nil, err
		}
		if m.ID == nil || *m.ID != id {
			continue // event notification or stale reply
		}
		if m.Error != nil {
			return nil, fmt.Errorf("%s (code %d)", m.Error.Message, m.Error.Code)
		}
		return m.Result, nil
	}
}

func (c *client) commands() ([]commandInfo, error) {
	raw, err := c.call("commands.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var list []commandInfo
	err = json.Unmarshal(raw, &list)
	return list, err
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "sensor:", err)
	os.Exit(1)
}

func main() {
	args := os.Args[1:]
	output := ""
	// global flags
	rest := args[:0:0]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			output = "json"
		case "--table":
			output = "table"
		case "--version":
			fmt.Println("sensor cli 0.1.0")
			return
		default:
			rest = append(rest, args[i])
		}
	}
	args = rest
	if output == "" {
		if fi, err := os.Stdout.Stat(); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
			output = "table"
		} else {
			output = "json"
		}
	}
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		args = []string{"help"}
	}

	c, err := connect()
	if err != nil {
		die(err)
	}
	defer c.conn.Close()

	switch args[0] {
	case "help":
		cmds, err := c.commands()
		if err != nil {
			die(err)
		}
		printHelp(cmds, args[1:])
		return
	case "raw":
		if len(args) < 2 {
			die(errors.New("usage: sensor raw <method> [json-params]"))
		}
		params := json.RawMessage("{}")
		if len(args) > 2 {
			params = json.RawMessage(args[2])
		}
		res, err := c.call(args[1], params)
		if err != nil {
			die(err)
		}
		printResult(res, output)
		return
	case "events":
		if len(args) >= 2 && (args[1] == "watch" || args[1] == "subscribe") {
			watch(c, args[2:])
			return
		}
	case "status":
		args = []string{"app.status"}
	}

	cmds, err := c.commands()
	if err != nil {
		die(err)
	}
	byID := map[string]commandInfo{}
	for _, ci := range cmds {
		byID[ci.ID] = ci
	}
	var cmd commandInfo
	var ok bool
	var params []string
	if len(args) >= 2 {
		cmd, ok = byID[args[0]+"."+args[1]]
		params = args[2:]
	}
	if !ok {
		cmd, ok = byID[args[0]]
		params = args[1:]
	}
	if !ok {
		suggest(cmds, args)
		os.Exit(2)
	}
	if len(params) == 1 && (params[0] == "-h" || params[0] == "--help") {
		printCommand(cmd)
		return
	}
	p, err := parseParams(cmd, params)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sensor:", err)
		printCommand(cmd)
		os.Exit(2)
	}
	res, err := c.call(cmd.ID, p)
	if err != nil {
		die(err)
	}
	printResult(res, output)
}

func parseParams(cmd commandInfo, args []string) (map[string]any, error) {
	out := map[string]any{}
	type pos struct {
		name string
		at   int
	}
	var positional []pos
	for name, spec := range cmd.Params {
		if spec.Positional != nil {
			positional = append(positional, pos{name, *spec.Positional})
		}
	}
	sort.Slice(positional, func(i, j int) bool { return positional[i].at < positional[j].at })
	pi := 0
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "--") {
			key := strings.TrimPrefix(a, "--")
			var val string
			hasVal := false
			if k, v, found := strings.Cut(key, "="); found {
				key, val, hasVal = k, v, true
			}
			key = camel(key)
			spec, known := cmd.Params[key]
			if !known {
				if strings.HasPrefix(key, "no") {
					if s2, k2 := cmd.Params[lowerFirst(strings.TrimPrefix(key, "no"))]; k2 && s2.Type == "boolean" {
						out[lowerFirst(strings.TrimPrefix(key, "no"))] = false
						continue
					}
				}
				return nil, fmt.Errorf("unknown option --%s", key)
			}
			if spec.Type == "boolean" && !hasVal {
				if i+1 < len(args) && (args[i+1] == "true" || args[i+1] == "false") {
					val = args[i+1]
					i++
				} else {
					out[key] = true
					continue
				}
			} else if !hasVal {
				if i+1 >= len(args) {
					return nil, fmt.Errorf("--%s needs a value", key)
				}
				val = args[i+1]
				i++
			}
			out[key] = convert(spec, val)
			continue
		}
		if pi >= len(positional) {
			// extra positional args join the last string/array positional
			if len(positional) > 0 {
				last := positional[len(positional)-1].name
				if s, ok := out[last].(string); ok {
					out[last] = s + " " + a
					continue
				}
			}
			return nil, fmt.Errorf("unexpected argument %q", a)
		}
		name := positional[pi].name
		out[name] = convert(cmd.Params[name], a)
		pi++
	}
	for name, spec := range cmd.Params {
		if spec.Required {
			if _, ok := out[name]; !ok {
				return nil, fmt.Errorf("missing required parameter: %s", name)
			}
		}
	}
	return out, nil
}

func convert(spec paramSpec, v string) any {
	switch spec.Type {
	case "number":
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	case "boolean":
		return v == "true" || v == "1" || v == "yes"
	case "array":
		var arr []any
		if strings.HasPrefix(v, "[") && json.Unmarshal([]byte(v), &arr) == nil {
			return arr
		}
		parts := strings.Split(v, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	case "object", "any":
		var obj any
		if json.Unmarshal([]byte(v), &obj) == nil {
			return obj
		}
	}
	return v
}

func camel(s string) string {
	parts := strings.Split(s, "-")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

func kebab(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r + 32)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func watch(c *client, topics []string) {
	if len(topics) == 0 {
		topics = []string{"*"}
	}
	if _, err := c.call("events.subscribe", map[string]any{"topics": topics}); err != nil {
		die(err)
	}
	fmt.Fprintf(os.Stderr, "watching %s (Ctrl+C to stop)\n", strings.Join(topics, ", "))
	enc := json.NewEncoder(os.Stdout)
	for {
		m, err := c.read()
		if err != nil {
			die(err)
		}
		if m.Method == "event" {
			var ev any
			_ = json.Unmarshal(m.Params, &ev)
			_ = enc.Encode(ev)
		}
	}
}

func printHelp(cmds []commandInfo, args []string) {
	if len(args) > 0 {
		q := strings.Join(args, ".")
		for _, c := range cmds {
			if c.ID == q {
				printCommand(c)
				return
			}
		}
		fmt.Printf("Commands in %q:\n\n", args[0])
		for _, c := range cmds {
			if strings.HasPrefix(c.ID, args[0]+".") {
				fmt.Printf("  %-28s %s\n", usageName(c.ID), c.Title)
			}
		}
		return
	}
	fmt.Println("sensor: control Sensor from the command line")
	fmt.Println()
	fmt.Println("Usage:")
	fmt.Println("  sensor <group> <verb> [args] [--option value]   run a command")
	fmt.Println("  sensor help <group> | <group> <verb>             show commands / one command")
	fmt.Println("  sensor events watch [topic ...]                  stream events (e.g. download.completed, tab.*)")
	fmt.Println("  sensor raw <method> '<json>'                     send a raw JSON-RPC call")
	fmt.Println("  --json | --table                                 output format")
	fmt.Println()
	groups := map[string]int{}
	for _, c := range cmds {
		groups[strings.Split(c.ID, ".")[0]]++
	}
	names := make([]string, 0, len(groups))
	for g := range groups {
		names = append(names, g)
	}
	sort.Strings(names)
	fmt.Println("Groups:")
	for _, g := range names {
		fmt.Printf("  %-16s %d commands\n", g, groups[g])
	}
}

func usageName(id string) string {
	parts := strings.SplitN(id, ".", 2)
	if len(parts) == 2 {
		return parts[0] + " " + kebab(parts[1])
	}
	return id
}

func printCommand(c commandInfo) {
	type p struct {
		name string
		spec paramSpec
	}
	var pos, opts []p
	for n, s := range c.Params {
		if s.Positional != nil {
			pos = append(pos, p{n, s})
		} else {
			opts = append(opts, p{n, s})
		}
	}
	sort.Slice(pos, func(i, j int) bool { return *pos[i].spec.Positional < *pos[j].spec.Positional })
	sort.Slice(opts, func(i, j int) bool { return opts[i].name < opts[j].name })
	usage := "sensor " + strings.Replace(c.ID, ".", " ", 1)
	for _, x := range pos {
		if x.spec.Required {
			usage += " <" + x.name + ">"
		} else {
			usage += " [" + x.name + "]"
		}
	}
	fmt.Printf("%s\n\n  %s\n", usage, c.Title)
	if c.Description != "" {
		fmt.Printf("  %s\n", c.Description)
	}
	if len(c.Scopes) > 0 {
		fmt.Printf("  scopes: %s\n", strings.Join(c.Scopes, ", "))
	}
	if c.Destructive {
		fmt.Println("  destructive: yes")
	}
	all := append(pos, opts...)
	if len(all) > 0 {
		fmt.Println("\nParameters:")
		for _, x := range all {
			flag := "--" + kebab(x.name)
			extra := x.spec.Type
			if len(x.spec.Enum) > 0 {
				extra = strings.Join(x.spec.Enum, "|")
			}
			req := ""
			if x.spec.Required {
				req = " (required)"
			}
			fmt.Printf("  %-22s %-10s %s%s\n", flag, extra, x.spec.Description, req)
		}
	}
}

func suggest(cmds []commandInfo, args []string) {
	fmt.Fprintf(os.Stderr, "sensor: unknown command %q\n", strings.Join(args, " "))
	q := strings.ToLower(args[0])
	n := 0
	for _, c := range cmds {
		if strings.Contains(c.ID, q) && n < 10 {
			if n == 0 {
				fmt.Fprintln(os.Stderr, "did you mean:")
			}
			fmt.Fprintf(os.Stderr, "  sensor %s\n", usageName(c.ID))
			n++
		}
	}
	if n == 0 {
		fmt.Fprintln(os.Stderr, "run `sensor help` for the list of groups")
	}
}

func printResult(raw json.RawMessage, output string) {
	if output == "json" {
		var v any
		if json.Unmarshal(raw, &v) != nil {
			os.Stdout.Write(raw)
			fmt.Println()
			return
		}
		b, _ := json.MarshalIndent(v, "", "  ")
		fmt.Println(string(b))
		return
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		os.Stdout.Write(raw)
		fmt.Println()
		return
	}
	switch t := v.(type) {
	case nil:
		fmt.Println("ok")
	case []any:
		printTable(t)
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Printf("%-16s %s\n", k+":", scalar(t[k], 200))
		}
	case string:
		fmt.Println(t)
	default:
		b, _ := json.Marshal(t)
		fmt.Println(string(b))
	}
}

func scalar(v any, max int) string {
	var s string
	switch t := v.(type) {
	case nil:
		s = ""
	case string:
		s = t
	case float64:
		s = strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		s = strconv.FormatBool(t)
	default:
		b, _ := json.Marshal(t)
		s = string(b)
	}
	s = strings.ReplaceAll(s, "\n", " ")
	if utf8.RuneCountInString(s) > max {
		r := []rune(s)
		s = string(r[:max-1]) + "…"
	}
	return s
}

func printTable(rows []any) {
	if len(rows) == 0 {
		fmt.Println("(none)")
		return
	}
	objs := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		m, ok := r.(map[string]any)
		if !ok {
			fmt.Println(scalar(r, 300))
			continue
		}
		objs = append(objs, m)
	}
	if len(objs) == 0 {
		return
	}
	// columns: scalar fields of the first row, in a stable, useful order
	prefer := []string{"id", "name", "title", "url", "path", "state", "source", "kind", "uri"}
	seen := map[string]bool{}
	var cols []string
	for _, p := range prefer {
		if _, ok := objs[0][p]; ok {
			cols = append(cols, p)
			seen[p] = true
		}
	}
	var others []string
	for k, v := range objs[0] {
		if seen[k] {
			continue
		}
		switch v.(type) {
		case map[string]any, []any:
			continue
		}
		others = append(others, k)
	}
	sort.Strings(others)
	cols = append(cols, others...)
	if len(cols) > 7 {
		cols = cols[:7]
	}
	width := make([]int, len(cols))
	cells := make([][]string, len(objs))
	for i, c := range cols {
		width[i] = len(c)
	}
	for r, o := range objs {
		cells[r] = make([]string, len(cols))
		for i, c := range cols {
			s := scalar(o[c], 60)
			cells[r][i] = s
			if n := utf8.RuneCountInString(s); n > width[i] {
				width[i] = n
			}
		}
	}
	for i, c := range cols {
		fmt.Printf("%-*s  ", width[i], strings.ToUpper(c))
	}
	fmt.Println()
	for _, row := range cells {
		for i, s := range row {
			fmt.Printf("%s%s  ", s, strings.Repeat(" ", width[i]-utf8.RuneCountInString(s)))
		}
		fmt.Println()
	}
}
