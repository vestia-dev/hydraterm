/** @jsxImportSource @opentui/react */
import { BoxRenderable, createCliRenderer, type CliRenderer, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { TerminalSession } from "./session";

const ACTIVE_BORDER = "#7dd3fc";
const IDLE_BORDER = "#475569";
const NAV_WIDTH = 28;

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
}: {
  session: TerminalSession;
  focused: boolean;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
}) {
  useSessionUpdate(session);

  const detail = session.exitCode === null ? session.status : `${session.status} (${session.exitCode})`;
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
      >
        <text width="100%" content={session.snapshot()} fg="#e2e8f0" wrapMode="none" />
      </scrollbox>
    </box>
  );
}

export function DashboardView({ sessions, onQuit }: { sessions: readonly TerminalSession[]; onQuit: () => void }) {
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
        {selectedSession && <OutputPane key={`${selected}:${selectedSession.name}`} session={selectedSession} focused={mode === "output"} scrollRef={outputScroll} />}
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
