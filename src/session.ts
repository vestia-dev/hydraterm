import { GhosttyTerminal } from "./ffi";
import { FileWatcher, type WatchConfiguration } from "./watcher";

export type ProcessStatus = "idle" | "running" | "stopped" | "exited" | "failed";

export interface TerminalSession {
  readonly name: string;
  readonly command: readonly string[];
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly watchEnabled: boolean;
  readonly watchPending: boolean;
  snapshot(): string;
  start(): void;
  restart(): void;
  toggleWatch(): void;
  send(input: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  stop(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** A Bun.Terminal process with a Ghostty-backed visible screen. */
export class PtySession implements TerminalSession {
  terminal: GhosttyTerminal;
  readonly listeners = new Set<() => void>();
  status: ProcessStatus = "idle";
  exitCode: number | null = null;
  #pty: Bun.Terminal | null = null;
  #child: Bun.Subprocess | null = null;
  #cols: number;
  #rows: number;
  #run = 0;
  #restarting = false;
  #stopRequestedRun: number | null = null;
  #cwd: string | undefined;
  #env: Record<string, string> | undefined;
  #shell: boolean;
  #watchConfiguration: WatchConfiguration | false;
  #watcher: FileWatcher | null = null;

  constructor(
    readonly name: string,
    readonly command: readonly string[],
    { cols = 80, rows = 24, cwd, env, shell = false, watch = {} }: { cols?: number; rows?: number; cwd?: string; env?: Record<string, string>; shell?: boolean; watch?: (Omit<WatchConfiguration, "root"> & { root?: string }) | false } = {},
  ) {
    if (command.length === 0) throw new Error("A terminal session needs a command.");
    this.#cols = cols;
    this.#rows = rows;
    this.#cwd = cwd;
    this.#env = env;
    this.#shell = shell;
    this.#watchConfiguration = watch === false ? false : { ...watch, root: watch.root ?? cwd ?? process.cwd() };
    this.terminal = new GhosttyTerminal({ cols, rows });
  }

  start(): void {
    this.#ensureWatcher();
    if (this.#pty !== null) {
      if (this.status !== "running") this.restart();
      return;
    }

    const run = ++this.#run;
    this.#stopRequestedRun = null;
    const terminal = this.terminal;
    this.#pty = new Bun.Terminal({
      cols: this.#cols,
      rows: this.#rows,
      data: (_pty, data) => {
        if (this.#run !== run) return;
        terminal.write(data);
        this.#notify();
      },
      exit: () => this.#notify(),
    });
    this.#child = Bun.spawn(this.#shell ? ["/bin/sh", "-lc", this.command[0] ?? ""] : [...this.command], { terminal: this.#pty, cwd: this.#cwd, env: this.#env });
    this.status = "running";
    this.#notify();

    void this.#child.exited.then((exitCode) => {
      if (this.#run !== run) return;
      this.exitCode = exitCode;
      this.status = this.#stopRequestedRun === run ? "stopped" : exitCode === 0 ? "exited" : "failed";
      this.#stopRequestedRun = null;
      this.#notify();
    });
  }

  send(input: string | Uint8Array): void {
    this.#pty?.write(input);
  }

  restart(): void {
    void this.#restartSession();
  }

  #restartSession(): Promise<void> {
    if (this.#restarting) return Promise.resolve();
    this.#restarting = true;
    return this.#restart().finally(() => {
      this.#restarting = false;
    });
  }

  get watchEnabled(): boolean {
    return this.#watcher?.enabled ?? this.#watchConfiguration !== false;
  }

  get watchPending(): boolean {
    return this.#watcher?.pending ?? false;
  }

  toggleWatch(): void {
    if (this.#watchConfiguration === false) return;
    this.#ensureWatcher();
    this.#watcher?.toggle();
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    this.#cols = safeCols;
    this.#rows = safeRows;
    this.#pty?.resize(safeCols, safeRows);
    this.terminal.resize(safeCols, safeRows);
  }

  snapshot(): string {
    return this.terminal.snapshot();
  }

  stop(): void {
    if (this.status !== "running") return;
    this.#stopRequestedRun = this.#run;
    this.status = "stopped";
    this.#notify();
    this.#child?.kill();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.#watcher?.dispose();
    this.#run++;
    this.#stopRequestedRun = null;
    this.stop();
    this.#pty?.close();
    this.#pty = null;
    this.#child = null;
    this.terminal.dispose();
    this.listeners.clear();
  }

  #notify(): void {
    for (const listener of this.listeners) listener();
  }

  #ensureWatcher(): void {
    if (this.#watchConfiguration === false || this.#watcher) return;
    this.#watcher = new FileWatcher(
      this.#watchConfiguration,
      () => this.#restartSession(),
      () => this.#notify(),
    );
    this.#watcher.start();
  }

  async #restart(): Promise<void> {
    const previousChild = this.#child;
    this.#run++;
    this.#stopRequestedRun = null;
    if (this.status === "running") previousChild?.kill();
    if (previousChild) await previousChild.exited;

    this.#pty?.close();
    this.#pty = null;
    this.#child = null;
    this.terminal.dispose();
    this.terminal = new GhosttyTerminal({ cols: this.#cols, rows: this.#rows });
    this.status = "idle";
    this.exitCode = null;
    this.#notify();
    this.start();
  }
}
