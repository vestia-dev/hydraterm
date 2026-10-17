import { InspectionClient, type ProcessControlResult, type ProcessSummary, type RunningInstance } from "./inspection";
import type { ProcessStatus, TerminalSession } from "./session";

interface RemoteScreen {
  process: ProcessSummary;
  output: string;
  styledOutput: string;
}

/** A dashboard-compatible view of a session owned by another Hydraterm process. */
export class RemoteTerminalSession implements TerminalSession {
  readonly name: string;
  readonly command: readonly string[];
  readonly cwd: string | undefined;
  status: ProcessStatus;
  exitCode: number | null;
  watchEnabled: boolean;
  watchPending: boolean;
  pid: number | null;
  #revision: number;
  #output: string;
  #styledOutput: string;
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setInterval>;
  #refreshing = false;
  #disposed = false;
  #size: [number, number] | null = null;

  private constructor(
    readonly client: InspectionClient,
    screen: RemoteScreen,
  ) {
    this.name = screen.process.name;
    this.command = screen.process.command;
    this.cwd = screen.process.cwd ?? undefined;
    this.status = screen.process.status;
    this.exitCode = screen.process.exitCode;
    this.watchEnabled = screen.process.watchEnabled;
    this.watchPending = screen.process.watchPending;
    this.pid = screen.process.pid;
    this.#revision = screen.process.revision;
    this.#output = screen.output;
    this.#styledOutput = screen.styledOutput;
    this.#timer = setInterval(() => void this.#refresh(), 150);
  }

  static async connect(client: InspectionClient, process: string): Promise<RemoteTerminalSession> {
    const screen = await client.request<RemoteScreen>({ method: "screen", process });
    return new RemoteTerminalSession(client, screen);
  }

  snapshot(): string { return this.#output; }
  styledSnapshot(): string { return this.#styledOutput; }

  start(): void { void this.#control("start"); }
  stop(): void { void this.#control("stop"); }
  restart(): void { void this.#control("restart"); }

  toggleWatch(): void {
    void this.client.request<{ process: ProcessSummary }>({ method: "toggleWatch", process: this.name })
      .then((result) => this.#applySummary(result.process))
      .catch(() => {});
  }

  send(input: string | Uint8Array): void {
    const message = typeof input === "string"
      ? { method: "input" as const, process: this.name, data: input, encoding: "utf8" as const }
      : { method: "input" as const, process: this.name, data: Buffer.from(input).toString("base64"), encoding: "base64" as const };
    void this.client.request(message).catch(() => {});
  }

  resize(cols: number, rows: number): void {
    const next: [number, number] = [Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows))];
    if (this.#size?.[0] === next[0] && this.#size[1] === next[1]) return;
    this.#size = next;
    void this.client.request({ method: "resize", process: this.name, cols: next[0], rows: next[1] }).catch(() => {});
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#timer);
    this.#listeners.clear();
  }

  async #control(action: "start" | "stop" | "restart"): Promise<void> {
    try {
      const result = await this.client.request<ProcessControlResult>({ method: "control", process: this.name, action });
      this.#applySummary(result.process);
      await this.#refresh();
    } catch {
      // Polling will recover if the owner is temporarily busy.
    }
  }

  async #refresh(): Promise<void> {
    if (this.#refreshing || this.#disposed) return;
    this.#refreshing = true;
    try {
      const screen = await this.client.request<RemoteScreen>({ method: "screen", process: this.name });
      const outputChanged = screen.output !== this.#output || screen.styledOutput !== this.#styledOutput;
      this.#output = screen.output;
      this.#styledOutput = screen.styledOutput;
      const summaryChanged = this.#applySummary(screen.process, false);
      if (outputChanged || summaryChanged) this.#notify();
    } catch {
      // Keep the last rendered state while the owner is unavailable.
    } finally {
      this.#refreshing = false;
    }
  }

  #applySummary(summary: ProcessSummary, notify = true): boolean {
    const changed = this.status !== summary.status
      || this.exitCode !== summary.exitCode
      || this.watchEnabled !== summary.watchEnabled
      || this.watchPending !== summary.watchPending
      || this.pid !== summary.pid
      || this.#revision !== summary.revision;
    this.status = summary.status;
    this.exitCode = summary.exitCode;
    this.watchEnabled = summary.watchEnabled;
    this.watchPending = summary.watchPending;
    this.pid = summary.pid;
    this.#revision = summary.revision;
    if (changed && notify) this.#notify();
    return changed;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

export async function connectRemoteSessions(root: string, instance: RunningInstance): Promise<RemoteTerminalSession[]> {
  const client = new InspectionClient(root);
  try {
    return await Promise.all(instance.processes.map((process) => RemoteTerminalSession.connect(client, process.name)));
  } catch (error) {
    throw new Error(`Unable to attach to the running Hydraterm instance. Restart it with the current Hydraterm version. ${error instanceof Error ? error.message : String(error)}`);
  }
}
