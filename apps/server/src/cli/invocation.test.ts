import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { posixLauncherScript } from "../cloud/pinnedRuntime.ts";
import {
  hostShellWord,
  resolveHostCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
    readonly args?: ReadonlyArray<string>;
  }) =>
    resolveRootCliCommand("browser setup", input.args).pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  const pathWithAnkiel = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "ankiel"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/@ankielcode/cli/dist/bin.mjs";
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo npx @ankielcode/cli browser setup",
      );
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" npx @ankielcode/cli browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/@ankielcode/cli/dist/bin.mjs",
          path: yield* pathWithAnkiel,
        }),
      ).toBe('sudo env "PATH=$PATH" ankiel browser setup');
    }),
  );

  it.effect("keeps the arguments, so root runs setup on the same Ankiel home", () =>
    Effect.gen(function* () {
      const args = ["--base-dir", "/srv/ankiel home"];
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/@ankielcode/cli/dist/bin.mjs",
          path: yield* pathWithAnkiel,
          args,
        }),
      ).toBe(`sudo env "PATH=$PATH" ankiel browser setup --base-dir '/srv/ankiel home'`);
      expect(
        yield* rootCommand({
          node: "/opt/ankiel/ankiel",
          entry: "/opt/ankiel/ankiel",
          executable: true,
          args,
        }),
      ).toBe("sudo /opt/ankiel/ankiel browser setup --base-dir '/srv/ankiel home'");
    }),
  );

  it.effect("names this install's launcher when ankiel is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "ankiel");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_Akabc/ankielcode",
        entry: "/tmp/.mount_Akabc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { ANKIEL_CLI_PATH: shim },
      };

      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);

      // An unrelated `ankiel` on PATH, such as an older npm global, is another install's CLI.
      expect(yield* rootCommand({ ...desktop, path: yield* pathWithAnkiel })).toBe(
        `sudo '${shim}' browser setup`,
      );

      // The link the app installs onto PATH leads to its own launcher, so plain `ankiel` is right.
      const linked = yield* fs.makeTempDirectoryScoped();
      yield* fs.symlink(shim, path.join(linked, "ankiel"));
      expect(yield* rootCommand({ ...desktop, path: linked })).toBe(
        'sudo env "PATH=$PATH" ankiel browser setup',
      );

      expect(
        yield* rootCommand({
          node: "/opt/ankiel/ankiel",
          entry: "/opt/ankiel/ankiel",
          executable: true,
        }),
      ).toBe("sudo /opt/ankiel/ankiel browser setup");

      // A standalone executable started directly (systemd, no launcher) is still this install.
      expect(
        yield* rootCommand({
          node: "/opt/ankiel/ankiel",
          entry: "/opt/ankiel/ankiel",
          executable: true,
          path: yield* pathWithAnkiel,
        }),
      ).toBe("sudo /opt/ankiel/ankiel browser setup");

      // A global npm launcher runs the downloaded executable; PATH's `ankiel` is that launcher.
      const prefix = path.join(home, "npm");
      const npmLauncher = path.join(prefix, "lib/node_modules/@ankielcode/cli/bin/ankiel.mjs");
      yield* fs.makeDirectory(path.dirname(npmLauncher), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(npmLauncher, "", { mode: 0o755 });
      yield* fs.writeFileString(
        path.join(prefix, "lib/node_modules/@ankielcode/cli/package.json"),
        `{"name":"@ankielcode/cli","version":"${packageJson.version}"}`,
      );
      yield* fs.symlink(npmLauncher, path.join(prefix, "bin/ankiel"));
      expect(
        yield* rootCommand({
          node: "/home/theo/.ankiel/runtime/versions/1.0.0/ankiel",
          entry: "/home/theo/.ankiel/runtime/versions/1.0.0/ankiel",
          executable: true,
          path: path.join(prefix, "bin"),
          env: { ANKIEL_NPM_LAUNCHER_PATH: npmLauncher },
        }),
      ).toBe('sudo env "PATH=$PATH" ankiel browser setup');

      expect(
        yield* rootCommand({ ...desktop, env: { ANKIEL_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" ankiel browser setup');
    }),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "ankiel.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\n");
      const hostCommand = (platform: NodeJS.Platform, env: Record<string, string>) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.ankiel"]).pipe(
          Effect.provideService(
            HostProcess.ExecutablePath,
            "C:\\Program Files\\Ankiel Code\\ankiel.exe",
          ),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\Ankiel Code\\ankiel.exe",
            "C:\\Program Files\\Ankiel Code\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      expect((yield* hostCommand("win32", { ANKIEL_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.ankiel"`,
      );
      expect((yield* hostCommand("win32", {})).command).toBe(
        'ankiel doctor "--base-dir" "C:\\Users\\Jane Doe\\.ankiel"',
      );
      expect(
        (yield* resolveHostCliCommand("doctor", [
          "--base-dir",
          "C:\\Ankiel\\\u201CArchive\u201D",
        ]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.ExecutablePath, "C:\\ankiel.exe"),
          Effect.provideService(HostProcess.Arguments, ["C:\\ankiel.exe", "C:\\bin.mjs"]),
          Effect.provideService(HostProcess.IsExecutable, false),
        )).command,
      ).toBe('ankiel doctor "--base-dir" "C:\\Ankiel\\\u201C\u201CArchive\u201D\u201D"');
      expect((yield* hostCommand("linux", { ANKIEL_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.ankiel'$/,
      );
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "names the absolute path of an ankiel found through a relative PATH entry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bin = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(bin, "ankiel"), "#!/bin/sh\n", { mode: 0o755 });
        const hostCommand = (searchPath: string) =>
          resolveHostCliCommand("doctor").pipe(
            Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/node"),
            Effect.provideService(HostProcess.Arguments, [
              "/usr/bin/node",
              "/opt/ankiel/lib/node_modules/@ankielcode/cli/dist/bin.mjs",
            ]),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, { PATH: searchPath }),
          );

        // A relative entry was searched from this process's directory, unlike the user's shell.
        expect(yield* hostCommand(path.relative(process.cwd(), bin))).toEqual({
          command: `${hostShellWord("linux", path.join(bin, "ankiel"))} doctor`,
          launcher: false,
        });
        // An empty entry makes the shell search its own directory first, wherever that is.
        expect(yield* hostCommand(`:${bin}`)).toEqual({
          command: `${hostShellWord("linux", path.join(bin, "ankiel"))} doctor`,
          launcher: false,
        });
        expect(yield* hostCommand(bin)).toEqual({ command: "ankiel doctor", launcher: false });
      }),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for script packages and the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const executable = path.join(root, ".ankiel/runtime/versions/1.0.0/ankiel");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "");
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/@ankielcode/cli/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@ankielcode/cli/bin/ankiel.mjs", "npx"],
        ["pnpm/dlx/hash/node_modules/@ankielcode/cli/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/ankiel/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "../package.json"),
          `{"name":"@ankielcode/cli","version":"${packageJson.version}","bin":{"ankiel":"./bin/ankiel.mjs"}}`,
        );
        const launchedBy = entry.endsWith("ankiel.mjs");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, [launchedBy ? executable : "node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, launchedBy),
          Effect.provideService(
            HostProcess.Environment,
            launchedBy ? { ANKIEL_NPM_LAUNCHER_PATH: entry } : {},
          ),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/@ankielcode/cli");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/ankiel");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"@ankielcode/cli","version":"0.0.45","bin":{"ankiel":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Arguments, ["node", entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated ankiel command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the downloaded executable was started by a global npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/@ankielcode/cli");
      const launcher = path.join(packageRoot, "bin/ankiel.mjs");
      const executable = path.join(root, ".ankiel/runtime/versions/1.0.0/ankiel");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(executable, "");
      yield* fs.symlink(launcher, path.join(prefix, "bin/ankiel"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, executable),
        Effect.provideService(HostProcess.Arguments, [executable, executable]),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { ANKIEL_NPM_LAUNCHER_PATH: launcher }),
      );
      for (const [version, expected] of [
        ["0.0.1", null],
        [packageJson.version, { kind: "npm-global", prefix }],
      ] as const) {
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          `{"name":"@ankielcode/cli","version":"${version}","bin":{"ankiel":"./bin/ankiel.mjs"}}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("names the launcher that started a downloaded runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      // The install script's launcher names ~/.ankiel, which here links to a home elsewhere.
      const executable = path.join(root, "data/ankiel/runtime/versions/1.0.0/ankiel");
      const launcher = path.join(root, "bin/ankiel");
      const copy = path.join(root, "bin/ankiel-copy");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(executable, "", { mode: 0o755 });
      yield* fs.writeFileString(copy, "", { mode: 0o755 });
      yield* fs.symlink(path.join(root, "data/ankiel"), path.join(root, ".ankiel"));
      yield* fs.symlink(path.join(root, ".ankiel/runtime/versions/1.0.0/ankiel"), launcher);
      // Earlier PATH entries hold a directory and a non-executable file named ankiel.
      yield* fs.makeDirectory(path.join(root, "shadow-dir/ankiel"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "shadow-file"));
      yield* fs.writeFileString(path.join(root, "shadow-file/ankiel"), "");
      const resolve = (invokedAs: string, PATH = "shadow-dir:shadow-file:bin") =>
        resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.InvokedAs, invokedAs),
          Effect.provideService(HostProcess.WorkingDirectory, root),
          Effect.provideService(HostProcess.Environment, { PATH }),
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
      const baseDir = path.join(root, ".ankiel");

      expect(yield* resolve("ankiel")).toEqual({ kind: "ankiel-launcher", launcher, baseDir });
      expect(yield* resolve(launcher)).toEqual({ kind: "ankiel-launcher", launcher, baseDir });
      expect(yield* resolve(executable)).toBeNull();
      expect(yield* resolve(copy)).toBeNull();

      // The script launcher execs the runtime by absolute path, so argv0 names the runtime.
      yield* fs.remove(launcher);
      yield* fs.writeFileString(
        launcher,
        posixLauncherScript(path.join(root, ".ankiel/runtime/versions/1.0.0/ankiel")),
        { mode: 0o755 },
      );
      expect(yield* resolve(executable, path.join(root, "bin"))).toEqual({
        kind: "ankiel-launcher",
        launcher,
        baseDir,
      });
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/@ankielcode/cli/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".ankiel/runtime/0.0.45/ankiel",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
