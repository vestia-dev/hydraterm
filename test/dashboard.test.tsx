/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { RGBA, TextAttributes, type ScrollBoxRenderable, type TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { DashboardView, styledTerminalOutput } from "../src/dashboard";
import type { ProcessStatus, TerminalSession } from "../src/session";

class FakeSession implements TerminalSession {
  status: ProcessStatus = "idle";
  exitCode: number | null = null;
  watchEnabled = true;
  watchPending = false;
  readonly inputs: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  starts = 0;
  stops = 0;
  restarts = 0;
  #screen = "ready";
  #listeners = new Set<() => void>();

  constructor(readonly name: string, readonly command: readonly string[]) {}

  snapshot(): string {
    return this.#screen;
  }

  styledSnapshot(): string {
    return this.#screen;
  }

  start(): void {
    if (this.status === "running") return;
    this.starts++;
    this.status = "running";
  }
  restart(): void {
    this.restarts++;
    this.status = "idle";
    this.exitCode = null;
    this.start();
  }
  toggleWatch(): void {
    this.watchEnabled = !this.watchEnabled;
  }
  stop(): void {
    if (this.status !== "running") return;
    this.stops++;
    this.status = "stopped";
  }
  dispose(): void {}

  send(input: string | Uint8Array): void {
    this.inputs.push(typeof input === "string" ? input : new TextDecoder().decode(input));
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setScreen(screen: string): void {
    this.#screen = screen;
    for (const listener of this.#listeners) listener();
  }
}

test("converts Ghostty HTML formatter output into styled OpenTUI chunks", () => {
  const output = styledTerminalOutput('<div style="font-family: monospace;"><div style="display: inline;color: var(--vt-palette-1);font-weight: bold;">red</div> <span style="display: inline;text-decoration-line: underline;text-decoration-style: solid;">underlined</span> &#10140; <a href="https://example.com/?value=1&amp;next=2">link</a></div>');

  expect(output.chunks).toHaveLength(5);
  expect(output.chunks[0]).toMatchObject({
    text: "red",
    fg: RGBA.fromIndex(1),
    attributes: TextAttributes.BOLD,
  });
  expect(output.chunks[1]).toMatchObject({ text: " ", attributes: undefined });
  expect(output.chunks[2]).toMatchObject({ text: "underlined", attributes: TextAttributes.UNDERLINE });
  expect(output.chunks[3]).toMatchObject({ text: " ➜ ", attributes: undefined });
  expect(output.chunks[4]).toMatchObject({
    text: "link",
    link: { url: "https://example.com/?value=1&next=2" },
    fg: RGBA.fromIndex(6),
    attributes: TextAttributes.UNDERLINE,
  });
});

test("renders plain HTTP URLs as visible hyperlinks", () => {
  const output = styledTerminalOutput('<div style="font-family: monospace;">Listening at http://localhost:3000</div>');

  expect(output.chunks).toHaveLength(2);
  expect(output.chunks[1]).toMatchObject({
    text: "http://localhost:3000",
    fg: RGBA.fromIndex(6),
    attributes: TextAttributes.UNDERLINE,
    link: { url: "http://localhost:3000" },
  });
});

test("links a URL split between its hostname and port without consuming punctuation", () => {
  const output = styledTerminalOutput('<div>http://localhost:<span style="font-weight: bold;">3004/.</span></div>');

  expect(output.chunks).toEqual([
    expect.objectContaining({ text: "http://localhost:", link: { url: "http://localhost:3004/" }, attributes: TextAttributes.UNDERLINE }),
    expect.objectContaining({ text: "3004/", link: { url: "http://localhost:3004/" }, attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE }),
    expect.objectContaining({ text: ".", link: undefined, attributes: TextAttributes.BOLD }),
  ]);
});

test("opens a clicked output hyperlink while keeping output text selectable", async () => {
  const session = new FakeSession("web", ["web"]);
  session.setScreen('<div style="font-family: monospace;"><a href="https://example.com">link</a></div>');
  const opened: string[] = [];
  const setup = await testRender(<DashboardView sessions={[session]} onQuit={() => {}} onOpenLink={(url) => opened.push(url)} />, {
    width: 80,
    height: 20,
    exitOnCtrlC: false,
  });

  try {
    await setup.flush();
    const output = setup.renderer.root.findDescendantById("process-output-text") as TextRenderable;
    expect(output.selectable).toBe(true);
    await act(async () => {
      await setup.mockMouse.click(output.x, output.y);
    });
    expect(opened).toEqual(["https://example.com"]);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

test("React dashboard uses j/k navigation and routes focused output input to the selected pane", async () => {
  const first = new FakeSession("api", ["api"]);
  const second = new FakeSession("web", ["web"]);
  let quit = false;
  const setup = await testRender(<DashboardView sessions={[first, second]} onQuit={() => { quit = true; }} />, {
    width: 80,
    height: 20,
    exitOnCtrlC: false,
    kittyKeyboard: true,
  });

  try {
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("hydraterm");
    expect(setup.captureCharFrame()).toContain("ready");
    await act(async () => {
      setup.mockInput.pressKey("a");
    });
    expect(first.starts).toBe(1);
    expect(second.starts).toBe(1);

    await act(async () => {
      setup.mockInput.pressKey("j");
    });
    await setup.flush();
    expect(first.starts).toBe(1);
    expect(second.starts).toBe(1);
    second.status = "failed";
    second.exitCode = 1;
    await act(async () => {
      setup.mockInput.pressKey("r");
    });
    expect(second.restarts).toBe(1);
    expect(second.starts).toBe(2);
    await act(async () => {
      setup.mockInput.pressKey("w");
    });
    expect(second.watchEnabled).toBe(false);
    await act(async () => {
      setup.mockInput.pressKey("s");
    });
    expect(second.stops).toBe(1);
    expect(second.status as ProcessStatus).toBe("stopped");
    await act(async () => {
      setup.mockInput.pressKey("s");
    });
    expect(second.starts).toBe(3);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.flush();
    await act(async () => {
      await setup.mockInput.typeText("x");
    });
    expect(first.inputs).toEqual([]);
    expect(second.inputs).toEqual(["x"]);

    const history = Array.from({ length: 60 }, (_, index) => `server line ${index}`).join("\n");
    await act(async () => {
      second.setScreen(history);
    });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("server line 59");

    const output = setup.renderer.root.findDescendantById("process-output") as ScrollBoxRenderable;
    expect(output.scrollHeight).toBeGreaterThan(output.viewport.height);
    const bottom = output.scrollTop;
    await act(async () => {
      setup.mockInput.pressKey("k");
    });
    await setup.flush();
    expect(output.scrollTop).toBeLessThan(bottom);

    await act(async () => {
      setup.mockInput.pressCtrlC();
    });
    expect(second.inputs).toEqual(["x", "\x03"]);

    await act(async () => {
      setup.mockInput.pressEscape();
    });
    await setup.flush();
    await act(async () => {
      setup.mockInput.pressKey("p");
    });
    expect(first.stops).toBe(1);
    expect(second.stops).toBe(2);
    await act(async () => {
      setup.mockInput.pressKey("q");
    });
    expect(quit).toBe(true);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});
