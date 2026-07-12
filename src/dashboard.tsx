/** @jsxImportSource @opentui/react */
import { BoxRenderable, createCliRenderer, RGBA, StyledText, TextAttributes, type CliRenderer, type KeyEvent, type ScrollBoxRenderable, type TextChunk } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { TerminalSession } from "./session";

const ACTIVE_BORDER = "#7dd3fc";
const IDLE_BORDER = "#475569";
const NAV_WIDTH = 28;

interface TerminalStyle {
  fg?: RGBA;
  bg?: RGBA;
  attributes: number;
  href: string | null;
}

function htmlText(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity, value: string) => {
    if (value.startsWith("#")) {
      const codepoint = Number.parseInt(value.slice(value[1]?.toLowerCase() === "x" ? 2 : 1), value[1]?.toLowerCase() === "x" ? 16 : 10);
      return Number.isInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" })[value.toLowerCase()] ?? entity;
  });
}

function styledHtmlOutput(output: string): StyledText {
  const chunks: TextChunk[] = [];
  const stack: Array<{ name: string; style: TerminalStyle; line: boolean }> = [];
  let style: TerminalStyle = { attributes: TextAttributes.NONE, href: null };
  let text = "";

  const append = () => {
    if (text.length === 0) return;
    chunks.push({ __isChunk: true, text: htmlText(text), fg: style.fg, bg: style.bg, attributes: style.attributes || undefined, link: style.href === null ? undefined : { url: style.href } });
    text = "";
  };
  const applyCss = (next: TerminalStyle, css: string) => {
    const palette = /(?:^|;)color:\s*var\(--vt-palette-(\d+)\)/.exec(css);
    const background = /(?:^|;)background-color:\s*var\(--vt-palette-(\d+)\)/.exec(css);
    const rgb = /(?:^|;)color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css);
    const rgbBackground = /(?:^|;)background-color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css);
    if (palette?.[1]) next.fg = RGBA.fromIndex(Number(palette[1]));
    if (background?.[1]) next.bg = RGBA.fromIndex(Number(background[1]));
    if (rgb?.[1] && rgb[2] && rgb[3]) next.fg = RGBA.fromInts(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
    if (rgbBackground?.[1] && rgbBackground[2] && rgbBackground[3]) next.bg = RGBA.fromInts(Number(rgbBackground[1]), Number(rgbBackground[2]), Number(rgbBackground[3]));
    if (css.includes("font-weight: bold")) next.attributes |= TextAttributes.BOLD;
    if (css.includes("font-style: italic")) next.attributes |= TextAttributes.ITALIC;
    if (css.includes("text-decoration: underline") || css.includes("text-decoration-line: underline")) next.attributes |= TextAttributes.UNDERLINE;
    if (css.includes("line-through")) next.attributes |= TextAttributes.STRIKETHROUGH;
  };

  const tags = /<[^>]*>/g;
  let position = 0;
  for (let match = tags.exec(output); match !== null; match = tags.exec(output)) {
    text += output.slice(position, match.index);
    position = match.index + match[0].length;
    const closing = /^<\//.test(match[0]);
    const name = /^<\/?([a-z]+)/i.exec(match[0])?.[1]?.toLowerCase();
    if (!name) continue;
    append();
    if (closing) {
      const entry = stack.pop();
      if (entry?.line) text = "\n";
      style = stack.at(-1)?.style ?? { attributes: TextAttributes.NONE, href: null };
      continue;
    }

    const next: TerminalStyle = { ...style };
    const css = /style="([^"]*)"/.exec(match[0])?.[1] ?? "";
    applyCss(next, css);
    if (name === "a") {
      next.href = htmlText(/href="([^"]*)"/.exec(match[0])?.[1] ?? "") || null;
      next.attributes |= TextAttributes.UNDERLINE;
      next.fg ??= RGBA.fromIndex(6);
    }
    const line = name === "div" && !css.includes("display: inline") && stack.length > 0;
    stack.push({ name, style: next, line });
    style = next;
  }
  text += output.slice(position);
  append();
  return new StyledText(chunks);
}

function hyperlinkAt(output: StyledText, column: number, row: number): string | null {
  let x = 0;
  let y = 0;
  for (const chunk of output.chunks) {
    for (const character of Array.from(chunk.text)) {
      if (character === "\r") continue;
      if (character === "\n") {
        x = 0;
        y++;
        continue;
      }
      if (x === column && y === row) return chunk.link?.url ?? null;
      x++;
    }
  }
  return null;
}

