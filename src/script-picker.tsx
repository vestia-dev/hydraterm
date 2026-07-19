/** @jsxImportSource @opentui/react */
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useState } from "react";
import { scriptLabel, type PackageScript } from "./scripts";
import { detectTerminalTheme, FALLBACK_TERMINAL_THEME, type TerminalTheme } from "./theme";

export function ScriptPickerView({ scripts, onConfirm, onCancel, theme = FALLBACK_TERMINAL_THEME }: {
  scripts: readonly PackageScript[];
  onConfirm: (scripts: PackageScript[]) => void;
  onCancel: () => void;
  theme?: TerminalTheme;
}) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useKeyboard((key) => {
    if (key.name === "q") {
      key.preventDefault();
      onCancel();
    } else if (key.name === "j" || key.name === "k") {
      key.preventDefault();
      setCursor((current) => (current + (key.name === "j" ? 1 : -1) + scripts.length) % scripts.length);
    } else if (key.name === "space") {
      key.preventDefault();
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
    } else if (key.name === "a") {
      key.preventDefault();
      setSelected(new Set(scripts.map((_, index) => index)));
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      onConfirm([...selected].map((index) => scripts[index]).filter((script): script is PackageScript => script !== undefined));
    }
  });
  return <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} paddingX={1}>
    <text height={1} content=" Select scripts " fg={theme.foreground} bg={theme.surface} />
    <box flexGrow={1} flexDirection="column">
      {scripts.map((script, index) => <text key={`${script.packageRoot}:${script.scriptName}`} height={1} content={`${index === cursor ? "›" : " "} ${selected.has(index) ? "[x]" : "[ ]"} ${scriptLabel(script)}  ${script.command}`} fg={index === cursor ? theme.background : theme.foreground} bg={index === cursor ? theme.active : theme.background} truncate />)}
    </box>
    <text height={1} content="j/k move · Space toggle · a select all · Enter start · q cancel" fg={theme.foreground} bg={theme.surface} />
  </box>;
}

export class ScriptPicker {
  #result = Promise.withResolvers<PackageScript[] | null>();
  #settled = false;

  private constructor(readonly renderer: CliRenderer, readonly scripts: readonly PackageScript[]) {
    renderer.once("destroy", () => this.#finish(null));
  }

  static async select(scripts: readonly PackageScript[]): Promise<PackageScript[] | null> {
    const renderer = await createCliRenderer({ exitOnCtrlC: false, consoleMode: "disabled", targetFps: 30 });
    const theme = await detectTerminalTheme(renderer);
    const picker = new ScriptPicker(renderer, scripts);
    createRoot(renderer).render(<ScriptPickerView scripts={scripts} onConfirm={(selected) => picker.#finish(selected)} onCancel={() => picker.#finish(null)} theme={theme} />);
    return picker.#result.promise;
  }

  #finish(result: PackageScript[] | null): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#result.resolve(result);
    this.renderer.destroy();
  }
}
