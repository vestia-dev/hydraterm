import { chmod, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TerminalSession } from "./session";

const MAX_OUTPUT_CHARS = 50_000;
const MAX_TAIL_LINES = 2_000;
const MAX_WAIT_MS = 30_000;

export type InstanceMode = "tui" | "headless";

interface InspectionState {
  version: 2;
  root: string;
  pid: number;
  mode: InstanceMode;
  startedAt: string;
  url: string;
  token: string;
}

interface InstanceLock {
  version: 1;
  root: string;
  pid: number;
  token: string;
  createdAt: string;
}

export interface ProcessSummary {
  name: string;
  command: readonly string[];
  cwd: string | null;
  pid: number | null;
  status: TerminalSession["status"];
  exitCode: number | null;
  watchEnabled: boolean;
  watchPending: boolean;
  revision: number;
}

export interface ProcessOutput {
  root: string;
  process: ProcessSummary;
  output: string;
  truncated: boolean;
}

export interface RunningInstance {
  instanceStatus: "running";
  root: string;
  pid: number;
  mode: InstanceMode;
  startedAt: string;
  processes: ProcessSummary[];
}

export interface StoppedInstance {
  instanceStatus: "stopped";
  root: string;
  processes: [];
}

export type InstanceStatus = RunningInstance | StoppedInstance;
export type ProcessAction = "start" | "stop" | "restart";

export interface ProcessControlResult {
  root: string;
  action: ProcessAction;
  settled: boolean;
  process: ProcessSummary;
}

export class InstanceAlreadyRunningError extends Error {
  constructor(readonly root: string, readonly pid: number) {
    super(`Hydraterm is already running for ${root} (PID ${pid}).`);
    this.name = "InstanceAlreadyRunningError";
  }
}

type InspectionRequest =
  | { method: "list" }
  | { method: "output"; process: string; tailLines?: number }
  | { method: "wait"; process: string; pattern: string; timeoutMs?: number; afterRevision?: number }
  | { method: "control"; process: string; action: ProcessAction }
  | { method: "screen"; process: string }
  | { method: "input"; process: string; data: string; encoding: "utf8" | "base64" }
  | { method: "resize"; process: string; cols: number; rows: number }
  | { method: "toggleWatch"; process: string };

function projectId(root: string): string {
  return new Bun.CryptoHasher("sha256").update(resolve(root)).digest("hex").slice(0, 24);
}

export function inspectionStatePath(root: string): string {
  return join(homedir(), "Library", "Caches", "hydraterm", `${projectId(root)}.json`);
}

export function instanceLockPath(root: string): string {
  return join(homedir(), "Library", "Caches", "hydraterm", `${projectId(root)}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function prepareStateDirectory(): Promise<void> {
  const directory = join(homedir(), "Library", "Caches", "hydraterm");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function acquireInstanceLock(root: string): Promise<InstanceLock> {
  await prepareStateDirectory();
  const path = instanceLockPath(root);
  for (let attempt = 0; attempt < 4; attempt++) {
    const lock: InstanceLock = {
      version: 1,
      root,
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`);
      } finally {
        await handle.close();
      }
      return lock;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }

    let existing: InstanceLock | null = null;
    try {
      existing = await Bun.file(path).json() as InstanceLock;
    } catch {
      await Bun.sleep(20);
      try {
        existing = await Bun.file(path).json() as InstanceLock;
      } catch {
        existing = null;
      }
    }
    if (existing && isProcessAlive(existing.pid)) throw new InstanceAlreadyRunningError(root, existing.pid);
    try {
      await unlink(path);
    } catch {
      // Another contender may already have removed the stale lock.
    }
  }
  throw new Error(`Unable to acquire the Hydraterm instance lock for ${root}.`);
}

