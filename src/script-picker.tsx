/** @jsxImportSource @opentui/react */
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useState } from "react";
import { scriptLabel, type PackageScript } from "./scripts";

export function ScriptPickerView({ scripts, onConfirm, onCancel }: {
  scripts: readonly PackageScript[];
  onConfirm: (scripts: PackageScript[]) => void;
  onCancel: () => void;
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
  return <box width="100%" height="100%" flexDirection="column" backgroundColor="#0f172a" paddingX={1}>
    <text height={1} content=" Select scripts " fg="#e2e8f0" bg="#1e293b" />
    <box flexGrow={1} flexDirection="column">
      {scripts.map((script, index) => <text key={`${script.packageRoot}:${script.scriptName}`} height={1} content={`${index === cursor ? "›" : " "} ${selected.has(index) ? "[x]" : "[ ]"} ${scriptLabel(script)}  ${script.command}`} fg={index === cursor ? "#f8fafc" : "#94a3b8"} bg={index === cursor ? "#0c4a6e" : "#0f172a"} truncate />)}
    </box>
    <text height={1} content="j/k move · Space toggle · a select all · Enter start · q cancel" fg="#94a3b8" bg="#1e293b" />
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
    const picker = new ScriptPicker(renderer, scripts);
    createRoot(renderer).render(<ScriptPickerView scripts={scripts} onConfirm={(selected) => picker.#finish(selected)} onCancel={() => picker.#finish(null)} />);
    return picker.#result.promise;
  }

  #finish(result: PackageScript[] | null): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#result.resolve(result);
    this.renderer.destroy();
  }
}
