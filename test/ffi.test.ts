import { expect, test } from "bun:test";
import { GhosttyTerminal } from "../src/ffi";

test("formats an empty terminal without passing an invalid zero-length FFI buffer", () => {
  using terminal = new GhosttyTerminal();
  expect(terminal.snapshot()).toBe("");
});

test("formats raw PTY redraws as their final screen state", async () => {
  const terminal = new GhosttyTerminal({ cols: 40, rows: 4 });
  try {
    const pty = new Bun.Terminal({
      cols: 40,
      rows: 4,
      data(_pty, data) {
        terminal.write(data);
      },
    });
    const child = Bun.spawn([process.execPath, "run", "--silent", "demo:spinner"], {
      terminal: pty,
    });
    await child.exited;
    pty.close();

    expect(terminal.snapshot()).toContain("⠹ Done");
    expect(terminal.snapshot()).not.toContain("⠋ Building");
  } finally {
    terminal.dispose();
  }
});