function linkifyUrls(output: StyledText): StyledText {
  const chunks: TextChunk[] = [];
  const text = output.chunks.map((chunk) => chunk.text).join("");
  const matches = Array.from(text.matchAll(/https?:\/\/[^\s<>"']*[A-Za-z0-9/_~#?=&%-]/g)).map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    url: match[0],
  }));
  let absoluteOffset = 0;

  for (const chunk of output.chunks) {
    const chunkStart = absoluteOffset;
    const chunkEnd = chunkStart + chunk.text.length;
    absoluteOffset = chunkEnd;
    const boundaries = new Set([chunkStart, chunkEnd]);
    for (const match of matches) {
      if (match.start < chunkEnd && match.end > chunkStart) {
        boundaries.add(Math.max(chunkStart, match.start));
        boundaries.add(Math.min(chunkEnd, match.end));
      }
    }
    const positions = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < positions.length - 1; index++) {
      const start = positions[index] ?? chunkStart;
      const end = positions[index + 1] ?? chunkEnd;
      if (start === end) continue;
      const match = matches.find((candidate) => candidate.start <= start && candidate.end >= end);
      const segment = chunk.text.slice(start - chunkStart, end - chunkStart);
      if (match && !chunk.link) {
        chunks.push({
          ...chunk,
          text: segment,
          fg: RGBA.fromIndex(6),
          attributes: (chunk.attributes ?? TextAttributes.NONE) | TextAttributes.UNDERLINE,
          link: { url: match.url },
        });
      } else {
        chunks.push({ ...chunk, text: segment });
      }
    }
  }
  return new StyledText(chunks);
}

function openHyperlink(url: string): void {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") return;
  Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
}

function ansiColor(code: number): RGBA {
  return RGBA.fromIndex(code < 8 ? code : code + 8);
}

function applySgr(style: TerminalStyle, rawParameters: string): void {
  const parameters = rawParameters === "" ? [0] : rawParameters.split(";").map((parameter) => Number(parameter || 0));
  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index] ?? 0;
    if (parameter === 0) {
      style.fg = undefined;
      style.bg = undefined;
      style.attributes = TextAttributes.NONE;
    } else if (parameter === 1) style.attributes |= TextAttributes.BOLD;
    else if (parameter === 2) style.attributes |= TextAttributes.DIM;
    else if (parameter === 3) style.attributes |= TextAttributes.ITALIC;
    else if (parameter === 4) style.attributes |= TextAttributes.UNDERLINE;
    else if (parameter === 5 || parameter === 6) style.attributes |= TextAttributes.BLINK;
    else if (parameter === 7) style.attributes |= TextAttributes.INVERSE;
    else if (parameter === 8) style.attributes |= TextAttributes.HIDDEN;
    else if (parameter === 9) style.attributes |= TextAttributes.STRIKETHROUGH;
    else if (parameter === 22) style.attributes &= ~(TextAttributes.BOLD | TextAttributes.DIM);
    else if (parameter === 23) style.attributes &= ~TextAttributes.ITALIC;
    else if (parameter === 24) style.attributes &= ~TextAttributes.UNDERLINE;
    else if (parameter === 25) style.attributes &= ~TextAttributes.BLINK;
    else if (parameter === 27) style.attributes &= ~TextAttributes.INVERSE;
    else if (parameter === 28) style.attributes &= ~TextAttributes.HIDDEN;
    else if (parameter === 29) style.attributes &= ~TextAttributes.STRIKETHROUGH;
    else if (parameter >= 30 && parameter <= 37) style.fg = ansiColor(parameter - 30);
    else if (parameter >= 90 && parameter <= 97) style.fg = ansiColor(parameter - 90 + 8);
    else if (parameter >= 40 && parameter <= 47) style.bg = ansiColor(parameter - 40);
    else if (parameter >= 100 && parameter <= 107) style.bg = ansiColor(parameter - 100 + 8);
    else if (parameter === 39) style.fg = undefined;
    else if (parameter === 49) style.bg = undefined;
    else if ((parameter === 38 || parameter === 48) && parameters[index + 1] === 5) {
      const color = parameters[index + 2];
      if (color !== undefined) (parameter === 38 ? (style.fg = RGBA.fromIndex(color)) : (style.bg = RGBA.fromIndex(color)));
      index += 2;
    } else if ((parameter === 38 || parameter === 48) && parameters[index + 1] === 2) {
      const [red, green, blue] = parameters.slice(index + 2, index + 5);
      if (red !== undefined && green !== undefined && blue !== undefined) {
        if (parameter === 38) style.fg = RGBA.fromInts(red, green, blue);
        else style.bg = RGBA.fromInts(red, green, blue);
      }
      index += 4;
    }
  }
}

