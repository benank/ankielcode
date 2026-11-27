// @effect-diagnostics nodeBuiltinImport:off - reads the workspace manifests synchronously.
// The workspace packages a change touches, plus their dependents: check:changed typechecks these.
// Unknown paths affect every package.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");

const INERT = [
  /^docs\//,
  /^\.(agents|cursor|vscode|devcontainer|macroscope|repos)\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
];

// Vendored mobile dependencies change what every package installs.
const AFFECTS_EVERYTHING = [/^apps\/mobile\/deps\//];

// Cross-package reads absent from package.json dependencies.
const EXTRA_OWNERS: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [
  // Vite configs and tsconfigs of these apps import scripts/lib directly.
  [
    /^scripts\/lib\//,
    ["@ankielcode/desktop", "@ankielcode/mobile", "@ankielcode/web", "@ankielcode/server"],
  ],
  // scripts/build-desktop-artifact.ts reads the GNOME extension manifest, and its test the crates.
  [/^apps\/desktop\/gnome-extension\//, ["@ankielcode/scripts"]],
  [/^native\/(resource-monitor|kde-snap-shot|hyprland-snap-shot)\//, ["@ankielcode/scripts"]],
  [/^native\/browser-secret\//, ["@ankielcode/desktop"]],
  [/^native\/kde-snap-shot\//, ["@ankielcode/desktop"]],
  [/^native\/libghostty-vt\//, ["@ankielcode/web"]],
];

// These packages' tests import other packages without declaring them as dependencies.
const UNDECLARED_DEPS: Record<string, ReadonlyArray<string>> = {
  "@ankielcode/provider-pi": ["@ankielcode/client-runtime"],
  "@ankielcode/scripts": [
    "@ankielcode/desktop",
    "@ankielcode/mobile",
    "@ankielcode/web",
    "@ankielcode/server",
    "@ankielcode/provider-cursor",
  ],
};
// The server bundles the web build without importing it.
const BUILD_ONLY_DEPS: Record<string, ReadonlyArray<string>> = { ankiel: ["@ankielcode/web"] };

export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly deps: ReadonlyArray<string>;
}

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

export function readWorkspace(): Array<WorkspacePackage> {
  const patterns: Array<string> = [];
  let inPackages = false;
  for (const line of NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8").split(
    "\n",
  )) {
    if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
    const entry = inPackages ? line.match(/^\s+-\s+["']?([^"'\s]+)/) : null;
    if (entry?.[1]) patterns.push(entry[1]);
  }

  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return NodeFS.readdirSync(NodePath.join(root, parent)).map((name) => `${parent}/${name}`);
  });

  return dirs.flatMap((dir) => {
    const manifestPath = NodePath.join(root, dir, "package.json");
    if (!NodeFS.existsSync(manifestPath)) return [];
    const manifest: Manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    return [
      {
        name: manifest.name,
        dir,
        deps: Object.keys(deps).filter(
          (dep) =>
            String(deps[dep]).startsWith("workspace:") &&
            !BUILD_ONLY_DEPS[manifest.name]?.includes(dep),
        ),
      },
    ];
  });
}

// [] means inert; null means unknown and affects every package.
function ownersOf(file: string, packages: ReadonlyArray<WorkspacePackage>) {
  const extra = EXTRA_OWNERS.flatMap(([pattern, names]) => (pattern.test(file) ? names : []));
  if (INERT.some((pattern) => pattern.test(file))) return extra;
  // A manifest can change dependencies or versions other packages read.
  if (NodePath.posix.basename(file) === "package.json") return null;
  if (AFFECTS_EVERYTHING.some((pattern) => pattern.test(file))) return null;

  const owner = packages
    .filter((pkg) => file.startsWith(`${pkg.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (owner) return [owner.name, ...extra];
  return extra.length > 0 ? extra : null;
}

export function affectedPackages(
  files: ReadonlyArray<string>,
  packages: ReadonlyArray<WorkspacePackage>,
): Array<string> {
  const affected = new Set<string>();
  for (const file of files) {
    const owners = ownersOf(file, packages);
    if (owners === null) return packages.map((pkg) => pkg.name).sort();
    for (const owner of owners) affected.add(owner);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (!affected.has(pkg.name) && pkg.deps.some((dep) => affected.has(dep))) {
        affected.add(pkg.name);
        grew = true;
      }
    }
  }
  for (const [name, deps] of Object.entries(UNDECLARED_DEPS)) {
    if (deps.some((dep) => affected.has(dep))) affected.add(name);
  }
  return [...affected].sort();
}
