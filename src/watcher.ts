import { watch, type FSWatcher } from "node:fs";
import { isAbsolute, relative } from "node:path";

export const DEFAULT_WATCH_INCLUDES = ["**/*.{ts,tsx,js,jsx,mjs,cjs,json,css,scss,sass,html,md,mdx,yaml,yml,toml}"];
export const DEFAULT_WATCH_EXCLUDES = ["node_modules", ".git", "vendor", ".build-libghostty", "dist", "out", "build"];

export interface WatchConfiguration {
  root: string;
  include?: readonly string[];
  exclude?: readonly string[];
  debounceMs?: number;
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** A recursive Bun fs.watch wrapper with path filtering and restart coalescing. */
export class FileWatcher {
  readonly root: string;
  readonly debounceMs: number;
  readonly #includes: Bun.Glob[];
  readonly #excludes: Bun.Glob[];
  #watcher: FSWatcher | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #changing = false;
  #ignoreUntil = 0;
  #disposed = false;
  #enabled = true;

  constructor(
    configuration: WatchConfiguration,
    readonly onChange: () => void | Promise<void>,
    readonly onStateChange: () => void = () => {},
  ) {
    this.root = configuration.root;
    this.debounceMs = Math.max(0, Math.floor(configuration.debounceMs ?? 150));
    this.#includes = (configuration.include ?? DEFAULT_WATCH_INCLUDES).map((pattern) => new Bun.Glob(pattern));
    this.#excludes = (configuration.exclude ?? []).map((pattern) => new Bun.Glob(pattern));
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get pending(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#disposed || !this.#enabled || this.#watcher) return;
    this.#watcher = watch(this.root, { recursive: true }, (_event, filename) => {
      if (typeof filename === "string") this.handleChange(filename);
    });
    this.onStateChange();
  }

  toggle(): void {
    if (this.#disposed) return;
    this.#enabled = !this.#enabled;
    if (!this.#enabled) this.#close();
    else this.start();
    this.onStateChange();
  }

  matches(path: string): boolean {
    const candidate = normalizedPath(isAbsolute(path) ? relative(this.root, path) : path);
    if (!candidate || candidate.startsWith("../")) return false;
    if (candidate.split("/").some((part) => DEFAULT_WATCH_EXCLUDES.includes(part))) return false;
    if (this.#excludes.some((glob) => glob.match(candidate))) return false;
    return this.#includes.some((glob) => glob.match(candidate));
  }

  /** Receives the relative path provided by fs.watch; public for deterministic tests. */
  handleChange(path: string): boolean {
    if (this.#disposed || !this.#enabled || Date.now() < this.#ignoreUntil || !this.matches(path)) return false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.onStateChange();
      if (this.#disposed || !this.#enabled || this.#changing) return;
      // macOS can report one write as separated rename/change events; ignore that tail.
      this.#ignoreUntil = Date.now() + this.debounceMs * 2;
      this.#changing = true;
      void Promise.resolve(this.onChange()).finally(() => {
        this.#changing = false;
      });
    }, this.debounceMs);
    this.onStateChange();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#close();
  }

  #close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#watcher?.close();
    this.#watcher = null;
    this.onStateChange();
  }
}