/** Convert Ghostty's SGR and OSC 8 formatter output into OpenTUI text chunks. */
export function styledTerminalOutput(output: string): StyledText {
  if (output.startsWith("<")) return linkifyUrls(styledHtmlOutput(output));
  const chunks: TextChunk[] = [];
  const style: TerminalStyle = { attributes: TextAttributes.NONE, href: null };
  let text = "";

  const append = () => {
    if (text.length === 0) return;
    chunks.push({
      __isChunk: true,
      text,
      fg: style.fg,
      bg: style.bg,
      attributes: style.attributes || undefined,
      link: style.href === null ? undefined : { url: style.href },
    });
    text = "";
  };

  for (let index = 0; index < output.length;) {
    if (output[index] !== "\x1b") {
      text += output[index++] ?? "";
      continue;
    }

    if (output[index + 1] === "[") {
      let end = index + 2;
      while (end < output.length && (output.charCodeAt(end) < 0x40 || output.charCodeAt(end) > 0x7e)) end++;
      if (end < output.length) {
        append();
        if (output[end] === "m") applySgr(style, output.slice(index + 2, end));
        index = end + 1;
        continue;
      }
    } else if (output[index + 1] === "]") {
      const bell = output.indexOf("\x07", index + 2);
      const st = output.indexOf("\x1b\\", index + 2);
      const end = bell === -1 ? st : st === -1 ? bell : Math.min(bell, st);
      if (end !== -1) {
        const command = output.slice(index + 2, end);
        if (command.startsWith("8;")) {
          append();
          const separator = command.indexOf(";", 2);
          if (separator !== -1) style.href = command.slice(separator + 1) || null;
        }
        index = end + (end === bell ? 1 : 2);
        continue;
      }
    }

    // Formatter output is trusted VT, but never render unrecognized controls as text.
    index++;
  }
  append();
  return linkifyUrls(new StyledText(chunks));
}

/** Convert OpenTUI's parsed input (including Kitty keyboard events) to PTY bytes. */
function keyToPtyInput(key: KeyEvent): string {
  if (key.ctrl && key.name.length === 1 && /[a-z]/i.test(key.name)) {
    const control = String.fromCharCode(key.name.toUpperCase().charCodeAt(0) - 64);
    return key.meta || key.option ? `\x1b${control}` : control;
  }

  const modifier = 1 + (key.shift ? 1 : 0) + (key.meta || key.option ? 2 : 0) + (key.ctrl ? 4 : 0);
  const arrows: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };
  if (key.name in arrows) {
    const suffix = arrows[key.name];
    return modifier === 1 ? `\x1b[${suffix}` : `\x1b[1;${modifier}${suffix}`;
  }

  const keys: Record<string, string> = {
    return: "\r",
    enter: "\r",
    escape: "\x1b",
    tab: key.shift ? "\x1b[Z" : "\t",
    backspace: "\x7f",
    delete: "\x1b[3~",
    home: "\x1b[H",
    end: "\x1b[F",
  };
  if (key.name in keys) return keys[key.name] ?? key.sequence;

  return key.meta || key.option ? `\x1b${key.sequence}` : key.sequence;
}

function useSessionUpdate(session: TerminalSession): void {
  const [, setVersion] = useState(0);
  useEffect(() => session.subscribe(() => setVersion((version) => version + 1)), [session]);
}

function ProcessRow({ session, selected }: { session: TerminalSession; selected: boolean }) {
  useSessionUpdate(session);

  const processDetail = session.exitCode === null ? session.status : `${session.status} (${session.exitCode})`;
  const detail = `${processDetail} · watch ${session.watchEnabled ? (session.watchPending ? "pending" : "on") : "off"}`;
  return (
    <text
      height={1}
      content={`${selected ? "›" : " "} ${session.name}  ${detail}`}
      fg={selected ? "#f8fafc" : "#94a3b8"}
      bg={selected ? "#0c4a6e" : "#0f172a"}
      truncate
    />
  );
}

function OutputPane({
  session,
  focused,
  scrollRef,
  onOpenLink,
}: {
  session: TerminalSession;
  focused: boolean;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onOpenLink: (url: string) => void;
}) {
  useSessionUpdate(session);

  const detail = session.exitCode === null ? session.status : `${session.status} (${session.exitCode})`;
  const output = styledTerminalOutput(session.styledSnapshot());
  return (
    <box
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={focused ? ACTIVE_BORDER : IDLE_BORDER}
      title={` ${focused ? "● output" : "○ output"} · ${session.name} · ${detail} `}
      titleColor="#cbd5e1"
      paddingX={1}
      paddingY={0}
      onSizeChange={function (this: BoxRenderable) {
        session.resize(Math.max(1, this.width - 4), Math.max(1, this.height - 2));
      }}
    >
        <scrollbox
        ref={scrollRef}
        id="process-output"
        flexGrow={1}
        scrollY
        stickyScroll
          stickyStart="bottom"
          verticalScrollbarOptions={{ showArrows: false }}
          onMouseDown={function (event) {
            if (event.button !== 0) return;
            const url = hyperlinkAt(
              output,
              event.x - this.viewport.x,
              Math.floor(event.y - this.viewport.y + this.scrollTop),
            );
            if (url !== null) onOpenLink(url);
          }}
        >
        <text
          id="process-output-text"
          width="100%"
          content={output}
          fg="#e2e8f0"
          wrapMode="none"
        />
      </scrollbox>
    </box>
  );
}

