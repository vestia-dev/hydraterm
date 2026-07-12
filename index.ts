#!/usr/bin/env bun
import { Dashboard } from "./src/dashboard";
import { ScriptPicker } from "./src/script-picker";
import { discoverConfiguredProcesses, discoverScripts, resolveScriptNames, saveConfiguredProcesses, scriptLabel } from "./src/scripts";
import { PtySession } from "./src/session";

const args = process.argv.slice(2);
const help = `Usage: hydraterm [--all] [--root <path>] [--no-watch] [--watch-debounce <ms>] [process ...]

On first run, choose from all discovered scripts; Hydraterm saves the selection as named
processes in the root package.json. Later runs start configured processes. --all starts
every configured process; a process name starts only that process.`;
let root: string | undefined;
let all = false;
let watch = true;
let watchDebounce: number | undefined;
const names: string[] = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === undefined) continue;
  if (arg === "--help" || arg === "-h") {
    console.log(help);
    process.exit(0);
  } else if (arg === "--all") all = true;
  else if (arg === "--no-watch") watch = false;
  else if (arg === "--watch-debounce") {
    const value = Number(args[++index]);
    if (!Number.isFinite(value) || value < 0) throw new Error("--watch-debounce requires a non-negative number.");
    watchDebounce = value;
  }
  else if (arg === "--root") {
    root = args[++index];
    if (!root) throw new Error("--root requires a path.");
  } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
  else names.push(arg);
}

const configured = await discoverConfiguredProcesses({ root });
let scripts;
if (configured) {
  scripts = names.length > 0
    ? resolveScriptNames(configured, names)
    : all
      ? configured
      : configured.filter((process) => process.autoStart);
} else {
  const discovered = await discoverScripts({ root });
  scripts = await ScriptPicker.select(discovered);
  if (scripts?.length) await saveConfiguredProcesses(scripts, { root });
}
if (!scripts || scripts.length === 0) process.exit(0);

const sessions = scripts.map(
  (script) => new PtySession(scriptLabel(script), script.shell ? [script.command] : [process.execPath, "run", "--silent", script.scriptName], {
    cwd: script.packageRoot,
    env: script.env,
    shell: script.shell,
    watch: !watch || script.watch === false ? false : { ...script.watch, root: script.watchRoot, debounceMs: watchDebounce ?? script.watch?.debounceMs },
  }),
);
const dashboard = await Dashboard.create(sessions);
await dashboard.closed;
