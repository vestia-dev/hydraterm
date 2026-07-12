import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtySession } from "../src/session";
import { FileWatcher } from "../src/watcher";

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("filters excluded paths and coalesces matching writes", async () => {
  let changes = 0;
  const watcher = new FileWatcher({ root: process.cwd(), debounceMs: 20 }, () => { changes++; });
  try {
    expect(watcher.matches("src/app.ts")).toBe(true);
    expect(watcher.matches("package.json")).toBe(true);
    expect(watcher.matches("node_modules/pkg/index.ts")).toBe(false);
    expect(watcher.matches("dist/app.ts")).toBe(false);
    expect(watcher.handleChange("src/app.ts")).toBe(true);
    expect(watcher.handleChange("src/app.ts")).toBe(true);
    expect(watcher.handleChange("src/app.ts")).toBe(true);
    expect(watcher.pending).toBe(true);
    await wait(50);
    expect(changes).toBe(1);
    expect(watcher.pending).toBe(false);
  } finally {
    watcher.dispose();
  }
});

test("disposal cancels a pending restart", async () => {
  let changes = 0;
  const watcher = new FileWatcher({ root: process.cwd(), debounceMs: 20 }, () => { changes++; });
  watcher.handleChange("src/app.ts");
  watcher.dispose();
  await wait(50);
  expect(changes).toBe(0);
  expect(watcher.pending).toBe(false);
});

test("ignores an event whose debounce expires during a restart", async () => {
  let changes = 0;
  const restarted = Promise.withResolvers<void>();
  const watcher = new FileWatcher({ root: process.cwd(), debounceMs: 10 }, async () => {
    changes++;
    await restarted.promise;
  });
  try {
    watcher.handleChange("src/app.ts");
    await wait(20);
    watcher.handleChange("src/other.ts");
    await wait(20);
    restarted.resolve();
    await wait(20);
    expect(changes).toBe(1);
  } finally {
    watcher.dispose();
  }
});

test("a session restarts once for a matching filesystem write", async () => {
  const root = await mkdtemp(join(tmpdir(), "hydraterm-watch-"));
  const countFile = join(root, "runs");
  const sourceFile = join(root, "src.ts");
  await writeFile(sourceFile, "export const value = 1;\n");
  const session = new PtySession("watch", ["/bin/sh", "-c", `echo run >> '${countFile}'; while :; do sleep 1; done`], {
    cwd: root,
    watch: { debounceMs: 40 },
  });
  try {
    session.start();
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if ((await readFile(countFile, "utf8")).trim().split("\n").length === 1) break;
      } catch {}
      await wait(25);
    }
    await writeFile(sourceFile, "export const value = 2;\n");
    await writeFile(sourceFile, "export const value = 3;\n");
    await wait(250);
    expect((await readFile(countFile, "utf8")).trim().split("\n")).toHaveLength(2);
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