async function releaseOwnedFile(path: string, token: string): Promise<void> {
  try {
    const record = await Bun.file(path).json() as { token?: string };
    if (record.token === token) await unlink(path);
  } catch {
    // Missing and replaced ownership files must not be removed.
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("Expected a finite number.");
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function tailOutput(output: string, requestedLines?: number): { output: string; truncated: boolean } {
  const lineCount = boundedInteger(requestedLines, 200, 1, MAX_TAIL_LINES);
  const lines = output.split("\n");
  let truncated = lines.length > lineCount;
  let result = lines.slice(-lineCount).join("\n");
  if (result.length > MAX_OUTPUT_CHARS) {
    result = result.slice(-MAX_OUTPUT_CHARS);
    truncated = true;
  }
  return { output: result, truncated };
}

export class InspectionServer {
  readonly #revisions = new Map<TerminalSession, number>();
  readonly #unsubscribers: Array<() => void> = [];
  readonly #server: ReturnType<typeof Bun.serve>;
  readonly #state: InspectionState;
  readonly #lock: InstanceLock;
  readonly #statePath: string;
  #stopped = false;

  private constructor(
    readonly root: string,
    readonly sessions: readonly TerminalSession[],
    server: ReturnType<typeof Bun.serve>,
    state: InspectionState,
    lock: InstanceLock,
  ) {
    this.#server = server;
    this.#state = state;
    this.#lock = lock;
    this.#statePath = inspectionStatePath(root);
    for (const session of sessions) {
      this.#revisions.set(session, 0);
      this.#unsubscribers.push(session.subscribe(() => {
        this.#revisions.set(session, (this.#revisions.get(session) ?? 0) + 1);
      }));
    }
  }

  static async start(root: string, sessions: readonly TerminalSession[], mode: InstanceMode = "tui"): Promise<InspectionServer> {
    const canonicalRoot = await realpath(resolve(root));
    const lock = await acquireInstanceLock(canonicalRoot);
    const token = crypto.randomUUID();
    let instance: InspectionServer | undefined;
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => instance ? instance.#handle(request) : Response.json({ error: "Inspection server is starting." }, { status: 503 }),
      });
    } catch (error) {
      await releaseOwnedFile(instanceLockPath(canonicalRoot), lock.token);
      throw error;
    }
    const state: InspectionState = {
      version: 2,
      root: canonicalRoot,
      pid: process.pid,
      mode,
      startedAt: lock.createdAt,
      url: server.url.origin,
      token,
    };
    instance = new InspectionServer(canonicalRoot, sessions, server, state, lock);
    const statePath = inspectionStatePath(canonicalRoot);
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    try {
      await Bun.write(temporaryPath, `${JSON.stringify(state)}\n`);
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, statePath);
    } catch (error) {
      await server.stop(true);
      await releaseOwnedFile(instanceLockPath(canonicalRoot), lock.token);
      throw error;
    }
    return instance;
  }

  #summary(session: TerminalSession): ProcessSummary {
    return {
      name: session.name,
      command: session.command,
      cwd: session.cwd ?? null,
      pid: session.pid ?? null,
      status: session.status,
      exitCode: session.exitCode,
      watchEnabled: session.watchEnabled,
      watchPending: session.watchPending,
      revision: this.#revisions.get(session) ?? 0,
    };
  }

  #findSession(name: string): TerminalSession {
    const session = this.sessions.find((candidate) => candidate.name === name);
    if (!session) throw new Error(`Unknown process: ${name}.`);
    return session;
  }

  #output(session: TerminalSession, tailLines?: number): ProcessOutput {
    const output = tailOutput(session.snapshot(), tailLines);
    return { root: this.root, process: this.#summary(session), ...output };
  }

  async #wait(request: Extract<InspectionRequest, { method: "wait" }>): Promise<ProcessOutput & { matched: boolean }> {
    if (request.pattern.length === 0) throw new Error("pattern must not be empty.");
    const session = this.#findSession(request.process);
    const timeoutMs = boundedInteger(request.timeoutMs, 10_000, 0, MAX_WAIT_MS);
    const matches = () => {
      const revision = this.#revisions.get(session) ?? 0;
      const revisionMatches = request.afterRevision === undefined || revision > request.afterRevision;
      return revisionMatches && session.snapshot().includes(request.pattern);
    };
    if (matches()) return { ...this.#output(session), matched: true };

    const matched = await new Promise<boolean>((resolveMatch) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolveMatch(value);
      };
      const unsubscribe = session.subscribe(() => {
        if (matches()) finish(true);
      });
      const timeout = setTimeout(() => finish(false), timeoutMs);
      if (matches()) finish(true);
    });
    return { ...this.#output(session), matched };
  }

  #waitForProcessState(session: TerminalSession, afterRevision: number, status: TerminalSession["status"], timeoutMs = 10_000): Promise<boolean> {
    return new Promise((resolveState) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolveState(value);
      };
      const check = () => {
        if ((this.#revisions.get(session) ?? 0) > afterRevision && session.status === status) finish(true);
      };
      const unsubscribe = session.subscribe(check);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      check();
    });
  }

  async #control(request: Extract<InspectionRequest, { method: "control" }>): Promise<ProcessControlResult> {
    const session = this.#findSession(request.process);
    let settled = true;
    if (request.action === "stop") {
      session.stop();
      settled = session.status === "stopped" || session.status === "idle" || session.status === "exited" || session.status === "failed";
    } else if (request.action === "start") {
      if (session.status !== "running") {
        const revision = this.#revisions.get(session) ?? 0;
        session.start();
        settled = String(session.status) === "running" || await this.#waitForProcessState(session, revision, "running");
      }
    } else {
      const completion = this.#waitForProcessState(session, this.#revisions.get(session) ?? 0, "running");
      session.restart();
      settled = await completion;
    }
    return { root: this.root, action: request.action, settled, process: this.#summary(session) };
  }

  async #handle(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/inspect") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("authorization") !== `Bearer ${this.#state.token}`) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
    try {
      const message = await request.json() as InspectionRequest;
      if (message.method === "list") {
        return Response.json({
          instanceStatus: "running",
          root: this.root,
          pid: this.#state.pid,
          mode: this.#state.mode,
          startedAt: this.#state.startedAt,
          processes: this.sessions.map((session) => this.#summary(session)),
        } satisfies RunningInstance);
      }
      if (message.method === "output") {
        return Response.json(this.#output(this.#findSession(message.process), message.tailLines));
      }
      if (message.method === "wait") return Response.json(await this.#wait(message));
      if (message.method === "control") return Response.json(await this.#control(message));
      if (message.method === "screen") {
        const session = this.#findSession(message.process);
        return Response.json({
          root: this.root,
          process: this.#summary(session),
          output: session.snapshot(),
          styledOutput: session.styledSnapshot(),
        });
      }
      if (message.method === "input") {
        const session = this.#findSession(message.process);
        session.send(message.encoding === "base64" ? Buffer.from(message.data, "base64") : message.data);
        return Response.json({ root: this.root, process: this.#summary(session) });
      }
      if (message.method === "resize") {
        const session = this.#findSession(message.process);
        session.resize(
          boundedInteger(message.cols, 80, 1, 10_000),
          boundedInteger(message.rows, 24, 1, 10_000),
        );
        return Response.json({ root: this.root, process: this.#summary(session) });
      }
      if (message.method === "toggleWatch") {
        const session = this.#findSession(message.process);
        session.toggleWatch();
        return Response.json({ root: this.root, process: this.#summary(session) });
      }
      return Response.json({ error: "Unknown inspection method." }, { status: 400 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    await this.#server.stop(true);
    await releaseOwnedFile(this.#statePath, this.#state.token);
    await releaseOwnedFile(instanceLockPath(this.root), this.#lock.token);
  }
}

export class InspectionClient {
  constructor(readonly root: string) {}

  async status(): Promise<InstanceStatus> {
    try {
      const result = await this.request<RunningInstance | { root: string; processes: ProcessSummary[] }>({ method: "list" });
      if ("instanceStatus" in result) return result;
      const state = await Bun.file(inspectionStatePath(this.root)).json() as Partial<InspectionState>;
      return {
        instanceStatus: "running",
        root: result.root,
        pid: state.pid ?? 0,
        mode: state.mode ?? "tui",
        startedAt: state.startedAt ?? new Date(0).toISOString(),
        processes: result.processes,
      };
    } catch {
      return { instanceStatus: "stopped", root: resolve(this.root), processes: [] };
    }
  }

  async stop(timeoutMs = 10_000): Promise<InstanceStatus> {
    const status = await this.status();
    if (status.instanceStatus === "stopped") return status;
    if (!Number.isSafeInteger(status.pid) || status.pid <= 0) throw new Error(`Hydraterm reported an invalid PID for ${resolve(this.root)}.`);
    try {
      process.kill(status.pid, "SIGTERM");
    } catch {
      return { instanceStatus: "stopped", root: resolve(this.root), processes: [] };
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.status();
      if (current.instanceStatus === "stopped" && !(await Bun.file(instanceLockPath(this.root)).exists())) return current;
      await Bun.sleep(25);
    }
    throw new Error(`Timed out stopping Hydraterm PID ${status.pid}.`);
  }

  async request<T>(message: InspectionRequest): Promise<T> {
    let state: InspectionState;
    try {
      state = await Bun.file(inspectionStatePath(this.root)).json() as InspectionState;
    } catch {
      throw new Error(`No running Hydraterm instance found for ${resolve(this.root)}.`);
    }
    if (resolve(state.root) !== resolve(this.root)) {
      throw new Error(`The Hydraterm inspection record does not match ${resolve(this.root)}. Restart Hydraterm to refresh it.`);
    }
    let response: Response;
    try {
      const requestTimeoutMs = message.method === "wait"
        ? Math.min(MAX_WAIT_MS, Math.max(0, message.timeoutMs ?? 10_000)) + 2_000
        : 5_000;
      response = await fetch(`${state.url}/inspect`, {
        method: "POST",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new Error(`Hydraterm is not reachable for ${resolve(this.root)}. Restart Hydraterm to refresh its inspection endpoint.`);
    }
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Inspection request failed with HTTP ${response.status}.`);
    return body as T;
  }
}
