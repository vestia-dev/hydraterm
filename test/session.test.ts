import { expect, test } from "bun:test";
import { PtySession } from "../src/session";

function waitForStatus(session: PtySession, status: "running" | "failed" | "exited"): Promise<void> {
  if (session.status === status) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${status}; current status: ${session.status}`));
    }, 1_000);
    const unsubscribe = session.subscribe(() => {
      if (session.status !== status) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
    if (session.status === status) {
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    }
  });
}

test("restarts a failed PTY process with a fresh terminal state", async () => {
  const session = new PtySession("fails", ["/bin/sh", "-c", "printf 'attempt\\r\\n'; sleep 0.05; exit 1"]);
  try {
    session.start();
    await waitForStatus(session, "failed");
    expect(session.exitCode).toBe(1);

    session.restart();
    await waitForStatus(session, "running");
    await waitForStatus(session, "failed");
    expect(session.exitCode).toBe(1);
    expect(session.snapshot()).toContain("attempt");
  } finally {
    session.dispose();
  }
});

test("runs a process from its configured working directory", async () => {
  const cwd = "/tmp";
  const session = new PtySession("pwd", ["/bin/sh", "-c", "pwd"], { cwd });
  try {
    session.start();
    await waitForStatus(session, "exited");
    expect(session.snapshot()).toContain(cwd);
  } finally {
    session.dispose();
  }
});

test("runs configured process commands through a shell with their environment", async () => {
  const cwd = "/tmp";
  const session = new PtySession("configured", ["printf '%s:%s' \"$PORT\" \"$PWD\""], {
    cwd,
    env: { PORT: "3002" },
    shell: true,
    watch: false,
  });
  try {
    session.start();
    await waitForStatus(session, "exited");
    expect(session.snapshot()).toContain("3002:");
    expect(session.snapshot()).toContain("tmp");
  } finally {
    session.dispose();
  }
});

test("forwards Ghostty query responses to the child PTY", async () => {
  const session = new PtySession(
    "device-attributes",
    ["/bin/sh", "-c", "stty raw -echo; printf '\\033[c'; response=$(dd bs=1 count=9 2>/dev/null | od -An -t x1); stty sane; printf 'response:%s\\n' \"$response\""],
    { watch: false },
  );
  try {
    session.start();
    await waitForStatus(session, "exited");

    expect(session.snapshot()).toMatch(/response:\s+1b\s+5b\s+3f\s+36\s+32\s+3b\s+32\s+32\s+63/);
  } finally {
    session.dispose();
  }
});
