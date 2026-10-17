import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { InspectionClient, inspectionStatePath, instanceLockPath, type ProcessControlResult, type ProcessOutput, type RunningInstance } from "../src/inspection";

const entrypoint = join(import.meta.dir, "..", "index.ts");
setDefaultTimeout(15_000);

async function waitFor<T>(operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await Bun.sleep(25);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for headless Hydraterm.");
}

test("headless mode starts configured processes, serves inspection, and stops on SIGTERM", async () => {
  const temporaryParent = join(process.env.TMPDIR ?? "/private/var/folders/7n/x3zhx7y94y9158pbwlqfmjyw0000gn/T", "opencode");
  await mkdir(temporaryParent, { recursive: true });
  const root = await realpath(await mkdtemp(join(temporaryParent, "hydraterm-headless-")));
  await Bun.write(join(root, "package.json"), `${JSON.stringify({
    name: "headless-test",
    hydraterm: {
      processes: {
        server: {
          command: "printf 'headless ready:%s\\n' \"$$\"; sleep 60",
          autoStart: true,
        },
      },
    },
  })}\n`);

  const child = Bun.spawn([process.execPath, entrypoint, "--headless", "--root", root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = new InspectionClient(root);

  try {
    const listed = await waitFor(() => client.request<RunningInstance>({ method: "list" }));
    expect(listed.instanceStatus).toBe("running");
    expect(listed.mode).toBe("headless");
    expect(listed.processes).toHaveLength(1);
    expect(listed.processes[0]).toMatchObject({ name: "server" });

    const output = await waitFor(async () => {
      const result = await client.request<ProcessOutput>({ method: "output", process: "server" });
      if (!result.output.includes("headless ready")) throw new Error("Output is not ready yet.");
      return result;
    });
    expect(output.output).toContain("headless ready");
    const processPid = Number(/headless ready:(\d+)/.exec(output.output)?.[1]);
    expect(processPid).toBeGreaterThan(0);

    const stoppedProcess = await client.request<ProcessControlResult>({ method: "control", process: "server", action: "stop" });
    expect(stoppedProcess).toMatchObject({ action: "stop", settled: true, process: { status: "stopped" } });
    const startedProcess = await client.request<ProcessControlResult>({ method: "control", process: "server", action: "start" });
    expect(startedProcess).toMatchObject({ action: "start", settled: true, process: { status: "running" } });
    const restartedProcess = await client.request<ProcessControlResult>({ method: "control", process: "server", action: "restart" });
    expect(restartedProcess).toMatchObject({ action: "restart", settled: true, process: { status: "running" } });

    const duplicate = Bun.spawnSync([process.execPath, entrypoint, "headless", "--root", root], { stdout: "pipe", stderr: "pipe" });
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr.toString()).toContain("already running");

    const status = Bun.spawnSync([process.execPath, entrypoint, "status", "--root", root], { stdout: "pipe", stderr: "pipe" });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toContain("running in headless mode");

    const stopped = Bun.spawnSync([process.execPath, entrypoint, "stop", "--root", root], { stdout: "pipe", stderr: "pipe" });
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout.toString()).toContain("Stopped Hydraterm");
    expect(await child.exited).toBe(0);
    const processState = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(processPid)], { stdout: "pipe", stderr: "ignore" });
    expect(processState.stdout.toString().trim()).toBe("");
    await waitFor(async () => {
      if (await Bun.file(inspectionStatePath(root)).exists()) throw new Error("Inspection state still exists.");
      if (await Bun.file(instanceLockPath(root)).exists()) throw new Error("Instance lock still exists.");
    });
    expect((await client.status()).instanceStatus).toBe("stopped");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true });
  }
});

test("ensure starts one detached headless instance and reuses it", async () => {
  const temporaryParent = join(process.env.TMPDIR ?? "/private/var/folders/7n/x3zhx7y94y9158pbwlqfmjyw0000gn/T", "opencode");
  await mkdir(temporaryParent, { recursive: true });
  const root = await realpath(await mkdtemp(join(temporaryParent, "hydraterm-ensure-")));
  await Bun.write(join(root, "package.json"), `${JSON.stringify({
    name: "ensure-test",
    hydraterm: { processes: { server: { command: "sleep 60", autoStart: true } } },
  })}\n`);
  const client = new InspectionClient(root);

  try {
    const ensureCommand = [process.execPath, entrypoint, "ensure", "--headless", "--root", root];
    const firstRun = Bun.spawn(ensureCommand, { stdout: "pipe", stderr: "pipe" });
    const concurrentRun = Bun.spawn(ensureCommand, { stdout: "pipe", stderr: "pipe" });
    expect(await Promise.all([firstRun.exited, concurrentRun.exited])).toEqual([0, 0]);
    const first = await client.status();
    expect(first.instanceStatus).toBe("running");
    if (first.instanceStatus !== "running") throw new Error("Expected a running instance.");

    const secondRun = Bun.spawnSync(ensureCommand, { stdout: "pipe", stderr: "pipe" });
    expect(secondRun.exitCode).toBe(0);
    const second = await client.status();
    expect(second).toMatchObject({ instanceStatus: "running", pid: first.pid, mode: "headless" });

    const stop = Bun.spawnSync([process.execPath, entrypoint, "stop", "--root", root], { stdout: "pipe", stderr: "pipe" });
    expect(stop.exitCode).toBe(0);
    expect((await client.status()).instanceStatus).toBe("stopped");
  } finally {
    await client.stop().catch(() => {});
    await rm(root, { recursive: true });
  }
});
