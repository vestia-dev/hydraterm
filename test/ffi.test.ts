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

test("writes device-attribute and XTVERSION responses to its configured target", () => {
  using terminal = new GhosttyTerminal();
  const responses: Uint8Array[] = [];
  terminal.setWriteTarget((data) => responses.push(data));

  terminal.write("\x1b[c");
  terminal.write("\x1b[>q");

  const decoder = new TextDecoder();
  expect(responses.map((data) => decoder.decode(data))).toEqual([
    "\x1b[?62;22c",
    "\x1bP>|libghostty\x1b\\",
  ]);
});

test("routes repeated query responses without reentering the terminal", () => {
  using terminal = new GhosttyTerminal();
  let responses = 0;
  terminal.setWriteTarget(() => responses++);

  for (let index = 0; index < 100; index++) terminal.write("\x1b[c\x1b[5n");

  expect(responses).toBe(200);
});

test("formats screen colors, styles, and hyperlinks as HTML output", () => {
  using terminal = new GhosttyTerminal({ cols: 80, rows: 4 });
  terminal.write("\x1b[1;31mred\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\");

  expect(terminal.styledSnapshot()).toContain('color: var(--vt-palette-1);font-weight: bold;">red');
  expect(terminal.styledSnapshot()).toContain('<a href="https://example.com">link</a>');
});
