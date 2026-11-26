import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
      const checkout = "/home/theo/src/ankielcode/apps/server/dist/bin.mjs";
      expect(
        yield* rootCommand({ node: "/usr/bin/node", entry: checkout, path: yield* pathWithAnkiel }),
      ).toBe("sudo ankiel browser setup");
      expect(
        yield* rootCommand({
          node: "/home/theo/.nvm/versions/node/v24/bin/node",
          entry: checkout,
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
          entry: "/home/theo/src/ankielcode/apps/server/dist/bin.mjs",
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

  it.effect("names this install's executable when ankiel on PATH is another install", () =>
    Effect.gen(function* () {
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
    }),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const hostCommand = (platform: NodeJS.Platform, executable: boolean) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.ankiel"]).pipe(
          Effect.provideService(
            HostProcess.ExecutablePath,
            "C:\\Program Files\\Ankiel Code\\ankiel.exe",
          ),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\Ankiel Code\\ankiel.exe",
            "C:\\Program Files\\Ankiel Code\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, executable),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
        );
      expect((yield* hostCommand("win32", true)).command).toBe(
        `& "C:\\Program Files\\Ankiel Code\\ankiel.exe" doctor "--base-dir" "C:\\Users\\Jane Doe\\.ankiel"`,
      );
      expect((yield* hostCommand("win32", false)).command).toBe(
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
      expect((yield* hostCommand("linux", true)).command).toMatch(
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
              "/opt/ankielcode/apps/server/dist/bin.mjs",
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
        "project/node_modules/@ankielcode/server/dist/bin.mjs",
        "prefix/lib/node_modules/@ankielcode/server/dist/bin.mjs",
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
