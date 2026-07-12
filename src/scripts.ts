import { dirname, relative, resolve, sep } from "node:path";

export interface PackageScript {
  packageRoot: string;
  packageName: string;
  scriptName: string;
  command: string;
  label?: string;
  shell?: boolean;
  env?: Record<string, string>;
  autoStart?: boolean;
  watchRoot?: string;
  watch?: PackageWatchConfiguration | false;
}

export interface PackageWatchConfiguration {
  include?: string[];
  exclude?: string[];
  debounceMs?: number;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  hydraterm?: {
    watch?: PackageWatchConfiguration | false;
    processes?: Record<string, ProcessManifestEntry>;
  };
}

interface ProcessManifestEntry {
  command: string;
  workingDir?: string;
  restartWhenChanged?: string[];
  autoStart?: boolean;
  env?: Record<string, string>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

export interface DiscoverScriptsOptions {
  root?: string;
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "vendor", ".build-libghostty", "dist", "out"]);

function isIgnoredPath(path: string): boolean {
  return path.split(sep).some((part) => IGNORED_DIRECTORIES.has(part));
}

async function readPackageJson(packageRoot: string): Promise<PackageJson | null> {
  try {
    return await Bun.file(resolve(packageRoot, "package.json")).json();
  } catch {
    return null;
  }
}

async function findPackageRoot(start: string): Promise<string> {
  let current = resolve(start);
  while (true) {
    if (await Bun.file(resolve(current, "package.json")).exists()) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No package.json found from ${start}.`);
    current = parent;
  }
}

function workspacePatterns(packageJson: PackageJson): string[] {
  return Array.isArray(packageJson.workspaces) ? packageJson.workspaces : (packageJson.workspaces?.packages ?? []);
}

function toScripts(packageRoot: string, packageJson: PackageJson): PackageScript[] {
  return Object.entries(packageJson.scripts ?? {}).map(([scriptName, command]) => ({
    packageRoot,
    packageName: packageJson.name ?? (relative(process.cwd(), packageRoot) || "."),
    scriptName,
    command,
    watch: packageJson.hydraterm?.watch,
  }));
}

/** Discovers root and workspace scripts without descending into generated trees. */
export async function discoverScripts(options: DiscoverScriptsOptions = {}): Promise<PackageScript[]> {
  const root = await findPackageRoot(options.root ?? process.cwd());
  const rootPackage = await readPackageJson(root);
  if (!rootPackage) throw new Error(`Unable to read ${resolve(root, "package.json")}.`);

  const packages: Array<{ root: string; json: PackageJson }> = [{ root, json: rootPackage }];
  for (const pattern of workspacePatterns(rootPackage)) {
    const glob = new Bun.Glob(`${pattern.replace(/\/+$/, "")}/package.json`);
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      const packageRoot = resolve(root, dirname(file));
      if (isIgnoredPath(packageRoot) || packageRoot === root) continue;
      const packageJson = await readPackageJson(packageRoot);
      if (packageJson) packages.push({ root: packageRoot, json: packageJson });
    }
  }

  return [...new Map(packages.map((item) => [item.root, item])).values()]
    .flatMap(({ root: packageRoot, json }) => toScripts(packageRoot, json))
    .sort((left, right) =>
      left.packageName.localeCompare(right.packageName) || left.scriptName.localeCompare(right.scriptName),
    );
}

/** Reads named root processes; returns null when the project uses script discovery instead. */
export async function discoverConfiguredProcesses(options: DiscoverScriptsOptions = {}): Promise<PackageScript[] | null> {
  const root = await findPackageRoot(options.root ?? process.cwd());
  const packageJson = await readPackageJson(root);
  const processes = packageJson?.hydraterm?.processes;
  if (!processes) return null;

  return Object.entries(processes).map(([name, process]) => {
    if (!process || typeof process.command !== "string" || process.command.length === 0) {
      throw new Error(`hydraterm.processes.${name} needs a command.`);
    }
    const packageRoot = resolve(root, process.workingDir ?? ".");
    const restartWhenChanged = process.restartWhenChanged;
    if (restartWhenChanged !== undefined && !Array.isArray(restartWhenChanged)) {
      throw new Error(`hydraterm.processes.${name}.restartWhenChanged must be an array.`);
    }
    const watch: PackageWatchConfiguration | false = restartWhenChanged !== undefined && restartWhenChanged.length > 0
      ? { include: restartWhenChanged }
      : false;
    return {
      packageRoot,
      packageName: packageJson?.name ?? ".",
      scriptName: name,
      command: process.command,
      label: name,
      shell: true,
      env: process.env,
      autoStart: process.autoStart !== false,
      watchRoot: root,
      watch,
    };
  }).sort((left, right) => left.label!.localeCompare(right.label!));
}

/** Persists first-run script choices as explicit root process definitions. */
export async function saveConfiguredProcesses(scripts: readonly PackageScript[], options: DiscoverScriptsOptions = {}): Promise<void> {
  const root = await findPackageRoot(options.root ?? process.cwd());
  const packageFile = resolve(root, "package.json");
  const document = await Bun.file(packageFile).json() as Record<string, unknown>;
  const hydraterm = typeof document.hydraterm === "object" && document.hydraterm !== null
    ? document.hydraterm as Record<string, unknown>
    : {};
  const processes = Object.fromEntries(scripts.map((script) => [scriptLabel(script), {
    command: `bun run --silent ${shellQuote(script.scriptName)}`,
    workingDir: relative(root, script.packageRoot) || ".",
    autoStart: true,
  }]));
  await Bun.write(packageFile, `${JSON.stringify({ ...document, hydraterm: { ...hydraterm, processes } }, null, 2)}\n`);
}

/** Lifecycle hooks and common helpers require explicit selection by default. */
export function isDefaultScript(script: PackageScript): boolean {
  return !/^(pre|post)/.test(script.scriptName) && !["lint", "typecheck"].includes(script.scriptName);
}

export function scriptLabel(script: PackageScript): string {
  return script.label ?? `${script.packageName}:${script.scriptName}`;
}

/** A bare name selects that script from every discovered package; package:name selects one package. */
export function resolveScriptNames(scripts: readonly PackageScript[], names: readonly string[]): PackageScript[] {
  const selected: PackageScript[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const matches = scripts.filter((script) => script.scriptName === name || scriptLabel(script) === name);
    if (matches.length === 0) missing.push(name);
    else selected.push(...matches);
  }
  if (missing.length > 0) {
    const available = scripts.map(scriptLabel).join(", ") || "none";
    throw new Error(`Unknown script${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Available: ${available}`);
  }
  return [...new Map(selected.map((script) => [`${script.packageRoot}\0${script.scriptName}`, script])).values()];
}
