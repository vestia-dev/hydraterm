# hydraterm

**Status: early work in progress.** The VT parsing and multi-process OpenTUI
dashboard work; script discovery and automatic restart are still to come.

A Bun-native terminal process dashboard: auto-detects npm scripts, runs
them together, restarts on file change, and lets you navigate between
them as full-fidelity terminal panes (built on Ghostty's VT engine).

To install dependencies:

```bash
bun install
```

Run selected package scripts together in the dashboard:

```bash
bun run index.ts demo:spinner test
```

Each command runs in Bun's native PTY. Its raw output is fed to Ghostty's VT
parser before OpenTUI renders it. In the process navigation, use `j`/`k` to
select a process, then `s` to start/stop it (or `a` to start all and `p` to stop all), and Enter to focus its output. While focused, typing and
Ctrl-C go to that process, while `j`/`k` scroll its retained output history.
Esc returns to navigation, `r` restarts the selected process, and `q` exits.

Run the automated proof:

```bash
bun test
```

## Platform support

v1 currently targets macOS on Apple Silicon only. The npm package declares
this restriction so it cannot install silently on an unsupported platform.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