export function DashboardView({ sessions, onQuit, onOpenLink = openHyperlink }: { sessions: readonly TerminalSession[]; onQuit: () => void; onOpenLink?: (url: string) => void }) {
  const renderer = useRenderer();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"navigation" | "output">("navigation");
  const outputScroll = useRef<ScrollBoxRenderable | null>(null);

  useKeyboard((key) => {
    if (mode === "navigation") {
      if (key.name === "q" && !key.ctrl && !key.meta && !key.option) {
        key.preventDefault();
        onQuit();
        return;
      }
      if (key.name === "j" || key.name === "k") {
        key.preventDefault();
        const delta = key.name === "j" ? 1 : -1;
        setSelected((current) => (current + delta + sessions.length) % sessions.length);
        return;
      }
      if (key.name === "s" && !key.ctrl && !key.meta && !key.option) {
        key.preventDefault();
        const session = sessions[selected];
        if (session?.status === "running") session.stop();
        else session?.start();
        return;
      }
      if (key.name === "a" && !key.ctrl && !key.meta && !key.option) {
        key.preventDefault();
        for (const session of sessions) session.start();
        return;
      }
      if (key.name === "r" && !key.ctrl && !key.meta && !key.option) {
        key.preventDefault();
        sessions[selected]?.restart();
        return;
      }
      if (key.name === "w" && !key.ctrl && !key.meta && !key.option) {
        key.preventDefault();
        sessions[selected]?.toggleWatch();
        return;
      }
      if (key.name === "p" && !key.ctrl && !key.meta && !key.option) {
        key.preventDefault();
        for (const session of sessions) session.stop();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        setMode("output");
      }
      return;
    }

    if (key.name === "escape") {
      key.preventDefault();
      setMode("navigation");
      return;
    }
    if (key.name === "j" || key.name === "k") {
      key.preventDefault();
      outputScroll.current?.scrollBy(key.name === "j" ? 1 / 5 : -1 / 5, "viewport");
      return;
    }

    // Output mode forwards OpenTUI's exact escape sequence, including Ctrl-C,
    // arrows, modifiers, and terminal-app keyboard input.
    sessions[selected]?.send(keyToPtyInput(key));
  });

  const selectedSession = sessions[selected];
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor="#0f172a">
      <text height={1} content={` hydraterm  ·  ${sessions.length} process${sessions.length === 1 ? "" : "es"}`} fg="#e2e8f0" bg="#1e293b" />
      <box flexGrow={1} flexDirection="row" backgroundColor="#0f172a">
        <box width={NAV_WIDTH} border borderStyle="rounded" borderColor={mode === "navigation" ? ACTIVE_BORDER : IDLE_BORDER} title=" processes " paddingY={0}>
          {sessions.map((session, index) => (
            <ProcessRow key={`${session.name}:${index}`} session={session} selected={index === selected} />
          ))}
        </box>
        <box width={1} />
        {selectedSession && <OutputPane key={`${selected}:${selectedSession.name}`} session={selectedSession} focused={mode === "output"} scrollRef={outputScroll} onOpenLink={onOpenLink} />}
      </box>
      <text
        height={1}
        content={mode === "navigation" ? "j/k select · s start/stop · a start all · p stop all · r restart · w watch · Enter focus output · q quit" : "j/k scroll output · Esc navigation · Ctrl-C interrupt selected process"}
        fg="#94a3b8"
        bg="#1e293b"
      />
    </box>
  );
}

/** React/JSX OpenTUI dashboard for a set of PTY-backed terminal sessions. */
export class Dashboard {
  #closed = Promise.withResolvers<void>();
  #disposed = false;

  private constructor(
    readonly renderer: CliRenderer,
    readonly sessions: readonly TerminalSession[],
  ) {
    renderer.once("destroy", () => this.dispose());
  }

  static async create(sessions: readonly TerminalSession[]): Promise<Dashboard> {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      consoleMode: "disabled",
      targetFps: 30,
      useMouse: true,
    });
    const dashboard = new Dashboard(renderer, sessions);
    createRoot(renderer).render(<DashboardView sessions={sessions} onQuit={() => renderer.destroy()} />);
    return dashboard;
  }

  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of this.sessions) session.dispose();
    this.#closed.resolve();
  }
}
