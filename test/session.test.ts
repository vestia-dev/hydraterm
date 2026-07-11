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
