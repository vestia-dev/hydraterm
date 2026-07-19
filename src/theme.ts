import { RGBA, type CliRenderer } from "@opentui/core";

type ThemeColor = string | RGBA;

export interface TerminalTheme {
  background: ThemeColor;
  foreground: ThemeColor;
  muted: ThemeColor;
  surface: ThemeColor;
  active: ThemeColor;
  border: ThemeColor;
}

export const FALLBACK_TERMINAL_THEME: TerminalTheme = {
  background: RGBA.fromIndex(0),
  foreground: RGBA.fromIndex(7),
  muted: RGBA.fromIndex(8),
  surface: RGBA.fromIndex(0),
  active: RGBA.fromIndex(6),
  border: RGBA.fromIndex(8),
};

function color(value: string | null | undefined, fallbackIndex: number): ThemeColor {
  return value ?? RGBA.fromIndex(fallbackIndex);
}

/** Read the terminal palette so the UI follows the active terminal theme. */
export async function detectTerminalTheme(renderer: CliRenderer): Promise<TerminalTheme> {
  try {
    const colors = await renderer.getPalette({ timeout: 200 });
    return {
      background: color(colors.defaultBackground, 0),
      foreground: color(colors.defaultForeground, 7),
      muted: color(colors.palette[8], 8),
      surface: color(colors.palette[0], 0),
      active: color(colors.palette[6], 6),
      border: color(colors.palette[8], 8),
    };
  } catch {
    return FALLBACK_TERMINAL_THEME;
  }
}
