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
bun run index.ts
```

After configuration exists, Hydraterm starts its auto-starting processes. Pass a process
name to start only that process, or use `--all` to start every configured process.
`--root <path>` chooses a starting directory. `--no-watch` disables automatic restarts,
while `--watch-debounce <ms>` changes the default 150ms debounce.

```bash
bun run index.ts --all
bun run index.ts API
bun run index.ts --watch-debounce 300 API
```

The first-run picker lists all discovered scripts, including lifecycle hooks and linting
commands. Every selected script runs from its owning package directory.

## Process manifests

Hydraterm runs only named processes in the root `package.json`; it never starts a
discovered workspace script until it has been saved to this configuration. Commands run
through the system shell, so they support the same command syntax as Solo. `workingDir`
and `restartWhenChanged` are relative to the repository root; an empty or omitted change
list disables watching for that process. Processes auto-start unless `autoStart` is set
to `false`.

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

Run one configured process by name, for example `bun run index.ts API`. Use `--all` to
start every configured process.

`restartWhenChanged` glob patterns are the complete watch declaration for a configured
process. The watcher always ignores paths under `node_modules`, `.git`, `vendor`,
`.build-libghostty`, `dist`, `out`, and `build`. Use `--no-watch` to temporarily disable
every configured watcher.

Each command runs in Bun's native PTY. Its raw output is fed to Ghostty's VT
parser before OpenTUI renders it. In the process navigation, use `j`/`k` to
select a process, then `s` to start/stop it (or `a` to start all and `p` to stop all), and Enter to focus its output. While focused, typing and
Ctrl-C go to that process, while `j`/`k` scroll its retained output history.
Esc returns to navigation, `r` restarts the selected process, `w` toggles its watcher,
and `q` exits. Process rows show whether watching is on, off, or awaiting debounce.

Run the automated proof:

```bash
bun test
```

## Platform support

v1 currently targets macOS on Apple Silicon only. The npm package declares
this restriction so it cannot install silently on an unsupported platform.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
