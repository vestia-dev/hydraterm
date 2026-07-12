import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverConfiguredProcesses, discoverScripts, isDefaultScript, resolveScriptNames, saveConfiguredProcesses, scriptLabel } from "../src/scripts";

const root = resolve(import.meta.dir, "fixtures/monorepo");
const manifestRoot = resolve(import.meta.dir, "fixtures/process-manifest");

test("discovers root and workspace scripts deterministically while ignoring generated trees", async () => {
  const scripts = await discoverScripts({ root });
  expect(scripts.map(scriptLabel)).toEqual([
    "@fixture/api:build",
    "@fixture/api:dev",
    "@fixture/api:postbuild",
    "@fixture/web:dev",
    "fixture-root:dev",
    "fixture-root:lint",
    "fixture-root:prebuild",
    "fixture-root:typecheck",
  ]);
  expect(scripts.filter(isDefaultScript).map(scriptLabel)).toEqual(["@fixture/api:build", "@fixture/api:dev", "@fixture/web:dev", "fixture-root:dev"]);
});

test("resolves bare and package-qualified names and reports unknown choices", async () => {
  const scripts = await discoverScripts({ root });
  expect(resolveScriptNames(scripts, ["dev"]).map(scriptLabel)).toEqual(["@fixture/api:dev", "@fixture/web:dev", "fixture-root:dev"]);
  expect(resolveScriptNames(scripts, ["@fixture/api:build"]).map(scriptLabel)).toEqual(["@fixture/api:build"]);
  expect(() => resolveScriptNames(scripts, ["missing"])).toThrow("Unknown script: missing. Available:");
});

test("discovers named manifest processes with repository-root watch paths", async () => {
  const processes = await discoverConfiguredProcesses({ root: manifestRoot });
  expect(processes).toEqual([
    {
      packageRoot: resolve(manifestRoot, "packages/functions"),
      packageName: "process-fixture",
      scriptName: "API",
      command: "bun run dev:api",
      label: "API",
      shell: true,
      env: { PORT: "3002" },
      autoStart: true,
      watchRoot: manifestRoot,
      watch: { include: ["packages/functions/**", "packages/data/**"] },
    },
    {
      packageRoot: resolve(manifestRoot, "packages/web"),
      packageName: "process-fixture",
      scriptName: "Web",
      command: "bun run dev",
      label: "Web",
      shell: true,
      env: undefined,
      autoStart: true,
      watchRoot: manifestRoot,
      watch: false,
    },
  ]);
});

test("persists selected scripts as auto-starting manifest processes", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "hydraterm-manifest-"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "example", hydraterm: { watch: { debounceMs: 200 } } }));
  try {
    await saveConfiguredProcesses([{
      packageRoot: join(packageRoot, "packages/web"),
      packageName: "@example/web",
      scriptName: "dev",
      command: "vite",
    }], { root: packageRoot });
    const saved = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    expect(saved.hydraterm).toEqual({
      watch: { debounceMs: 200 },
      processes: {
        "@example/web:dev": {
          command: "bun run --silent 'dev'",
          workingDir: "packages/web",
          autoStart: true,
        },
      },
    });
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});
