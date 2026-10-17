#!/usr/bin/env bun
import { realpath } from "node:fs/promises";
import { Dashboard } from "./src/dashboard";
import { InspectionClient, InspectionServer, InstanceAlreadyRunningError, type InstanceStatus, type RunningInstance } from "./src/inspection";
import { runMcpServer } from "./src/mcp";
import { connectRemoteSessions } from "./src/remote-session";
import { ScriptPicker } from "./src/script-picker";
import { discoverConfiguredProcesses, discoverScripts, findPackageRoot, resolveScriptNames, saveConfiguredProcesses, scriptLabel } from "./src/scripts";
import { PtySession } from "./src/session";

const args = process.argv.slice(2);
const help = `Usage: hydraterm [--all] [--root <path>] [--no-watch] [--watch-debounce <ms>] [process ...]
       hydraterm headless [--detach] [--all] [--root <path>] [process ...]
       hydraterm ensure --headless [--all] [--root <path>] [process ...]
       hydraterm status [--root <path>]
       hydraterm stop [--root <path>]
       hydraterm mcp [--root <path>]

Hydraterm runs configured project processes with PTY-backed terminal fidelity. Headless
mode omits the TUI while retaining process supervision and MCP inspection. The ensure
command atomically reuses or starts a detached headless instance.`;

interface LaunchOptions {
  root?: string;
  all: boolean;
  headless: boolean;
  detach: boolean;
  watch: boolean;
  watchDebounce?: number;
  names: string[];
}

function waitForTerminationSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function parseLaunchOptions(commandArgs: readonly string[], defaults: Partial<LaunchOptions> = {}): LaunchOptions | null {
  const options: LaunchOptions = {
    all: false,
    headless: false,
    detach: false,
    watch: true,
    names: [],
    ...defaults,
  };
  for (let index = 0; index < commandArgs.length; index++) {
    const arg = commandArgs[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      console.log(help);
      return null;
    }
    if (arg === "--all") options.all = true;
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--detach") options.detach = true;
    else if (arg === "--no-watch") options.watch = false;
    else if (arg === "--watch-debounce") {
      const value = Number(commandArgs[++index]);
      if (!Number.isFinite(value) || value < 0) throw new Error("--watch-debounce requires a non-negative number.");
      options.watchDebounce = value;
    } else if (arg === "--root") {
      options.root = commandArgs[++index];
      if (!options.root) throw new Error("--root requires a path.");
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.names.push(arg);
  }
  if (options.detach && !options.headless) throw new Error("--detach requires headless mode.");
  return options;
}

function parseRootOption(commandArgs: readonly string[]): string | null | undefined {
  let root: string | undefined;
  for (let index = 0; index < commandArgs.length; index++) {
    const arg = commandArgs[index];
    if (arg === "--help" || arg === "-h") {
      console.log(help);
      return null;
    }
    if (arg === "--root") {
      root = commandArgs[++index];
      if (!root) throw new Error("--root requires a path.");
    } else throw new Error(`Unknown option: ${arg}.`);
  }
  return root;
}

async function projectRoot(root?: string): Promise<string> {
  return realpath(await findPackageRoot(root ?? process.cwd()));
}

function describeStatus(status: InstanceStatus): string {
  return status.instanceStatus === "running"
    ? `Hydraterm is running in ${status.mode} mode for ${status.root} (PID ${status.pid}).`
    : `Hydraterm is stopped for ${status.root}.`;
}

function detachedCommand(options: LaunchOptions, root: string): string[] {
  const childArgs = ["--headless", "--root", root];
  if (options.all) childArgs.push("--all");
  if (!options.watch) childArgs.push("--no-watch");
  if (options.watchDebounce !== undefined) childArgs.push("--watch-debounce", String(options.watchDebounce));
  childArgs.push(...options.names);
  const sourceEntry = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
  return [process.execPath, ...sourceEntry, ...childArgs];
}

async function ensureDetached(options: LaunchOptions, root: string): Promise<InstanceStatus> {
  const client = new InspectionClient(root);
  const existing = await client.status();
  if (existing.instanceStatus === "running") {
    console.log(describeStatus(existing));
    return existing;
  }

  const child = Bun.spawn(detachedCommand(options, root), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await client.status();
    if (status.instanceStatus === "running") {
      console.log(describeStatus(status));
      return status;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out starting headless Hydraterm for ${root}.`);
}

async function attachDashboard(root: string, instance: RunningInstance): Promise<void> {
  const sessions = await connectRemoteSessions(root, instance);
  let dashboard: Dashboard | undefined;
  const terminateDashboard = () => dashboard?.renderer.destroy();
  try {
    dashboard = await Dashboard.create(sessions);
    process.once("SIGINT", terminateDashboard);
    process.once("SIGTERM", terminateDashboard);
    await dashboard.closed;
  } finally {
    process.off("SIGINT", terminateDashboard);
    process.off("SIGTERM", terminateDashboard);
    for (const session of sessions) session.dispose();
  }
}

async function runMcpCommand(commandArgs: readonly string[]): Promise<void> {
  const root = parseRootOption(commandArgs);
  if (root === null) return;
  await runMcpServer(await projectRoot(root));
}

async function runStatusCommand(commandArgs: readonly string[]): Promise<void> {
  const root = parseRootOption(commandArgs);
  if (root === null) return;
  console.log(describeStatus(await new InspectionClient(await projectRoot(root)).status()));
}

async function runStopCommand(commandArgs: readonly string[]): Promise<void> {
  const root = parseRootOption(commandArgs);
  if (root === null) return;
  const canonicalRoot = await projectRoot(root);
  const client = new InspectionClient(canonicalRoot);
  const before = await client.status();
  if (before.instanceStatus === "stopped") {
    console.log(describeStatus(before));
    return;
  }
  await client.stop();
  console.log(`Stopped Hydraterm for ${canonicalRoot} (PID ${before.pid}).`);
}

async function runProcesses(options: LaunchOptions): Promise<void> {
  const root = await projectRoot(options.root);
  if (options.detach) {
    await ensureDetached(options, root);
    return;
  }

  if (!options.headless) {
    const existing = await new InspectionClient(root).status();
    if (existing.instanceStatus === "running") {
      await attachDashboard(root, existing);
      return;
    }
  }

  const configured = await discoverConfiguredProcesses({ root });
  let scripts;
  if (configured) scripts = configured;
  else {
    if (options.headless) throw new Error("Headless mode requires configured hydraterm.processes in package.json.");
    const discovered = await discoverScripts({ root });
    scripts = await ScriptPicker.select(discovered);
    if (scripts?.length) await saveConfiguredProcesses(scripts, { root });
  }
  if (!scripts || scripts.length === 0) return;

  const startOnLaunch = new Set(configured
    ? options.names.length > 0
      ? resolveScriptNames(configured, options.names)
      : options.all
        ? configured
        : configured.filter((process) => process.autoStart)
    : scripts);
  const sessions = scripts.map(
    (script) => new PtySession(scriptLabel(script), script.shell ? [script.command] : [process.execPath, "run", "--silent", script.scriptName], {
      cwd: script.packageRoot,
      env: script.env,
      shell: script.shell,
      watch: !options.watch || script.watch === false ? false : { ...script.watch, root: script.watchRoot, debounceMs: options.watchDebounce ?? script.watch?.debounceMs },
    }),
  );

  let inspection: InspectionServer;
  try {
    inspection = await InspectionServer.start(root, sessions, options.headless ? "headless" : "tui");
  } catch (error) {
    for (const session of sessions) session.dispose();
    if (error instanceof InstanceAlreadyRunningError && !options.headless) {
      const deadline = Date.now() + 2_000;
      const client = new InspectionClient(root);
      while (Date.now() < deadline) {
        const existing = await client.status();
        if (existing.instanceStatus === "running") {
          await attachDashboard(root, existing);
          return;
        }
        await Bun.sleep(25);
      }
    }
    throw error;
  }
  const startSessions = () => {
    for (const [index, script] of scripts.entries()) {
      if (startOnLaunch.has(script)) sessions[index]?.start();
    }
  };

  if (options.headless) {
    const terminated = waitForTerminationSignal();
    try {
      startSessions();
      console.error(`Hydraterm is running headlessly for ${root}.`);
      await terminated;
    } finally {
      for (const session of sessions) session.dispose();
      await inspection.stop();
    }
    return;
  }

  let dashboard: Dashboard | undefined;
  const terminateDashboard = () => dashboard?.renderer.destroy();
  try {
    dashboard = await Dashboard.create(sessions);
    process.once("SIGINT", terminateDashboard);
    process.once("SIGTERM", terminateDashboard);
    startSessions();
    await dashboard.closed;
  } finally {
    process.off("SIGINT", terminateDashboard);
    process.off("SIGTERM", terminateDashboard);
    await inspection.stop();
  }
}

async function main(): Promise<void> {
  const command = args[0];
  if (command === "mcp") return runMcpCommand(args.slice(1));
  if (command === "status") return runStatusCommand(args.slice(1));
  if (command === "stop") return runStopCommand(args.slice(1));
  if (command === "headless") {
    const options = parseLaunchOptions(args.slice(1), { headless: true });
    if (options) await runProcesses(options);
    return;
  }
  if (command === "ensure") {
    const options = parseLaunchOptions(args.slice(1), { detach: true });
    if (!options) return;
    if (!options.headless) throw new Error("ensure currently requires --headless.");
    await runProcesses(options);
    return;
  }
  const options = parseLaunchOptions(args);
  if (options) await runProcesses(options);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof InstanceAlreadyRunningError ? message : `error: ${message}`);
  process.exitCode = 1;
}
