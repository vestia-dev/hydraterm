import { dlopen, ptr, read, type Pointer } from "bun:ffi";

/** The public libghostty-vt result codes used by this wrapper. */
const GHOSTTY_SUCCESS = 0;
const GHOSTTY_OUT_OF_SPACE = -3;

const libraryPath = new URL("../native/darwin-arm64/libghostty-vt.dylib", import.meta.url).pathname;

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    "hydraterm currently ships libghostty-vt only for macOS on Apple Silicon.",
  );
}

const library = dlopen(libraryPath, {
  // GhosttyTerminalOptions is a 16-byte integer aggregate. Darwin arm64
  // passes it in two 64-bit argument registers; Bun FFI has no struct type,
  // so its two ABI words are declared explicitly here.
  ghostty_terminal_new: { args: ["ptr", "ptr", "u64", "u64"], returns: "i32" },
  ghostty_terminal_free: { args: ["ptr"], returns: "void" },
  ghostty_terminal_resize: { args: ["ptr", "u16", "u16", "u32", "u32"], returns: "i32" },
  ghostty_terminal_vt_write: { args: ["ptr", "ptr", "usize"], returns: "void" },

  // GhosttyFormatterTerminalOptions is 56 bytes. The Darwin arm64 ABI passes
  // aggregates larger than 16 bytes indirectly, so a pointer is the correct
  // FFI representation for its final argument.
  ghostty_formatter_terminal_new: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  ghostty_formatter_format_buf: { args: ["ptr", "ptr", "usize", "ptr"], returns: "i32" },
  ghostty_formatter_free: { args: ["ptr"], returns: "void" },
} as const);

type NativeHandle = Pointer;

function check(result: number, operation: string): void {
  if (result !== GHOSTTY_SUCCESS) {
    throw new Error(`${operation} failed with libghostty-vt result ${result}.`);
  }
}

function pointerFrom(out: BigUint64Array, operation: string): NativeHandle {
  const handle = read.ptr(ptr(out)) as NativeHandle | null;
  if (handle === null) {
    throw new Error(`${operation} succeeded without returning a handle.`);
  }
  return handle;
}

function packTerminalOptions(cols: number, rows: number, maxScrollback: number): [bigint, bigint] {
  if (!Number.isInteger(cols) || cols <= 0 || cols > 0xffff) {
    throw new RangeError("cols must be an integer between 1 and 65535.");
  }
  if (!Number.isInteger(rows) || rows <= 0 || rows > 0xffff) {
    throw new RangeError("rows must be an integer between 1 and 65535.");
  }
  if (!Number.isSafeInteger(maxScrollback) || maxScrollback < 0) {
    throw new RangeError("maxScrollback must be a non-negative safe integer.");
  }

  // uint16_t cols @ byte 0, uint16_t rows @ byte 2, six bytes of padding,
  // then size_t max_scrollback @ byte 8. This only describes the documented
  // Darwin arm64 ABI for the bundled library.
  return [BigInt(cols) | (BigInt(rows) << 16n), BigInt(maxScrollback)];
}

function plainFormatterOptions(): Uint8Array {
  // GhosttyFormatterTerminalOptions is 56 bytes on 64-bit Darwin:
  // size_t size; int emit; bool unwrap; bool trim; padding;
  // GhosttyFormatterTerminalExtra extra; GhosttySelection *selection.
  const bytes = new Uint8Array(56);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 56n, true);
  view.setUint32(8, 0, true); // GHOSTTY_FORMATTER_FORMAT_PLAIN
  view.setBigUint64(16, 32n, true); // GhosttyFormatterTerminalExtra.size
  view.setBigUint64(32, 16n, true); // GhosttyFormatterScreenExtra.size
  return bytes;
}

/**
 * A small ownership-safe wrapper around Ghostty's VT parser and plain-text
 * formatter. Feed it raw PTY bytes, then call snapshot() for its screen view.
 */
export class GhosttyTerminal {
  #terminal: NativeHandle | null;
  #formatter: NativeHandle | null;

  constructor({ cols = 80, rows = 24, maxScrollback = 10_000 }: GhosttyTerminalOptions = {}) {
    const terminalOut = new BigUint64Array(1);
    const [optionsLo, optionsHi] = packTerminalOptions(cols, rows, maxScrollback);
    check(
      library.symbols.ghostty_terminal_new(null, ptr(terminalOut), optionsLo, optionsHi),
      "ghostty_terminal_new",
    );
    this.#terminal = pointerFrom(terminalOut, "ghostty_terminal_new");

    try {
      const formatterOut = new BigUint64Array(1);
      const options = plainFormatterOptions();
      check(
        library.symbols.ghostty_formatter_terminal_new(
          null,
          ptr(formatterOut),
          this.#terminal,
          ptr(options),
        ),
        "ghostty_formatter_terminal_new",
      );
      this.#formatter = pointerFrom(formatterOut, "ghostty_formatter_terminal_new");
    } catch (error) {
      library.symbols.ghostty_terminal_free(this.#terminal);
      this.#terminal = null;
      throw error;
    }
  }

  write(data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.byteLength === 0) return;
    library.symbols.ghostty_terminal_vt_write(this.#getTerminal(), ptr(bytes), BigInt(bytes.byteLength));
  }

  resize(cols: number, rows: number, cellWidthPx = 0, cellHeightPx = 0): void {
    check(
      library.symbols.ghostty_terminal_resize(
        this.#getTerminal(),
        cols,
        rows,
        cellWidthPx,
        cellHeightPx,
      ),
      "ghostty_terminal_resize",
    );
  }

  /** Return Ghostty's current active-screen contents, with terminal control codes removed. */
  snapshot(): string {
    const formatter = this.#getFormatter();
    const lengthOut = new BigUint64Array(1);
    const result = library.symbols.ghostty_formatter_format_buf(
      formatter,
      null,
      0n,
      ptr(lengthOut),
    );
    if (result !== GHOSTTY_OUT_OF_SPACE) {
      check(result, "ghostty_formatter_format_buf size query");
    }

    const length = Number(lengthOut[0]);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Formatter returned an unsafe output length: ${lengthOut[0]}.`);
    }
    if (length === 0) return "";
    const output = new Uint8Array(length);
    check(
      library.symbols.ghostty_formatter_format_buf(formatter, ptr(output), BigInt(output.length), ptr(lengthOut)),
      "ghostty_formatter_format_buf",
    );
    return new TextDecoder().decode(output.subarray(0, Number(lengthOut[0])));
  }

  dispose(): void {
    if (this.#formatter !== null) {
      library.symbols.ghostty_formatter_free(this.#formatter);
      this.#formatter = null;
    }
    if (this.#terminal !== null) {
      library.symbols.ghostty_terminal_free(this.#terminal);
      this.#terminal = null;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  #getTerminal(): NativeHandle {
    if (this.#terminal === null) throw new Error("GhosttyTerminal has been disposed.");
    return this.#terminal;
  }

  #getFormatter(): NativeHandle {
    if (this.#formatter === null) throw new Error("GhosttyTerminal has been disposed.");
    return this.#formatter;
  }
}

export interface GhosttyTerminalOptions {
  cols?: number;
  rows?: number;
  maxScrollback?: number;
}
