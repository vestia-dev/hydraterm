# hydraterm

**Status: early work in progress.** Script discovery, watching, and the multi-process
OpenTUI dashboard work.

A Bun-native terminal process dashboard: auto-detects npm scripts, runs
them together, restarts on file change, and lets you navigate between
them as terminal panes backed by Ghostty's VT engine. See [fidelity limits](docs/fidelity.md)
for the current parser and renderer boundary.

To install dependencies:

```bash
bun install
```

On first run, Hydraterm discovers every root and workspace script, presents a picker,
then saves the selection as named processes in the root `package.json`:

```bash
hydraterm
```

After configuration exists, Hydraterm shows every configured process and starts those with
`autoStart` enabled. Pass a process name to start only that process (while still showing
the others), or use `--all` to start every configured process.
`--root <path>` chooses a starting directory. `--no-watch` disables automatic restarts,
while `--watch-debounce <ms>` changes the default 150ms debounce.

```bash
hydraterm --all
hydraterm API
hydraterm --watch-debounce 300 API
```

Use headless mode when a terminal UI is unnecessary, such as when an agent owns the
process supervisor and inspects it through MCP. It starts the same configured processes,
PTYs, watchers, and inspection endpoint, and exits cleanly on SIGINT or SIGTERM:

```bash
hydraterm headless
hydraterm headless --all
```

Use `--detach` to wait for readiness and return while the supervisor continues in the
background. `ensure --headless` is the preferred agent command: it atomically reuses an
existing project instance or starts one, so concurrent calls cannot duplicate processes.

```bash
hydraterm headless --detach
hydraterm ensure --headless
hydraterm status
hydraterm stop
```

TUI and headless instances share a per-project lock based on the canonical project path.
Only one can own a project at a time. The original `hydraterm --headless` spelling remains
available as an alias.

Running plain `hydraterm` while an instance already owns the project attaches a TUI to
that instance instead of starting duplicate processes. The attached TUI displays the
owner's styled terminal screens and forwards input, resize, watcher, and lifecycle actions.
Exiting the attached TUI leaves the owning headless instance and its processes running.

The first-run picker lists all discovered scripts, including lifecycle hooks and linting
commands. Every selected script runs from its owning package directory.

## Process manifests

Hydraterm runs only named processes in the root `package.json`; it never starts a
discovered workspace script until it has been saved to this configuration. Commands run
through the system shell, so they support the same command syntax as Solo. `workingDir`
and `restartWhenChanged` are relative to the repository root; an empty or omitted change
list disables watching for that process. All configured processes appear in the dashboard;
those with `autoStart: false` remain idle until started manually. Processes auto-start
unless `autoStart` is set to `false`.

```json
{
  "hydraterm": {
    "processes": {
      "API": {
        "command": "bun run dev:api",
        "workingDir": "packages/functions",
        "restartWhenChanged": [
          "packages/functions/**",
          "packages/zero/**",
          "packages/data/**"
        ],
        "autoStart": true,
        "env": { "PORT": "3002" }
      },
      "Web": {
        "command": "bun run dev",
        "workingDir": "packages/web",
        "restartWhenChanged": [],
        "autoStart": true
      }
    }
  }
}
```

Run one configured process by name, for example `hydraterm API`. Use `--all` to
start every configured process.

`restartWhenChanged` glob patterns are the complete watch declaration for a configured
process. The watcher always ignores paths under `node_modules`, `.git`, `vendor`,
`.build-libghostty`, `dist`, `out`, and `build`. Use `--no-watch` to temporarily disable
every configured watcher.

Each command runs in Bun's native PTY. Its raw output is fed to Ghostty's VT
parser before OpenTUI renders it. In the process navigation, use `j`/`k` to
select a process, then `s` to start/stop it (or `a` to start all and `p` to stop all), and Enter to focus its output. While focused, typing and
Ctrl-C go to that process, while `j`/`k` scroll its retained output history. Dragging to
select output copies it to the clipboard automatically; Cmd-C and Ctrl-Shift-C also copy
the current selection when the terminal forwards those shortcuts.
Esc returns to navigation, `r` restarts the selected process, `w` toggles its watcher,
and `q` exits. Process rows show whether watching is on, off, or awaiting debounce.

## Agent inspection with MCP

Hydraterm exposes MCP tools for inspecting and controlling its configured processes:

- `list_processes`
- `get_process_output`
- `wait_for_process_output`
- `start_process`
- `stop_process`
- `restart_process`

The MCP command infers the project from its working directory, so an MCP client should
start it from the project it will inspect:

```bash
hydraterm mcp
```

For OpenCode V2, run this once from the project root:

```bash
opencode mcp add hydraterm -- hydraterm mcp
opencode mcp list
```

The equivalent project configuration is:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "hydraterm": {
        "type": "local",
        "command": ["hydraterm", "mcp"],
        "cwd": "."
      }
    }
  }
}
```

The MCP server remains connected when no TUI or headless instance is running.
`list_processes` explicitly returns `instanceStatus: "running" | "stopped"`, allowing an
agent to call `hydraterm ensure --headless` and use the same MCP connection once startup
completes. Use `hydraterm mcp --root /absolute/project/path` only when the MCP client cannot
start the command from that project. The local inspection endpoint binds to loopback,
authenticates with a per-run token stored in a user-only cache file, never exposes process
environment variables, and limits returned output. Lifecycle tools require an exact
configured process name and operate only through the authenticated project instance.

Run the automated proof:

```bash
bun test
```

## Installation

Install it globally with either package manager, then run `hydraterm` from a project:

```bash
npm install --global hydraterm
# or
bun install --global hydraterm
```

Run it once without a global installation:

```bash
npx hydraterm
# or
bunx hydraterm
```

## Platform support

v1 currently targets macOS on Apple Silicon only. The npm package declares
this restriction so it cannot install silently on an unsupported platform. It
ships a standalone executable, so npm/npx users do not need Bun installed.

## Releases

Every non-bot push to `main` creates the next patch release, publishes it to npm,
tags the release, and creates a GitHub Release. Publishing uses npm trusted publishing
with GitHub Actions OIDC, so no npm token is stored in GitHub.

Configure the `hydraterm` package's trusted publisher in npm before merging the
workflow: select GitHub Actions, enter organization `vestia-dev`, repository
`hydraterm`, workflow filename `release.yml`, and allow `npm publish`. The package must
already exist on npm to configure a trusted publisher; bootstrap its first publication
manually if necessary.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
