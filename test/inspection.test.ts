import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { InspectionClient, InspectionServer, inspectionStatePath, instanceLockPath, type ProcessOutput, type ProcessSummary } from "../src/inspection";
import { RemoteTerminalSession } from "../src/remote-session";
import type { ProcessStatus, TerminalSession } from "../src/session";

class FakeSession implements TerminalSession {
  status: ProcessStatus = "running";
  exitCode: number | null = null;
  watchEnabled = true;
  watchPending = false;
  pid: number | null = 1234;
  starts = 0;
  stops = 0;
  restarts = 0;
  inputs: string[] = [];
  sizes: Array<[number, number]> = [];
  #output = "one\ntwo\nthree";
  #listeners = new Set<() => void>();

  constructor(readonly name: string, readonly command: readonly string[], readonly cwd: string) {}
  snapshot(): string { return this.#output; }
  styledSnapshot(): string { return this.#output; }
  start(): void {
    this.starts++;
    this.status = "running";
    this.#notify();
  }
  restart(): void {
    this.restarts++;
    this.status = "idle";
    this.#notify();
    this.status = "running";
    this.#notify();
  }
  toggleWatch(): void {
    this.watchEnabled = !this.watchEnabled;
    this.#notify();
  }
  send(input: string | Uint8Array): void {
    this.inputs.push(typeof input === "string" ? input : new TextDecoder().decode(input));
  }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  stop(): void {
    this.stops++;
    this.status = "stopped";
    this.#notify();
  }
  dispose(): void {}
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  setOutput(output: string): void {
    this.#output = output;
    this.#notify();
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for remote session action.");
    await Bun.sleep(10);
  }
}

test("serves bounded live process inspection to a project client", async () => {
  const temporaryParent = join(process.env.TMPDIR ?? "/private/var/folders/7n/x3zhx7y94y9158pbwlqfmjyw0000gn/T", "opencode");
  await mkdir(temporaryParent, { recursive: true });
  const root = await realpath(await mkdtemp(join(temporaryParent, "hydraterm-inspection-")));
  await Bun.write(join(root, "package.json"), '{"name":"inspection-test"}\n');
  const session = new FakeSession("api", ["bun", "run", "api"], root);
  const server = await InspectionServer.start(root, [session]);
  const client = new InspectionClient(root);

  try {
    const listed = await client.request<{ root: string; processes: ProcessSummary[] }>({ method: "list" });
    expect(listed.root).toBe(root);
    expect(listed.processes).toEqual([
      expect.objectContaining({ name: "api", status: "running", pid: 1234, revision: 0 }),
    ]);

    const output = await client.request<ProcessOutput>({ method: "output", process: "api", tailLines: 2 });
    expect(output.output).toBe("two\nthree");
    expect(output.truncated).toBe(true);

    const waiting = client.request<ProcessOutput & { matched: boolean }>({
      method: "wait",
      process: "api",
      pattern: "ready",
      afterRevision: output.process.revision,
      timeoutMs: 1_000,
    });
    session.setOutput("server ready");
    const result = await waiting;
    expect(result.matched).toBe(true);
    expect(result.output).toContain("ready");
    expect(result.process.revision).toBe(1);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "..", "index.ts"), "mcp"],
      cwd: root,
      stderr: "pipe",
    });
    const mcp = new Client({ name: "hydraterm-test", version: "1.0.0" });
    try {
      await mcp.connect(transport);
      const tools = await mcp.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "list_processes",
        "get_process_output",
        "wait_for_process_output",
        "start_process",
        "stop_process",
        "restart_process",
      ]);
      const listedByMcp = await mcp.callTool({ name: "list_processes", arguments: {} });
      const content = listedByMcp.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]?.text ?? "null")).toMatchObject({
        instanceStatus: "running",
        processes: [expect.objectContaining({ name: "api", status: "running" })],
      });

      const stoppedProcess = await mcp.callTool({ name: "stop_process", arguments: { process: "api" } });
      const stoppedProcessContent = stoppedProcess.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(stoppedProcessContent[0]?.text ?? "null")).toMatchObject({
        action: "stop",
        settled: true,
        process: { name: "api", status: "stopped" },
      });
      expect(session.stops).toBe(1);

      await mcp.callTool({ name: "start_process", arguments: { process: "api" } });
      expect(session.starts).toBe(1);
      expect(session.status).toBe("running");

      const restartedProcess = await mcp.callTool({ name: "restart_process", arguments: { process: "api" } });
      const restartedProcessContent = restartedProcess.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(restartedProcessContent[0]?.text ?? "null")).toMatchObject({
        action: "restart",
        settled: true,
        process: { name: "api", status: "running" },
      });
      expect(session.restarts).toBe(1);

      const remote = await RemoteTerminalSession.connect(client, "api");
      try {
        expect(remote.snapshot()).toBe("server ready");
        remote.send("hello");
        remote.send(new TextEncoder().encode(" bytes"));
        remote.resize(120, 40);
        remote.toggleWatch();
        await waitUntil(() => session.inputs.length === 2 && session.sizes.length === 1 && session.watchEnabled === false);
        expect(session.inputs).toEqual(["hello", " bytes"]);
        expect(session.sizes).toEqual([[120, 40]]);
      } finally {
        remote.dispose();
      }

      await server.stop();
      const stoppedByMcp = await mcp.callTool({ name: "list_processes", arguments: {} });
      const stoppedContent = stoppedByMcp.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(stoppedContent[0]?.text ?? "null")).toEqual({
        instanceStatus: "stopped",
        root,
        processes: [],
      });
    } finally {
      await mcp.close();
    }
  } finally {
    await server.stop();
    expect(await Bun.file(inspectionStatePath(root)).exists()).toBe(false);
    expect(await Bun.file(instanceLockPath(root)).exists()).toBe(false);
    await rm(root, { recursive: true });
  }
});
