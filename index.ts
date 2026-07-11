#!/usr/bin/env bun
import { Dashboard } from "./src/dashboard";
import { PtySession } from "./src/session";

const scripts = process.argv.slice(2);

if (scripts.length === 0) {
  console.error("Usage: hydraterm <package-script> [...package-scripts]");
  process.exit(1);
}

const sessions = scripts.map(
  (script) => new PtySession(script, [process.execPath, "run", "--silent", script]),
);
const dashboard = await Dashboard.create(sessions);
await dashboard.closed;
